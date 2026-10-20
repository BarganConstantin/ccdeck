// Minimal host transport. Native session algorithms live in the private engine.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ENGINE_PROTOCOL, ENGINE_MAX_FRAME, verifyEngineInstallation } from './pro-engine-install.mjs';

const fail = (code, message = 'The terminal engine is unavailable.') => Object.assign(new Error(message), { code });
const MAX_PENDING = 32;
const MAX_WRITE_QUEUE = 4 * 1024 * 1024;
const ALLOWED = /^terminal\.[a-zA-Z][a-zA-Z0-9.]{0,63}$/;
export class ProEngineClient extends EventEmitter {
  #child; #starting; #installation; #nonce; #pending = new Map(); #out = 0n; #in = 0n; #id = 0;
  #prefix = Buffer.alloc(4); #prefixAt = 0; #body; #bodyAt = 0;
  #closed = false; #heartbeat; #failures = 0; #retryAt = 0; #generation = 0; #capabilities;
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
    const installation = await verifyEngineInstallation(this.options);
    if (this.#closed) throw fail('closed');
    const child = spawn(installation.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, env: process.env });
    this.#child = child; this.#installation = installation; this.#nonce = randomBytes(32).toString('hex');
    const generation = ++this.#generation;
    this.#out = 0n; this.#in = 0n; this.#prefixAt = 0; this.#body = undefined; this.#bodyAt = 0;
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
    if (!ALLOWED.test(method)) throw fail('unknown_method');
    if (options.signal?.aborted) throw fail('cancelled', 'The operation was cancelled.');
    await this.start();
    return this.#send(method, params, options);
  }
  #send(method, params, { signal, timeoutMs = this.options.timeoutMs } = {}, authenticated = true) {
    if (!this.#child || this.#closed) return Promise.reject(fail('exited'));
    if (this.#pending.size >= MAX_PENDING) return Promise.reject(fail('busy'));
    if (signal?.aborted) return Promise.reject(fail('cancelled', 'The operation was cancelled.'));
    const id = `r${++this.#id}`;
    let payload;
    try { payload = Buffer.from(JSON.stringify({ id, method, params, ...(authenticated ? { auth: this.#nonce } : {}) })); } catch { return Promise.reject(fail('invalid_request')); }
    if (payload.length > ENGINE_MAX_FRAME - 13 || this.#child.stdin.writableLength + payload.length + 17 > MAX_WRITE_QUEUE) return Promise.reject(fail('busy'));
    const body = Buffer.allocUnsafe(payload.length + 17); body.writeUInt32BE(payload.length + 13); body[4] = 0; body.writeUInt32BE(0, 5); body.writeBigUInt64BE(++this.#out, 9); payload.copy(body, 17);
    return new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#pending.delete(id); };
      const cancel = code => { if (!this.#pending.has(id)) return; clean(); reject(fail(code, code === 'cancelled' ? 'The operation was cancelled.' : undefined)); if (authenticated && method !== 'system.cancel') this.#send('system.cancel', { id }, { timeoutMs: 1000 }).catch(() => {}); };
      const abort = () => cancel('cancelled');
      const timer = setTimeout(() => cancel('timeout'), timeoutMs); timer.unref();
      this.#pending.set(id, { resolve: value => { clean(); resolve(value); }, reject: error => { clean(); reject(error); } });
      signal?.addEventListener('abort', abort, { once: true });
      const child = this.#child;
      child.stdin.write(body, error => { if (error) this.#lost(child, fail('transport')); });
    });
  }
  #consume(chunk) {
    let offset = 0;
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
      if (frame[0] !== 0 || frame.readUInt32BE(1) !== 0 || frame.readBigUInt64BE(5) !== ++this.#in) throw fail('protocol');
      const reply = JSON.parse(frame.subarray(13).toString('utf8'));
      if (!reply || typeof reply.id !== 'string' || typeof reply.ok !== 'boolean' || (reply.ok ? !Object.hasOwn(reply, 'data') : !reply.error || typeof reply.error.code !== 'string')) throw fail('protocol');
      const pending = this.#pending.get(reply.id);
      // Timed-out/cancelled requests can have an already-in-flight final reply.
      if (pending) { if (reply.ok) pending.resolve(reply.data); else pending.reject(fail(reply.error.code, 'The terminal operation could not be completed.')); }
    }
  }
  #lost(child, error) {
    if (!child || child !== this.#child) return;
    this.#child = undefined; this.#capabilities = undefined; this.#nonce = undefined;
    clearInterval(this.#heartbeat); this.#heartbeat = undefined;
    this.#body = undefined; this.#prefixAt = 0;
    this.#retryAt = Date.now() + Math.min(30_000, 250 * 2 ** Math.min(this.#failures++, 7));
    for (const item of [...this.#pending.values()]) item.reject(error);
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
