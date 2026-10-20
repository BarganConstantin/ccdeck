// Public IPC test double, deliberately no native session implementation.
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const digest = createHash('sha256').update(readFileSync(process.argv[1])).digest('hex');
const HANDSHAKE_DELAY_MS = 0;
let input = Buffer.alloc(0), seq = 0n, nonce;
const pending = new Map();
function respond(id, data, error) {
  const payload = Buffer.from(JSON.stringify(error ? { id, ok: false, error: { code: error, message: 'fixture' } } : { id, ok: true, data }));
  const frame = Buffer.alloc(17 + payload.length); frame.writeUInt32BE(payload.length + 13); frame[4] = 0; frame.writeBigUInt64BE(++seq, 9); payload.copy(frame, 17);
  // Fragment the prefix and body across writes, even for simultaneous replies.
  process.stdout.write(frame.subarray(0, 2)); process.stdout.write(frame.subarray(2, 11)); process.stdout.write(frame.subarray(11));
}
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4 && input.length >= input.readUInt32BE() + 4) {
    const length = input.readUInt32BE(); const req = JSON.parse(input.subarray(17, length + 4)); input = input.subarray(length + 4);
    if (req.method === 'system.hello') {
      nonce = req.params.nonce;
      setTimeout(() => respond(req.id, { protocol: 1, target: ({darwin:'apple-darwin',linux:'unknown-linux-gnu'})[process.platform] && `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`, engineVersion: '0.1.0', engineInstance: '12345678-1234-1234-1234-123456789abc', buildDigest: digest, maxFrameBytes: 2097152, maxPending: 32, streamWindowBytes: 524288, terminal: { backend: 'unavailable', launch: false, resume: false, attachOwned: false, attachExternalTmux: false, attachExternalConsole: false, surviveEngineRestart: false } }), HANDSHAKE_DELAY_MS);
    } else if (req.auth !== nonce) process.exit(64);
    else if (req.method === 'system.ping') respond(req.id, { alive: true });
    else if (req.method === 'system.shutdown') { respond(req.id, { stopping: true }); process.exit(0); }
    else if (req.method === 'system.cancel') {
      const id = req.params.id; const timer = pending.get(id); clearTimeout(timer); pending.delete(id);
      if (timer) respond(id, null, 'cancelled'); respond(req.id, { cancelled: !!timer });
    } else if (req.method === 'terminal.pause') {
      process.stdin.pause(); respond(req.id, { paused: process.stdin.isPaused() }); return;
    } else if (req.method === 'terminal.slow') {
      pending.set(req.id, setTimeout(() => { pending.delete(req.id); respond(req.id, { pid: process.pid }); }, 2000));
    } else if (req.method === 'terminal.crash') process.exit(67);
    else if (req.method === 'terminal.badframe') { const prefix = Buffer.alloc(4); prefix.writeUInt32BE(2097153); process.stdout.write(prefix); }
    else respond(req.id, { value: req.params, pid: process.pid });
  }
});
process.stdin.on('end', () => process.exit(0));
