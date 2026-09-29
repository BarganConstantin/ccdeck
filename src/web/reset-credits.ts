// The one sentence both quota cards say about saved rate-limit resets.
//
// Claude calls them limit resets ("Reset for free" in its Settings → Usage) and
// Codex calls them rate-limit resets; the server sends both in the same shape
// (codex-quota.mjs and quota.mjs, #1308), and the panel prints both the same
// way. Its own module so the sentence can be checked by running it rather than
// by reading the component that prints it.

/** Resets that can be spent now, and when the first of them lapses, in epoch
 *  milliseconds — null when none of them has an end. */
export interface ResetCredits { availableCount: number; nextExpiryAt: number | null }

/**
 * "2 limit resets available · expires Oct 4".
 *
 * The date only, and in en-US like every other date on the panel: a grant lasts
 * weeks, and a date is how both products' own settings pages show it.
 */
export function resetCreditsLine(noun: string, c: ResetCredits): string {
  const expiry = c.nextExpiryAt != null
    ? ` · expires ${new Date(c.nextExpiryAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : "";
  return `${c.availableCount} ${noun}${c.availableCount !== 1 ? "s" : ""} available${expiry}`;
}
