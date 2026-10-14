import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Node backend
import {
  passiveRoster,
  createSnapshotStore,
  startAccountSnapshots,
} from "../../server/account-usage-history.mjs";
// @ts-expect-error Node backend
import { writeFileAtomic } from "../../server/atomic-write.mjs";
// @ts-expect-error Node backend
import { GUARDED_READS } from "../../server/request-gates.mjs";
describe("snapshot integration with passive local reads", () => {
  it("reads the real cswap schema without requests and refuses a recycled slot identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccdeck-snapshots-"));
    const previous = process.env.CLAUDE_SWAP_BACKUP;
    process.env.CLAUDE_SWAP_BACKUP = root;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No network allowed"));
    try {
      await mkdir(join(root, "cache"));
      const t = Date.now();
      await writeFile(
        join(root, "sequence.json"),
        JSON.stringify({
          accounts: {
            1: { email: "new@example.test", organizationUuid: "org" },
            2: {
              email: "valid@example.test",
              organizationUuid: "org",
              alias: "Valid",
            },
          },
        }),
      );
      const good = {
        five_hour: { pct: 0, resets_at: new Date(t + 3600000).toISOString() },
        seven_day: { pct: 100, resets_at: null },
      };
      await writeFile(
        join(root, "cache", "usage.json"),
        JSON.stringify({
          schemaVersion: 2,
          accounts: {
            1: {
              email: "old@example.test",
              organizationUuid: "org",
              fetchedAt: t / 1000,
              lastGood: good,
            },
            2: {
              email: "valid@example.test",
              organizationUuid: "org",
              fetchedAt: t / 1000,
              lastGood: good,
            },
          },
        }),
      );
      const roster = await passiveRoster();
      expect(roster.ok).toBe(true);
      expect(roster.accounts[0].lanes).toEqual([]);
      expect(roster.accounts[1].fetchedAt).toBe(t);
      expect(roster.accounts[1].lanes[1].pct).toBe(100);
      const store = createSnapshotStore({
        now: () => t,
        settings: () => ({ usageSnapshots: true, snapshotRetentionDays: 30 }),
        load: async () => null,
        save: async () => {},
      });
      await store.capture(roster);
      const recorded = await store.report();
      expect(recorded.accounts).toHaveLength(1);
      expect(recorded.accounts[0].points[0].t).toBe(t);
      expect(recorded.accounts[0].points[0].seven_day.pct).toBe(100);
      expect(fetchSpy).not.toHaveBeenCalled();
      await writeFile(join(root, "cache", "usage.json"), "{bad JSON");
      expect((await passiveRoster()).ok).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      if (previous == null) delete process.env.CLAUDE_SWAP_BACKUP;
      else process.env.CLAUDE_SWAP_BACKUP = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  it("survives file reload and applies shorter retention to persisted data", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccdeck-history-store-"));
    const file = join(root, "history.json");
    let now = Date.UTC(2026, 9, 14);
    const settings = { usageSnapshots: true, snapshotRetentionDays: 90 };
    const make = () =>
      createSnapshotStore({
        now: () => now,
        settings: () => settings,
        load: async () => {
          try {
            return JSON.parse(await readFile(file, "utf8"));
          } catch (e: any) {
            if (e.code === "ENOENT") return null;
            throw e;
          }
        },
        save: async (text: string) => writeFileAtomic(file, text),
      });
    try {
      const store = make();
      await store.capture({
        ok: true,
        accounts: [
          {
            email: "sample@example.test",
            orgUuid: "org",
            fetchedAt: now,
            lanes: [{ id: "five_hour", pct: 69, resetAt: null }],
          },
        ],
      });
      expect((await make().report()).accounts[0].points[0].five_hour.pct).toBe(
        69,
      );
      now += 40 * 86400000;
      settings.snapshotRetentionDays = 30;
      expect((await make().report()).accounts).toEqual([]);
      expect(JSON.parse(await readFile(file, "utf8")).accounts).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("collects with no page mounted, prunes while paused and stops on server close", async () => {
    vi.useFakeTimers();
    const server = new EventEmitter();
    const capture = vi.fn(async () => {}),
      read = vi.fn(async () => ({ ok: true, accounts: [] }));
    const settings = { usageSnapshots: true };
    try {
      startAccountSnapshots(server, {
        readRoster: read,
        getStore: () => ({ capture }),
        settings: () => settings,
        ready: Promise.resolve(),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60000);
      expect(read).toHaveBeenCalledTimes(2);
      settings.usageSnapshots = false;
      await vi.advanceTimersByTimeAsync(60000);
      expect(read).toHaveBeenCalledTimes(2);
      expect(capture).toHaveBeenLastCalledWith({ ok: false });
      server.emit("close");
      const calls = capture.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120000);
      expect(capture).toHaveBeenCalledTimes(calls);
    } finally {
      server.emit("close");
      vi.useRealTimers();
    }
  });
  it("protects private account history as an authenticated data read", () => {
    expect(GUARDED_READS.has("/api/accounts/history")).toBe(true);
  });
});
