// What the accounts panel's fold is drawn from: the accounts behind it, as its
// row counts them, whether the live account is already past the auto-switch
// threshold, and whether anything is going to switch without a press.
//
// Lifted out of AccountsPanel.tsx unchanged, as three pure functions, so what
// the fold's row says can be run rather than read. Which accounts stand behind
// the fold at all is still the panel's (`head` and `rest`), and what the row
// makes of these three is other-accounts.ts's restLine.
import { accountIssue } from "./account-issue";
import { type Account, type AutoStatus } from "./claude-accounts";
import { laneKey } from "./lane-open";
import { type Peer } from "./other-accounts";

/** The accounts behind the fold, each as the fold's row counts it. */
/**
 * Whether the reader could switch to this account now: the same pair of
 * refusals the row's own `Switch` is withheld for, so the fold's count, the
 * button and the list's order (#1579) can never disagree about who can be
 * reached.
 */
export function reachable(a: Account, nowSec: number): boolean {
  return !a.disabled && !accountIssue(a, nowSec)?.blocksSwitch;
}

export function peersOf(
  rest: readonly Account[],
  nowSec: number,
  /** What Local network knows about each account's copies elsewhere, so a
   *  folded row says what its unfolded row does. */
  lanFor?: (a: Account) => { noCopyWorksNearby?: boolean },
): Peer[] {
  return rest.map(a => {
    const issue = accountIssue(a, nowSec, lanFor?.(a));
    return {
      key: laneKey(a),
      name: a.alias ?? a.email ?? `account ${a.num}`,
      ready: reachable(a, nowSec),
      why: a.disabled ? "held out" : issue?.blocksSwitch ? issue.text : null,
      warn: issue?.tone === "warn",
      headroom: a.headroom,
    };
  });
}

/**
 * Where auto-switch would already be acting. Past it, "where do I go next" is
 * the question the reader has, and the row answers it before it is unfolded.
 * Derived from the same `headroom` the peers carry rather than from a second
 * walk over the lanes, so the two numbers cannot disagree.
 */
export function pastThreshold(activeAcct: Account | undefined, threshold: string): boolean {
  const trip = Number(threshold);
  return activeAcct?.headroom != null && Number.isFinite(trip)
    && 100 - activeAcct.headroom >= trip;
}

/**
 * WHETHER ANYTHING IS GOING TO SWITCH WITHOUT A PRESS. The deck's own loop
 * and a `cswap auto` in a terminal are one fact to the fold's row: in both,
 * the reader is not the one picking, and in both a roster with nothing
 * reachable is a policy that will reach the threshold and do nothing. The
 * toggle can read `off` while the terminal loop runs — that is what
 * `external` is for — so the two are an OR and never the toggle alone.
 */
export function isAutoArmed(auto: AutoStatus | null): boolean {
  return auto?.ok === true && (auto.enabled || auto.external);
}
