// What is wrong with an account, said in the product's voice.
//
// Lifted out of AccountsPanel.tsx unchanged. claude-swap reports trouble in
// three ways — a read that failed (`error`), a collector that stopped with its
// verdict (`stopped`, `collector`), and a stored copy the deck is re-capturing
// (`staleCopy`) — and this is where each becomes the words a row says, and
// where the one decision the row, the notice over the list and the warning's
// popover all draw from is made. None of it touches React. It sat in the
// component because the component was its only reader, which had two test
// files importing a component of nearly two thousand lines to reach four pure
// functions.

import { t as tNow, type TFunction } from "./i18n";

/** A verb from picker-commit.ts as a button in the popover says it. Those words
 *  are lowercase because the row's pills are; the popover's buttons are in
 *  sentence case, like every dialog button in the deck.
 *  The words an issue says go through it as well, which is why it lives here
 *  and the panel's move button imports it. */
export function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** How the server's re-capture of a `staleCopy` row is going (autoRecapture). */
export type Repair = { state: "running" } | { state: "failed"; reason: string | null; retryAt: number };

/** The parts of an account row this file reads: the three kinds of trouble the
 *  server sends, and how the deck's repair of the third is going. The panel's
 *  roster rows are these and more. */
export interface IssueSource {
  error: string | null;
  stopped?: boolean;
  collector?: string | null;
  staleCopy?: boolean;
  repair?: Repair | null;
}

/**
 * What a `staleCopy` row says (#721): the login works, claude-swap's stored copy
 * of it does not, and the deck re-captures the copy on its own.
 *
 * `resuming…` while that runs, `numbers paused` once an attempt has not taken,
 * with when the next one is. No state at all is a deck that is not repairing —
 * so it says only what is true without promising anything. Exported for its
 * test.
 */
export function staleCopyText(repair: Repair | null, nowSec: number, t: TFunction = tNow): { text: string; hint: string } {
  const why = t("accounts.issue.stale.why");
  if (repair?.state === "running") {
    return { text: t("accounts.issue.stale.running"), hint: t("accounts.issue.stale.runningHint", { why }) };
  }
  if (repair?.state === "failed") {
    const mins = Math.max(1, Math.ceil((repair.retryAt / 1000 - nowSec) / 60));
    const what = repair.reason
      ? t("accounts.issue.stale.failedReason", { reason: repair.reason })
      : t("accounts.issue.stale.failed");
    return { text: t("accounts.issue.stale.paused"), hint: t("accounts.issue.stale.failedHint", { why, what, mins }) };
  }
  return { text: t("accounts.issue.stale.paused"), hint: why };
}

/**
 * claude-swap's failure codes, said in the product's voice.
 *
 * These come straight out of its store, and the panel used to print whatever it
 * found — which is how a user ended up looking at `invalid_grant` on their
 * ACTIVE account with nothing to do about it. Two of these are permanent and
 * only the user can clear them: the stored refresh token is dead, and every
 * poll will keep failing until someone signs in again. Those get `fixable`, and
 * the row grows a button.
 */
export function errorText(code: string, t: TFunction = tNow): { text: string; hint: string; fixable: boolean } {
  switch (code) {
    case "invalid_grant":
    case "no_refresh_token":
      return {
        text: t("accounts.issue.err.expired"),
        hint: t("accounts.issue.err.expiredHint"),
        fixable: true,
      };
    case "http-401":
      return { text: t("accounts.issue.err.relogin"), hint: t("accounts.issue.err.reloginHint"), fixable: true };
    case "http-429":
      return { text: t("accounts.issue.err.rate"), hint: t("accounts.issue.err.rateHint"), fixable: false };
    case "transient":
      return { text: t("accounts.issue.err.transient"), hint: t("accounts.issue.err.transientHint"), fixable: false };
    case "timeout":
      return { text: t("accounts.issue.err.timeout"), hint: t("accounts.issue.err.timeoutHint"), fixable: false };
    case "network":
      return { text: t("accounts.issue.err.network"), hint: t("accounts.issue.err.networkHint"), fixable: false };
    default:
      // Still shown, because a code we have not met is better than silence —
      // but labelled as one, so it does not read as a sentence.
      return { text: code, hint: t("accounts.issue.reported", { code }), fixable: false };
  }
}

/**
 * claude-swap's verdict for a slot, said in the product's voice.
 *
 * THREE STATES, THREE DIFFERENT THINGS TO DO, and until this existed the panel
 * collapsed all of them into one silence. Measured at one instant on the same
 * account: `usage.json` said `consecutiveFailures: 0, lastError: null` while
 * `cswap list` said `no_credentials`. The counter cannot tell them apart, and
 * for two of the three it reads zero.
 *
 * The third one is the reason this is worth a sentence rather than a word:
 * `keychain_unavailable` is not about the account at all. Measured on this
 * machine — the same command, the same instant, two sessions:
 *
 *   from a background session  ->  keychain_unavailable, keychain_unavailable
 *   from the GUI session       ->  no_credentials,       relogin_required
 *
 * A deck started where it cannot reach the keychain reports every account as
 * broken and none of them are. Saying which of the two happened is the
 * difference between a person re-adding an account they already have and a
 * person starting the deck differently.
 */
export function collectorText(code: string | null, t: TFunction = tNow): { text: string; hint: string; fix?: string } | null {
  switch (code) {
    case "no_credentials":
      return {
        text: t("accounts.issue.col.none"),
        hint: t("accounts.issue.col.noneHint"),
        // NOT "again". There is nothing there to replace — this is the first
        // login claude-swap will hold for this slot.
        fix: t("accounts.issue.col.noneFix"),
      };
    case "relogin_required":
      return {
        text: t("accounts.issue.err.expired"),
        hint: t("accounts.issue.err.expiredHint"),
        fix: t("accounts.issue.col.againFix"),
      };
    case "keychain_unavailable":
      return {
        text: t("accounts.issue.col.keychain"),
        hint: t("accounts.issue.col.keychainHint"),
        // NO `fix`, and this is the case that makes the field worth having
        // rather than always offering a button: nothing is wrong with the
        // account, and a sign-in here would have somebody replace a working
        // login to repair a deck that was started in the wrong place.
      };
    case "token_expired":
      return { text: t("accounts.issue.col.tokenExpired"), hint: t("accounts.issue.col.tokenExpiredHint") };
    case "foreign_credential":
      return { text: t("accounts.issue.col.foreign"), hint: t("accounts.issue.col.foreignHint") };
    case null:
    case undefined:
      return null;
    default:
      return { text: code, hint: t("accounts.issue.reported", { code }) };
  }
}

/**
 * What is wrong with an account, decided once, for the row, the notice over the
 * list and the popover that explains it.
 *
 * The three fields the server sends — `error`, `stopped` with claude-swap's
 * verdict, `staleCopy` — never arrive together (authTrouble returns one kind),
 * and each already has its sentence in this file. What this adds is the two
 * decisions the row makes about them: whether the problem is the reader's to
 * act on (`warn`, the amber mark) or something that clears or repairs on its own
 * (`quiet`), and whether a switch to the account can work at all. A login that
 * is dead or was never stored cannot be switched to — the switch would only put
 * the dead one live — so the row does not offer it.
 */
export interface AccountIssue {
  /** The row's words, in sentence case. */
  text: string;
  /** The whole explanation — claude-swap's verdict in the product's voice. */
  hint: string;
  /** The one press that repairs it, when there is one. */
  fix: string | null;
  tone: "warn" | "quiet";
  blocksSwitch: boolean;
}

/** accounts.issue.everywhere / everywhereHint: what a dead login's row says when no paired deck can repair it — see
 *  noCopyWorksNearby. The visible line names the one fact that changes what
 *  to do; the hint says why it happens and what a single sign-in repairs —
 *  on a machine that shares the login, since one that does not hands it to
 *  nobody, and the row can be a login that is not ticked here. */
export function accountIssue(
  a: IssueSource,
  nowSec: number,
  /** Whether any paired online deck has a working copy for recovery. */
  lan?: { noCopyWorksNearby?: boolean },
  t: TFunction = tNow,
): AccountIssue | null {
  const issue = ownIssue(a, nowSec, t);
  if (!issue || !lan?.noCopyWorksNearby || !deadLogin(a)) return issue;
  return { ...issue, text: t("accounts.issue.everywhere"), hint: t("accounts.issue.everywhereHint") };
}

/** A stored login that only a sign-in can bring back, as the row's own issue
 *  says it: the collector stopped on a quarantined slot, or the stored token
 *  was refused outright.
 *
 *  NEVER A STALE COPY (#721). There the reader IS signed in — only the copy
 *  claude-swap keeps is dead, and the deck re-captures it by itself — so
 *  telling them to sign in again, on every deck, is the false alarm #721
 *  removed. And never on the collector's verdict alone: a row whose issue is
 *  a rate limit is about the rate limit, whatever the verdict beside it.
 *
 *  Exported for reauth-prompt-1893.test.ts, which holds the server's copy of
 *  this rule — needsSignIn in account-origins.mjs — to it. */
export function deadLogin(a: IssueSource): boolean {
  if (a.staleCopy) return false;
  if (a.stopped) return a.collector === "relogin_required";
  return a.error === "invalid_grant" || a.error === "no_refresh_token";
}

function ownIssue(
  a: IssueSource,
  nowSec: number,
  t: TFunction,
): AccountIssue | null {
  if (a.staleCopy) {
    // Signed in, and the deck is re-capturing the copy by itself (#721): news,
    // not a task.
    const s = staleCopyText(a.repair ?? null, nowSec, t);
    return { text: sentence(s.text), hint: s.hint, fix: null, tone: "quiet", blocksSwitch: false };
  }
  if (a.stopped) {
    const v = collectorText(a.collector ?? null, t);
    if (!v) {
      return {
        text: t("accounts.issue.notCollecting"),
        hint: t("accounts.issue.notCollectingHint"),
        fix: null,
        tone: "quiet",
        blocksSwitch: false,
      };
    }
    const dead = a.collector === "no_credentials" || a.collector === "relogin_required";
    return {
      text: sentence(v.text),
      hint: v.hint,
      fix: v.fix ? sentence(v.fix) : null,
      // An unreadable keychain is not the account's fault, and it is still the
      // reader's to fix: the deck has to be started from somewhere that can
      // reach it.
      tone: dead || a.collector === "keychain_unavailable" ? "warn" : "quiet",
      blocksSwitch: dead,
    };
  }
  if (a.error) {
    const e = errorText(a.error, t);
    return { text: sentence(e.text), hint: e.hint, fix: e.fixable ? t("accounts.issue.signInAgain") : null, tone: e.fixable ? "warn" : "quiet", blocksSwitch: e.fixable };
  }
  return null;
}
