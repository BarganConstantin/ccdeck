import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createTrafficCapture } from '../../server/traffic-radar-capture.mjs';
import { handleTrafficCapture, isAuthorizedTrafficIngest } from '../../server/traffic-radar-routes.mjs';
import { GUARDED_READS, OPEN_MUTATIONS, isAuthorizedDataRead, isAuthorizedMutation } from '../../server/request-gates.mjs';
import { request, packet, pcap } from './traffic-capture-fixture.mjs';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
describe('telemetry capture route authorization', () => {
  it('guards content reads and setup mutations instead of making capture a public mutation', () => {
    expect(OPEN_MUTATIONS.has('/api/system/traffic-radar/capture/permission')).toBe(false);
    expect(GUARDED_READS.has('/api/system/traffic-radar/capture')).toBe(true);
    expect(GUARDED_READS.has('/api/system/traffic-radar/capture/event')).toBe(true);
    expect(OPEN_MUTATIONS.has('/api/system/traffic-radar/ingest')).toBe(false);
    expect(isAuthorizedDataRead({ headers: { host: '127.0.0.1:4329' } })).toBe(false);
    expect(isAuthorizedMutation({ headers: { host: '127.0.0.1:4329' } })).toBe(false);
    expect(isAuthorizedTrafficIngest({ method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, new URL('http://localhost/api/system/traffic-radar/ingest'))).toBe(false);
  });
  it('rejects remote clients even when other deck gates would accept them', async () => {
    let status = 0, body = '';
    await handleTrafficCapture({ method: 'GET', headers: {}, socket: { remoteAddress: '192.0.2.10' } }, { writeHead: (s: number) => { status = s; }, end: (s: string) => { body = s; } }, new URL('http://localhost/api/system/traffic-radar/capture'));
    expect(status).toBe(403); expect(body).toContain('this machine only');
  });
  it('accepts only the active temporary token and returns payloads through the selected detail route', async () => {
    const capture = createTrafficCapture({ platform: 'darwin', findTool: async () => '/usr/sbin/tcpdump', findInterface: async () => 'en0' }); cleanup.push(() => capture.dispose());
    const server = createServer((req, res) => void handleTrafficCapture(req, res, new URL(req.url!, 'http://localhost'), capture));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/system/traffic-radar`;
    const denied = await fetch(base + '/ingest', { method: 'POST', body: Buffer.alloc(0) }); expect(denied.status).toBe(401);
    const setup = await capture.prepare('192.0.2.16:4317', 4329);
    const token = /'([a-f0-9]{64})' '0'$/.exec(setup.command)![1];
    const response = await fetch(base + '/ingest', { method: 'POST', headers: { 'x-radar-capture': token }, body: pcap(packet(request())) });
    expect(response.status).toBe(200);
    const state = await fetch(base + '/capture').then(r => r.json());
    expect(state.events[0].payload).toBeUndefined();
    const detail = await fetch(base + `/capture/event?id=${state.events[0].id}`).then(r => r.json()); expect(detail.payload.resourceLogs).toBeDefined();
    capture.stop();
    expect((await fetch(base + '/ingest', { method: 'POST', headers: { 'x-radar-capture': token }, body: Buffer.alloc(0) })).status).toBe(401);
    capture.clear(); expect((await fetch(base + `/capture/event?id=${state.events[0].id}`)).status).toBe(404);
  });
});

// Monitoring is always on (2026-10-23): the Settings switch, Start and Stop are
// gone from the server too, so nothing on the page or off it can turn it off.
it('answers the removed switch, Start and Stop routes with 404', async () => {
  const calls: string[] = [];
  const capture = { settings: async () => { calls.push('settings'); return {}; }, setEnabled: async () => { calls.push('setEnabled'); return {}; },
    prepare: async () => { calls.push('prepare'); return {}; }, stop: async () => { calls.push('stop'); } };
  const server = createServer((req, res) => void handleTrafficCapture(req, res, new URL(req.url!, 'http://localhost'), capture as never));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/system/traffic-radar`;
  expect((await fetch(base + '/settings')).status).toBe(404);
  for (const action of ['/settings', '/capture/prepare', '/capture/stop'])
    expect((await fetch(base + action, { method: 'POST', body: '{"enabled":false,"destination":"192.0.2.16:4317"}' })).status, action).toBe(404);
  expect(GUARDED_READS.has('/api/system/traffic-radar/settings')).toBe(false);
  expect(calls).toEqual([]);
});

// Allow capture: the system's own password prompt, once. A grant starts capture
// again at once; any other answer leaves capture to its own retries.
it('asks for capture permission and starts capture again only when it was granted', async () => {
  const outcomes = [
    { outcome: 'granted' },
    { outcome: 'cancelled' },
    { outcome: 'unavailable', message: 'No password prompt can open in this session.', command: "sudo sh '/tmp/x/radar-capture-setup.sh'" },
    { outcome: 'failed', message: 'The password was not accepted.', command: "sudo sh '/tmp/x/radar-capture-setup.sh'" },
  ];
  let next = 0, retries = 0, asks = 0;
  const capture = { retry: async () => { retries++; } };
  const permission = async () => { asks++; return outcomes[next++]; };
  const server = createServer((req, res) => void handleTrafficCapture(req, res, new URL(req.url!, 'http://localhost'), capture as never, permission as never));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/system/traffic-radar/capture/permission`;
  for (const expected of outcomes) {
    const res = await fetch(url, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...expected });
  }
  expect(asks).toBe(4);
  expect(retries).toBe(1);
  // A read is not a request for the prompt.
  expect((await fetch(url)).status).toBe(404);
  expect(asks).toBe(4);
});

it("holds the permission prompt behind the deck's own page: no anonymous or cross-site press", () => {
  const anonymous = { headers: { host: '127.0.0.1:4329' } };
  expect(OPEN_MUTATIONS.has('/api/system/traffic-radar/capture/permission')).toBe(false);
  expect(isAuthorizedMutation(anonymous as never)).toBe(false);
  expect(isAuthorizedMutation({ headers: { host: '127.0.0.1:4329', origin: 'http://192.0.2.9:4329' } } as never)).toBe(false);
  expect(isAuthorizedDataRead({ headers: { host: '127.0.0.1:4329', 'sec-fetch-site': 'cross-site' } } as never)).toBe(false);
});

it('refuses the permission prompt to a remote client before asking anything', async () => {
  let asks = 0, status = 0;
  await handleTrafficCapture({ method: 'POST', headers: {}, socket: { remoteAddress: '192.0.2.10' } } as never,
    { writeHead: (s: number) => { status = s; }, end: () => {} } as never, new URL('http://localhost/api/system/traffic-radar/capture/permission'),
    { retry: async () => {} } as never, (async () => { asks++; return { outcome: 'granted' }; }) as never);
  expect(status).toBe(403);
  expect(asks).toBe(0);
});
