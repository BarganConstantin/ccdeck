import { t as tNow, type TFunction } from "./i18n";
import { fmtCost } from "./pricing";
import { fmtTokens } from "./token-format";
import { listNames } from "./accounts-time";

/** How the Projects report names a window in a sentence. 0 = everything tracked. */
export function windowPhrase(days: number, t: TFunction = tNow): string {
  if (days === 0) return t("accounts.projects.allTime");
  if (days === 1) return t("accounts.projects.today");
  return t("accounts.projects.lastDays", { n: days });
}

/** The empty report's sentence. "Today" is still under way, so it reads "yet". */
export function emptyWindowSentence(days: number, t: TFunction = tNow): string {
  return days === 1
    ? t("accounts.projects.emptyToday")
    : t("accounts.projects.empty", { window: windowPhrase(days, t) });
}

/** The next wider window an empty report can offer, or null from the widest. */
export function widerWindow(days: number): number | null {
  if (days === 1) return 7;
  if (days === 7) return 30;
  if (days === 30) return 0;
  return null;
}

/** A single day has one bar, which only repeats the total above it. */
export function showsDayChart(days: number, chartDays: number): boolean {
  return days !== 1 && chartDays > 0;
}

/** projectCostLabel (account-projects-reconcile.ts) with the "not priced" word
 *  in the language on show: a floor reads "$12+", nothing priced reads the word. */
export function projectCostText(usd: number, unpricedTokens: number, fmt: (usd: number) => string = fmtCost, t: TFunction = tNow): string {
  if (!(unpricedTokens > 0)) return fmt(usd);
  return usd > 0 ? `${fmt(usd)}+` : t("accounts.projects.notPriced");
}

/** unpricedTitle, in the language on show. */
export function unpricedTitleText(unpricedTokens: number, t: TFunction = tNow): string | undefined {
  return unpricedTokens > 0 ? t("accounts.projects.unpricedTitle", { tokens: fmtTokens(unpricedTokens) }) : undefined;
}

/** unpricedNote, in the language on show: the sentence that names what the
 *  "+" leaves out. */
export function unpricedNoteText(models: string[], t: TFunction = tNow): string | null {
  if (models.length === 0) return null;
  const label = t("accounts.projects.notPriced");
  return t(models.length === 1 ? "accounts.projects.unpricedOne" : "accounts.projects.unpricedMany", { list: listNames(models), label });
}
