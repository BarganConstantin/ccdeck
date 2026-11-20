// The one sentence both quota cards say about saved rate-limit resets.
//
// Claude calls them limit resets ("Reset for free" in its Settings → Usage) and
// Codex calls them rate-limit resets; the server sends both in the same shape
// (codex-quota.mjs and quota.mjs, #1308), and the panel prints both the same
// way. Its own module so the sentence can be checked by running it rather than
// by reading the component that prints it.
//
// CLAUDE'S COME IN KINDS. A Fable reset gives back what Fable used to the
// weekly limit and a full one clears every limit, and "1 limit reset" said
// neither (user feedback). The server now sends Claude's as one group per kind
// (claude-reset-credits.mjs), and the panel prints a line for each.

import { currentLanguage, t as tNow, type TFunction } from "./i18n";

/** Resets that can be spent now, and when the first of them lapses, in epoch
 *  milliseconds — null when none of them has an end. */
export interface ResetCredits { availableCount: number; nextExpiryAt: number | null }

/** Which limit a Claude reset clears, as the server words it: a Fable reset,
 *  a full one (every limit), a weekly one, a 5-hour one, or one whose grant did
 *  not say. In the order the panel lists them. */
export const RESET_KINDS = ["fable", "full", "weekly", "session", "unknown"] as const;
export type ResetKind = typeof RESET_KINDS[number];

/** One line of Claude's resets: how many of one kind, and when the first ends. */
export interface ResetCreditGroup extends ResetCredits { kind: ResetKind }

const isGroup = (v: unknown): v is ResetCredits => {
  if (!v || typeof v !== "object") return false;
  const { availableCount, nextExpiryAt } = v as Record<string, unknown>;
  return Number.isInteger(availableCount) && (availableCount as number) > 0
    && (nextExpiryAt === null || (typeof nextExpiryAt === "number" && Number.isFinite(nextExpiryAt)));
};

const kindOf = (g: ResetCredits): ResetKind => {
  const kind = (g as { kind?: unknown }).kind;
  return (RESET_KINDS as readonly unknown[]).includes(kind) ? kind as ResetKind : "unknown";
};

/**
 * Claude's resets as the lines the panel prints, in RESET_KINDS' order, only
 * the kinds with one to spend.
 *
 * A deck from before the kinds sends the single total it always sent, and a
 * page left open across an upgrade can hold one; that total is one line of
 * the kind nobody named, worded as it always was. A kind this page does not
 * know is that same line. Anything else is nothing, as an absent inventory is.
 */
export function resetCreditGroups(v: unknown): ResetCreditGroup[] {
  if (!Array.isArray(v)) return isGroup(v) ? [{ kind: "unknown", availableCount: v.availableCount, nextExpiryAt: v.nextExpiryAt }] : [];
  const groups = v.filter(isGroup);
  return RESET_KINDS.flatMap(kind => {
    const of = groups.filter(g => kindOf(g) === kind);
    if (!of.length) return [];
    const ends = of.map(g => g.nextExpiryAt).filter((e): e is number => e != null);
    return [{ kind, availableCount: of.reduce((n, g) => n + g.availableCount, 0), nextExpiryAt: ends.length ? Math.min(...ends) : null }];
  });
}

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
 *  Claude's resets of no named kind, "rate" for Codex, and Claude's kinds by
 *  name — "Fable reset", "Global reset" for a full one, "weekly reset",
 *  "5-hour reset"), the date is written the way the language writes it, in the
 *  reader's own zone. */
export function resetCreditsText(kind: "limit" | "rate" | Exclude<ResetKind, "unknown">, c: ResetCredits, t: TFunction = tNow, lang: string = currentLanguage()): string {
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

/** Claude's line for one group: the kind's own noun, the neutral one for a
 *  grant that did not say. */
export function resetGroupText(g: ResetCreditGroup, t: TFunction = tNow, lang: string = currentLanguage()): string {
  return resetCreditsText(g.kind === "unknown" ? "limit" : g.kind, g, t, lang);
}

/** The line's title: what a Fable or a Global reset does, over where any of
 *  them is redeemed (`where`, the card's own sentence). The other kinds say
 *  what they clear in their name. */
export function resetGroupTitle(kind: ResetKind, where: string, t: TFunction = tNow): string {
  if (kind === "fable") return `${t("usage.credits.fableTitle")}\n${where}`;
  if (kind === "full") return `${t("usage.credits.fullTitle")}\n${where}`;
  return where;
}
