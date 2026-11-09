import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error — plain .mjs server module, no types
import { createQuotaHistory, normalizeHistory } from "../../server/quota-history.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { writeFileAtomic } from "../../server/atomic-write.mjs";

const NOW = Date.parse("2026-11-09T10:00:00Z");
const first = { email: "first@example.test", organizationUuid: "synthetic-a" };
const second = { email: "second@example.test", organizationUuid: "synthetic-b" };
const reading = (pct: number, fetchedAt = NOW) => ({
  ok: true, fetchedAt, session5hPct: pct,
  session5hResetAt: NOW / 1000 + 3600, session5hWindowSec: 18000,
});
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function seeded() {
  const dir = await mkdtemp(join(tmpdir(), "ccdeck-history-recovery-"));
  dirs.push(dir);
  const file = join(dir, "quota-history.json");
  const load = async () => JSON.parse(await readFile(file, "utf8"));
  const save = async (raw: unknown) => writeFileAtomic(file, JSON.stringify(raw));
  const seed = createQuotaHistory({ now: () => NOW, save });
  const account = seed.activate("claude", first);
  await seed.record("claude", account, reading(25, NOW - 120_000));
  expect(normalizeHistory(await load(), NOW)).toHaveLength(1);
  return { account, load, save };
}

describe("quota history recovers from an unreadable existing file", () => {
  it("keeps the original file intact, then merges buffered account observations after retry", async () => {
    const { account: original, load: disk, save: write } = await seeded();
    const load = vi.fn(disk).mockRejectedValueOnce(new Error("synthetic EIO"));
    const save = vi.fn(write);
    const history = createQuotaHistory({ now: () => NOW, load, save });
    const account = history.activate("claude", second);

    await history.record("claude", account, reading(40));
    expect(save).not.toHaveBeenCalled();
    expect((await disk()).series.map((s: any) => s.account)).toEqual([original]);

    const report = await history.report("claude", account);
    expect(report).toMatchObject({ storageOk: true, series: [{ points: [{ t: NOW, pct: 40 }] }] });
    expect(load).toHaveBeenCalledTimes(2);
    expect((await disk()).series.map((s: any) => s.account).sort()).toEqual([original, account].sort());
  });

  it("keeps working in memory without writing over unread data during a persistent fault", async () => {
    const { account: original, load: disk, save: write } = await seeded();
    let unavailable = true;
    const load = vi.fn(async () => {
      if (unavailable) throw new Error("synthetic EIO");
      return disk();
    });
    const save = vi.fn(write);
    const history = createQuotaHistory({ now: () => NOW, load, save });
    const account = history.activate("claude", second);
    await history.record("claude", account, reading(40, NOW - 60_000));
    expect(await history.report("claude", account)).toMatchObject({
      storageOk: false, series: [{ points: [{ t: NOW - 60_000, pct: 40 }] }],
    });
    expect(save).not.toHaveBeenCalled();
    expect((await disk()).series.map((s: any) => s.account)).toEqual([original]);

    unavailable = false;
    const reports = await Promise.all([
      history.report("claude", account),
      history.record("claude", account, reading(55)),
      history.report("claude", account),
    ]);
    expect(reports[2].storageOk).toBe(true);
    const rows = (await disk()).series;
    expect(rows.find((s: any) => s.account === original).points).toEqual([{ t: NOW - 120_000, pct: 25 }]);
    expect(rows.find((s: any) => s.account === account).points).toEqual([
      { t: NOW - 60_000, pct: 40 }, { t: NOW, pct: 55 },
    ]);
  });

  it("merges disk and buffered points for the same window without dropping either", async () => {
    const { account, load: disk, save } = await seeded();
    const load = vi.fn(disk).mockRejectedValueOnce(new Error("synthetic EIO"));
    const history = createQuotaHistory({ now: () => NOW, load, save });
    history.activate("claude", first);
    await history.record("claude", account, reading(30, NOW - 60_000));
    await history.record("claude", account, reading(35));
    const report = await history.report("claude", account);
    expect(report.series).toHaveLength(1);
    expect(report.series[0].points).toEqual([
      { t: NOW - 120_000, pct: 25 }, { t: NOW - 60_000, pct: 30 }, { t: NOW, pct: 35 },
    ]);
    expect((await disk()).series[0].points).toEqual(report.series[0].points);
  });

  it("retains pending observations after a save failure and flushes them on the next report", async () => {
    const { account: original, load, save: write } = await seeded();
    const save = vi.fn(write).mockRejectedValueOnce(new Error("synthetic write failure"));
    const history = createQuotaHistory({ now: () => NOW, load, save });
    const account = history.activate("claude", second);
    await history.record("claude", account, reading(40));
    expect((await load()).series.map((s: any) => s.account)).toEqual([original]);
    expect((await history.report("claude", account)).storageOk).toBe(true);
    expect((await load()).series.map((s: any) => s.account).sort()).toEqual([original, account].sort());
    expect(save).toHaveBeenCalledTimes(2);
    await history.report("claude", account);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
