import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createWireCapture } from '../../server/traffic-radar-wire.mjs';
import { captureDestination, createTrafficCapture } from '../../server/traffic-radar-capture.mjs';
import { streamCapture } from '../../server/traffic-radar-helper.mjs';
import { LOGS, frame, headers, packet, pcap, request, response } from './traffic-capture-fixture.mjs';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
function reader() {
  const events: any[] = [], receipts: any[] = [], issues: string[] = [];
  const decoder = createWireCapture({ host: '192.0.2.16', port: 4317, onExport: (value: unknown) => { events.push(value); return events.length; }, onResponse: (id: number, value: unknown) => receipts.push({ id, ...value as object }), onIssue: (value: string) => issues.push(value) });
  return { decoder, events, receipts, issues };
}
describe('passive OTLP capture', () => {
  it('decodes a real protobuf export and distinguishes observation from acceptance', () => {
    const r = reader(); r.decoder.feed(pcap(packet(request())));
    expect(r.events[0].payload).toEqual(LOGS); expect(r.receipts).toEqual([]);
    r.decoder.feed(packet(response(), { side: 'in' }));
    expect(r.receipts[0]).toMatchObject({ id: 1, outcome: 'accepted', grpcStatus: '0' });
    expect(r.issues).toEqual([]);
  });
  it.each(['metrics', 'traces'])('decodes %s with its own OTLP schema', signal => {
    const payload = signal === 'metrics' ? { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { dataPoints: [{ asInt: '34' }] } }] }] }] } : { resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'claude.tool', attributes: [{ key: 'tool.name', value: { stringValue: 'Read' } }] }] }] }] };
    const r = reader(); r.decoder.feed(pcap(packet(request(signal, payload)), packet(response(signal), { side: 'in' })));
    expect(r.events[0].payload).toEqual(payload); expect(r.receipts[0].outcome).toBe('accepted');
  });
  it('handles arbitrary pcap chunking, TCP reordering and retransmission without duplicate exports', () => {
    const req = request(), cut = 40;
    const data = pcap(packet(Buffer.alloc(0), { seq: 999, flags: 2 }), packet(req.subarray(cut), { seq: 1000 + cut }), packet(req.subarray(0, cut)), packet(req));
    const r = reader(); for (let i = 0; i < data.length; i += 7) r.decoder.feed(data.subarray(i, i + 7));
    expect(r.events).toHaveLength(1); expect(r.events[0].payload).toEqual(LOGS);
  });
  it('handles gzip without mistaking compressed bytes for readable text', () => {
    const r = reader(); r.decoder.feed(pcap(packet(request('logs', LOGS, true)))); expect(r.events[0].payload).toEqual(LOGS);
  });
  it.each([['partial', { rejectedLogRecords: '1', errorMessage: 'Synthetic rejection' }, '0'], ['rejected', null, '7']])('reports %s instead of successful delivery', (outcome, partial, status) => {
    const r = reader(); r.decoder.feed(pcap(packet(request()), packet(response('logs', partial, status), { side: 'in' })));
    expect(r.receipts[0].outcome).toBe(outcome);
  });
  it.each([['encrypted', Buffer.from([22, 3, 3, 0, 10])], ['joined_midstream', frame(0, 1, 3, Buffer.from('not a complete session'))]])('reports %s without inventing contents', (issue, data) => {
    const r = reader(); r.decoder.feed(pcap(packet(data))); expect(r.events).toEqual([]); expect(r.issues).toContain(issue);
  });
  it('requires a complete response body as well as success trailers', () => {
    const r = reader(); r.decoder.feed(pcap(packet(request()), packet(Buffer.concat([frame(1, 4, 1, headers({ ':status': '200' })), frame(1, 5, 1, headers({ 'grpc-status': '0' }))]), { side: 'in' })));
    expect(r.receipts[0].outcome).toBe('unknown');
  });
  it('ignores traffic outside the exact destination', () => {
    const r = reader(); r.decoder.feed(pcap(packet(request(), { host: '192.0.2.17' }))); expect(r.events).toEqual([]);
  });
  it('rejects unsupported and oversized capture inputs', () => {
    const r = reader(); expect(() => r.decoder.feed(Buffer.alloc(262145))).toThrow();
    expect(() => r.decoder.feed(Buffer.alloc(24))).toThrow('pcap_required');
  });
});
describe('capture lifecycle and privacy', () => {
  async function prepare() {
    let clock = 1700000000000;
    const capture = createTrafficCapture({ now: () => clock, platform: 'darwin', findInterface: async () => 'en0' }); cleanup.push(() => capture.dispose());
    const setup = await capture.prepare('192.0.2.16:4317', 4329);
    const token = /'([a-f0-9]{64})'$/.exec(setup.command)![1];
    return { capture, setup, token, advance: (ms: number) => { clock += ms; } };
  }
  it('keeps tokens and payloads out of status reads; details are on demand', async () => {
    const { capture, token, setup } = await prepare();
    expect(setup.command).toContain("'host 192.0.2.16 and tcp port 4317'");
    capture.ingest(token, pcap(packet(request())));
    const snapshot = capture.read(); expect(JSON.stringify(snapshot)).not.toContain(token); expect(snapshot.events[0]).not.toHaveProperty('payload');
    expect(capture.detail(snapshot.events[0].id).payload).toEqual(LOGS);
  });
  it('does not claim capture is running just because a command was prepared or a helper connected', async () => {
    const { capture, token } = await prepare(); expect(capture.read().state).toBe('awaiting');
    capture.ingest(token, Buffer.alloc(0)); expect(capture.read().state).toBe('receiving'); expect(capture.read().events).toEqual([]);
  });
  it('invalidates tokens immediately on stop and clears captured contents explicitly', async () => {
    const { capture, token } = await prepare(); capture.ingest(token, pcap(packet(request()))); const id = capture.read().events[0].id;
    capture.stop(); expect(capture.accepts(token)).toBe(false); expect(capture.ingest(token, Buffer.alloc(0))).toBe(false);
    expect(capture.detail(id)).not.toBeNull(); capture.clear(); expect(capture.detail(id)).toBeNull();
  });
  it('expires tokens and retained contents without relying on an open modal', async () => {
    const { capture, token, advance } = await prepare(); capture.ingest(token, pcap(packet(request())));
    advance(300001); expect(capture.read().events).toEqual([]); expect(capture.read().state).toBe('interrupted');
    advance(300000); expect(capture.accepts(token)).toBe(false);
  });
  it('checks IPv4, port and interface inputs before generating a shell command', async () => {
    for (const value of ['localhost:4317', '192.0.2.16:0', '192.0.2.16:65536', '999.0.2.1:4317', '192.0.2.1:4317;whoami']) expect(() => captureDestination(value)).toThrow();
    const capture = createTrafficCapture({ platform: 'darwin', findInterface: async () => 'en0;whoami' }); cleanup.push(() => capture.dispose());
    await expect(capture.prepare('192.0.2.16:4317', 4329)).rejects.toThrow('interface');
  });
  it('streams only to loopback and follows no redirects', async () => {
    const calls: any[] = [];
    await streamCapture({ base: 'http://127.0.0.1:4329', token: 'a'.repeat(64), input: Readable.from([Buffer.from('test')]), report: () => {}, send: async (...args: any[]) => { calls.push(args); return { ok: true }; } });
    expect(calls[0][0].hostname).toBe('127.0.0.1'); expect(calls[0][1].redirect).toBe('error');
    await expect(streamCapture({ base: 'http://192.0.2.16:4317', token: 'a'.repeat(64), input: Readable.from([]), report: () => {} })).rejects.toThrow();
  });
});
