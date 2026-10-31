import { t as tNow, type TFunction } from "./i18n";

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
