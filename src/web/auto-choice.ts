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
import { t as tNow, type TFunction } from "./i18n";

export type NextChoice = "room" | "weekly";

/** The picker's options, in its order. "room" is what Auto-switch always did. */
export const NEXT_OPTIONS: ReadonlyArray<{ value: NextChoice; label: string }> = [
  { value: "room", label: "Most room left" },
  { value: "weekly", label: "Soonest weekly reset" },
];

/** Said under the picker while it shows the weekly option, and only then. */
export const WEEKLY_HINT = "Uses up quota that resets within 4 days first";

/** The same two, in the language on show (the constants above stay English). */
export function nextOptionLabel(value: NextChoice, t: TFunction = tNow): string {
  return t(value === "weekly" ? "accounts.auto.next.weekly" : "accounts.auto.next.room");
}
export function weeklyHint(t: TFunction = tNow): string { return t("accounts.auto.weeklyHint"); }

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
export function homeTitle(a: Pick<Account, "disabled" | "alive" | "error" | "reauth">, autoOn: boolean, t: TFunction = tNow): string {
  if (!autoOn) return t("accounts.auto.home.off");
  if (a.disabled) return t("accounts.auto.home.held");
  if (a.alive === false || a.error || a.reauth) return t("accounts.auto.home.reauth");
  return t("accounts.auto.home.on");
}
