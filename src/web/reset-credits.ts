// The one sentence both quota cards say about saved rate-limit resets.
//
// Claude calls them limit resets ("Reset for free" in its Settings → Usage) and
// Codex calls them rate-limit resets; the server sends both in the same shape
// (codex-quota.mjs and quota.mjs, #1308), and the panel prints both the same
// way. Its own module so the sentence can be checked by running it rather than
// by reading the component that prints it.

import { currentLanguage, t as tNow, type TFunction } from "./i18n";

/** Resets that can be spent now, and when the first of them lapses, in epoch
 *  milliseconds — null when none of them has an end. */
export interface ResetCredits { availableCount: number; nextExpiryAt: number | null }

/** en-US like every other date on the panel; the zone is left to the browser,
 *  so the time is the reader's own. */
const EXPIRY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true };

/**
 * "2 limit resets available · expires Oct 4, 2:00pm".
 *
 * The date AND the time, in the reader's local zone. A grant ends at an
 * instant, not on a day: the date alone left open whether a reset could still
 * be spent that evening, and a user asked for the time. The meridiem is
 * lower-cased the way the windows' own reset label writes it
 * (server/reset-label.mjs), so the two read alike in one panel.
 *
 * The expiry is joined with no-break spaces: the Codex sentence is longer than
 * the panel is wide, and wrapped freely it put "Oct 24," on one line and
 * "3:30pm" on the next. Now the line breaks before "expires", if at all.
 */
export function resetCreditsLine(noun: string, c: ResetCredits): string {
  const expiry = c.nextExpiryAt != null
    ? ` · ${`expires ${new Date(c.nextExpiryAt).toLocaleString("en-US", EXPIRY).replace(/\s+(AM|PM)/, (_, p: string) => p.toLowerCase())}`.replace(/\s/g, " ")}`
    : "";
  return `${c.availableCount} ${noun}${c.availableCount !== 1 ? "s" : ""} available${expiry}`;
}

/** The same line in the language on show: `kind` picks the noun ("limit" for
 *  Claude, "rate" for Codex), the date is written the way the language writes
 *  it, in the reader's own zone. */
export function resetCreditsText(kind: "limit" | "rate", c: ResetCredits, t: TFunction = tNow, lang: string = currentLanguage()): string {
  let expiry = "";
  if (c.nextExpiryAt != null) {
    const d = new Date(c.nextExpiryAt);
    const at = lang === "en"
      ? d.toLocaleString("en-US", EXPIRY).replace(/\s+(AM|PM)/, (_, p: string) => p.toLowerCase())
      : d.toLocaleString(lang, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    expiry = t("usage.credits.expires", { at: at.replace(/\s/g, "\u00a0") });
  }
  return t(`usage.credits.${kind}`, { count: c.availableCount, expiry });
}
