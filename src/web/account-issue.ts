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
export function staleCopyText(repair: Repair | null, nowSec: number): { text: string; hint: string } {
  const why = "The deck can still see this account — its live usage is being read — but claude-swap's "
    + "own stored copy of the login was rejected, so these numbers stopped updating.";
  if (repair?.state === "running") {
    return { text: "resuming…", hint: `${why} The deck is re-capturing it from the login you already have. No sign-in, no switch.` };
  }
  if (repair?.state === "failed") {
    const mins = Math.max(1, Math.ceil((repair.retryAt / 1000 - nowSec) / 60));
    const what = repair.reason
      ? `Re-capturing it from the login you already have did not work (${repair.reason}).`
      : "The deck re-captured it from the login you already have, and claude-swap still cannot read it.";
    return { text: "numbers paused", hint: `${why} ${what} It tries again in ${mins}m. No sign-in, no switch.` };
  }
  return { text: "numbers paused", hint: why };
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
export function errorText(code: string): { text: string; hint: string; fixable: boolean } {
  switch (code) {
    case "invalid_grant":
    case "no_refresh_token":
      return {
        text: "login expired",
        hint: "claude-swap's stored login for this account was rejected and cannot be refreshed. "
            + "Signing in again replaces it — the account keeps its slot, its alias and its history.",
        fixable: true,
      };
    case "http-401":
      return { text: "re-login needed", hint: "Anthropic refused this account's token.", fixable: true };
    case "http-429":
      return { text: "rate limited", hint: "Anthropic is throttling requests for this account. It clears on its own.", fixable: false };
    case "transient":
      return { text: "temporary error", hint: "A network or server hiccup while reading usage. The next collection retries.", fixable: false };
    case "timeout":
      return { text: "timed out", hint: "Reading this account's usage took too long. The next collection retries.", fixable: false };
    case "network":
      return { text: "unreachable", hint: "Could not reach Anthropic to read this account's usage.", fixable: false };
    default:
      // Still shown, because a code we have not met is better than silence —
      // but labelled as one, so it does not read as a sentence.
      return { text: code, hint: `claude-swap reported "${code}" for this account.`, fixable: false };
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
export function collectorText(code: string | null): { text: string; hint: string; fix?: string } | null {
  switch (code) {
    case "no_credentials":
      return {
        text: "no stored login",
        hint: "claude-swap holds no credentials for this account, so there is nothing to read its usage with "
            + "and nothing to switch to. A paired deck that has them sends them on its own; signing in as "
            + "this account puts them there by hand.",
        // NOT "again". There is nothing there to replace — this is the first
        // login claude-swap will hold for this slot.
        fix: "sign in",
      };
    case "relogin_required":
      return {
        text: "login expired",
        hint: "claude-swap's stored login for this account was rejected and cannot be refreshed. "
            + "Signing in again replaces it — the account keeps its slot, its alias and its history.",
        fix: "sign in again",
      };
    case "keychain_unavailable":
      return {
        text: "keychain unreadable",
        hint: "This is about the deck, not the account: claude-swap could not open your keychain, so it cannot "
            + "read any account's stored login. A deck started from a background session cannot reach the "
            + "keychain at all — start it from a terminal, or let it start at login, and this clears.",
        // NO `fix`, and this is the case that makes the field worth having
        // rather than always offering a button: nothing is wrong with the
        // account, and a sign-in here would have somebody replace a working
        // login to repair a deck that was started in the wrong place.
      };
    case "token_expired":
      return { text: "token expired", hint: "The access token ran out and the refresh was deferred. The next collection retries." };
    case "foreign_credential":
      return { text: "wrong credential", hint: "The live credential belongs to a different account. Switching to this one repairs it." };
    case null:
    case undefined:
      return null;
    default:
      return { text: code, hint: `claude-swap reported "${code}" for this account.` };
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

/** What a dead login's row says when no paired deck can repair it — see
 *  noCopyWorksNearby. The visible line names the one fact that changes what
 *  to do; the hint says why it happens and what a single sign-in repairs. */
const EXPIRED_EVERYWHERE = {
  text: "Login expired on every deck",
  hint: "Every paired deck that shares this account holds a copy that has expired too, so none of them can "
      + "repair this one. Claude retires a login's other copies each time one machine refreshes it, which is "
      + "how shared copies expire together. Sign in again on any one machine; the others repair from it on "
      + "their next round.",
};

export function accountIssue(
  a: IssueSource,
  nowSec: number,
  /** What Local network knows about this account's copies on other decks. */
  lan?: { noCopyWorksNearby?: boolean },
): AccountIssue | null {
  const issue = ownIssue(a, nowSec);
  if (!issue || !lan?.noCopyWorksNearby || !deadLogin(a)) return issue;
  return { ...issue, text: EXPIRED_EVERYWHERE.text, hint: EXPIRED_EVERYWHERE.hint };
}

/** A stored login that only a sign-in can bring back — the two verdicts and
 *  the two errors that say so. */
function deadLogin(a: IssueSource): boolean {
  return a.collector === "relogin_required"
    || (!a.stopped && (a.error === "invalid_grant" || a.error === "no_refresh_token"));
}

function ownIssue(
  a: IssueSource,
  nowSec: number,
): AccountIssue | null {
  if (a.staleCopy) {
    // Signed in, and the deck is re-capturing the copy by itself (#721): news,
    // not a task.
    const s = staleCopyText(a.repair ?? null, nowSec);
    return { text: sentence(s.text), hint: s.hint, fix: null, tone: "quiet", blocksSwitch: false };
  }
  if (a.stopped) {
    const v = collectorText(a.collector ?? null);
    if (!v) {
      return {
        text: "Not collecting",
        hint: "claude-swap has collected nothing for this account in over half a day and has not said why. "
            + "A paired deck holding a working copy of this account will replace it on its own. "
            + "To do it by hand, sign in as this account from + Add.",
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
    const e = errorText(a.error);
    return { text: sentence(e.text), hint: e.hint, fix: e.fixable ? "Sign in again" : null, tone: e.fixable ? "warn" : "quiet", blocksSwitch: e.fixable };
  }
  return null;
}
