import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
// @ts-expect-error server module
import { buildToolAuditReport } from '../../server/tool-audit-report.mjs';
// @ts-expect-error server module
import { auditQuery } from '../../server/tool-audit-routes.mjs';
import type { AuditDay } from '../tool-audit';
const DAY = 86400000, now = Date.parse('2026-10-14T12:00:00Z');
type Spec = { t: number; ms: number | null; provider?: string; operations?: string[]; endClock?: string };
async function report(specs: Spec[], extra = {}, startedAt = now - 20 * DAY) {
  const records = specs.flatMap((spec, i) => {
    const base = { id: i.toString(16).padStart(64, '0'), provider: spec.provider ?? 'codex', clock: 'rollout' };
    return [{ ...base, kind: 'start', t: spec.t, at: spec.t, tool: 'exec', operations: spec.operations ?? ['rg'] },
      { ...base, kind: 'end', clock: spec.endClock ?? base.clock, t: spec.t + (spec.ms ?? 1), at: spec.ms === null ? null : spec.t + spec.ms, failed: false }];
  });
  const text = records.map(record => JSON.stringify(record)).join('\n');
  return buildToolAuditReport({ files: [{ path: 'fixture', size: Buffer.byteLength(text) }], query: { days: 7, provider: 'all', operation: 'rg', history: true, timeZone: 'UTC', ...extra }, now, meta: { startedAt, retentionDays: 90 } }, { createReadStream: () => Readable.from([text]), createInterface });
}
describe('daily observed interval aggregation', () => {
  it('calculates mean, median and maximum from valid timings, excluding unknowns', async () => {
    const r = await report([0,100,100,1000,null].map(ms => ({ t: now - DAY, ms })));
    const day = r.details.history.days.find((day: AuditDay) => day.calls);
    expect(day).toMatchObject({ calls: 5, measured: 4, averageMs: 300, medianMs: 100, maxMs: 1000, p95Ms: null, status: 'measured' });
    expect(r.rows[0].averageMs).toBe(300);
    expect(r.details.measurements).toEqual(r.rows[0]);
    expect(r.details.capturedAt).toBe(now);
    expect(r.details.recent).toHaveLength(5);
  });
  it('applies P95 eligibility separately for each day', async () => {
    const r = await report([...Array.from({ length:20 },(_,i)=>({ t: now - DAY, ms:i })), { t: now - 2*DAY, ms:9999 }]);
    const days = r.details.history.days.filter((day: AuditDay)=>day.calls);
    expect(days[0].p95Ms).toBeNull();
    expect(days[1]).toMatchObject({ averageMs:9.5, medianMs:9.5, p95Ms:18, maxMs:19, measured:20 });
  });
  it('distinguishes retained-history gaps, no calls, missing timings and measured zero', async () => {
    const r = await report([{ t:now-2*DAY, ms:null }, { t:now-DAY, ms:0 }], {}, now-3*DAY);
    const days = r.details.history.days;
    expect(days.find((day: AuditDay)=>day.date==='2026-10-07')).toMatchObject({status:'outside-history',averageMs:null,calls:0});
    expect(days.find((day: AuditDay)=>day.date==='2026-10-11')).toMatchObject({status:'no-calls',averageMs:null,partial:true});
    expect(days.find((day: AuditDay)=>day.date==='2026-10-12')).toMatchObject({status:'missing-timing',averageMs:null,calls:1,measured:0});
    expect(days.find((day: AuditDay)=>day.date==='2026-10-13')).toMatchObject({status:'measured',averageMs:0,medianMs:0,maxMs:0});
  });
  it.each([7,30,60,90])('bounds and orders a %i-day rolling range', async days => {
    const r = await report([], { days });
    const series = r.details.history.days;
    expect(series).toHaveLength(days+1); // Partial first and final calendar days.
    expect(series[0].date < series.at(-1).date).toBe(true);
    expect(series.at(-1).partial).toBe(true);
    expect(series.every((day: AuditDay)=>day.averageMs===null)).toBe(true);
  });
  it('assigns a midnight-spanning call once to its observed start day', async () => {
    const t = Date.parse('2026-10-12T23:59:00Z');
    const r = await report([{ t, ms:120000 }]);
    expect(r.details.history.days.find((day: AuditDay)=>day.date==='2026-10-12')).toMatchObject({calls:1,averageMs:120000});
    expect(r.details.history.days.find((day: AuditDay)=>day.date==='2026-10-13').calls).toBe(0);
  });
  it.each([
    ['2026-03-08', ['2026-03-08T06:30:00Z','2026-03-08T07:30:00Z']],
    ['2026-11-01', ['2026-11-01T05:30:00Z','2026-11-01T06:30:00Z']],
  ])('buckets DST transitions on %s by IANA local calendar date', async (date,times) => {
    const r = await report(times.map(t=>({t:Date.parse(t),ms:100})), { since:Date.parse(date+'T00:00:00Z'),until:Date.parse(date+'T23:59:59Z'),timeZone:'America/New_York' }, Date.parse(date+'T00:00:00Z')-DAY);
    expect(r.details.history.days.find((day: AuditDay)=>day.date===date)).toMatchObject({calls:2,averageMs:100});
    expect(r.total).toBe(2);
  });
  it('filters provider and exact operation before daily aggregation; preserves shared memberships', async () => {
    const specs = [{t:now-DAY,ms:100,operations:['rg','cat']},{t:now-DAY,ms:900,provider:'claude'}];
    const r = await report(specs, {provider:'codex'});
    expect(r.details.history.days.find((day: AuditDay)=>day.calls)).toMatchObject({calls:1,averageMs:100,shared:1,providers:{claude:0,codex:1}});
    expect(r.rows.reduce((sum:number,row:{calls:number})=>sum+row.calls,0)).toBe(2);
    const cat = await report(specs, {operation:'cat'});
    expect(cat.details.history.days.find((day: AuditDay)=>day.calls).averageMs).toBe(100);
  });
  it('uses all journal calls beyond truncated evidence lists', async () => {
    const r = await report(Array.from({length:10000},(_,i)=>({t:now-DAY,ms:i})));
    expect(r.details.recent).toHaveLength(30); expect(r.details.slowest).toHaveLength(20);
    expect(r.details.history.days.find((day: AuditDay)=>day.calls)).toMatchObject({calls:10000,averageMs:4999.5,medianMs:4999.5,maxMs:9999,p95Ms:9499});
  });
  it('reuses clock, negative-duration and seven-day timing validation', async () => {
    const r = await report([{t:now-DAY,ms:8*DAY},{t:now-DAY,ms:-10},{t:now-DAY,ms:100,endClock:'hook'},{t:now-DAY,ms:200}]);
    expect(r.details.history.days.find((day: AuditDay)=>day.calls)).toMatchObject({calls:4,measured:1,averageMs:200,maxMs:200});
  });
  it('does not label a complete requested UTC calendar day as partial', async () => {
    const r = await report([{t:now-2*DAY,ms:200}], {since:Date.parse('2026-10-12T00:00:00Z'),until:Date.parse('2026-10-12T23:59:59.999Z')}, Date.parse('2026-10-01T00:00:00Z'));
    expect(r.details.history.days).toHaveLength(1);
    expect(r.details.history.days[0]).toMatchObject({partial:false,calls:1,averageMs:200});
  });
  it('keeps legacy replies unchanged except additive average; history is opt-in', async () => {
    const r = await report([{t:now,ms:500}], {history:false});
    expect(r.details.history).toBeUndefined(); expect(r.rows[0].averageMs).toBe(500);
  });
  it('validates timezones and bounded history requests at the API boundary', () => {
    for(const q of ['history=1','operation=rg&history=2','operation=rg&history=1&timeZone=Unknown/Zone','days=91&operation=rg&history=1'])expect(auditQuery(new URLSearchParams(q))).toBeNull();
    expect(auditQuery(new URLSearchParams('operation=rg&history=1&timeZone=Europe/Chisinau'))).toMatchObject({history:true,timeZone:'Europe/Chisinau'});
  });
});
