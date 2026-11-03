// Codex 0.166's Windows endpoint is AF_UNIX, not a named pipe. Its official
// app-server proxy relays raw bytes, including the WebSocket HTTP handshake.
import { Duplex } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { spawnSpec } from './exec-spec.mjs';

const disconnected = () => Object.assign(new Error('native_disconnected'), { code: 'native_disconnected' });
export function createCodexWindowsProxy(endpoint, options = {}) {
  const env = { ...(options.env ?? process.env), CODEX_HOME: endpoint.home };
  for (const key of Object.keys(env)) if (/^(OPENAI_API_KEY|CODEX_API_KEY)$/i.test(key)) delete env[key];
  const spec = spawnSpec(endpoint.executable, ['app-server', 'proxy', '--sock', endpoint.socketPath], options.platform ?? process.platform);
  const child = (options.spawnChild ?? spawn)(spec.file, spec.args,
    { ...spec.opts, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  let timer, stopped = false;
  const stream = new Duplex({
    read() { child.stdout.resume(); },
    write(data, encoding, done) { child.stdin.write(data, encoding, error => done(error ? disconnected() : null)); },
    final(done) { child.stdin.end(done); },
    destroy(error, done) {
      clearTimeout(timer);
      if (!stopped) {
        stopped = true;
        if (child.exitCode === null && child.signalCode === null) {
          if ((options.platform ?? process.platform) === 'win32' && child.pid) {
            // npm's .cmd/JS wrapper may own a child proxy. Stop this process tree
            // only; never call daemon stop or target an advertised daemon PID.
            const taskkill = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
            (options.execFile ?? execFile)(taskkill, ['/PID', String(child.pid), '/T', '/F'],
              { timeout: 2000, windowsHide: true, shell: false, maxBuffer: 4096 }, () => {});
          } else child.kill();
        }
        child.stdin.destroy(); child.stdout.destroy();
      }
      done(error);
    },
  });
  // HTTP/ws accept a Duplex but expect the small net.Socket tuning interface.
  stream.setNoDelay = stream.setKeepAlive = () => stream;
  stream.setTimeout = (ms, callback) => {
    clearTimeout(timer);
    if (callback) stream.once('timeout', callback);
    if (ms) timer = setTimeout(() => stream.emit('timeout'), ms);
    return stream;
  };
  child.stdout.on('data', data => { if (!stream.push(data)) child.stdout.pause(); });
  child.stdout.on('end', () => stream.push(null));
  child.stdout.on('error', () => stream.destroy(disconnected()));
  child.stdin.on('error', () => stream.destroy(disconnected()));
  child.on('error', () => stream.destroy(disconnected()));
  child.on('exit', () => stream.destroy(disconnected()));
  return stream;
}
