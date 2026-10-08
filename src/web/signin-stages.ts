// What the sign-in dialog shows while an account is being added.
//
// The dialog used to say one thing between "Open the sign-in page" and the
// success card: a Continue button whose label turned into "registering…". The
// sign-in passes through four points the deck genuinely knows about, and this
// module is the map from what the server reports to those four:
//
//   link     `claude auth login` was started and has not printed its link yet
//            (the start request is out, or the server says awaiting_url)
//   approve  the link is out and a browser tab opened on it; the user approves
//            there, or pastes a code here when the page shows one
//   confirm  the CLI finished and is being asked who signed in — `registering`
//            with step "confirm", which a pasted code also starts on
//   save     claude-swap records the account and the account the user was on
//            goes back in front — steps "save" and "restore"
//
// Nothing here is estimated. There is no percentage and no stage the server
// does not report, and claude-swap's plan-and-quota read is not a stage at all:
// the server starts it detached and does not wait for it, so the dialog must
// not either. Kept out of AddAccountDialog so the order, the mapping, every
// stage's failure and the timings can be tested without React or a DOM.
import type { LoginServerState } from "./login-flow";
import { LOGIN_VANISHED } from "./login-flow";

export type SignInStage = "link" | "approve" | "confirm" | "save";
/** Where inside `registering` the server is — LOGIN_STEPS in cswap-admin.mjs. */
export type SignInStep = "confirm" | "save" | "restore";
export type StageStatus = "done" | "active" | "pending" | "failed";
export type StageRow = { id: SignInStage; status: StageStatus; label: string };

/** The four, in the order a sign-in passes through them and the list draws them. */
export const SIGN_IN_STAGES: readonly SignInStage[] = ["link", "approve", "confirm", "save"];

const STEP_STAGE: Record<SignInStep, SignInStage> = { confirm: "confirm", save: "save", restore: "save" };

/** The stage a server step belongs to, or null for a step this build does not
 *  know — which an older or newer server could send. */
export function stageOfStep(step: string | null | undefined): SignInStage | null {
  return step != null && Object.prototype.hasOwnProperty.call(STEP_STAGE, step)
    ? STEP_STAGE[step as SignInStep]
    : null;
}

/**
 * The stage a sign-in that is still moving is at, or null when nothing is.
 *
 * `starting` is the dialog's own half: between the press and the server's
 * first answer there is no state to read yet, and the request that is out is
 * the link being asked for. A `registering` without a step this build knows is
 * placed at confirm, the first thing registering does, rather than nowhere.
 */
export function liveStage(
  { state, step, starting }: { state?: LoginServerState | string | null; step?: string | null; starting?: boolean },
): SignInStage | null {
  if (state === "registering") return stageOfStep(step) ?? "confirm";
  if (state === "awaiting_code") return "approve";
  if (state === "awaiting_url") return "link";
  if (state == null && starting) return "link";
  return null;
}

/**
 * Which stage an ended sign-in stopped at.
 *
 * The server leaves `step` on whatever was running when something after the
 * browser failed. Before that there is no step, and the link is what tells the
 * two earlier stages apart: a sign-in that never printed one failed to open the
 * page, and one that did failed while waiting on the browser — the window ran
 * out, or the CLI exited with an error. A flow the server forgot ("idle") has
 * nothing left to say where it was, so the dialog's own last sighting does.
 */
export function failedStage(
  { state, step, url, lastLive }: {
    state?: string | null; step?: string | null; url?: string | null; lastLive?: SignInStage | null;
  },
): SignInStage {
  if (state === "failed") return stageOfStep(step) ?? (url ? "approve" : "link");
  if (state === "idle") return lastLive ?? "link";
  return "link";
}

const LABELS: Record<SignInStage, Record<"pending" | "active" | "done", string>> = {
  link:    { pending: "Open the sign-in page",   active: "Opening the sign-in page",                  done: "Sign-in page opened" },
  approve: { pending: "Approve in your browser", active: "Waiting for you to approve in the browser", done: "Approved in the browser" },
  confirm: { pending: "Confirm who signed in",   active: "Confirming who signed in",                  done: "Sign-in confirmed" },
  save:    { pending: "Save the credentials",    active: "Saving the credentials",                    done: "Credentials saved" },
};

/**
 * A row's words for its status. A failed row says what went wrong in a few
 * words — its heading — and the sentence under it says why; `state` tells a
 * flow the server forgot ("idle") from one that failed.
 */
export function stageLabel(id: SignInStage, status: StageStatus, state?: string | null): string {
  return status === "failed" ? stageFailureTitle(id, state) : LABELS[id][status];
}

/**
 * Every row of the list, from where the sign-in is.
 *
 * Exactly one of `live`, `failed` and `done` is the answer: everything before
 * that stage is done, it is active or failed, and everything after it waits.
 * `done` ticks all four. With none of them the list is all pending, which the
 * dialog never draws but which is still a list rather than a throw.
 */
export function stageRows(
  { live = null, failed = null, done = false, state = null }: {
    live?: SignInStage | null; failed?: SignInStage | null; done?: boolean; state?: string | null;
  },
): StageRow[] {
  const at = done ? SIGN_IN_STAGES.length : SIGN_IN_STAGES.indexOf((failed ?? live)!);
  return SIGN_IN_STAGES.map((id, i) => {
    const status: StageStatus = done || i < at ? "done"
      : i > at || at < 0 ? "pending"
      : failed ? "failed" : "active";
    return { id, status, label: stageLabel(id, status, state) };
  });
}

/**
 * The sentence under the active row: what the deck is doing, in its own words,
 * and on the approve row what the user has to do. Save has two because the
 * server reports two steps under it, and the second — putting the user's own
 * account back in front — is the one they would otherwise wonder about.
 */
export function stageDetail(id: SignInStage, step?: string | null): string {
  switch (id) {
    case "link": return "The claude CLI is preparing a sign-in link, and opens a browser tab with it.";
    case "approve": return "Approve the sign-in in the tab that opened. This finishes by itself.";
    case "confirm": return "Asking the claude CLI which account just signed in.";
    case "save": return step === "restore"
      ? "Switching this machine back to the account you were using."
      : "claude-swap is recording the account.";
  }
}

const FAILED_TITLES: Record<SignInStage, string> = {
  link: "The sign-in page did not open",
  approve: "The sign-in did not finish in the browser",
  confirm: "The sign-in could not be confirmed",
  save: "claude-swap could not save the account",
};

/** The heading a failed stage gets — or "Sign-in ended" for a flow the server
 *  forgot, which is not a failure of any stage. */
export function stageFailureTitle(id: SignInStage, state?: string | null): string {
  return state === "idle" ? "Sign-in ended" : FAILED_TITLES[id];
}

/** Product and command names the server's reasons start with. They are
 *  written in lower case on purpose and stay that way. */
const LOWERCASE_NAMES = /^(?:claude|claude-swap|cswap|ccdeck|npm|uv)\b/;

/**
 * A server reason as a sentence: a capital, unless it opens on a name that is
 * spelled in lower case, and a full stop. The reasons are written as clauses
 * ("the sign-in window expired") because the accounts panel strings them into
 * longer lines; here each one stands alone under a heading.
 */
export function asSentence(text: string | null | undefined): string {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const head = LOWERCASE_NAMES.test(t) ? t : t[0].toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(head) ? head : `${head}.`;
}

/** The message an ended sign-in shows when nothing more specific arrived. */
export const SIGN_IN_VANISHED = asSentence(LOGIN_VANISHED);

// ── timing ──────────────────────────────────────────────────────────────────

/** How long the browser may take before the dialog offers a way back to it. */
export const SLOW_BROWSER_MS = 10_000;
/** How long an import may take before the dialog says it is still going. */
export const SLOW_IMPORT_MS = 10_000;
/** `claude auth login`'s own deadline (LOGIN_TIMEOUT_MS in cswap-admin.mjs). */
const LOGIN_WINDOW_MINUTES = 5;

/**
 * The hint under the approve row once the browser has been slow, or null.
 *
 * Nothing at all for the first ten seconds: a hint that appears while the user
 * is still reading the consent page is a nag. After that it says the one useful
 * thing — the tab can be reopened — and, when the server's deadline can be
 * read, how long the sign-in stays open. The deadline is the server's clock and
 * `now` the page's, so a count that comes out implausible (a deck on another
 * machine with a skewed clock) is left out rather than shown wrong.
 */
export function approveHint(
  { since, now, expiresAt }: { since: number | null; now: number; expiresAt?: number | null },
): string | null {
  if (since == null || now - since < SLOW_BROWSER_MS) return null;
  const left = expiresAt != null ? Math.ceil((expiresAt - now) / 60_000) : NaN;
  const lead = "Still waiting for the browser. If no tab opened, or you closed it, use the link above";
  return left >= 1 && left <= LOGIN_WINDOW_MINUTES
    ? `${lead} — the sign-in stays open ${left} more minute${left === 1 ? "" : "s"}.`
    : `${lead}.`;
}

/** The line under the import once it has been slow, or null. claude-swap's
 *  own timeout is a minute (CSWAP_TIMEOUT_MS), which is what makes this true. */
export function importHint({ since, now }: { since: number | null; now: number }): string | null {
  if (since == null || now - since < SLOW_IMPORT_MS) return null;
  return "Still importing. claude-swap stops by itself after a minute if it cannot finish.";
}

/**
 * How often the dialog asks the server where the sign-in is.
 *
 * The browser half is minutes of a person reading a consent page, and 1.5s is
 * plenty for it. Registering is the opposite — three short commands, usually
 * done in a few seconds — and at 1.5s a whole step could start and finish
 * between two looks, ticking off without ever having been shown as running. The
 * read is a localhost GET of an in-memory object, so a third of a second costs
 * nothing.
 */
export function loginPollMs(state: string | null | undefined): number {
  return state === "registering" ? 400 : 1500;
}

// ── the handoff into the success card ──────────────────────────────────────

/** How long the finished list stays up while the ring closes, before the
 *  success card takes its place — the ring's sweep plus the list's fade. */
export const HANDOFF_MS = 460;

/**
 * How long to hold the finished list before the success card replaces it.
 *
 * Only when the list was what the user was watching: a sign-in that finished
 * while the dialog was on another tab, or before the list ever drew, goes
 * straight to the card. And never under reduced motion, where the hold would be
 * a pause with nothing moving in it.
 */
export function handoffHold({ fromStages, reducedMotion }: { fromStages: boolean; reducedMotion: boolean }): number {
  return fromStages && !reducedMotion ? HANDOFF_MS : 0;
}

/**
 * Whether the success card throws confetti.
 *
 * Only for an account that is new here. A refresh is the same account signing
 * in again — worth a check mark, not a party — and the paste tab already holds
 * its burst back for imports that changed nothing, for the same reason: a
 * celebration that fires for maintenance stops meaning anything. Never under
 * reduced motion, where it is decoration and nothing else.
 */
export function celebrates({ added, reducedMotion }: { added: boolean; reducedMotion: boolean }): boolean {
  return added && !reducedMotion;
}

/** The success card's heading. */
export function doneTitle({ num, added }: { num: string | null; added: boolean }): string {
  if (!added) return "Credentials refreshed";
  return num != null && num !== "" ? `Account ${num} added` : "Account added";
}

// ── what a screen reader hears ─────────────────────────────────────────────

/**
 * The polite announcement for a stage becoming active, or null.
 *
 * One sentence per stage, said once when the stage starts — never for the
 * elapsed hint, the restore step inside save, or a poll that changed nothing.
 * Link is left out because it is answering the press the user just made, and
 * the next sentence arrives within a second.
 */
export function stageAnnouncement(id: SignInStage | null): string | null {
  switch (id) {
    case "approve": return "Waiting for you to approve the sign-in in your browser.";
    case "confirm": return "Approved. Confirming who signed in.";
    case "save": return "Saving the credentials.";
    default: return null;
  }
}
