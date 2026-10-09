// Read-only OS probe; --live adds isolated synthetic loopback traffic and requires capture privileges.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as tcpServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
import { createTrafficRadar } from '../src/server/traffic-radar.mjs';
import { captureInterface, captureTool } from '../src/server/traffic-radar-platform.mjs';
import { createTrafficCapture } from '../src/server/traffic-radar-capture.mjs';
import { handleTrafficCapture } from '../src/server/traffic-radar-routes.mjs';
import { streamCapture } from '../src/server/traffic-radar-helper.mjs';

const snapshot = await createTrafficRadar().read();
assert.equal(snapshot.status, 'observing', 'Native connection visibility should be available');
console.log(JSON.stringify({ platform: snapshot.platform, status: snapshot.status, processCount: snapshot.processCount, connectionCount: snapshot.connections.length, configSources: snapshot.config.sources }));
assert.ok(await captureInterface('127.0.0.1', process.platform));
try { console.log(JSON.stringify({ captureTool: await captureTool(process.platform) })); }
catch (error) { console.log(JSON.stringify({ captureSetup: error.message })); if (process.argv.includes('--live')) throw error; }
if (!process.argv.includes('--live')) process.exit(0);

const { request, response, LOGS } = await import('../src/web/__tests__/traffic-capture-fixture.mjs');
const capture = createTrafficCapture();
const ingest = createServer((req, res) => void handleTrafficCapture(req, res, new URL(req.url, 'http://localhost'), capture));
const collector = tcpServer(socket => { let answered = false; socket.on('data', () => { if (!answered) { answered = true; socket.write(response()); } }); });
let child, client, runner;
const sockets = new Set();
collector.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
try {
  await Promise.all([new Promise(r => ingest.listen(0, '127.0.0.1', r)), new Promise(r => collector.listen(0, '127.0.0.1', r))]);
  const port = collector.address().port, localPort = ingest.address().port;
  const setup = await capture.prepare(`127.0.0.1:${port}`, localPort);
  const token = /'([a-f0-9]{64})'/.exec(setup.command)[1];
  const base = `http://127.0.0.1:${localPort}`;
  const tool = await captureTool(process.platform), iface = await captureInterface('127.0.0.1', process.platform);
  if (process.platform === 'win32') {
    // Run the exact PowerShell command shown in Radar, including helper CLI arguments.
    const activation = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', setup.command], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    runner = new Promise((resolve, reject) => {
      activation.once('error', reject);
      activation.once('exit', code => code === 0 ? resolve() : reject(new Error(`Capture activation exited ${code}`)));
    });
    runner.catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
  } else {
    child = spawn(tool, ['-i', iface, '-nn', '-U', '-s', '0', '-w', '-', `host 127.0.0.1 and tcp port ${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      child.on('error', reject); child.on('exit', code => reject(new Error(`tcpdump exited ${code}`)));
      child.stderr.on('data', bytes => { if (bytes.toString().includes('listening on')) resolve(); });
    });
    runner = streamCapture({ base, token, input: child.stdout });
  }
  // This process is a synthetic Claude stand-in on Linux; no actual Claude settings change.
  const title = process.title;
  if (process.platform === 'linux') process.title = 'claude';
  client = connect(port, '127.0.0.1');
  await new Promise(r => client.once('connect', r));
  client.write(request());
  if (process.platform === 'linux') {
    const actual = await createTrafficRadar().read();
    assert.ok(actual.connections.some(c => c.pid === process.pid && c.destination === `127.0.0.1:${port}`));
    process.title = title;
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !capture.read().events.some(e => e.outcome === 'accepted')) await new Promise(r => setTimeout(r, 100));
  const event = capture.read().events[0];
  assert.ok(event, 'Expected a decoded export from real loopback packets');
  assert.equal(event.outcome, 'accepted');
  assert.deepEqual(capture.detail(event.id).payload, LOGS);
  console.log(JSON.stringify({ liveCapture: 'passed', backend: capture.read().backend, sessionIds: event.sessionIds, outcome: event.outcome }));
} finally {
  capture.stop(); child?.kill(); client?.destroy(); for (const socket of sockets) socket.destroy();
  ingest.closeAllConnections(); await Promise.all([new Promise(r => ingest.close(r)), new Promise(r => collector.close(r))]);
  if (runner) await runner;
  capture.dispose();
}
