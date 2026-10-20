// Minimal host transport. Native session algorithms live in the private engine.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ENGINE_PROTOCOL, ENGINE_MAX_FRAME, verifyEngineInstallation } from './pro-engine-install.mjs';

const fail = (code, message = 'The terminal engine is unavailable.') => Object.assign(new Error(message), { code });
const MAX_PENDING = 32;
const MAX_WRITE_QUEUE = 4 * 1024 * 1024;
// Terminal streams (docs/contracts/pro-engine-host-v1.md): ids per engine
// instance; one input message at most what ws-frames lets a browser send
// (DEFAULT_MAX_MESSAGE_BYTES); one joined output message and one control
// object at most what the engine may send.
const MAX_STREAM_ID = 0xffff_ffff;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_JOINED_BYTES = 64 * 1024 * 1024;
const MAX_CONTROL_BYTES = 4096;
const CLOSE_CODES = new Set([1000, 1001, 1011]);
const HANDLE = /^[0-9a-f]{64}$/;
// A lone UTF-16 surrogate has no UTF-8 form: JSON.stringify writes it as an
// escape the engine's parser refuses as malformed, which ends the IPC and
// every request on it. No JSON on the wire carries one.
const LONE_SURROGATE = /\p{Cs}/u;
const wellFormed = (key, value) => { if (LONE_SURROGATE.test(key) || (typeof value === 'string' && LONE_SURROGATE.test(value))) throw fail('invalid_request'); return value; };
const replaceLoneSurrogates = text => text.replace(/\p{Cs}/gu, '\ufffd');
function awaitStartup(starting, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(fail('cancelled', 'The operation was cancelled.')); };
    const timer = setTimeout(() => { clean(); reject(fail('timeout')); }, timeoutMs); timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    starting.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
  });
}
const isCount = value => Number.isSafeInteger(value) && value >= 0;
/** The engine's one control object in a kind-3 payload, or null for anything
 *  that is not exactly `credit` or `close`: not UTF-8 JSON, an unknown `t`, a
 *  field missing, unknown, repeated (JSON.parse keeps the last of two) or of
 *  the wrong type, a close code the bridge never sends, or a reason over the
 *  123 bytes a close frame has room for. */
function engineControl(payload) {
  if (payload.length > MAX_CONTROL_BYTES) return null;
  let text, message;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload); message = JSON.parse(text); } catch { return null; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const keys = Object.keys(message), spelled = text.match(/"(?:[^"\\]|\\.)*"\s*:/g)?.length ?? 0;
  if (spelled !== keys.length) return null;
  const fields = keys.sort().join(',');
  if (message.t === 'credit') return fields === 'bytes,t' && isCount(message.bytes) ? message : null;
  if (message.t === 'close') return fields === 'code,reason,t' && CLOSE_CODES.has(message.code) && typeof message.reason === 'string' && Buffer.byteLength(message.reason) <= 123 ? message : null;
  return null;
}
const ALLOWED = /^terminal\.[a-zA-Z][a-zA-Z0-9.]{0,63}$/;
export class ProEngineClient extends EventEmitter {
  #child; #starting; #installation; #nonce; #pending = new Map(); #out = 0n; #in = 0n; #id = 0;
  #prefix = Buffer.alloc(4); #prefixAt = 0; #body; #bodyAt = 0;
  #closed = false; #heartbeat; #failures = 0; #retryAt = 0; #generation = 0; #capabilities;
  #streams = new Map(); #lastStream = 0;
  constructor({ enabled = false, directory, publicKey, hostVersion = '0.0.0', timeoutMs = 10_000, heartbeatMs = 15_000 } = {}) {
    super(); this.options = Object.freeze({ enabled, directory, publicKey, hostVersion, timeoutMs, heartbeatMs });
  }
  get enabled() { return this.options.enabled === true; }
  get capabilities() { return this.#capabilities; }
  get running() { return !!this.#child && !!this.#capabilities; }
  async start() {
    if (!this.enabled) throw fail('disabled');
    if (this.#closed) throw fail('closed');
    if (this.running) return this.#capabilities;
    if (this.#starting) return this.#starting;
    if (Date.now() < this.#retryAt) throw fail('backoff');
    const starting = this.#launch(); this.#starting = starting;
    try { return await starting; } finally { if (this.#starting === starting) this.#starting = undefined; }
  }
  async #launch() {
    const installation = await awaitStartup(verifyEngineInstallation(this.options), undefined, 5000);
    if (this.#closed) throw fail('closed');
    const child = spawn(installation.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, env: process.env });
    this.#child = child; this.#installation = installation; this.#nonce = randomBytes(32).toString('hex');
    const generation = ++this.#generation;
    // Stream ids start again at 1 for every engine instance.
    this.#out = 0n; this.#in = 0n; this.#prefixAt = 0; this.#body = undefined; this.#bodyAt = 0; this.#lastStream = 0;
    child.stdout.on('data', chunk => { if (generation === this.#generation) { try { this.#consume(chunk); } catch { this.#lost(child, fail('protocol')); } } });
    // Drain without exposing untrusted stderr (which can contain paths/secrets).
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.#lost(child, fail('transport')));
    child.on('error', () => this.#lost(child, fail('startup')));
    child.on('exit', () => this.#lost(child, fail('exited')));
    try {
      const caps = await this.#send('system.hello', { protocol: ENGINE_PROTOCOL, hostPid: process.pid, hostVersion: this.options.hostVersion, nonce: this.#nonce }, { timeoutMs: 5000 }, false);
      if (!caps || caps.protocol !== ENGINE_PROTOCOL || caps.target !== installation.target || caps.buildDigest !== installation.digest || caps.engineVersion !== installation.version || !/^[0-9a-f-]{36}$/.test(caps.engineInstance ?? '') || caps.maxFrameBytes !== ENGINE_MAX_FRAME || caps.maxPending !== MAX_PENDING || caps.streamWindowBytes !== 512 * 1024 || !caps.terminal || typeof caps.terminal !== 'object' || !['unavailable', 'tmux', 'conpty'].includes(caps.terminal.backend) || ['launch', 'resume', 'attachOwned', 'attachExternalTmux', 'attachExternalConsole', 'surviveEngineRestart'].some(key => typeof caps.terminal[key] !== 'boolean')) throw fail('incompatible');
      if (child !== this.#child || this.#closed) throw fail('exited');
      this.#capabilities = Object.freeze({ ...caps, terminal: Object.freeze({ ...caps.terminal }) });
      this.#failures = 0;
      this.#heartbeat = setInterval(() => { if (this.#pending.size < MAX_PENDING) this.#send('system.ping', {}, { timeoutMs: 5000 }).catch(() => this.#lost(child, fail('heartbeat'))); }, this.options.heartbeatMs);
      this.#heartbeat.unref(); return this.#capabilities;
    } catch (error) { this.#lost(child, error); throw error; }
  }
  async request(method, params = {}, options = {}) {
    // An attach opens a stream, which only attachTerminal registers.
    if (!ALLOWED.test(method) || method === 'terminal.attach') throw fail('unknown_method');
    if (options.signal?.aborted) throw fail('cancelled', 'The operation was cancelled.');
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw fail('invalid_request');
    const deadline = performance.now() + timeoutMs;
    await awaitStartup(this.start(), options.signal, timeoutMs);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw fail('timeout');
    return this.#send(method, params, { ...options, timeoutMs: remaining });
  }
  /**
   * Attach a terminal stream for `handle`, the 64 hex characters an engine
   * route answered in a ticket's place. The stream id is registered before the
   * request is written, so what the engine sends on it after its answer is
   * kept for `start`. Never starts the engine: a handle belongs to the
   * instance that is running. Answers the stream, or rejects with the engine's
   * refusal (`bad_params`, `busy`, `unavailable`, `invalid_handle`) or the
   * transport's code; a deadline or an abort gives the attach up and tells the
   * engine with `close`.
   */
  async attachTerminal(handle, { signal, timeoutMs = this.options.timeoutMs } = {}) {
    if (!this.running || this.#capabilities.terminal.backend === 'unavailable') throw fail('unavailable');
    if (typeof handle !== 'string' || !HANDLE.test(handle)) throw fail('bad_params');
    if (signal?.aborted) throw fail('cancelled', 'The operation was cancelled.');
    if (this.#lastStream >= MAX_STREAM_ID) throw fail('busy');
    const child = this.#child;
    const stream = { id: ++this.#lastStream, sink: undefined, held: [], parts: [], partBytes: 0, relayed: 0, sent: 0, credit: 0, input: [], paused: false, ended: false, lost: false };
    this.#streams.set(stream.id, stream);
    let data;
    try { data = await this.#send('terminal.attach', { handle, stream: stream.id }, { signal, timeoutMs, attach: true }); } catch (error) {
      // Given up: the engine may attach it yet, so it is told. Refused or gone:
      // the id stays named, and anything that arrives for it is discarded.
      if (error.code === 'timeout' || error.code === 'cancelled') this.#closeStream(stream); else this.#forget(stream);
      throw error;
    }
    if (!data || typeof data !== 'object' || Object.keys(data).join() !== 'stream' || data.stream !== stream.id) { this.#lost(child, fail('protocol')); throw fail('protocol'); }
    return Object.freeze({
      id: stream.id,
      /** Relay to `sink` ({ binary, text, close, lost, buffered, resume }): what arrived before it first, in order. */
      start: sink => this.#start(stream, sink),
      /** A browser message; false when it is held for the input window, and the socket should stop being read until `resume`. */
      send: (type, bytes) => this.#input(stream, type, bytes),
      /** The socket drained: report it. */
      flow: () => this.#flow(stream),
      /** The socket went away, or the host gives the stream up. */
      close: () => this.#closeStream(stream),
      /** closeOpenTerminals for this stream; false when it is no longer live. */
      shutdown: (reason, text) => this.#shutdownStream(stream, reason, text),
    });
  }
  #send(method, params, { signal, timeoutMs = this.options.timeoutMs, attach = false } = {}, authenticated = true) {
    if (!this.#child || this.#closed) return Promise.reject(fail('exited'));
    // An attach is answered at once and is not counted by the engine either;
    // MAX_TERMINALS bounds how many can be waiting.
    if (!attach && this.#pending.size >= MAX_PENDING) return Promise.reject(fail('busy'));
    if (signal?.aborted) return Promise.reject(fail('cancelled', 'The operation was cancelled.'));
    const id = `r${++this.#id}`;
    let payload;
    try { payload = Buffer.from(JSON.stringify({ id, method, params, ...(authenticated ? { auth: this.#nonce } : {}) }, wellFormed)); } catch { return Promise.reject(fail('invalid_request')); }
    if (payload.length > ENGINE_MAX_FRAME - 13 || this.#child.stdin.writableLength + payload.length + 17 > MAX_WRITE_QUEUE) return Promise.reject(fail('busy'));
    const body = Buffer.allocUnsafe(payload.length + 17); body.writeUInt32BE(payload.length + 13); body[4] = 0; body.writeUInt32BE(0, 5); body.writeBigUInt64BE(++this.#out, 9); payload.copy(body, 17);
    const child = this.#child;
    return new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#pending.delete(id); };
      // An attach given up is closed on its stream instead (attachTerminal): cancelling it would answer nothing.
      const cancel = code => { if (!this.#pending.has(id)) return; clean(); reject(fail(code, code === 'cancelled' ? 'The operation was cancelled.' : undefined)); if (authenticated && method !== 'system.cancel' && !attach) this.#send('system.cancel', { id }, { timeoutMs: 1000 }).catch(() => this.#lost(child, fail('cancellation_failed'))); };
      const abort = () => cancel('cancelled');
      const timer = setTimeout(() => cancel('timeout'), timeoutMs); timer.unref();
      this.#pending.set(id, { resolve: value => { clean(); resolve(value); }, reject: error => { clean(); reject(error); } });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(body, error => { if (error) this.#lost(child, fail('transport')); });
    });
  }
  /** One stream frame, on the sequence counter every kind shares. */
  #frame(kind, id, payload) {
    const child = this.#child;
    const body = Buffer.allocUnsafe(payload.length + 17); body.writeUInt32BE(payload.length + 13); body[4] = kind; body.writeUInt32BE(id, 5); body.writeBigUInt64BE(++this.#out, 9); payload.copy(body, 17);
    child.stdin.write(body, error => { if (error) this.#lost(child, fail('transport')); });
  }
  #control(id, message) { this.#frame(3, id, Buffer.from(JSON.stringify(message, wellFormed))); }
  #consume(chunk) {
    let offset = 0; const flows = new Set();
    while (offset < chunk.length) {
      if (!this.#body) {
        const count = Math.min(4 - this.#prefixAt, chunk.length - offset); chunk.copy(this.#prefix, this.#prefixAt, offset, offset + count); this.#prefixAt += count; offset += count;
        if (this.#prefixAt < 4) continue;
        const length = this.#prefix.readUInt32BE(); this.#prefixAt = 0;
        if (length < 13 || length > ENGINE_MAX_FRAME) throw fail('protocol');
        this.#body = Buffer.allocUnsafe(length); this.#bodyAt = 0;
      }
      const count = Math.min(this.#body.length - this.#bodyAt, chunk.length - offset); chunk.copy(this.#body, this.#bodyAt, offset, offset + count); this.#bodyAt += count; offset += count;
      if (this.#bodyAt < this.#body.length) continue;
      const frame = this.#body; this.#body = undefined;
      if (frame.readBigUInt64BE(5) !== ++this.#in) throw fail('protocol');
      if (frame[0] !== 0 || frame.readUInt32BE(1) !== 0) { this.#streamFrame(frame[0], frame.readUInt32BE(1), frame.subarray(13), flows); continue; }
      const reply = JSON.parse(frame.subarray(13).toString('utf8'));
      if (!reply || typeof reply.id !== 'string' || typeof reply.ok !== 'boolean' || (reply.ok ? !Object.hasOwn(reply, 'data') : !reply.error || typeof reply.error.code !== 'string')) throw fail('protocol');
      const pending = this.#pending.get(reply.id);
      // Timed-out/cancelled requests can have an already-in-flight final reply.
      if (pending) { if (reply.ok) pending.resolve(reply.data); else pending.reject(fail(reply.error.code, 'The terminal operation could not be completed.')); }
    }
    // One flow per stream per chunk, once that stream's data in it is relayed.
    for (const stream of flows) this.#flow(stream);
  }
  /** Kinds 1–4 on a nonzero stream; anything else is a violation, as is an id
   *  never allocated. An allocated id that is not live (refused, given up,
   *  closed) has its frames discarded: they crossed its close. */
  #streamFrame(kind, id, payload, flows) {
    if (kind < 1 || kind > 4 || id === 0 || id > this.#lastStream) throw fail('protocol');
    const stream = this.#streams.get(id);
    if (!stream || stream.ended) return;
    if (kind === 4) {
      // A part of a binary message that continues: never empty, and the whole never over the cap.
      if (!payload.length || stream.partBytes + payload.length > MAX_JOINED_BYTES) throw fail('protocol');
      stream.parts.push(payload); stream.partBytes += payload.length; return;
    }
    if (stream.parts.length && kind !== 1) throw fail('protocol');
    if (kind === 3) {
      const message = engineControl(payload);
      if (!message) throw fail('protocol');
      if (message.t === 'close') { stream.ended = true; return this.#deliver(stream, 'close', message, flows); }
      // Credit is cumulative: never backwards, never past what was sent.
      if (message.bytes < stream.credit || message.bytes > stream.sent) throw fail('protocol');
      stream.credit = message.bytes; return this.#sendInput(stream);
    }
    let bytes = payload;
    if (stream.parts.length) {
      if (stream.partBytes + payload.length > MAX_JOINED_BYTES) throw fail('protocol');
      bytes = Buffer.concat([...stream.parts, payload], stream.partBytes + payload.length); stream.parts = []; stream.partBytes = 0;
    }
    this.#deliver(stream, kind === 1 ? 'binary' : 'text', bytes, flows);
  }
  #deliver(stream, type, value, flows) {
    if (!stream.sink) return void stream.held.push([type, value]);
    this.#relay(stream, type, value);
    if (type !== 'close') flows.add(stream);
  }
  #relay(stream, type, value) {
    try { if (type === 'close') stream.sink.close(value.code, value.reason); else stream.sink[type](value); } catch { /* a socket that cannot take it is already closing */ }
    // Taken off the IPC once whole: handed to the socket, or dropped by one that has closed.
    if (type === 'close') this.#forget(stream); else stream.relayed += value.length;
  }
  #start(stream, sink) {
    if (stream.lost) { try { sink.lost(); } catch {} return; }
    if (this.#streams.get(stream.id) !== stream || stream.sink) return;
    stream.sink = sink;
    const held = stream.held; stream.held = [];
    for (const [type, value] of held) this.#relay(stream, type, value);
    if (held.length) this.#flow(stream);
  }
  /** The input window: data may be sent while nothing is owed, or while what is
   *  owed plus it fits; otherwise it waits, with everything after it, in order. */
  #input(stream, type, bytes) {
    if (bytes.length > MAX_INPUT_BYTES) throw new RangeError('A terminal message is at most 1 MiB.');
    // A stream that has ended takes nothing more; the socket's close follows.
    if (this.#streams.get(stream.id) !== stream || stream.ended) return true;
    stream.input.push([type === 'binary' ? 1 : 2, bytes]);
    this.#sendInput(stream);
    return !(stream.paused = stream.input.length > 0);
  }
  #sendInput(stream) {
    while (stream.input.length) {
      const [kind, bytes] = stream.input[0], owed = stream.sent - stream.credit;
      if (owed !== 0 && owed + bytes.length > this.#capabilities.streamWindowBytes) return;
      stream.input.shift(); stream.sent += bytes.length; this.#frame(kind, stream.id, bytes);
    }
    if (stream.paused) { stream.paused = false; try { stream.sink?.resume(); } catch {} }
  }
  #flow(stream) {
    if (this.#streams.get(stream.id) !== stream || stream.ended || !stream.sink) return;
    let buffered = 0; try { buffered = stream.sink.buffered(); } catch {}
    this.#control(stream.id, { t: 'flow', relayed: stream.relayed, buffered: isCount(buffered) ? buffered : 0 });
  }
  #closeStream(stream) {
    if (this.#streams.get(stream.id) !== stream) return;
    this.#forget(stream);
    // Never after the engine's own close.
    if (!stream.ended) this.#control(stream.id, { t: 'close' });
  }
  #shutdownStream(stream, reason = 'server-shutdown', text) {
    const told = typeof text === 'string' && text !== '';
    if (typeof reason !== 'string' || !reason) throw new RangeError('Not a shutdown the engine can be sent.');
    // The deck's own words, so the panel is still told them: a lone surrogate
    // becomes U+FFFD, as the UTF-8 the browser receives would have it anyway.
    reason = replaceLoneSurrogates(reason); if (told) text = replaceLoneSurrogates(text);
    if (Buffer.byteLength(reason) > 123 || (told && Buffer.byteLength(text) > 1024)) throw new RangeError('Not a shutdown the engine can be sent.');
    if (this.#streams.get(stream.id) !== stream || stream.ended) return false;
    this.#control(stream.id, { t: 'shutdown', reason, ...(told ? { text } : {}) });
    return true;
  }
  #forget(stream) { if (this.#streams.get(stream.id) === stream) this.#streams.delete(stream.id); }
  #lost(child, error) {
    if (!child || child !== this.#child) return;
    this.#child = undefined; this.#capabilities = undefined; this.#nonce = undefined;
    clearInterval(this.#heartbeat); this.#heartbeat = undefined;
    this.#body = undefined; this.#prefixAt = 0;
    this.#retryAt = Date.now() + Math.min(30_000, 250 * 2 ** Math.min(this.#failures++, 7));
    for (const item of [...this.#pending.values()]) item.reject(error);
    // Every relayed socket closes without an exit, so its panel reconnects with a new ticket.
    const streams = [...this.#streams.values()]; this.#streams.clear();
    for (const stream of streams) { stream.lost = true; if (stream.sink) try { stream.sink.lost(); } catch {} }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill();
    // Kill only our IPC child; it owns detaching, never persistent-agent teardown.
    this.emit('disconnected', error.code ?? 'exited');
  }
  async close() {
    if (this.#closed) return;
    if (this.#child && this.#capabilities) { try { await this.#send('system.shutdown', {}, { timeoutMs: 1000 }); } catch {} }
    this.#closed = true; this.#lost(this.#child, fail('closed'));
  }
}

/** Disabled construction does no I/O, discovery, subprocess launch or download. */
export function createProEngineClient(options = {}) { return new ProEngineClient(options); }
