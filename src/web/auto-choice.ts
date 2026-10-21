// What the accounts panel says about Auto-switch's two rules — the home
// account it comes back to, and how it picks the next one — and which row is
// home. The rules themselves are the server's (account-choice.mjs); this is
// their words, kept out of the JSX so the suite can read them.
//
// QUIET ON PURPOSE. The panel once had a strategy picker and lost it
// (#17, 2026-08-12): its two options only made sense to somebody who had read
// claude-swap's source. So the options are named by what they do, the one that
// is not obvious says so in one line under it, the 95 hours are not a field,
// and home is a mark on a row and a word in its ⋯ rather than another control.
import { type Account, type AutoChoice } from "./claude-accounts";

export type NextChoice = "room" | "weekly";

/** The picker's options, in its order. "room" is what Auto-switch always did. */
export const NEXT_OPTIONS: ReadonlyArray<{ value: NextChoice; label: string }> = [
  { value: "room", label: "Most room left" },
  { value: "weekly", label: "Soonest weekly reset" },
];

/** Said under the picker while it shows the weekly option, and only then. */
export const WEEKLY_HINT = "Uses up quota that resets within 4 days first";

export function isNextChoice(v: unknown): v is NextChoice {
  return v === "room" || v === "weekly";
}

/** Whether this row is the home account: the same identity, never the same
 *  slot — slots are reused, and the server keeps home by email and org. */
export function isHome(a: Pick<Account, "email" | "orgUuid">, home: AutoChoice["home"] | undefined): boolean {
  if (!home || !a.email) return false;
  return a.email.trim().toLowerCase() === home.email.trim().toLowerCase() && (a.orgUuid ?? "") === (home.orgUuid ?? "");
}

/** The home mark's title: what home does, or why Auto-switch is passing it
 *  over right now. */
export function homeTitle(a: Pick<Account, "disabled" | "alive" | "error" | "reauth">, autoOn: boolean): string {
  if (!autoOn) return "Home · Auto-switch comes back here while it is on";
  if (a.disabled) return "Home · paused while held out of rotation";
  if (a.alive === false || a.error || a.reauth) return "Home · paused until this account is signed in again";
  return "Home · Auto-switch comes back here after its 5-hour window resets";
}
