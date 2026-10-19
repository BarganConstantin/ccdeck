// What the accounts panel says when the deck refused a switch because the
// account's stored login has expired (#2184).
//
// Every Claude Code session on the machine runs on the login a switch puts
// live, so the server refuses to switch onto one claude-swap has already seen
// refused (login-guard.mjs) and answers `login_expired` with nothing changed.
// The row that was pressed says so by the name it shows, and offers the one
// press that fixes it: signing in as that account again.
//
// Pure, for the suite's usual reason: it has no DOM, so the rule lives where it
// can be called.
import { type Failure } from "./accounts-reload";

/** The server's reason for that refusal, as /api/claude-accounts/switch sends it. */
export const LOGIN_EXPIRED = "login_expired";

/** The refusal to draw on row `row`, or null when this answer is not that one. */
export function expiredSwitch(body: { reason?: string } | null | undefined, name: string, row: number): Failure | null {
  if (body?.reason !== LOGIN_EXPIRED) return null;
  return { text: `${name}'s login expired · sign in again to use it`, row, signIn: true };
}

/** What a removal answers beyond `ok`, when the account removed was the active
 *  one and its login had expired: the account Claude Code was moved to, or that
 *  none could take over. See removeLeavingLiveLogin in login-guard.mjs. */
export interface RemoveAnswer {
  ok?: boolean;
  movedTo?: { num: number; email: string | null; alias: string | null } | null;
  stillExpired?: boolean;
}

/** Said at the foot of the panel when nothing could take over, because the
 *  live account is no longer in the list to say it on its own row. */
export const STILL_EXPIRED =
  "Removed. Claude Code is still signed in with that expired login, and no other account here was ready to take over — sign in to one from +";

/**
 * What the panel says after such a removal: the switch that took, on the row it
 * took to — the same confirmation a press of Switch leaves — or why every
 * session is still stopped. Null for every other removal, which moves nothing.
 */
export function afterRemoval(out: RemoveAnswer | null | undefined):
  { switched: { num: number; name: string } } | { failure: Failure } | null {
  if (!out?.ok) return null;
  const to = out.movedTo;
  if (to && Number.isInteger(to.num)) return { switched: { num: to.num, name: to.alias ?? to.email ?? `account ${to.num}` } };
  if (out.stillExpired) return { failure: { text: STILL_EXPIRED } };
  return null;
}
