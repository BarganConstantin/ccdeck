import { pathToFileURL } from "node:url";

export async function streamCapture({ base, token, input = process.stdin, send = fetch, report = message => process.stderr.write(message + '\n') }) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local capture destination.');
  let stopped = false, sequence = Promise.resolve();
  const finish = () => { stopped = true; input.destroy(); };
  const post = bytes => {
    sequence = sequence.then(async () => {
      if (stopped) return;
      try {
        const response = await send(new URL('/api/system/traffic-radar/ingest', url), {
          method: 'POST', headers: { 'x-radar-capture': token, 'content-type': 'application/octet-stream' },
          body: bytes, signal: AbortSignal.timeout(3000), redirect: 'error',
        });
        if (!response.ok) finish();
      } catch { finish(); }
    });
    return sequence;
  };
  const heartbeat = setInterval(() => { if (!stopped) void post(Buffer.alloc(0)); }, 1000);
  const deadline = setTimeout(finish, 600_000);
  report('Telemetry Radar: sending capture bytes only to local ccdeck; no file is written. Press Ctrl+C to stop tcpdump.');
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
    report('Telemetry Radar: local receiver stopped. Press Ctrl+C if tcpdump is still running.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  streamCapture({ base: process.argv[2], token: process.argv[3] }).catch(() => {
    process.stderr.write('Could not start the local capture helper.\n'); process.exitCode = 1;
  });
}
