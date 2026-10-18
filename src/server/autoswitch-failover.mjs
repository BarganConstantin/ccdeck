// Auto-switch away from an active login that has died.
//
// WHY THE ENGINE CANNOT DO THIS UNDER THE DECK. claude-swap fails over only
// after the active account's usage has been unreadable for `unhealthyTicks`
// polls in a row (3 by default), and it counts them on the engine instance. The
// deck runs the engine as `cswap auto --once`, a new process per tick, so the
// count is 1 every time: each tick reports `active-usage-unknown 1/3` and the
// user stays on an account they can no longer use. Its idle hold has the same
// shape — `_idle_hold_since` starts again with every process, so its
// thirty-minute cap is never reached either. (claude-swap 0.26.0: cli.py builds
// a fresh AutoSwitchEngine for each --once run; autoswitch.py keeps both
// counters on it.)
//
// So the deck finishes that one decision itself, and nothing else: every other
// switch is still the engine's.
//
// WHAT COUNTS AS DEAD. Three answers from three places, all required:
//   - the engine could not read the active account this tick;
//   - claude-swap's stored copy of it is not alive (account-health.mjs);
//   - the `claude` CLI itself says nobody is signed in. That is what Claude
//     Code leaves behind once a refresh is refused: "Login expired · Please run
//     /login" clears the saved credentials.
// Each alone has a known false alarm. An unreadable usage endpoint is a network
// blip; a dead stored copy beside a working session is #721's stale copy; and a
// signed-out CLI whose stored copy is alive is a /logout somebody meant, or one
// claude-swap can still repair. A CLI that could not be asked is no answer, so
// it never counts as signed out.
//
// WHERE IT GOES. An account claude-swap can still use, not disabled, under the
// threshold the tick ran with: the freshest reading first, then the most
// headroom. A reading can be old — claude-swap collects idle accounts on its
// own schedule — and an old reading is still better than staying on a login
// that cannot answer at all; once the new account is active, the engine reads
// it and moves on by its own rules if it is full.
//
// HOW OFTEN. Once per FAILOVER_COOLDOWN_MS. A target whose login dies too is
// found the same way a tick later, and the wait keeps that from becoming a walk
// through every dead account in the store inside a minute.
import { fetchClaudeAccounts, switchClaudeAccount } from "./claude-accounts.mjs";
import { cliSignIn } from "./claude-identity.mjs";

/** The engine's two ways of saying it could not read the active account. */
export const LOST_ACTIVE_REASONS = new Set(["active-usage-unknown", "active-idle"]);

/** claude-swap's own cooldown after a switch, used here between failovers. */
export const FAILOVER_COOLDOWN_MS = 5 * 60_000;

/** What `failOver` names the switch, and the stuck tick, after. */
export const LOGIN_EXPIRED = "login-expired";

/** Whether a tick's answer could be a dead active login worth asking about. */
export function engineLostActive(tick) {
  return tick?.ok === true && tick.event === "no-switch" && LOST_ACTIVE_REASONS.has(tick.reason);
}

/** The active roster row when its stored login is gone, else null. A stale
 *  copy is a working session the collector cannot see (#721), never this. */
export function deadActiveRow(accounts) {
  const active = Array.isArray(accounts) ? accounts.find(a => a?.active) : null;
  if (!active || active.staleCopy || active.alive !== false) return null;
  return active;
}

/** The accounts a failover may land on, best first. */
export function failoverTargets(accounts, threshold) {
  const limit = typeof threshold === "number" && Number.isFinite(threshold) ? threshold : 90;
  return (Array.isArray(accounts) ? accounts : [])
    .filter(a => a && !a.active && !a.disabled && a.alive === true && !a.staleCopy && !a.stopped
      && typeof a.headroom === "number" && 100 - a.headroom < limit)
    .sort((a, b) => Number(a.stale === true) - Number(b.stale === true) || b.headroom - a.headroom);
}

const refOf = a => ({ number: a.num, email: a.email ?? "" });

/**
 * Finish a tick the engine could not finish: switch away from the active
 * account when its login is dead, or say why not.
 *
 * Null when this tick is not about a dead login at all — the tick then stands
 * as the engine reported it. Otherwise a tick-shaped answer to merge over it:
 * a `switch` with `trigger: "login-expired"`, or a `no-switch` whose reason is
 * `login-expired` and whose detail says what stood in the way.
 *
 * `before` runs inside the store lock, ahead of the switch, so the loop can
 * stand down if it was turned off or a terminal engine started meanwhile.
 */
export async function failOver(tick, {
  lastAt = null,
  now = Date.now(),
  before,
  roster = () => fetchClaudeAccounts({ force: true }),
  signIn = cliSignIn,
  switchTo = switchClaudeAccount,
} = {}) {
  if (!engineLostActive(tick)) return null;
  const read = await roster().catch(() => null);
  const dead = deadActiveRow(read?.ok ? read.accounts : null);
  if (!dead) return null;
  const cli = await signIn().catch(() => null);
  if (cli?.loggedIn !== false) return null;

  const from = refOf(dead);
  if (lastAt != null && now - lastAt < FAILOVER_COOLDOWN_MS) {
    return { event: "no-switch", reason: LOGIN_EXPIRED, detail: "waiting after the last switch away from an expired login", from };
  }
  const [target] = failoverTargets(read.accounts, tick.threshold);
  if (!target) {
    // `stuck`: the one answer the notifier says, and the panel shows.
    return { event: "no-switch", reason: LOGIN_EXPIRED, detail: "no other account is ready", stuck: true, from };
  }
  // Forced: the current login is the dead one, and Claude Code has already
  // cleared it. A plain switch would first back that empty login up, and
  // claude-swap refuses to (see switchClaudeAccount).
  const r = await switchTo(target.num, { before, force: true });
  if (r?.skipped) return { event: "skipped", reason: r.skipped };
  if (!r?.ok) {
    return { ok: false, event: "no-switch", reason: "failover_failed", detail: r?.output || r?.reason || "switch failed", from };
  }
  return { event: "switch", switched: true, trigger: LOGIN_EXPIRED, from, to: refOf(target) };
}
