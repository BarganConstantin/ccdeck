// Public IPC test double, deliberately no native session implementation.
const { createHash, randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const digest = createHash('sha256').update(readFileSync(process.argv[1])).digest('hex');
const HANDSHAKE_DELAY_MS = 0;
// Tests that relay a terminal replace this with 'tmux'.
const TERMINAL_BACKEND = 'unavailable';
let input = Buffer.alloc(0), seq = 0n, inSeq = 0n, nonce;
const pending = new Map();
// A paused stdin does not hold the event loop, and an engine does not exit
// because it stopped reading: kept alive until stdin ends or it is killed.
setInterval(() => {}, 1 << 30);
// The engine's JSON parser refuses a lone UTF-16 surrogate as malformed,
// escaped or not, and ends as it does for any message it cannot read.
const LONE_SURROGATE = /\p{Cs}/u;
const readable = value => typeof value === 'string' ? !LONE_SURROGATE.test(value) : !value || typeof value !== 'object' || Object.entries(value).every(([k, v]) => !LONE_SURROGATE.test(k) && readable(v));
function write(kind, stream, payload, skip = 0n) {
  const frame = Buffer.alloc(17 + payload.length); frame.writeUInt32BE(payload.length + 13); frame[4] = kind; frame.writeUInt32BE(stream, 5); seq += 1n + skip; frame.writeBigUInt64BE(seq, 9); payload.copy(frame, 17);
  const live = streams.get(stream); if (live && kind !== 3) live.sent += payload.length;
  // Fragment the prefix and body across writes, even for simultaneous replies.
  process.stdout.write(frame.subarray(0, 2)); process.stdout.write(frame.subarray(2, 11)); process.stdout.write(frame.subarray(11));
}
function respond(id, data, error) {
  write(0, 0, Buffer.from(JSON.stringify(error ? { id, ok: false, error: { code: error, message: 'fixture' } } : { id, ok: true, data })));
}

// Terminal streams, as the engine's half of the contract has them: attach
// redeems a handle once, the bridge's first frame is `hello`, input is
// credited as it is taken, and `close`, `shutdown` and `flow` are checked.
// Every violation by the host ends this process with 64, as the engine's do.
const WINDOW = 524288, PART = 2097152 - 13;
const handles = new Map(), streams = new Map(), early = new Set(), plans = [], log = [];
let named = 0;
const pattern = (size, seed) => { const b = Buffer.allocUnsafe(size); for (let i = 0; i < size; i++) b[i] = (i * 31 + seed + (i >>> 11)) & 255; return b; };
const json = (stream, kind, value) => write(kind, stream, Buffer.from(JSON.stringify(value)));
function end(id, reason, message) {
  json(id, 2, { t: 'exit', reason, ...(message ? { message } : {}) });
  json(id, 3, { t: 'close', code: reason === 'server-shutdown' ? 1001 : 1000, reason }); streams.delete(id);
}
function credit(id, s) { if (s.taken > s.credited) { s.credited = s.taken; json(id, 3, { t: 'credit', bytes: s.taken }); } }
function attach(req) {
  const params = req.params ?? {}, id = params.stream, plan = plans.shift() ?? {};
  const valid = Object.keys(params).sort().join() === 'handle,stream' && /^[0-9a-f]{64}$/.test(params.handle) && Number.isInteger(id) && id >= 1 && id <= 0xffffffff && id > named;
  if (Number.isInteger(id) && id > named) named = id;
  log.push({ attach: id, handle: params.handle, params: Object.keys(params).sort() });
  if (!valid) return respond(req.id, null, 'bad_params');
  if (plan.silent) return;
  const answer = () => {
    if (plan.refuse) return respond(req.id, null, plan.refuse);
    if (streams.size >= 8) return respond(req.id, null, 'busy');
    if (TERMINAL_BACKEND === 'unavailable') return respond(req.id, null, 'unavailable');
    const minted = handles.get(params.handle); handles.delete(params.handle);
    if (!minted || Date.now() - minted > 35000) return respond(req.id, null, 'invalid_handle');
    respond(req.id, { stream: id });
    // The host's close crossed this answer: the stream ends before it starts.
    if (early.has(id)) return;
    streams.set(id, { taken: 0, credited: 0, sent: 0, relayed: 0, hold: !!plan.hold, deaf: !!plan.ignoreShutdown });
    json(id, 2, { t: 'hello', kind: 'A', sizeOwner: 'dock', readOnly: false });
  };
  if (plan.delayMs) setTimeout(answer, plan.delayMs); else answer();
}
function streamFrame(kind, id, payload) {
  if (kind < 1 || kind > 3 || id === 0 || id > named) process.exit(64);
  const s = streams.get(id);
  if (kind === 3) {
    let msg; try { msg = JSON.parse(payload); } catch { process.exit(64); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !readable(msg)) process.exit(64);
    const fields = Object.keys(msg).sort().join(), count = n => Number.isSafeInteger(n) && n >= 0;
    const ok = (msg.t === 'close' && fields === 't') || (msg.t === 'flow' && fields === 'buffered,relayed,t' && count(msg.relayed) && count(msg.buffered))
      || (msg.t === 'shutdown' && (fields === 'reason,t' || fields === 'reason,t,text') && typeof msg.reason === 'string' && msg.reason.length > 0 && Buffer.byteLength(msg.reason) <= 123 && (msg.text === undefined || (typeof msg.text === 'string' && Buffer.byteLength(msg.text) <= 1024)));
    if (!ok) process.exit(64);
    log.push({ stream: id, control: msg, live: !!s });
    if (!s) { if (msg.t === 'close') early.add(id); return; }
    if (msg.t === 'close') return void streams.delete(id);
    if (msg.t === 'flow') { if (msg.relayed < s.relayed || msg.relayed > s.sent) process.exit(64); s.relayed = msg.relayed; return; }
    if (!s.deaf) end(id, msg.reason, msg.text);
    return;
  }
  if (payload.length > 1048576) process.exit(64);
  if (!s) return void log.push({ stream: id, discarded: kind });
  const owed = s.taken - s.credited;
  if (owed !== 0 && owed + payload.length > WINDOW) process.exit(64);
  s.taken += payload.length;
  log.push({ stream: id, kind, size: payload.length, ...(payload.length <= 4096 ? { data: payload.toString('base64') } : { sha256: createHash('sha256').update(payload).digest('hex') }) });
  if (!s.hold) credit(id, s);
}
// Frames for terminal.emit: `{ kind, stream, text | size + seed, skip }` as
// one frame, or `{ binary: size, stream, seed }` as one binary message, in
// kind-4 parts when it does not fit one frame.
function emit(frames) {
  for (const f of frames) {
    if (f.binary !== undefined) {
      const bytes = pattern(f.binary, f.seed ?? 0); let at = 0;
      while (bytes.length - at > PART) { write(4, f.stream, bytes.subarray(at, at + PART)); at += PART; }
      write(1, f.stream, bytes.subarray(at));
    } else write(f.kind, f.stream, f.text !== undefined ? Buffer.from(f.text) : pattern(f.size ?? 0, f.seed ?? 0), BigInt(f.skip ?? 0));
  }
}

process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4 && input.length >= input.readUInt32BE() + 4) {
    const length = input.readUInt32BE(); const kind = input[4], stream = input.readUInt32BE(5);
    if (input.readBigUInt64BE(9) !== ++inSeq) process.exit(64);
    const body = input.subarray(17, length + 4); input = input.subarray(length + 4);
    if (kind !== 0 || stream !== 0) { streamFrame(kind, stream, body); continue; }
    const req = JSON.parse(body);
    if (!readable(req)) process.exit(64);
    if (req.method === 'system.hello') {
      nonce = req.params.nonce;
      setTimeout(() => respond(req.id, { protocol: 1, target: ({darwin:'apple-darwin',linux:'unknown-linux-gnu'})[process.platform] && `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`, engineVersion: '0.1.0', engineInstance: '12345678-1234-1234-1234-123456789abc', buildDigest: digest, maxFrameBytes: 2097152, maxPending: 32, streamWindowBytes: 524288, terminal: { backend: TERMINAL_BACKEND, launch: false, resume: false, attachOwned: false, attachExternalTmux: false, attachExternalConsole: false, surviveEngineRestart: false } }), HANDSHAKE_DELAY_MS);
    } else if (req.auth !== nonce) process.exit(64);
    else if (req.method === 'system.ping') respond(req.id, { alive: true });
    else if (req.method === 'system.shutdown') {
      // Every live stream's last frames come before the answer.
      for (const id of [...streams.keys()]) end(id, 'server-shutdown');
      respond(req.id, { stopping: true }); process.exit(0);
    }
    else if (req.method === 'system.cancel') {
      const id = req.params.id; const timer = pending.get(id); clearTimeout(timer); pending.delete(id);
      if (timer) respond(id, null, 'cancelled'); respond(req.id, { cancelled: !!timer });
    } else if (req.method === 'terminal.pause') {
      process.stdin.pause(); respond(req.id, { paused: process.stdin.isPaused() }); return;
    } else if (req.method === 'terminal.slow') {
      pending.set(req.id, setTimeout(() => { pending.delete(req.id); respond(req.id, { pid: process.pid }); }, 2000));
    } else if (req.method === 'terminal.crash') process.exit(67);
    else if (req.method === 'terminal.badframe') { const prefix = Buffer.alloc(4); prefix.writeUInt32BE(2097153); process.stdout.write(prefix); }
    else if (req.method === 'terminal.attach') attach(req);
    // What a route would answer in a ticket's place.
    else if (req.method === 'terminal.mint') { const handle = randomBytes(32).toString('hex'); handles.set(handle, Date.now()); respond(req.id, { handle }); }
    // How the next attaches are answered: `{ refuse, silent, delayMs, hold, ignoreShutdown }` each.
    else if (req.method === 'terminal.plan') { plans.push(...req.params.plans); respond(req.id, { planned: plans.length }); }
    else if (req.method === 'terminal.emit') { emit(req.params.frames); respond(req.id, { emitted: req.params.frames.length }); }
    else if (req.method === 'terminal.hold') { const s = streams.get(req.params.stream); if (s) { s.hold = req.params.hold; if (!s.hold) credit(req.params.stream, s); } respond(req.id, { live: !!s }); }
    else if (req.method === 'terminal.log') respond(req.id, { log, live: [...streams.keys()], named });
    else respond(req.id, { value: req.params, pid: process.pid });
  }
});
process.stdin.on('end', () => process.exit(0));
