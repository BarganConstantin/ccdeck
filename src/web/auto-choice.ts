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

/** The picker's options, in its order, each with the key of its name.
 *  "room" is what Auto-switch always did. */
export const NEXT_OPTIONS: ReadonlyArray<{ value: NextChoice; labelMsg: string }> = [
  { value: "room", labelMsg: "accounts.auto.next.room" },
  { value: "weekly", labelMsg: "accounts.auto.next.weekly" },
];

/** Said under the picker while it shows the weekly option, and only then. */
export const WEEKLY_HINT_MSG = "accounts.auto.weeklyHint";

/** The same two, in the language on show. */
export function nextOptionLabel(value: NextChoice, t: TFunction = tNow): string {
  return t(NEXT_OPTIONS.find(o => o.value === value)?.labelMsg ?? NEXT_OPTIONS[0].labelMsg);
}
export function weeklyHint(t: TFunction = tNow): string { return t(WEEKLY_HINT_MSG); }

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

/** The same title on a Codex row. Its home is come back to once it has room
 *  again, not after a 5-hour window: a Codex plan may have only the weekly one
 *  (codex-auto.mjs). */
export function codexHomeTitle(a: Pick<Account, "disabled">, signedIn: boolean, autoOn: boolean, t: TFunction = tNow): string {
  if (!autoOn) return t("accounts.auto.home.off");
  if (a.disabled) return t("accounts.auto.home.held");
  if (!signedIn) return t("accounts.auto.home.reauth");
  return t("codex.auto.home.on");
}
