import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ES module
import { readCodexAuto, applyCodexAuto, codexAutoTick, startCodexAutoLoop } from "../../server/codex-auto.mjs";

const id = (c: string) => c.repeat(20);
const A = id("a"), B = id("b"), C = id("c"), D = id("d");
const NOW = 1_800_000_000_000;
const sec = NOW / 1000;
const DAY = 86400;

let store: string;
beforeEach(async () => { store = await mkdtemp(join(tmpdir(), "codex-auto-")); });
afterEach(async () => { await rm(store, { recursive: true, force: true }); });

type Row = Record<string, unknown>;
const row = (rid: string, extra: Row = {}) => ({ id: rid, active: false, available: true, signedIn: true, signedInFilePresent: true, ...extra });
const q = (usedPercent: number, extra: Row = {}) => ({ ok: true, windows: [{ usedPercent, seconds: 18000, resetAt: sec + 3600, ...extra }] });

function rig(rows: Row[], quotas: Record<string, unknown>, opts: { now?: () => number; selectError?: string } = {}) {
  const reads: string[] = [];
  const select = vi.fn(async (..._a: unknown[]) => { if (opts.selectError) throw Object.assign(new Error(opts.selectError), { code: opts.selectError }); return {}; });
  const options = {
    store,
    now: opts.now ?? (() => NOW),
    readSelection: async () => ({ profileId: A, revision: 7 }),
    discover: async () => rows,
    readQuota: async (rid: string) => { reads.push(rid); return quotas[rid] ?? { ok: false, reason: "no_token" }; },
    select,
  };
  return { options, reads, select };
}
const enable = () => applyCodexAuto({ action: "enable", enabled: true }, { store });
const roster = () => [row(A, { active: true }), row(B), row(C), row(D)];
const picked = (select: { mock: { calls: unknown[][] } }) => (select.mock.calls[0][0] as { id: string });

describe("settings", () => {
  it("defaults when the file is missing", async () => {
    expect(await readCodexAuto({ store })).toEqual({
      ok: true, enabled: false, external: false, lastTick: null,
      settings: { "autoswitch.threshold": { value: "90", isDefault: true } },
      choice: { next: "room", home: null }, heldOut: [],
    });
  });

  it("defaults when the file is corrupt", async () => {
    await writeFile(join(store, "codex-auto.json"), "{nope");
    const s = await readCodexAuto({ store });
    expect(s.enabled).toBe(false);
    expect(s.settings["autoswitch.threshold"].value).toBe("90");
  });

  it("persists every action across reads, mode 0600", async () => {
    await applyCodexAuto({ action: "enable", enabled: true }, { store });
    await applyCodexAuto({ action: "setting", key: "autoswitch.threshold", value: "85" }, { store });
    await applyCodexAuto({ action: "next", value: "weekly" }, { store });
    const r = await applyCodexAuto({ action: "account", id: B, enabled: false }, { store });
    expect(r.ok).toBe(true);
    const s = await readCodexAuto({ store });
    expect(s).toMatchObject({ enabled: true, choice: { next: "weekly" }, heldOut: [B] });
    expect(s.settings["autoswitch.threshold"]).toEqual({ value: "85", isDefault: false });
    if (process.platform !== "win32") {
      expect(((await stat(join(store, "codex-auto.json"))).mode & 0o777).toString(8)).toBe("600");
    }
    await applyCodexAuto({ action: "account", id: B, enabled: true }, { store });
    expect((await readCodexAuto({ store })).heldOut).toEqual([]);
  });

  it("refuses bad input and writes nothing", async () => {
    const bad = [
      null, {}, { action: "nope" },
      { action: "enable", enabled: "yes" },
      { action: "setting", key: "autoswitch.threshold", value: "49" },
      { action: "setting", key: "autoswitch.threshold", value: "100" },
      { action: "setting", key: "autoswitch.threshold", value: "85.5" },
      { action: "setting", key: "autoswitch.threshold", value: 85 },
      { action: "setting", key: "other", value: "85" },
      { action: "next", value: "home" },
      { action: "account", id: "xyz", enabled: false },
      { action: "account", id: B },
    ];
    for (const b of bad) expect(await applyCodexAuto(b, { store })).toEqual({ ok: false, reason: "bad_request" });
    await expect(readFile(join(store, "codex-auto.json"))).rejects.toThrow();
  });
});

describe("tick", () => {
  it("does nothing and reads nothing while off", async () => {
    const { options, reads, select } = rig(roster(), { [A]: q(99) });
    await codexAutoTick(options);
    expect(reads).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("stays put under the threshold", async () => {
    await enable();
    const { options, reads, select } = rig(roster(), { [A]: q(89), [B]: q(10) });
    await codexAutoTick(options);
    expect(reads).toEqual([A]);
    expect(select).not.toHaveBeenCalled();
    expect((await readCodexAuto({ store })).lastTick).toBeNull();
  });

  it("stays put without a reading", async () => {
    await enable();
    const { options, select } = rig(roster(), {});
    await codexAutoTick(options);
    expect(select).not.toHaveBeenCalled();
  });

  it("past the threshold moves to the account with most room", async () => {
    await enable();
    const { options, select } = rig(roster(), { [A]: q(95), [B]: q(60), [C]: q(20), [D]: q(40) });
    await codexAutoTick(options);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0]).toMatchObject({ id: C, expectedRevision: 7 });
    expect((select.mock.calls[0][0] as { operationId: string }).operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await readCodexAuto({ store })).lastTick).toEqual({ at: NOW, event: "switched", to: C, trigger: "proactive" });
  });

  it("honours a custom threshold", async () => {
    await applyCodexAuto({ action: "setting", key: "autoswitch.threshold", value: "60" }, { store });
    await enable();
    const { options, select } = rig(roster(), { [A]: q(65), [B]: q(61), [C]: q(30) });
    await codexAutoTick(options);
    expect(picked(select).id).toBe(C);
  });

  it("ignores windows that have already reset when measuring load", async () => {
    await enable();
    const stale = { ok: true, windows: [{ usedPercent: 99, seconds: 18000, resetAt: sec - 10 }, { usedPercent: 30, seconds: 18000, resetAt: null }] };
    const { options, select } = rig(roster(), { [A]: stale, [B]: q(10) });
    await codexAutoTick(options);
    expect(select).not.toHaveBeenCalled();
    const second = rig(roster(), { [A]: q(95), [B]: stale, [C]: q(50) });
    await codexAutoTick(second.options);
    expect(picked(second.select).id).toBe(B);
  });

  it("skips held-out, signed-out, same-account, unavailable and full accounts", async () => {
    await enable();
    await applyCodexAuto({ action: "account", id: B, enabled: false }, { store });
    const rows = [
      row(A, { active: true }),
      row(B),
      row(C, { signedIn: false }),
      row(D, { sameAccountAs: A }),
      row(id("e"), { available: false }),
      row(id("f"), { signedIn: undefined, signedInFilePresent: false }),
      row(id("1")),
      row(id("2"), { signedIn: undefined, signedInFilePresent: true }),
    ];
    const quotas = { [A]: q(95), [B]: q(1), [C]: q(1), [D]: q(1), [id("e")]: q(1), [id("f")]: q(1), [id("1")]: q(95), [id("2")]: q(70) };
    const { options, reads, select } = rig(rows, quotas);
    await codexAutoTick(options);
    expect(reads).toEqual([A, id("1"), id("2")]);
    expect(picked(select).id).toBe(id("2"));
  });

  it("records nowhere when no account has room", async () => {
    await enable();
    const { options, select } = rig(roster(), { [A]: q(95), [B]: q(92), [C]: { ok: false, reason: "expired" } });
    await codexAutoTick(options);
    expect(select).not.toHaveBeenCalled();
    expect((await readCodexAuto({ store })).lastTick).toEqual({ at: NOW, event: "nowhere", reason: "no_account_with_room" });
  });

  const wk = (used: number, days: number) => ({ ok: true, windows: [{ usedPercent: used, seconds: 7 * DAY, resetAt: sec + days * DAY }] });

  it("weekly takes the soonest weekly reset within 4 days", async () => {
    await applyCodexAuto({ action: "next", value: "weekly" }, { store });
    await enable();
    const { options, select } = rig(roster(), { [A]: q(95), [B]: wk(70, 3), [C]: wk(10, 6), [D]: wk(80, 1) });
    await codexAutoTick(options);
    expect(picked(select).id).toBe(D);
  });

  it("weekly falls back to most room when none resets within 4 days", async () => {
    await applyCodexAuto({ action: "next", value: "weekly" }, { store });
    await enable();
    const { options, select } = rig(roster(), { [A]: q(95), [B]: wk(70, 5), [C]: wk(10, 6) });
    await codexAutoTick(options);
    expect(picked(select).id).toBe(C);
  });

  it("leaves lastTick alone on a selection_conflict", async () => {
    await enable();
    const { options, select } = rig(roster(), { [A]: q(95), [B]: q(10) }, { selectError: "selection_conflict" });
    await codexAutoTick(options);
    expect(select).toHaveBeenCalledTimes(1);
    expect((await readCodexAuto({ store })).lastTick).toBeNull();
    // no cooldown either: the next tick looks again
    await codexAutoTick(options);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("cools down for 5 minutes after a switch", async () => {
    await enable();
    let t = NOW;
    const { options, select } = rig(roster(), { [A]: q(95), [B]: q(10) }, { now: () => t });
    await codexAutoTick(options);
    t += 4 * 60_000;
    await codexAutoTick(options);
    expect(select).toHaveBeenCalledTimes(1);
    t += 61_000;
    await codexAutoTick(options);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("never rejects when a dependency throws", async () => {
    await enable();
    const boom = async () => { throw new Error("boom"); };
    const { options } = rig(roster(), { [A]: q(95), [B]: q(10) });
    for (const key of ["readSelection", "discover", "readQuota", "select"]) {
      await expect(codexAutoTick({ ...options, [key]: boom })).resolves.toBeUndefined();
    }
  });
});

describe("loop", () => {
  it("starts once, returns the same stop, and skips overlapping ticks", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // file reads stay real
    const settle = () => new Promise(r => setTimeout(r, 50));
    try {
      await enable();
      let calls = 0;
      const options = { store, readSelection: () => { calls++; return new Promise<never>(() => {}); } };
      const stop = startCodexAutoLoop(options);
      expect(startCodexAutoLoop(options)).toBe(stop);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(calls).toBe(1);
      stop();
      const again = startCodexAutoLoop(options);
      expect(again).not.toBe(stop);
      again();
    } finally { vi.useRealTimers(); }
  });
});
