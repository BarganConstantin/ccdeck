import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — server ES module
import { createQuotaHistory, historyAccount, normalizeHistory, HISTORY_LIMITS } from "../../server/quota-history.mjs";
import { captureAge, quotaPlot } from "../quota-history";
const now = Date.parse("2026-10-13T10:00:00Z");
const identity = { email: "owner@example.com", organizationUuid: "org-a" };
const reading = (t = now, pct = 25, resetAt = now / 1000 + 3600) => ({ ok: true, fetchedAt: t,
  session5hPct: pct, session5hResetAt: resetAt, session5hWindowSec: 18000 });
function setup(options = {}) {
  const save = vi.fn(async () => {});
  const history = createQuotaHistory({ now: () => now, save, ...options });
  const account = history.activate("claude", identity);
  return { history, account, save };
}

describe("observed quota history", () => {
  it("stores opaque account identities and never exposes another account's readings", async () => {
    const { history, account, save } = setup();
    await history.record("claude", account, reading());
    expect(JSON.stringify(save.mock.calls)).not.toContain(identity.email);
    expect(historyAccount("claude", { ...identity, email: " OWNER@EXAMPLE.COM " })).toBe(account);
    const second = history.activate("claude", { ...identity, organizationUuid: "org-b" });
    expect((await history.report("claude", account)).series).toEqual([]);
    expect((await history.report("claude", second)).series).toEqual([]);
    await history.record("claude", second, reading(now, 10));
    expect((await history.report("claude", second)).series[0].points).toEqual([{ t: now, pct: 10 }]);
    history.activate("claude", identity);
    expect((await history.report("claude", account)).series[0].points).toEqual([{ t: now, pct: 25 }]);
    expect(history.activate("claude", null)).toBeNull();
    expect((await history.report("claude", account)).series).toEqual([]);
  });
  it("deduplicates concurrent reads and skips failed, stale, invalid and older observations", async () => {
    const { history, account, save } = setup();
    await Promise.all([history.record("claude", account, reading()), history.record("claude", account, reading())]);
    for (const bad of [{ ...reading(), stale: true }, { ...reading(), ok: false }, reading(now - 1),
      reading(now + 120000), reading(now, NaN), reading(now, -1), reading(now, 101),
      { ...reading(), session5hWindowSec: 0 }, reading(now, 25, now / 1000)]) {
      await history.record("claude", account, bad);
    }
    expect(save).toHaveBeenCalledTimes(1);
    expect((await history.report("claude", account)).series[0].points).toHaveLength(1);
  });
  it("keeps resets separate while tolerating reset timestamp jitter", async () => {
    const { history, account } = setup();
    await history.record("claude", account, reading(now - 120000));
    await history.record("claude", account, reading(now - 60000, 30, now / 1000 + 3610));
    await history.record("claude", account, reading(now, 0, now / 1000 + 7200));
    const report = await history.report("claude", account);
    expect(report.series).toHaveLength(2);
    expect(report.series.map((s: any) => s.points.length).sort()).toEqual([1, 2]);
    expect(report.series.find((s: any) => s.points.length === 1).points[0].pct).toBe(0);
  });
  it("records Codex extra windows without mixing providers", async () => {
    const { history, account } = setup();
    const codex = history.activate("codex", { accountId: "workspace-1" });
    const w = { id: "primary", label: "5 hours", pct: 42, resetAt: now / 1000 + 3600, windowSec: 18000 };
    await history.record("codex", codex, { ok: true, fetchedAt: now, windows: [w], extraWindows: [{ ...w, id: "review" }] });
    expect((await history.report("codex", codex)).series).toHaveLength(2);
    expect((await history.report("claude", account)).series).toEqual([]);
  });
  it("loads once, rejects corrupt observations and retains only bounded recent data", async () => {
    const account = historyAccount("claude", identity);
    const row = { provider: "claude", account, id: "five_hour", label: "5-hour", resetAt: now / 1000 + 3600, windowSec: 18000,
      points: [{ t: now, pct: 25 }, { t: now, pct: 30 }, { t: now + 120000, pct: 40 }, { t: now - 40 * 86400000, pct: 20 }] };
    expect(normalizeHistory({ v: 1, series: [row, { ...row, account: "email" }] }, now)).toHaveLength(1);
    const load = vi.fn(async () => ({ v: 1, series: [row] }));
    const { history } = setup({ load });
    const reports = await Promise.all([history.report("claude", account), history.report("claude", account)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(reports[0].series[0].points).toEqual([{ t: now, pct: 25 }]);
    reports[0].series[0].points[0].pct = 99;
    expect((await history.report("claude", account)).series[0].points[0].pct).toBe(25);
    const rows = Array.from({ length: HISTORY_LIMITS.series + 4 }, (_, i) => ({ ...row, id: String(i) }));
    expect(normalizeHistory({ v: 1, series: rows }, now)).toHaveLength(HISTORY_LIMITS.series);
    expect(normalizeHistory({ v: 2, series: rows }, now)).toEqual([]);
  });
  it("keeps quota history usable in memory when disk fails", async () => {
    const { history, account } = setup({ load: async () => { throw Error("corrupt"); }, save: async () => { throw Error("read only"); } });
    await history.record("claude", account, reading());
    expect(await history.report("claude", account)).toMatchObject({ ok: true, storageOk: false, series: [{ points: [{ t: now, pct: 25 }] }] });
  });
  it("bounds observation count and age even for a valid long window", () => {
    const account = historyAccount("claude", identity);
    const points = Array.from({ length: HISTORY_LIMITS.points + 10 }, (_, i) => ({ t: now - (HISTORY_LIMITS.points + 10 - i) * 1000, pct: 10 }));
    const row = { provider: "claude", account, id: "long", label: "Long window", resetAt: now / 1000 + 3600, windowSec: 40 * 86400,
      points: [{ t: now - 36 * 86400000, pct: 5 }, ...points] };
    expect(normalizeHistory({ v: 1, series: [row] }, now)[0].points).toHaveLength(HISTORY_LIMITS.points);
    expect(normalizeHistory({ v: 1, series: [{ ...row, points: [{ t: now - 36 * 86400000, pct: 5 }] }] }, now)).toEqual([]);
    const rows = Array.from({ length: 12 }, (_, i) => ({ ...row, id: String(i), points }));
    const total = normalizeHistory({ v: 1, series: rows }, now).reduce((n: number, s: any) => n + s.points.length, 0);
    expect(total).toBeLessThanOrEqual(HISTORY_LIMITS.totalPoints);
    expect(historyAccount("claude", { email: 10, organizationUuid: "org" })).toBeNull();
    expect(historyAccount("codex", { email: false })).toBeNull();
  });
});

describe("remaining quota plot", () => {
  it("inverts used quota, breaks collection gaps and stops at the last observation", () => {
    const s = { id: "primary", label: "5-hour", resetAt: now / 1000 + 3600, windowSec: 18000,
      points: [{ t: now - 1200000, pct: 0 }, { t: now - 1140000, pct: 10 }, { t: now, pct: 100 }] };
    const segments = quotaPlot(s);
    expect(segments.map(p => p.length)).toEqual([2, 1]);
    expect(segments[0][0].y).toBe(12);
    expect(segments[1][0].y).toBe(162);
    expect(segments.at(-1)!.at(-1)!.x).toBeLessThan(552);
    expect(captureAge(now - 120000, now)).toBe("2m ago");
    expect(captureAge(now, now)).toBe("just now");
  });
});
