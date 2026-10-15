// Observed quota, never inferred from tokens or cost. Recording adds no polls.
import { createHash } from "node:crypto";
import { readFile, stat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deckDataDir } from "./deck-home.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";

export const HISTORY_LIMITS = Object.freeze({ series: 32, points: 2048, totalPoints: 16384, days: 35, bytes: 2 * 1024 * 1024 });
const finite = n => typeof n === "number" && Number.isFinite(n);
const providers = new Set(["claude", "codex"]);
const hash = (provider, identity) => createHash("sha256").update(`${provider}\0${identity}`).digest("hex");

export function historyAccount(provider, account) {
  if (provider === "claude" && typeof account?.email === "string" && account.email.trim()
      && typeof account?.organizationUuid === "string" && account.organizationUuid) {
    return hash(provider, `${account.email.trim().toLowerCase()}\0${account.organizationUuid}`);
  }
  if (provider === "codex" && (typeof account?.accountId === "string" && account.accountId
      || typeof account?.email === "string" && account.email.trim())) {
    return hash(provider, `${typeof account.accountId === "string" ? account.accountId : ""}\0${typeof account.email === "string" ? account.email.trim().toLowerCase() : ""}`);
  }
  return null;
}

export function historyWindows(provider, r) {
  if (!r?.ok || r.stale) return [];
  if (provider === "codex") return [...(r.windows ?? []), ...(r.extraWindows ?? [])];
  const out = [
    { id: "five_hour", label: "5-hour window", pct: r.session5hPct, resetAt: r.session5hResetAt, windowSec: r.session5hWindowSec },
    { id: "seven_day", label: "7-day window", pct: r.week7dPct, resetAt: r.week7dResetAt, windowSec: r.week7dWindowSec },
  ];
  // Store fallback can copy the weekly reading into the nominal session lane.
  return out.filter((w, i) => i !== 0 || w.resetAt !== out[1].resetAt || w.pct !== out[1].pct);
}

function prune(series, now) {
  const floor = now - HISTORY_LIMITS.days * 86400_000;
  let rows = series.filter(s => s.points.length && s.points.at(-1).t >= floor)
    .map(s => ({ ...s, points: s.points.filter(p => p.t >= floor).slice(-HISTORY_LIMITS.points) }))
    .filter(s => s.points.length).sort((a, b) => b.points.at(-1).t - a.points.at(-1).t)
    .slice(0, HISTORY_LIMITS.series);
  let total = rows.reduce((n, s) => n + s.points.length, 0);
  while (total > HISTORY_LIMITS.totalPoints) total -= rows.pop().points.length;
  return rows;
}

export function normalizeHistory(raw, now) {
  if (raw?.v !== 1 || !Array.isArray(raw.series)) return [];
  const out = [];
  for (const s of raw.series.slice(0, HISTORY_LIMITS.series)) {
    if (!providers.has(s?.provider) || !/^[a-f0-9]{64}$/.test(s.account ?? "")
        || typeof s.id !== "string" || s.id.length > 100 || typeof s.label !== "string"
        || !finite(s.resetAt) || !finite(s.windowSec) || s.windowSec < 60 || s.windowSec > 40 * 86400
        || !Array.isArray(s.points)) continue;
    const points = s.points.slice(-HISTORY_LIMITS.points).filter(p => finite(p?.t) && finite(p?.pct)
      && p.pct >= 0 && p.pct <= 100 && p.t <= now + 60_000
      && p.t >= (s.resetAt - s.windowSec) * 1000 - 120_000 && p.t < s.resetAt * 1000)
      .map(p => ({ t: p.t, pct: p.pct })).sort((a, b) => a.t - b.t)
      .filter((p, i, all) => !i || p.t !== all[i - 1].t);
    out.push({ provider: s.provider, account: s.account, id: s.id, label: s.label.slice(0, 100),
      resetAt: s.resetAt, windowSec: s.windowSec, points });
  }
  return prune(out, now);
}

export function createQuotaHistory({ load = async () => null, save = async () => {}, now = Date.now } = {}) {
  let series = [], loading = null, storageOk = true;
  const active = new Map();
  let queue = Promise.resolve();
  const ready = () => loading ??= (async () => {
    try { series = normalizeHistory(await load(), now()); }
    catch { storageOk = false; }
  })();
  return {
    activate(provider, account) {
      if (!providers.has(provider)) return null;
      const key = historyAccount(provider, account);
      active.set(provider, key);
      return key;
    },
    record(provider, account, reading) {
      queue = queue.then(async () => {
        await ready();
        if (!providers.has(provider) || !/^[a-f0-9]{64}$/.test(account ?? "") || !reading?.ok || reading.stale
            || !finite(reading.fetchedAt) || reading.fetchedAt > now() + 60_000) return;
        let changed = false;
        for (const w of historyWindows(provider, reading)) {
          if (typeof w.id !== "string" || !finite(w.pct) || w.pct < 0 || w.pct > 100
              || !finite(w.resetAt) || !finite(w.windowSec) || w.windowSec < 60 || w.windowSec > 40 * 86400
              || reading.fetchedAt >= w.resetAt * 1000
              || reading.fetchedAt < (w.resetAt - w.windowSec) * 1000 - 120_000) continue;
          let s = series.find(s => s.provider === provider && s.account === account && s.id === w.id
            && s.windowSec === w.windowSec && Math.abs(s.resetAt - w.resetAt) <= 120);
          if (!s) {
            s = { provider, account, id: w.id.slice(0, 100), label: String(w.label ?? w.id).slice(0, 100),
              resetAt: w.resetAt, windowSec: w.windowSec, points: [] };
            series.push(s);
          }
          if (s.points.length && reading.fetchedAt <= s.points.at(-1).t) continue;
          // Small source jitter must not place a captured point beyond the
          // persisted window's end, where the next load would discard it.
          s.resetAt = Math.max(s.resetAt, w.resetAt);
          s.points.push({ t: reading.fetchedAt, pct: w.pct });
          changed = true;
        }
        series = prune(series, now());
        if (changed) {
          try { await save({ v: 1, series }); storageOk = true; }
          catch { storageOk = false; } // history cannot fail a quota request
        }
      }).catch(() => { storageOk = false; });
      return queue;
    },
    async report(provider, account) {
      await queue;
      await ready();
      // A delayed request for an account that was switched away from cannot
      // display its history beside the new account's current quota.
      if (!account || active.get(provider) !== account) return { ok: true, account: null, series: [], storageOk };
      series = prune(series, now());
      return { ok: true, account, storageOk, series: series.filter(s => s.provider === provider && s.account === account)
        .map(({ account: _account, provider: _provider, ...s }) => ({ ...s, points: s.points.map(p => ({ ...p })) })) };
    },
  };
}

let history = null;
export function startQuotaHistory() {
  if (history) return;
  const file = join(deckDataDir(), "quota-history.json");
  history = createQuotaHistory({
    load: async () => {
      try {
        if ((await stat(file)).size > HISTORY_LIMITS.bytes) throw new Error("History exceeds capacity");
        return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
    },
    save: async raw => { await mkdir(dirname(file), { recursive: true }); await writeFileAtomic(file, JSON.stringify(raw)); },
  });
}
export function noteQuotaHistory(provider, account, reading) {
  if (!history) return;
  const key = history.activate(provider, account);
  if (key) { reading.historyAccount = key; void history.record(provider, key, reading); }
}
export function forgetQuotaHistoryAccount(provider) { history?.activate(provider, null); }
export async function quotaHistoryReport(provider, account) {
  return history ? history.report(provider, account) : { ok: true, account: null, series: [], storageOk: true };
}
