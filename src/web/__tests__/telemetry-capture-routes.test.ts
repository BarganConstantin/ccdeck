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
    const capture = createTrafficCapture({ platform: 'darwin', findInterface: async () => 'en0' }); cleanup.push(() => capture.dispose());
    const server = createServer((req, res) => void handleTrafficCapture(req, res, new URL(req.url!, 'http://localhost'), capture));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/system/traffic-radar`;
    const denied = await fetch(base + '/ingest', { method: 'POST', body: Buffer.alloc(0) }); expect(denied.status).toBe(401);
    const setup = await capture.prepare('192.0.2.16:4317', 4329);
    const token = /'([a-f0-9]{64})'$/.exec(setup.command)![1];
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
