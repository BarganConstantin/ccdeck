import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — server ES module
import { createQuotaCloses, normalizeCloses, sameReset, CLOSE_LIMITS } from "../../server/quota-closes.mjs";
// @ts-expect-error — server ES module
import { storedWindows } from "../../server/quota-close-watch.mjs";
import { endedWeeks, weekEndsLine, weekEndsTitle, READ_NEAR_RESET_MS, type QuotaClose } from "../quota-closes";

const H = 3600_000;
const START = Date.parse("2026-10-13T10:00:00Z");
const ACCOUNT = "a".repeat(64), OTHER = "b".repeat(64);
const RESET = START / 1000 + 2 * 86400; // this week's reset, two days on
const week = (pct: number, resetAt = RESET) => ({ id: "seven_day", label: "7-day window", pct, resetAt, windowSec: 604800 });
const session = (pct: number, resetAt = START / 1000 + 2.5 * 3600) => ({ id: "five_hour", label: "5-hour window", pct, resetAt, windowSec: 18000 });

function setup(load: () => Promise<unknown> = async () => null) {
  let clock = START;
  const save = vi.fn(async (_raw: unknown) => {});
  const closes = createQuotaCloses({ now: () => clock, save, load });
  // A reading is seen no earlier than it was taken.
  const see = (provider: string, account: string, windows: unknown[], t: number, extra?: unknown) => {
    clock = Math.max(clock, t);
    return closes.observe(provider, account, windows, t, extra);
  };
  return { closes, save, see, at: (t: number) => { clock = t; } };
}

describe("how full each quota window was at its reset", () => {
  it("closes a window with its last reading once its reset passes, keeping the peak", async () => {
    const { closes, save, see, at } = setup();
    await see("claude", ACCOUNT, [week(40), session(10)], START);
    await see("claude", ACCOUNT, [week(70)], START + H);
    await see("claude", ACCOUNT, [week(65)], START + 2 * H); // a saved reset can lower it
    expect((await closes.report("claude", ACCOUNT)).closed).toEqual([]);
    at(START + 3 * H);
    const report = await closes.report("claude", ACCOUNT);
    expect(report.closed).toEqual([expect.objectContaining({ id: "five_hour", pct: 10, peak: 10, n: 1, ended: "reset" })]);
    at(RESET * 1000 + 1);
    await closes.sweep();
    expect((await closes.report("claude", ACCOUNT)).closed.find((c: QuotaClose) => c.id === "seven_day"))
      .toMatchObject({ pct: 65, peak: 70, t: START + 2 * H, first: START, n: 3, ended: "reset" });
    expect((await closes.report("claude", OTHER)).closed).toEqual([]);
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ v: 1, open: [], closed: expect.any(Array) });
  });

  it("counts an older reading from the other source toward the peak and the first sight, never as the last", async () => {
    const { closes, see } = setup();
    await see("claude", ACCOUNT, [week(50)], START + H);
    await see("claude", ACCOUNT, [week(55)], START);
    expect((await closes.report("claude", ACCOUNT)).open[0]).toMatchObject({ pct: 50, peak: 55, first: START, t: START + H });
  });

  it("takes a reset printed to the hour for the same window, and a newer window before the reset as an early end", async () => {
    const { closes, see } = setup();
    expect(sameReset(604800, RESET, RESET + 3000)).toBe(true);
    expect(sameReset(18000, 1000, 1000 + 18000)).toBe(false);
    await see("claude", ACCOUNT, [week(30)], START);
    await see("claude", ACCOUNT, [week(35, RESET + 3000)], START + H);
    expect((await closes.report("claude", ACCOUNT)).open).toHaveLength(1);
    // The counters were flushed: a new week began before this one's reset.
    await see("claude", ACCOUNT, [week(2, START / 1000 + 7 * 86400)], START + 2 * H);
    const report = await closes.report("claude", ACCOUNT);
    expect(report.closed).toEqual([expect.objectContaining({ pct: 35, ended: "early" })]);
    expect(report.open).toEqual([expect.objectContaining({ pct: 2 })]);
    // A late reading of the week that ended is not a new one.
    await see("claude", ACCOUNT, [week(36, RESET)], START + H + 1);
    expect((await closes.report("claude", ACCOUNT)).open).toHaveLength(1);
  });

  it("improves a close with a later reading that arrives after the reset, and opens no window for it", async () => {
    const { closes, see, at } = setup();
    await see("claude", ACCOUNT, [week(50)], RESET * 1000 - 3 * H);
    at(RESET * 1000 + 5 * 60_000);
    // claude-swap collected ten minutes before the reset; the timer reads it after.
    await see("claude", ACCOUNT, [week(58)], RESET * 1000 - 10 * 60_000);
    await see("claude", ACCOUNT, [week(40)], RESET * 1000 - 4 * H);
    const report = await closes.report("claude", ACCOUNT);
    expect(report.open).toEqual([]);
    expect(report.closed).toEqual([expect.objectContaining({ pct: 58, peak: 58, t: RESET * 1000 - 10 * 60_000, n: 2, ended: "reset" })]);
  });

  it("an account idle across its reset closes with the reading taken before it", async () => {
    const { closes, see, at } = setup();
    at(RESET * 1000 + H);
    await see("claude", ACCOUNT, [week(20)], RESET * 1000 - 30 * H);
    expect((await closes.report("claude", ACCOUNT)).closed).toEqual([expect.objectContaining({ pct: 20, ended: "reset" })]);
  });

  it("skips readings outside their window, from the future, or not a window at all", async () => {
    // The clock stays at START, so a reading two minutes on is from the future.
    const { closes, save } = setup();
    for (const [windows, t] of [[[week(10)], RESET * 1000], [[week(10)], START - 8 * 86400_000], [[week(10)], START + 2 * 60_000],
      [[{ ...week(10), windowSec: 0 }], START], [[week(NaN)], START], [[week(-1)], START], [[{ ...week(10), id: 7 }], START]] as const) {
      await closes.observe("claude", ACCOUNT, windows, t);
    }
    await closes.observe("claude", "not-a-key", [week(10)], START);
    await closes.observe("gemini", ACCOUNT, [week(10)], START);
    expect(save).not.toHaveBeenCalled();
    await closes.observe("codex", ACCOUNT, [{ ...week(130), id: "weekly" }], START);
    expect((await closes.report("codex", ACCOUNT)).open[0]).toMatchObject({ pct: 100, peak: 100 }); // over quota reads as full
  });

  it("hands each weekly window out once for a fresh reading before its reset, and never a session", async () => {
    const { closes, see, at } = setup();
    await see("claude", ACCOUNT, [week(40), session(10, RESET - 1800)], RESET * 1000 - 3 * H);
    await see("claude", OTHER, [week(40)], RESET * 1000 - 20 * 60_000);
    at(RESET * 1000 - 30 * 60_000);
    expect(await closes.closingReads()).toEqual([{ provider: "claude", account: ACCOUNT, id: "seven_day", resetAt: RESET }]);
    expect(await closes.closingReads()).toEqual([]);
    at(RESET * 1000 + 1);
    // Asked once is not part of what is kept.
    expect((await closes.report("claude", ACCOUNT)).closed[0]).not.toHaveProperty("asked");
  });

  it("writes the plan onto the account's open windows and keeps it on the close", async () => {
    const { closes, see, at } = setup();
    await see("claude", ACCOUNT, [week(40)], START);
    await closes.plan("claude", ACCOUNT, "max-20x");
    await see("codex", OTHER, [{ ...week(10), id: "weekly" }], START, { plan: "plus" });
    at(RESET * 1000 + 1);
    expect((await closes.report("claude", ACCOUNT)).closed[0]).toMatchObject({ plan: "max-20x" });
    expect((await closes.report("codex", OTHER)).closed[0]).toMatchObject({ plan: "plus" });
  });

  it("loads what it can trust and ages out the rest", async () => {
    const good = { provider: "claude", account: ACCOUNT, ...week(60), peak: 60, t: START - H, first: START - 2 * H, n: 2 };
    const old = { ...good, resetAt: START / 1000 - (CLOSE_LIMITS.days + 1) * 86400, ended: "reset" };
    const state = normalizeCloses({ v: 1, open: [good, { ...good, account: "x" }, { ...good, t: START + H }],
      closed: [{ ...good, resetAt: START / 1000 - 86400, ended: "reset" }, old, { ...good, ended: "maybe" }] }, START);
    expect(state.open).toHaveLength(1);
    expect(state.closed).toEqual([expect.objectContaining({ pct: 60, ended: "reset" })]);
    expect(normalizeCloses({ v: 2, open: [good] }, START)).toEqual({ open: [], closed: [] });
    const { closes } = setup(async () => ({ v: 1, open: [good], closed: [] }));
    expect((await closes.report("claude", ACCOUNT)).open).toEqual([expect.objectContaining({ pct: 60 })]);
  });
});

describe("claude-swap's store rows as windows", () => {
  const iso = (s: number) => new Date(s * 1000).toISOString();
  it("reads both windows like the published reading, and drops a session lane copied from the week", () => {
    expect(storedWindows({ five_hour: { pct: 12.5, resets_at: iso(START / 1000 + 3600) }, seven_day: { pct: 40, resets_at: iso(RESET) } })).toEqual([
      { id: "five_hour", label: "5-hour window", pct: 12.5, resetAt: START / 1000 + 3600, windowSec: 18000 },
      { id: "seven_day", label: "7-day window", pct: 40, resetAt: RESET, windowSec: 604800 },
    ]);
    expect(storedWindows({ five_hour: { pct: 40, resets_at: iso(RESET) }, seven_day: { pct: 40, resets_at: iso(RESET) } }).map((w: { id: string }) => w.id)).toEqual(["seven_day"]);
    expect(storedWindows({ five_hour: { pct: 140, resets_at: iso(RESET) }, seven_day: { pct: 5 } })).toEqual([expect.objectContaining({ pct: 100 })]);
    expect(storedWindows(null)).toEqual([]);
  });
});

describe("the line under the 7-day bar", () => {
  const close = (resetAt: number, pct: number, extra: Partial<QuotaClose> = {}): QuotaClose => ({
    id: "seven_day", label: "7-day window", windowSec: 604800, resetAt, pct, peak: pct, t: resetAt * 1000 - H, first: 0, n: 3, ended: "reset", ...extra });
  const weeks = [1, 2, 3, 4, 5].map(i => close(RESET - i * 604800, 50 + i * 5));

  it("averages the last four weeks read near their reset, newest first", () => {
    const counted = endedWeeks([...weeks, close(RESET, 99, { ended: "early" }), close(RESET + 1, 99, { t: (RESET + 1) * 1000 - READ_NEAR_RESET_MS - 1 }),
      close(RESET + 2, 99, { id: "five_hour", windowSec: 18000 }), close(RESET + 3, 99, { id: "opus-weekly" })]);
    expect(counted.map(c => c.pct)).toEqual([55, 60, 65, 70]);
    expect(weekEndsLine(counted)).toBe("Last 4 weeks ended 63% used, 37% unused");
    expect(weekEndsLine([close(RESET, 70)])).toBe("Last week ended 70% used, 30% unused");
    expect(weekEndsLine([])).toBeNull();
    expect(endedWeeks([close(RESET, 80, { id: "weekly" })])).toHaveLength(1); // Codex names its week so
  });

  it("says each week and how near its reset it was read, in the title", () => {
    const title = weekEndsTitle([close(RESET, 70, { t: RESET * 1000 - 20 * 60_000 }), close(RESET - 604800, 40, { t: (RESET - 604800) * 1000 - 3 * H })]);
    expect(title).toMatch(/70% used, read 20 min before the reset/);
    expect(title).toMatch(/40% used, read 3 h before the reset/);
  });
});
