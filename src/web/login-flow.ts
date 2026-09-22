// What the sign-in dialog should do with the state the server reports.
//
// `claude auth login` runs on the server, not in the tab, so the dialog only
// ever sees it through a poll — and the server can lose that flow while the
// dialog is still watching it. GET /api/claude-accounts/login answers
// `{state:"idle"}` whenever the in-memory login is gone: a second tab pressed
// Escape and its login-cancel cleared it, or the deck restarted and killed the
// `claude auth login` child on its way out.
//
// "idle" is not a step in a sign-in. It is a sign-in that ended without a
// verdict, and the dialog had no branch for it: the poll stopped only on
// "done" and "failed", and every other state fell through to "Asking the claude
// CLI for a sign-in link…". So a sign-in that died elsewhere left a spinner
// that never resolved above a request every 1.5s for a flow that is never
// coming back.
//
// Both rules live here, out of AddAccountDialog, so they can be tested without
// React or a DOM — the repo's usual home for a decision a component makes.

/** Every state the login route can report. */
export type LoginServerState =
  | "idle" | "awaiting_url" | "awaiting_code" | "registering" | "done" | "failed";

/** The states in which the server still has a login that can change under us. */
const LIVE = new Set<string>(["awaiting_url", "awaiting_code", "registering"]);

/**
 * Keep polling only while something is actually moving on the server.
 *
 * A whitelist rather than "stop on the endings we know about", because that is
 * the shape that produced the endless loop: a state nobody listed kept the
 * interval alive forever. An unrecognised state now ends the poll, and
 * `isLoginOver` gives it somewhere to render.
 */
export function shouldPollLogin(state: string | null | undefined): boolean {
  return state != null && LIVE.has(state);
}

/** Whether the sign-in is over without having succeeded. */
export function isLoginOver(state: string | null | undefined): boolean {
  return state != null && state !== "done" && !LIVE.has(state);
}

/** Said when the server has forgotten a sign-in the dialog was still watching. */
export const LOGIN_VANISHED =
  "the sign-in ended before it finished — the deck restarted, or it was cancelled in another tab";

/** Said when the server called it a failure but sent no reason with it. */
export const LOGIN_FAILED = "the sign-in did not complete";

/**
 * The heading and sentence for an ended sign-in.
 *
 * A vanished login is not a failed one — nothing was rejected, the flow simply
 * stopped existing — so it gets its own heading and its own sentence instead of
 * the blank paragraph the failure branch would have rendered for it. A message
 * this request already earned still wins: "that sign-in is no longer waiting
 * for a code", from a code posted after another tab cancelled, says more than
 * the generic sentence does.
 */
export function loginEndNotice(
  { state, serverError, localError }:
  { state?: string | null; serverError?: string | null; localError?: string | null },
): { title: string; message: string } {
  const vanished = state === "idle";
  return {
    title: vanished ? "Sign-in ended" : "Sign-in failed",
    message: localError || serverError || (vanished ? LOGIN_VANISHED : LOGIN_FAILED),
  };
}

/** Which account the machine ended up signed in as, when it is not the one the
 *  user was working in. `email` is `""` for a slot the store holds no address
 *  for, which readStore treats as a real state rather than as missing. */
export type ActiveAccount = { num: string | null; email: string | null };

/**
 * The sentence for a sign-in that added the account but left the MACHINE on it.
 *
 * `cswap add` moves the live Claude login onto whatever it just added, and the
 * server's `restoreActive` moves it back. When that does not work — the stored
 * refresh token for the old slot is dead, or the switch timed out — the account
 * really was added and the sign-in really did succeed, so "Sign-in failed"
 * would be wrong. What is wrong is the success screen's own closing line: it
 * said "The account you were using is still active" unconditionally, which on
 * this path is the exact opposite of what happened, printed over a machine
 * whose every running Claude Code session had just changed account (#951).
 *
 * So this is a qualification on a success, not a failure, and it returns null
 * for every other case — including `restored` absent, which is what the poll
 * sees on `awaiting_code` and `registering`. A warning that appeared during an
 * ordinary sign-in would be trained straight past by the time it mattered.
 *
 * The ADDRESS is what makes it actionable: the accounts panel lists accounts by
 * address, so naming one points the user at a row to switch back from. The slot
 * number is the fallback for a store with no address, and the general sentence
 * the fallback for no slot either — both of which still beat silence, because
 * the thing the user must not do is close this dialog believing nothing moved.
 */
export function restoreWarning(
  { restored, activeAccount }:
  { restored?: boolean | null; activeAccount?: ActiveAccount | null },
): string | null {
  if (restored !== false) return null;
  const who = activeAccount?.email || (activeAccount?.num != null ? `account ${activeAccount.num}` : null);
  return who
    ? `This machine is now signed in as ${who} — the account you were using could not be put back. Switch back from the accounts panel.`
    : "The account you were using could not be put back — check which account this machine is signed in as from the accounts panel.";
}

// ── leaving the dialog while a sign-in is on the server (#1175) ─────────────

/** The admin request closing the dialog sends, or null when there is nothing
 *  to say. */
export type LoginExitRequest = { action: "login-cancel" } | null;

/**
 * What closing the sign-in dialog has to tell the server.
 *
 * `claude auth login` runs on the server and OUTLIVES this component, so a
 * dialog that simply unmounts leaves a child holding the next attempt hostage
 * for the rest of its five minutes — and, if the sign-in got far enough to
 * move the machine onto the new account, leaves it there. The cancel kills the
 * child and puts the previous account back, which is why every exit that is not
 * a finished sign-in sends it: ×, Escape, the backdrop, and Done.
 *
 * NOTHING WAS STARTED, NOTHING IS CANCELLED. The dialog opens on a primer — the
 * sign-in begins on a press, never on arriving — so closing an untouched dialog
 * must not reach the server at all, let alone cancel a sign-in another tab is
 * running.
 *
 * AND `done` IS AN EXIT WITH NOTHING LEFT TO UNDO. The server's registration
 * put the previous account back as its last act (registerSignedIn), so a cancel
 * here would queue a second `cswap switch` to the account the machine is
 * already on, behind the store lock, for nothing. It is also the one state
 * where the two exits used to disagree: × sent the cancel and Done did not, so
 * the same success screen did two different things depending on which control
 * the reader happened to reach for.
 */
export function exitRequest(
  { started, state }: { started: boolean; state: LoginServerState | null | undefined },
): LoginExitRequest {
  if (!started) return null;
  if (state === "done") return null;
  return { action: "login-cancel" };
}
