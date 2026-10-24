// What keeps quota-closes.mjs fed while no page is open. Every five minutes it
// reads claude-swap's store for every account (two small files, no request),
// notes the plan the signed-in account is on, and closes the windows whose
// reset has passed. And once per weekly window about to reset that was last
// read over an hour ago, it asks for one fresh reading: the reading the whole
// record is about, at a cost of one collection a week per account.
//
// The quota modules are reached by `import()`, as account-watch.mjs reaches
// them, and are pinned with the rest (pinned-build.mjs).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { historyAccount } from "./quota-history.mjs";
import { quotaCloses } from "./quota-closes.mjs";
import { readLiveLogin } from "./claude-login.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lazy = name => import(pathToFileURL(join(PKG_ROOT, "src/server", name)).href);
export const CLOSE_WATCH_MS = 5 * 60_000;

/** One store row's windows, in the shape quota-history.mjs's historyWindows
 *  gives the published reading, so both sources land on the same window. */
export function storedWindows(lastGood) {
  const win = (id, label, w, windowSec) => {
    const resetMs = typeof w?.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    return Number.isFinite(resetMs) && resetMs > 0 && typeof w?.pct === "number" && Number.isFinite(w.pct)
      ? { id, label, pct: Math.min(100, Math.max(0, w.pct)), resetAt: Math.floor(resetMs / 1000), windowSec } : null;
  };
  const five = win("five_hour", "5-hour window", lastGood?.five_hour, 18000);
  const week = win("seven_day", "7-day window", lastGood?.seven_day, 604800);
  // The store's fallback can copy the weekly reading into the session lane.
  return [five && !(week && five.resetAt === week.resetAt && five.pct === week.pct) ? five : null, week].filter(Boolean);
}

async function closingRead(due, liveKey) {
  if (due.provider === "codex") { await (await lazy("codex-quota.mjs")).fetchCodexQuota({ force: true }); return; }
  // claude-swap collects for every account it holds; the signed-in one is also
  // read the way the Usage panel reads it, for a deck without claude-swap.
  await (await lazy("claude-accounts.mjs")).requestCollection();
  if (due.account === liveKey) await (await lazy("quota.mjs")).fetchClaudeQuota({ force: true });
}

let _running = null;
/** One pass, never two at once. Every failure ends here: a record that cannot
 *  be kept is not worth a line in anyone's way. `providers` is deck-scope's
 *  deckProviders, asked each pass as account-watch.mjs asks it. */
export function closeWatchOnce({ providers } = {}) {
  if (_running) return _running;
  _running = (async () => {
    const closes = quotaCloses();
    if (!closes) return;
    const { claude = true, codex = true } = providers?.() ?? {};
    const watched = { claude, codex };
    let liveKey = null;
    if (claude) {
      const { storedUsageReadings } = await lazy("claude-accounts.mjs");
      for (const r of await storedUsageReadings()) {
        const key = historyAccount("claude", { email: r.email, organizationUuid: r.organizationUuid });
        if (key) await closes.observe("claude", key, storedWindows(r.lastGood), r.fetchedAt);
      }
      const live = await readLiveLogin();
      liveKey = live ? historyAccount("claude", { email: live.email, organizationUuid: live.orgUuid }) : null;
      if (liveKey && live.plan) await closes.plan("claude", liveKey, live.plan);
    }
    await closes.sweep();
    for (const due of await closes.closingReads()) {
      if (watched[due.provider]) await closingRead(due, liveKey).catch(() => {});
    }
  })().catch(() => {}).finally(() => { _running = null; });
  return _running;
}

let _timer = null;
/** Started from startServer once the port is bound, never at import; unref'd
 *  like every other timer the deck keeps. */
export function startQuotaCloseWatch({ providers } = {}) {
  if (_timer) return;
  _timer = setInterval(() => { void closeWatchOnce({ providers }); }, CLOSE_WATCH_MS);
  _timer.unref?.();
  const first = setTimeout(() => { void closeWatchOnce({ providers }); }, 30_000);
  first.unref?.();
}
