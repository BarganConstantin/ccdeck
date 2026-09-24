/** How the Projects report names a window in a sentence. 0 = everything tracked. */
export function windowPhrase(days: number): string {
  if (days === 0) return "all time";
  if (days === 1) return "today";
  return `the last ${days} days`;
}

/** The empty report's sentence. "Today" is still under way, so it reads "yet". */
export function emptyWindowSentence(days: number): string {
  return days === 1
    ? "No work attributed to this account yet today."
    : `No work attributed to this account in ${windowPhrase(days)}.`;
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
