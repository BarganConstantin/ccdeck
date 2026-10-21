// Which account Auto-switch should be on, by the owner's two rules — a home
// account it comes back to, and "soonest weekly reset" as the way it picks the
// next one — asked before claude-swap's own engine runs.
//
// THE ENGINE STAYS THE SAFETY NET. claude-swap decides with `best` exactly as it
// did before; this only answers when one of the two rules has something better
// to say, and answers nothing otherwise. Nothing here is consulted at all while
// neither rule is set, so a deck that never touched them switches as it always
// did.
//
// WHY NOT claude-swap's OWN `consume-first`. It ranks by the weekly reset too,
// but it has no horizon, skips the hysteresis gate below the threshold, and
// pulls away from any account it is on — and upstream measured endless
// 1→2→1→3 cycles when it was combined with a preferred account (PR #260). So
// the engine is left on `best`, and while it is not, the moves below the
// threshold are not made here either: two strategies would take turns.
//
// WHAT A MOVE MADE HERE DOES NOT DO. A `cswap switch` run by the deck does not
// start the engine's cooldown and switches off its guard against undoing its
// own last move (autoswitch.py `_no_return_account`). An account landed on
// above the threshold would be left again on the very next tick. So a target
// is only ever an account comfortably under it, read recently, with no window
// that has reset since it was read — and the deck keeps a cooldown of its own.
//
// Pure: the roster, the rules and the clock in, a target or null out. The loop
// (cswap-auto-loop.mjs) reads the store, carries out the move and remembers
// what happened.

/** Accounts further than this from their weekly reset are not chased. */
export const WEEKLY_HORIZON_H = 95;
/** How far under the threshold a target must sit, so the engine — which
 *  leaves an account at the threshold — does not leave it again at once. */
export const ROOM_MARGIN_PCT = 5;
/** A reading older than this is not acted on: claude-swap re-reads an idle
 *  account every five to ten minutes while the loop runs. */
export const FRESH_FOR_MS = 15 * 60_000;
/** Below the threshold, a sooner weekly reset is worth a move only when it is
 *  at least this much sooner — so two accounts that reset within the same hour
 *  do not trade places. */
export const WEEKLY_LEAD_S = 3600;
/** How long after any move the optional ones wait. The engine leaves an
 *  account at the threshold even when its 5-hour window resets minutes later;
 *  measured in the simulated week, a move straight back followed five minutes
 *  on. Nothing optional is worth a move that soon after another. */
export const SETTLE_MS = 30 * 60_000;

/** The two ways to pick the next account. "room" is the engine's own. */
export const NEXT_CHOICES = Object.freeze(["room", "weekly"]);

/**
 * The scoped (per-model) lanes the engine counts, from its `autoswitch.model`
 * setting: none, "all", or a comma list matched case-insensitively against
 * the model's name — the rule autoswitch.py applies to the same windows.
 */
export function countedModels(setting) {
  const raw = typeof setting === "string" ? setting.trim() : "";
  if (!raw) return [];
  if (raw.toLowerCase() === "all") return "all";
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** The lanes that decide whether an account is over the threshold: 5h, 7d and
 *  whichever model lanes the engine counts. */
export function bindingLanes(account, models) {
  return (account?.lanes ?? []).filter(l => {
    if (l.id === "five_hour" || l.id === "seven_day") return true;
    if (!String(l.id).startsWith("scoped-")) return false;
    return models === "all" || (Array.isArray(models) && models.includes(String(l.label).toLowerCase()));
  });
}

/** The tightest of those lanes, as a percentage used, or null when none. */
export function usedOf(account, models) {
  const lanes = bindingLanes(account, models);
  return lanes.length ? Math.max(...lanes.map(l => l.pct)) : null;
}

/** When the weekly window resets, in unix seconds, or null when unknown. */
export function weeklyResetOf(account) {
  const lane = (account?.lanes ?? []).find(l => l.id === "seven_day");
  return typeof lane?.resetAt === "number" ? lane.resetAt : null;
}

/**
 * Whether this account's numbers may be acted on now: read in the last
 * FRESH_FOR_MS, and no counted window has reset since. A window past its reset
 * still carries the percentage from before it — wrong in the direction that
 * matters least for leaving and most for landing, so it is simply not used
 * until claude-swap has read the account again.
 */
export function readingCurrent(account, models, now) {
  if (typeof account?.fetchedAt !== "number" || now - account.fetchedAt > FRESH_FOR_MS) return false;
  return bindingLanes(account, models).every(l => l.resetAt == null || l.resetAt * 1000 > now);
}

/**
 * Whether Auto-switch may land on this account: signed in, in rotation, not
 * the one another paired deck is working on, read recently, and comfortably
 * under the threshold on every window that counts. An account with no 5-hour
 * or weekly window (an API key) is never a target here; the engine still
 * decides about those.
 */
export function landable(account, { threshold, models, busy, now }) {
  if (!account || account.active || account.disabled || account.alive === false) return false;
  if (account.error || account.reauth) return false;
  if (busy?.has?.(account.key)) return false;
  const ids = new Set((account.lanes ?? []).map(l => l.id));
  if (!ids.has("five_hour") || !ids.has("seven_day")) return false;
  if (!readingCurrent(account, models, now)) return false;
  return usedOf(account, models) < threshold - ROOM_MARGIN_PCT;
}

/** The landable account whose weekly window resets soonest within the horizon
 *  (and before `before`, when given), the one with more room first on a tie,
 *  then the lower slot — or null. */
function soonestWeekly(accounts, ctx, before = null) {
  const limit = ctx.now / 1000 + WEEKLY_HORIZON_H * 3600;
  const fits = accounts
    .filter(a => landable(a, ctx))
    .map(a => ({ a, reset: weeklyResetOf(a), used: usedOf(a, ctx.models) }))
    .filter(x => x.reset != null && x.reset * 1000 > ctx.now && x.reset <= limit)
    .filter(x => before == null || x.reset <= before - WEEKLY_LEAD_S)
    .sort((x, y) => x.reset - y.reset || x.used - y.used || x.a.num - y.a.num);
  return fits.length ? fits[0] : null;
}

/**
 * Where Auto-switch should move now, or null for "leave it to the engine".
 *
 *   accounts  roster rows (claude-accounts.mjs), each with its `key`
 *   choice    { next: "room"|"weekly", home: key|null, manual, goHome }
 *             `manual` — the account in use was picked by hand, so the moves
 *             nobody needs (below the threshold) leave it alone. `goHome` —
 *             somebody just set a home and expects to be taken there.
 *   threshold the engine's, in percent
 *   models    countedModels(...) of the engine's model setting
 *   busy      keys of the accounts paired decks are working on
 *   sinceMove ms since the last move, the engine's or this one's
 *   cooldownMs the engine's cooldown, which every move here keeps too
 *   optional  whether moves below the threshold may be made at all: only
 *             while the engine itself is on `best`
 *
 * Returns { to, trigger: "home"|"weekly-reset", leaving, resetAt? }.
 */
export function chooseAccount({ accounts, choice, threshold, models = [], busy = new Set(), sinceMove = Infinity, cooldownMs = 300_000, optional = true, now }) {
  const next = choice?.next === "weekly" ? "weekly" : "room";
  const homeKey = choice?.home ?? null;
  if (next === "room" && !homeKey) return null;
  if (sinceMove < cooldownMs || !Number.isFinite(threshold)) return null;

  const active = accounts.find(a => a.active);
  // The engine reads the account it is on every minute or so; if the store
  // has nothing current for it, the engine is the one to sort that out.
  if (!active || !readingCurrent(active, models, now)) return null;
  const used = usedOf(active, models);
  if (used == null) return null;

  const ctx = { threshold, models, busy, now };
  const home = homeKey ? accounts.find(a => a.key === homeKey) ?? null : null;
  const onHome = home != null && home === active;

  // HAS TO LEAVE: the engine would move now. Home first, then the soonest
  // weekly reset within the horizon; when neither fits, the engine picks the
  // account with the most room, as it always has — so nobody is ever stuck.
  if (used >= threshold) {
    if (home && !onHome && landable(home, ctx)) return { to: home, trigger: "home", leaving: true };
    if (next === "weekly") {
      const pick = soonestWeekly(accounts, ctx);
      if (pick) return { to: pick.a, trigger: "weekly-reset", leaving: true, resetAt: pick.reset };
    }
    return null;
  }

  // BELOW THE THRESHOLD every move is optional, and four things stop one: a
  // second strategy in the engine, being home (never left from under the
  // threshold — that is what keeps the two rules from taking turns), a
  // hand-picked account, which stays picked until it fills or a home is set,
  // and a move less than SETTLE_MS ago. A home somebody has just set is the
  // one exception to the last: they asked to be taken there.
  if (!optional || onHome) return null;
  const settled = sinceMove >= Math.max(cooldownMs, SETTLE_MS);
  if (home && (choice.goHome || (!choice.manual && settled)) && landable(home, ctx)) {
    return { to: home, trigger: "home", leaving: false };
  }
  if (choice.manual || next !== "weekly" || !settled) return null;
  const mine = weeklyResetOf(active);
  if (mine == null || mine * 1000 <= now) return null;
  const pick = soonestWeekly(accounts, ctx, mine);
  return pick ? { to: pick.a, trigger: "weekly-reset", leaving: false, resetAt: pick.reset } : null;
}
