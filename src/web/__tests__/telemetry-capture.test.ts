import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable, PassThrough } from 'node:stream';
import { createWireCapture } from '../../server/traffic-radar-wire.mjs';
import { captureDestination, createTrafficCapture } from '../../server/traffic-radar-capture.mjs';
import { streamCapture } from '../../server/traffic-radar-helper.mjs';
import { LOGS, frame, headers, packet, pcap, request, response } from './traffic-capture-fixture.mjs';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.useRealTimers(); });
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
  it('preserves 64-bit measurements and non-finite doubles without JSON precision loss', () => {
    const payload = { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'synthetic.values', gauge: { dataPoints: [{ asInt: '9223372036854775806' }, { asDouble: Infinity }] } }] }] }] };
    const r = reader(); r.decoder.feed(pcap(packet(request('metrics', payload))));
    const points = r.events[0].payload.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints;
    expect(points).toEqual([{ asInt: '9223372036854775806' }, { asDouble: 'Infinity' }]);
    expect(JSON.parse(JSON.stringify(points))).toEqual(points);
    expect(r.events[0].protobufBase64).toBeTruthy();
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
  it('retains unreadable connection observations without inventing an export or session ID', async () => {
    const capture = createTrafficCapture({ platform: 'darwin', findTool: async () => '/usr/sbin/tcpdump', findInterface: async () => 'en0' });
    cleanup.push(() => capture.dispose());
    const setup = await capture.prepare('192.0.2.16:4317', 4329);
    const token = /'([a-f0-9]{64})' '0'$/.exec(setup.command)![1];
    capture.ingest(token, pcap(packet(Buffer.from([22, 3, 3, 0, 10]))));
    expect(capture.read().events).toEqual([]);
    expect(capture.read().observations[0]).toMatchObject({ destination: '192.0.2.16:4317', reason: 'encrypted' });
    expect(capture.read().observations[0]).not.toHaveProperty('sessionIds');
    capture.clear(); expect(capture.read().observations).toEqual([]);
  });
  it('captures independent destinations without mixing parsers, tokens or receipts', async () => {
    const capture = createTrafficCapture({ platform: 'darwin', findTool: async () => '/usr/sbin/tcpdump', findInterface: async host => host.endsWith('16') ? 'en0' : 'en1' });
    cleanup.push(() => capture.dispose());
    const setup = await capture.prepare(['192.0.2.16:4317', '192.0.2.17:4318'], 4329);
    expect(setup.commands).toHaveLength(2);
    expect(setup.commands[1].command).toContain("-i 'en1'");
    const token = /'([a-f0-9]{64})' '0'$/.exec(setup.command)![1];
    capture.ingest(token, pcap(packet(request())), 0);
    capture.ingest(token, pcap(packet(request(), { host: '192.0.2.17', port: 4318 })), 1);
    expect(capture.read().events.map(e => e.destination)).toEqual(['192.0.2.17:4318', '192.0.2.16:4317']);
    expect(capture.read().events.every(e => e.sessionIds.includes('fixture-session'))).toBe(true);
    expect(capture.read().sources.every(s => s.active)).toBe(true);
    expect(JSON.stringify(capture.read())).not.toContain(token);
    expect(capture.ingest(token, Buffer.alloc(0), 8)).toBe(false);
    capture.stop(); expect(capture.read().sources.every(s => !s.active)).toBe(true);
  });

  async function prepare() {
    let clock = 1700000000000;
    const capture = createTrafficCapture({ now: () => clock, platform: 'darwin', findTool: async () => '/usr/sbin/tcpdump', findInterface: async () => 'en0' }); cleanup.push(() => capture.dispose());
    const setup = await capture.prepare('192.0.2.16:4317', 4329);
    const token = /'([a-f0-9]{64})' '0'$/.exec(setup.command)![1];
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
    const { capture, token, advance } = await prepare(); capture.ingest(token, pcap(packet(request()))); const id = capture.read().events[0].id;
    capture.stop(); expect(capture.accepts(token)).toBe(false); expect(capture.ingest(token, Buffer.alloc(0))).toBe(false);
    expect(capture.detail(id)).not.toBeNull(); advance(6000); expect(capture.read().state).toBe('stopped'); capture.clear(); expect(capture.detail(id)).toBeNull();
  });
  it('keeps monitoring enabled past ten minutes while retaining only recent contents', async () => {
    const { capture, token, advance } = await prepare(); capture.ingest(token, pcap(packet(request())));
    advance(300001); expect(capture.read().events).toEqual([]); expect(capture.read().state).toBe('interrupted');
    advance(600000); expect(capture.accepts(token)).toBe(true);
    expect(capture.read().expiresAt).toBeNull();
    capture.ingest(token, Buffer.alloc(0)); expect(capture.read().state).toBe('receiving');
    capture.stop(); expect(capture.accepts(token)).toBe(false);
  });
  it('checks IPv4, port and interface inputs before generating a shell command', async () => {
    for (const value of ['localhost:4317', '192.0.2.16:0', '192.0.2.16:65536', '999.0.2.1:4317', '192.0.2.1:4317;whoami']) expect(() => captureDestination(value)).toThrow();
    const capture = createTrafficCapture({ platform: 'darwin', findTool: async () => '/usr/sbin/tcpdump', findInterface: async () => 'en0;whoami' }); cleanup.push(() => capture.dispose());
    await expect(capture.prepare('192.0.2.16:4317', 4329)).rejects.toThrow('interface');
  });
  it('keeps the compatibility helper alive beyond ten minutes until its input ends', async () => {
    vi.useFakeTimers(); const input = new PassThrough();
    const job = streamCapture({ base: 'http://127.0.0.1:4329', token: 'a'.repeat(64), input, report: () => {}, send: async () => ({ ok: true }) });
    await vi.advanceTimersByTimeAsync(660000); expect(input.destroyed).toBe(false);
    input.end(); await job;
  });
  it('streams only to loopback and follows no redirects', async () => {
    const calls: any[] = [];
    await streamCapture({ base: 'http://127.0.0.1:4329', token: 'a'.repeat(64), input: Readable.from([Buffer.from('test')]), report: () => {}, send: async (...args: any[]) => { calls.push(args); return { ok: true }; } });
    expect(calls[0][0].hostname).toBe('127.0.0.1'); expect(calls[0][1].redirect).toBe('error');
    await expect(streamCapture({ base: 'http://192.0.2.16:4317', token: 'a'.repeat(64), input: Readable.from([]), report: () => {} })).rejects.toThrow();
  });
});
