// When a turn that stopped on an expired login or a usage limit may be run
// again (#2193), read once for both halves of the deck: the page draws the
// Continue button from it, and the server refuses a press — and holds back the
// automatic continue — on the same answer. The page imports this file the way
// it imports stop-failure.mjs, so the two cannot come to disagree about one
// stop.
//
// WHAT COUNTS AS "A WORKING LOGIN IS ACTIVE AGAIN". The deck's newest reading
// of the active account's usage (quota.mjs), taken AFTER the stop and without
// an error. That reading is made with the very credentials a session uses —
// Claude Code's own token, `claude --print /usage`, or claude-swap's copy of
// the active account — so a login that is still dead cannot produce one, and
// one from before the stop says nothing about the login now. A switch of
// account invalidates the reading, so the next one is about the new account.
//
// And the account has to have room: a working login on an account at 100% of
// its 5-hour or 7-day window would stop the turn again on a usage limit at its
// first request.
//
// Pure. Nothing here reads a clock, a file or a process.

/** What the deck sends a background session to continue the turn that
 *  failed: Claude Code's own words for it, the default of
 *  CLAUDE_CODE_RESUME_PROMPT (code.claude.com/docs/en/env-vars), which is what
 *  Claude Code sends when it continues an interrupted turn by itself. */
export const CONTINUE_PROMPT = "Continue from where you left off.";

/**
 * A session the deck continued automatically, which then stops again on a
 * login or a limit inside this window, is not continued automatically again
 * until somebody acts on it — a prompt typed into it, or a press of Continue.
 * That is the loop the setting must never become: a login that works for one
 * request and dies on the next would otherwise be continued, stop, and be
 * continued again for as long as the deck runs.
 */
export const REPEAT_HOLD_MS = 60 * 60_000;

/**
 * The quota reading as the gate reads it: `{ ok, at, room }`, or null when
 * there is no reading at all.
 *
 *   ok    the reading is a real one, not a failure to read
 *   at    when its numbers were collected — the reading's own clock, which is
 *         the one that can be compared with a stop's (a reading the deck is
 *         only holding over is still as old as it says)
 *   room  both of the account's windows are under 100%, or null when the
 *         reading names neither
 */
export function loginEvidence(reading) {
  if (!reading || typeof reading !== "object") return null;
  const at = Number(reading.fetchedAt);
  const when = Number.isFinite(at) && at > 0 ? at : 0;
  if (reading.ok !== true || !when) return { ok: false, at: when, room: null };
  const pcts = [reading.session5hPct, reading.week7dPct].filter(v => typeof v === "number" && Number.isFinite(v));
  return { ok: true, at: when, room: pcts.length ? pcts.every(p => p < 100) : null };
}

/**
 * Whether the turn `stop` ended may be continued now, and when not, why:
 *
 *   "no-login"     there is no working reading of the active account at all
 *   "before-stop"  the newest one was taken before the stop, so it cannot say
 *                  the login works now
 *   "no-room"      it works, and its 5-hour or 7-day window is full
 *
 * An API error that is neither — an overloaded server, a refused request — is
 * not about the login, so nothing here holds it back. The automatic continue
 * never acts on one (stop-continue.mjs); a press may.
 */
export function continueGate(stop, login) {
  if (!stop || typeof stop !== "object") return { ready: false, reason: "no-login" };
  if (stop.kind !== "login" && stop.kind !== "usage-limit") return { ready: true, reason: null };
  if (!login || !login.ok) return { ready: false, reason: "no-login" };
  if (!(login.at > stop.at)) return { ready: false, reason: "before-stop" };
  if (login.room === false) return { ready: false, reason: "no-room" };
  return { ready: true, reason: null };
}
