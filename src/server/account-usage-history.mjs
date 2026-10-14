// #2104: local snapshots of provider observations. No provider calls, credentials,
// estimated renewal or reconstructed samples. Every mutation shares one queue.
import { createHash } from "node:crypto";
import { readFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { deckDataDir } from "./deck-home.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { heldPrefs, prefsRead } from "./prefs-state.mjs";
import { readBody, send } from "./http-io.mjs";

export const SAMPLE_MS = 15 * 60_000;
const DAY = 86400_000;
const MAX_BYTES = 32 * 1024 * 1024;
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const validTime = (n) =>
  finite(n) && n > 0 && Number.isFinite(new Date(n).getTime());
export const snapshotKey = (email, org) =>
  typeof email === "string" && email.trim()
    ? createHash("sha256")
        .update(JSON.stringify([email.trim().toLowerCase(), org ?? ""]))
        .digest("hex")
    : null;

export function normalizeSnapshots(raw, now, days) {
  if (raw?.v !== 1 || !Array.isArray(raw.accounts))
    throw new Error("Unsupported history format");
  const floor = now - days * DAY;
  return raw.accounts.flatMap((a) => {
    if (
      !/^[a-f0-9]{64}$/.test(a?.id ?? "") ||
      typeof a.name !== "string" ||
      !Array.isArray(a.points)
    )
      return [];
    const points = a.points
      .filter(
        (p) =>
          validTime(p?.t) &&
          validTime(p?.savedAt) &&
          p.t >= floor &&
          p.t <= now &&
          ["five_hour", "seven_day"].every(
            (id) =>
              p[id] == null ||
              (finite(p[id].pct) &&
                p[id].pct >= 0 &&
                p[id].pct <= 100 &&
                (p[id].resetAt == null || validTime(p[id].resetAt * 1000))),
          ),
      )
      .map((p) => ({
        t: p.t,
        savedAt: p.savedAt,
        ...Object.fromEntries(
          ["five_hour", "seven_day"].map((id) => [
            id,
            p[id] == null
              ? null
              : { pct: p[id].pct, resetAt: p[id].resetAt ?? null },
          ]),
        ),
      }))
      .sort((a, b) => a.t - b.t)
      .filter((p, i, all) => !i || p.t !== all[i - 1].t);
    return points.length
      ? [{ id: a.id, name: a.name.slice(0, 300), points }]
      : [];
  });
}

export function createSnapshotStore({
  load,
  save,
  settings,
  now = Date.now,
  size = null,
}) {
  let accounts = null,
    queue = Promise.resolve(),
    storageError = null,
    loadedDirty = false;
  let cutoff = 0;
  const run = (fn) => {
    const result = queue.then(async () => {
      if (accounts == null) {
        const raw = await load();
        accounts = raw == null ? [] : normalizeSnapshots(raw, now(), 90);
        cutoff = validTime(raw?.cutoff) ? raw.cutoff : 0;
        loadedDirty =
          raw != null &&
          JSON.stringify(raw) !== JSON.stringify({ v: 1, accounts, cutoff });
      }
      return fn();
    });
    queue = result.catch(() => {});
    return result;
  };
  const encode = () => JSON.stringify({ v: 1, accounts, cutoff });
  const prune = () => {
    const before = encode();
    accounts = normalizeSnapshots(
      { v: 1, accounts },
      now(),
      settings().snapshotRetentionDays,
    );
    const changed = loadedDirty || before !== encode();
    loadedDirty = false;
    return changed;
  };
  const persist = async () => {
    try {
      const text = encode();
      if (Buffer.byteLength(text) > MAX_BYTES)
        throw new Error("History storage limit reached");
      await save(text);
      storageError = null;
    } catch (e) {
      storageError =
        "History could not be saved. Check local storage permissions and available space.";
      throw e;
    }
  };
  return {
    capture(roster) {
      return run(async () => {
        const previous = structuredClone(accounts);
        let changed = prune();
        if (settings().usageSnapshots && roster?.ok)
          for (const a of roster.accounts ?? []) {
            const id = snapshotKey(a.email, a.orgUuid);
            const t = a.fetchedAt;
            if (
              !id ||
              !validTime(t) ||
              t <= cutoff ||
              t > now() ||
              now() - t > SAMPLE_MS ||
              a.stale ||
              a.staleCopy ||
              a.stopped ||
              a.error
            )
              continue;
            const point = { t, savedAt: now() };
            for (const win of ["five_hour", "seven_day"]) {
              const lane = a.lanes?.find((l) => l.id === win);
              point[win] =
                lane && finite(lane.pct) && lane.pct >= 0 && lane.pct <= 100
                  ? {
                      pct: lane.pct,
                      resetAt: validTime(lane.resetAt * 1000)
                        ? lane.resetAt
                        : null,
                    }
                  : null;
            }
            if (!point.five_hour && !point.seven_day) continue;
            let account = accounts.find((r) => r.id === id);
            if (!account) {
              account = {
                id,
                name: String(a.alias || a.email).slice(0, 300),
                points: [],
              };
              accounts.push(account);
            }
            const last = account.points.at(-1);
            if (last && t <= last.t) continue;
            const cycleChanged =
              last &&
              ["five_hour", "seven_day"].some(
                (w) => last[w]?.resetAt !== point[w]?.resetAt,
              );
            if (
              last &&
              Math.floor(last.t / SAMPLE_MS) === Math.floor(t / SAMPLE_MS) &&
              !cycleChanged
            )
              account.points.pop();
            account.name = String(a.alias || a.email).slice(0, 300);
            account.points.push(point);
            changed = true;
          }
        if (changed || storageError) {
          try {
            await persist();
          } catch (e) {
            accounts = previous;
            throw e;
          }
        }
      });
    },
    report() {
      return run(async () => {
        if (prune()) await persist();
        return {
          ok: true,
          enabled: settings().usageSnapshots,
          retentionDays: settings().snapshotRetentionDays,
          bytes: size ? await size() : Buffer.byteLength(encode()),
          storageError,
          accounts: structuredClone(accounts),
          sampledEveryMs: SAMPLE_MS,
        };
      });
    },
    clear() {
      return run(async () => {
        const old = accounts,
          oldCutoff = cutoff;
        accounts = [];
        cutoff = now();
        try {
          await persist();
        } catch (e) {
          accounts = old;
          cutoff = oldCutoff;
          throw e;
        }
      });
    },
  };
}

// Passive store reading deliberately bypasses fetchClaudeAccounts, whose normal
// UI path nudges claude-swap's collector. A closed tab must not add provider polls.
export async function passiveRoster() {
  const { backupRoot, usageRows, rowIsFor, observedMs } =
    await import("./claude-accounts.mjs");
  const root = backupRoot();
  try {
    const before = await readFile(join(root, "sequence.json"), "utf8");
    const seq = JSON.parse(before);
    const usage = usageRows(
      JSON.parse(await readFile(join(root, "cache", "usage.json"), "utf8")),
    );
    if (before !== (await readFile(join(root, "sequence.json"), "utf8")))
      return { ok: false };
    return {
      ok: true,
      accounts: Object.entries(seq.accounts ?? {}).map(([slot, a]) => {
        const row = usage[slot],
          matches = rowIsFor(row, a),
          good = matches ? row.lastGood : null;
        const fetchedAt = matches ? observedMs(row.fetchedAt) : null;
        return {
          email: a.email,
          orgUuid: a.organizationUuid,
          alias: a.alias,
          fetchedAt,
          error:
            matches && row.consecutiveFailures > 0
              ? "Last refresh failed"
              : null,
          lanes: ["five_hour", "seven_day"].flatMap((id) => {
            const w = good?.[id],
              reset = Date.parse(w?.resets_at);
            return finite(w?.pct)
              ? [
                  {
                    id,
                    pct: Math.min(100, Math.max(0, w.pct)),
                    resetAt: validTime(reset) ? reset / 1000 : null,
                  },
                ]
              : [];
          }),
        };
      }),
    };
  } catch {
    return { ok: false };
  }
}

let store = null;
export function accountSnapshotStore() {
  if (!store) {
    const file = join(deckDataDir(), "account-usage-history.json");
    store = createSnapshotStore({
      settings: () => heldPrefs.current(),
      size: async () =>
        stat(file).then(
          (s) => s.size,
          (e) => {
            if (e.code === "ENOENT") return 0;
            throw e;
          },
        ),
      load: async () => {
        try {
          if ((await stat(file)).size > MAX_BYTES)
            throw new Error("History exceeds capacity");
          return JSON.parse(await readFile(file, "utf8"));
        } catch (e) {
          if (e.code === "ENOENT") return null;
          throw e;
        }
      },
      save: async (text) => {
        await mkdir(dirname(file), { recursive: true });
        await writeFileAtomic(file, text);
      },
    });
  }
  return store;
}
export function startAccountSnapshots(
  server,
  {
    readRoster = passiveRoster,
    getStore = accountSnapshotStore,
    settings = () => heldPrefs.current(),
    ready = prefsRead,
  } = {},
) {
  let closed = false,
    running = false;
  const tick = async () => {
    if (closed || running) return;
    running = true;
    try {
      await ready;
      const roster = settings().usageSnapshots
        ? await readRoster()
        : { ok: false };
      if (!closed) await getStore().capture(roster);
    } catch {
      /* routes expose storage failure; never fail live quota collection */
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  server.once("close", () => {
    closed = true;
    clearInterval(timer);
  });
  void tick();
}
export async function handleAccountHistory(req, res) {
  try {
    await prefsRead;
    if (req.method === "POST") {
      const body = JSON.parse(await readBody(req, res));
      if (body.confirm !== true)
        return send(res, 400, { ok: false, error: "Confirmation required" });
      await accountSnapshotStore().clear();
    }
    const report = await accountSnapshotStore().report();
    const roster = await passiveRoster();
    const current = new Set(
      (roster.accounts ?? []).map((a) => snapshotKey(a.email, a.orgUuid)),
    );
    report.accounts = report.accounts.map((a) => ({
      ...a,
      removed: roster.ok ? !current.has(a.id) : null,
    }));
    send(res, 200, report);
  } catch {
    send(res, 503, {
      ok: false,
      error:
        "Account history is unavailable. Existing history has been preserved.",
    });
  }
}
