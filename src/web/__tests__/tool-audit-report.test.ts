import { describe, expect, it } from 'vitest';
import { callTime, failureShare, findHighlights, percent, sortTools, summaryParts, toolSortValue } from '../tool-audit-report';
import type { AuditRow } from '../tool-audit';

const row = (operation: string, extra: Partial<AuditRow> = {}): AuditRow => ({
  operation, calls: 20, completed: 20, failed: 0, errorRate: 0, measured: 20,
  missingTiming: 0, unmatched: 0, shared: 0, providers: { claude: 20, codex: 0 }, tools: ['Bash'],
  totalMs: 2000, medianMs: 100, p95Ms: 120, maxMs: 200, ...extra,
});

describe('the tool list', () => {
  const rows = [row('Read', { calls: 250, totalMs: 10000 }), row('npm test', { calls: 30, totalMs: 1500000, medianMs: 50000, failed: 6, completed: 30 }), row('untimed', { calls: 40, totalMs: null, medianMs: null, measured: 0 }), row('zero', { calls: 5, totalMs: 0, medianMs: 0 })];
  it('puts what was never timed last, below a measured zero', () => {
    expect(sortTools(rows, 'time').map(r => r.operation)).toEqual(['npm test', 'Read', 'zero', 'untimed']);
    expect(sortTools(rows, 'slowest').at(-1)!.operation).toBe('untimed');
    expect(toolSortValue(rows[2], 'time')).toBeNull();
  });
  it('breaks ties by use, then by name, so the order never jumps', () => {
    expect(sortTools([row('b', { failed: 0 }), row('a', { failed: 0, calls: 20 }), row('c', { calls: 50 })], 'failed').map(r => r.operation)).toEqual(['c', 'a', 'b']);
  });
  it('finds a tool by what it does as well as by its name, without touching the source', () => {
    const before = JSON.stringify(rows);
    expect(sortTools(rows, 'calls', 'tests').map(r => r.operation)).toEqual(['npm test']);
    expect(sortTools(rows, 'calls', ' READ ').map(r => r.operation)).toEqual(['Read']);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('worth a look', () => {
  it('names the tool that takes the most time, the one that fails often and the slowest other one', () => {
    const rows = [
      row('npm test', { calls: 33, measured: 33, totalMs: 1700000, medianMs: 56000, maxMs: 96000, failed: 7, completed: 33 }),
      row('Agent', { calls: 13, measured: 13, totalMs: 1600000, medianMs: 126000, maxMs: 204000 }),
      row('Read', { calls: 258, totalMs: 12000, failed: 1, completed: 258 }),
    ];
    const found = findHighlights(rows, 4000000);
    expect(found.map(h => [h.kind, h.operation])).toEqual([['time', 'npm test'], ['failing', 'npm test'], ['slow', 'Agent']]);
    expect(found[0].detail).toBe('28.3 min over 33 calls, 43% of all tool time.');
    expect(found[1].detail).toBe('7 of 33 calls failed (21%).');
    expect(found[2].detail).toBe('Usually 2.1 min per call; the longest took 3.4 min.');
  });
  it('says nothing rather than making a story out of a handful of calls', () => {
    expect(findHighlights([row('once', { calls: 2, completed: 2, failed: 2, measured: 1, totalMs: 90000, medianMs: 90000 })], 90000)).toEqual([]);
    expect(findHighlights([row('flaky', { completed: 40, failed: 2 })], 40000)).toEqual([]);
    expect(findHighlights([], null)).toEqual([]);
  });
  it('does not call one tool the biggest time sink when time is spread out', () => {
    const even = Array.from({ length: 10 }, (_, i) => row(`op${i}`, { totalMs: 1000 }));
    expect(findHighlights(even, 10000).some(h => h.kind === 'time')).toBe(false);
  });
});

describe('plain numbers', () => {
  it('writes the summary for the chosen agents and period', () => {
    expect(summaryParts({ total: 1508, totalMs: 4140000, failed: 49, completed: 1506 }, 'all', '7')).toEqual({
      lead: 'In the last 7 days, your agents made', calls: '1,508 tool calls', time: '1 h 9 min', failed: 49, failedShare: '3%',
    });
    expect(summaryParts({ total: 1, totalMs: null, failed: 0, completed: 0 }, 'codex', '1')).toMatchObject({ lead: 'In the last 24 hours, Codex made', calls: '1 tool call', time: null, failedShare: null });
  });
  it('shows a failure share only for calls that finished, and never rounds a failure to 0%', () => {
    expect(failureShare({ failed: 0, completed: 10 })).toBeNull();
    expect(failureShare({ failed: 1, completed: 0 })).toBeNull();
    expect(failureShare({ failed: 1, completed: 258 })).toBe('<1%');
    expect(percent(7, 33)).toBe('21%');
  });
  it('dates a call relative to today', () => {
    const now = new Date(2026, 9, 15, 12, 0).getTime();
    expect(callTime(new Date(2026, 9, 15, 9, 5).getTime(), now)).toMatch(/^Today /);
    expect(callTime(new Date(2026, 9, 14, 23, 59).getTime(), now)).toMatch(/^Yesterday /);
    expect(callTime(new Date(2026, 9, 12, 8, 0).getTime(), now)).toMatch(/12, /);
  });
});
