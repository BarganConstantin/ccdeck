// Updating the deck while nobody is looking at it.
//
// The update path had one automatic step, and it needed a page: the banner's
// `auto when idle` restarted the deck once an install had landed, and only in a
// tab somebody was looking at. An install itself never happened unless a person
// pressed `Update now`, and a deck with no tab open stayed on its old code for
// good. Since 3.20.0 the deck outlives its terminal and runs for days with no
// tab at all, which made that the common case.
//
// So the server does it, at the one moment it cannot interrupt anybody: no tab
// has focus (presence.mjs), no agent is mid-turn, and no turn has produced an
// event for AWAY_QUIET_MS (activity.mjs). The same switch governs it — the
// banner's `auto when idle`, kept in prefs.json as `autoUpdate` now so the
// server can read it with no page open. A person looking at the deck still gets
// the banner and its buttons; this is only for when they are not.
//
// Every effect goes through the code a press uses — startUpgrade, and the
// launcher's restart — so an unattended update cannot do anything a person
// could not have done from the banner. Pure rules here; index.mjs owns the
// timer and the effects.

/** Quiet before the deck may act: the page's IDLE_BEFORE_RESTART_MS, so the
 *  two paths agree on what idle means. */
export const AWAY_QUIET_MS = 30_000;

/** How long a deck that has just started waits before acting at all. A
 *  relaunch that came back on the version it left would otherwise try again a
 *  minute later, and again after that; this caps any such loop at one attempt
 *  per boot grace, under the launcher's own two-strike rule for npx
 *  (supervisor.mjs, upgradeAttempt). */
export const AWAY_BOOT_GRACE_MS = 5 * 60_000;

/** How long the same attempt is left alone after it was made: an install that
 *  failed, a fetch the launcher refused, a restart it could not run. A newer
 *  version is a different attempt and is not held back by this. */
export const AWAY_RETRY_MS = 30 * 60_000;

/** How often the server asks. The gate below is answered from memory; only
 *  when it passes does the tick read the version report, which touches disk. */
export const AWAY_TICK_MS = 60_000;

/** How long a report that found nothing newer is taken as the answer. The npm
 *  lookup behind it is hourly anyway, and the report is not free: on Windows
 *  upgradeBlock proves the npm prefix writable by creating a file in it, and a
 *  deck left alone overnight would otherwise do that once a minute. */
export const AWAY_RECHECK_MS = 5 * 60_000;

/**
 * Whether the deck may consider updating itself right now. Every input is
 * already in memory, so this runs every tick at no cost.
 */
export function awayGate({
  enabled, supervised, restarting, sinceBootMs, looking, busy, quietMs,
  graceMs = AWAY_BOOT_GRACE_MS, quietNeedMs = AWAY_QUIET_MS,
}) {
  return enabled === true && supervised === true && !restarting
    && sinceBootMs >= graceMs && !looking && !busy && quietMs >= quietNeedMs;
}

/**
 * What to do about the version report, once the gate has passed.
 *
 *   restart  the newer code is already on disk (an install landed, or a
 *            checkout was pulled) — the free half, as pickNotice says
 *   install  `npm i -g` over a global install; the next tick restarts into it
 *   npx      the launcher fetches the new version and hands it the port
 *   null     nothing newer, an install already running, the same attempt
 *            made too recently, or a copy that only a person can update
 */
export function awayUpdateStep({ notice, mode, installing, lastTry, now, retryMs = AWAY_RETRY_MS }) {
  if (!notice || installing) return { act: null };
  const target = `${notice.kind}:${notice.to}`;
  // A clock that moved backwards counts as time elapsed, as everywhere else in
  // the update path: a deck must not wait out a window it cannot measure.
  if (lastTry?.target === target && now >= lastTry.at && now - lastTry.at < retryMs) return { act: null, target };
  if (notice.kind === "restart") return { act: "restart", target };
  if (notice.kind === "upgrade" && (mode === "install" || mode === "npx")) return { act: mode, target };
  return { act: null, target };
}
