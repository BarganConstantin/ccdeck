import { describe, it, expect } from "vitest";
// @ts-expect-error Node backend module
import {
  createSnapshotStore,
  snapshotKey,
  normalizeSnapshots,
  SAMPLE_MS,
} from "../../server/account-usage-history.mjs";
import { historySegments, formatSnapshotTime } from "../account-history";
const DAY = 86400_000;
function fixture() {
  let time = Date.UTC(2026, 9, 14),
    disk: any = null;
  const prefs = { usageSnapshots: true, snapshotRetentionDays: 30 };
  const store = createSnapshotStore({
    now: () => time,
    settings: () => prefs,
    load: async () => disk,
    save: async (s: string) => {
      disk = JSON.parse(s);
    },
  });
  const account = (extra = {}) => ({
    email: "sample@example.test",
    orgUuid: "org-a",
    alias: "Work",
    fetchedAt: time,
    lanes: [
      { id: "five_hour", pct: 70, resetAt: time / 1000 + 18000 },
      { id: "seven_day", pct: 100, resetAt: time / 1000 + 604800 },
    ],
    ...extra,
  });
  return {
    store,
    prefs,
    account,
    advance: (n: number) => {
      time += n;
    },
    disk: () => disk,
    now: () => time,
  };
}
describe("account snapshots", () => {
  it("distinguishes repeated local times at the Chisinau DST boundary", () => {
    const a = formatSnapshotTime(
      Date.parse("2026-10-25T00:30:00Z"),
      "Europe/Chisinau",
    );
    const b = formatSnapshotTime(
      Date.parse("2026-10-25T01:30:00Z"),
      "Europe/Chisinau",
    );
    expect(a).not.toBe(b);
  });
  it("records reported used percentages and both reset timestamps without credentials", async () => {
    const f = fixture();
    await f.store.capture({
      ok: true,
      accounts: [f.account({ token: "secret" })],
    });
    const r = await f.store.report();
    expect(r.accounts[0].points[0].seven_day.pct).toBe(100);
    expect(JSON.stringify(f.disk())).not.toContain("secret");
    expect(r.bytes).toBe(Buffer.byteLength(JSON.stringify(f.disk())));
  });
  it("keeps organizations separate and is independent of slots and aliases", () => {
    expect(snapshotKey("sample@example.test", "a")).not.toBe(
      snapshotKey("sample@example.test", "b"),
    );
    expect(snapshotKey("", "a")).toBeNull();
  });
  it("deduplicates repeated and older observations", async () => {
    const f = fixture();
    const a = f.account();
    await f.store.capture({ ok: true, accounts: [a] });
    f.advance(1000);
    await f.store.capture({ ok: true, accounts: [a] });
    expect((await f.store.report()).accounts[0].points).toHaveLength(1);
  });
  it("samples at fifteen-minute buckets and preserves reset-cycle changes within a bucket", async () => {
    const f = fixture();
    await f.store.capture({ ok: true, accounts: [f.account()] });
    f.advance(1000);
    await f.store.capture({ ok: true, accounts: [f.account()] });
    expect((await f.store.report()).accounts[0].points).toHaveLength(2);
  });
  it("coalesces new observations in the same cycle and bucket", async () => {
    const f = fixture();
    const a = f.account();
    await f.store.capture({ ok: true, accounts: [a] });
    f.advance(1000);
    await f.store.capture({
      ok: true,
      accounts: [{ ...a, fetchedAt: f.now() }],
    });
    expect((await f.store.report()).accounts[0].points).toHaveLength(1);
    expect((await f.store.report()).accounts[0].points[0].t).toBe(f.now());
  });
  it.each([
    { stale: true },
    { staleCopy: true },
    { stopped: true },
    { error: "login expired" },
    { fetchedAt: null },
  ])("does not record unavailable readings %j", async (extra) => {
    const f = fixture();
    await f.store.capture({ ok: true, accounts: [f.account(extra)] });
    expect((await f.store.report()).accounts).toHaveLength(0);
  });
  it("does not make stale data current", async () => {
    const f = fixture();
    const a = f.account();
    f.advance(SAMPLE_MS + 1);
    await f.store.capture({ ok: true, accounts: [a] });
    expect((await f.store.report()).accounts).toHaveLength(0);
  });
  it("preserves unknown and missing windows rather than zero", async () => {
    const f = fixture();
    await f.store.capture({
      ok: true,
      accounts: [
        f.account({ lanes: [{ id: "five_hour", pct: 0, resetAt: null }] }),
      ],
    });
    const p = (await f.store.report()).accounts[0].points[0];
    expect(p.five_hour).toEqual({ pct: 0, resetAt: null });
    expect(p.seven_day).toBeNull();
  });
  it("does not fabricate renewal after a reset timestamp passes", async () => {
    const f = fixture();
    await f.store.capture({ ok: true, accounts: [f.account()] });
    f.advance(DAY);
    await f.store.capture({ ok: false });
    expect((await f.store.report()).accounts[0].points[0].seven_day.pct).toBe(
      100,
    );
  });
  it("retains removed accounts until retention expires even while recording is paused", async () => {
    const f = fixture();
    await f.store.capture({ ok: true, accounts: [f.account()] });
    f.prefs.usageSnapshots = false;
    await f.store.capture({ ok: true, accounts: [] });
    expect((await f.store.report()).accounts).toHaveLength(1);
    f.advance(31 * DAY);
    expect((await f.store.report()).accounts).toHaveLength(0);
    expect(f.disk().accounts).toHaveLength(0);
  });
  it("reduces retention without affecting live account data", async () => {
    const f = fixture();
    f.prefs.snapshotRetentionDays = 90;
    const a = f.account();
    await f.store.capture({ ok: true, accounts: [a] });
    f.advance(40 * DAY);
    expect((await f.store.report()).accounts).toHaveLength(1);
    f.prefs.snapshotRetentionDays = 30;
    expect((await f.store.report()).accounts).toHaveLength(0);
    expect(a.lanes[1].pct).toBe(100);
  });
  it("clear serializes with captures and does not recapture pre-clear readings after restart", async () => {
    const f = fixture();
    const a = f.account();
    await f.store.capture({ ok: true, accounts: [a] });
    await f.store.clear();
    const restored = createSnapshotStore({
      now: f.now,
      settings: () => f.prefs,
      load: async () => f.disk(),
      save: async () => {},
    });
    await restored.capture({ ok: true, accounts: [a] });
    expect((await restored.report()).accounts).toHaveLength(0);
  });
  it("preserves prior capture state when storage fails and recovers on a later save", async () => {
    const f = fixture();
    let fails = false;
    let disk: any = null;
    const store = createSnapshotStore({
      now: f.now,
      settings: () => f.prefs,
      load: async () => disk,
      save: async (s: string) => {
        if (fails) throw new Error("disk full");
        disk = JSON.parse(s);
      },
    });
    const a = f.account();
    await store.capture({ ok: true, accounts: [a] });
    fails = true;
    f.advance(SAMPLE_MS);
    await expect(
      store.capture({ ok: true, accounts: [f.account()] }),
    ).rejects.toThrow("disk full");
    expect((await store.report()).accounts[0].points).toHaveLength(1);
    expect((await store.report()).storageError).toBeTruthy();
    fails = false;
    await store.capture({ ok: true, accounts: [f.account()] });
    expect((await store.report()).accounts[0].points).toHaveLength(2);
    expect((await store.report()).storageError).toBeNull();
  });
  it("does not overwrite corrupt history", async () => {
    let saves = 0;
    const store = createSnapshotStore({
      now: () => Date.now(),
      settings: () => ({ snapshotRetentionDays: 30 }),
      load: async () => ({ v: 99, accounts: [] }),
      save: async () => {
        saves++;
      },
    });
    await expect(store.report()).rejects.toThrow();
    expect(saves).toBe(0);
  });
  it("rejects nonfinite and out-of-range values at persisted boundary", () => {
    const f = fixture();
    expect(
      normalizeSnapshots(
        {
          v: 1,
          accounts: [
            {
              id: snapshotKey("a", "b"),
              name: "a",
              points: [
                {
                  t: f.now(),
                  savedAt: f.now(),
                  five_hour: { pct: 101 },
                  seven_day: null,
                },
              ],
            },
          ],
        },
        f.now(),
        30,
      ),
    ).toEqual([]);
  });
  it("draws gaps and reported reset-cycle boundaries without joining them", () => {
    const t = Date.now();
    const point = (n: number, r: number) => ({
      t: t + n,
      savedAt: t + n,
      five_hour: { pct: 70, resetAt: r },
      seven_day: null,
    });
    expect(
      historySegments(
        [point(0, 1), point(1000, 2), point(40 * 60000, 2)],
        "five_hour",
      ),
    ).toHaveLength(3);
  });
});
