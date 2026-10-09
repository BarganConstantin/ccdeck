import { spawn } from 'node:child_process';
import { captureDestination } from './traffic-radar-capture.mjs';
import { captureInterfaceValid } from './traffic-radar-platform.mjs';
import { pathToFileURL } from "node:url";

export async function streamCapture({ base, token, source = 0, input = process.stdin, send = fetch, report = message => process.stderr.write(message + '\n') }) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local capture destination.');
  if (!Number.isInteger(source) || source < 0 || source > 7) throw new Error('Invalid capture source.');
  let stopped = false, sequence = Promise.resolve();
  const finish = () => { stopped = true; input.destroy(); };
  const post = bytes => {
    sequence = sequence.then(async () => {
      if (stopped) return;
      try {
        const response = await send(new URL('/api/system/traffic-radar/ingest', url), {
          method: 'POST', headers: { 'x-radar-capture': token, 'x-radar-source': String(source), 'content-type': 'application/octet-stream' },
          body: bytes, signal: AbortSignal.timeout(3000), redirect: 'error',
        });
        if (!response.ok) finish();
      } catch { finish(); }
    });
    return sequence;
  };
  const heartbeat = setInterval(() => { if (!stopped) void post(Buffer.alloc(0)); }, 1000);
  const deadline = setTimeout(finish, 600_000);
  report('Telemetry Radar: sending capture bytes only to local ccdeck; no file is written. Press Ctrl+C to stop capture.');
  try {
    for await (const chunk of input) {
      for (let offset = 0; offset < chunk.length && !stopped; offset += 65_536) await post(chunk.subarray(offset, offset + 65_536));
      if (stopped) break;
    }
    await sequence;
  } catch {
    if (!stopped) report('Capture input interrupted.');
  } finally {
    stopped = true; clearInterval(heartbeat); clearTimeout(deadline);
    report('Telemetry Radar: local receiver stopped. Press Ctrl+C if the capture tool is still running.');
  }
}

// PowerShell 5 pipelines convert binary output to text. Stream dumpcap directly in Node.
export async function runCaptureTool({ tool, interface: iface, host, port, base, token, source = 0, launch = spawn, send = fetch, report = message => process.stderr.write(message + '\n') }) {
  captureDestination(`${host}:${port}`);
  if (!captureInterfaceValid(iface, 'win32') || !tool || /[\r\n]/.test(tool)) throw new Error('Invalid capture tool or interface.');
  // Validate before launching a child, not after it has started capturing.
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !/^[a-f0-9]{64}$/.test(token) || !Number.isInteger(source) || source < 0 || source > 7) throw new Error('Invalid local capture destination.');
  const child = launch(tool, ['-i', iface, '-P', '-s', '0', '-f', `host ${host} and tcp port ${port}`, '-w', '-'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, shell: false });
  let failure = null;
  child.on('error', error => { failure = error; child.stdout.destroy(error); });
  child.on('exit', code => { if (code) failure = new Error('Capture tool failed. Check Npcap and capture permissions.'); });
  const stop = () => { child.kill(); child.stdout.destroy(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await streamCapture({ base, token, source, input: child.stdout, send, report });
    if (failure) throw failure;
  } finally {
    child.kill(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const job = args[0] === '--capture'
    ? runCaptureTool({ tool: args[1], interface: args[2], host: args[3], port: Number(args[4]), base: args[5], token: args[6], source: Number(args[7] ?? 0) })
    : streamCapture({ base: args[0], token: args[1], source: Number(args[2] ?? 0) });
  job.catch(() => { process.stderr.write('Could not start capture. Check that the capture tool is installed and its permissions allow this user.\n'); process.exitCode = 1; });
}
