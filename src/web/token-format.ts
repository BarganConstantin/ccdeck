// Token counts in the deck's voice: "999", "1.5k", "3.40M", "2.30B".
//
// Three copies of this lived in the tree: byte-identical private `fmtTokens`
// functions in App.tsx and UsagePanel.tsx, plus `fmtN` in UsageHistoryModal.tsx
// — the same function with a billions tier bolted on the end. They agreed on
// every value below 1e9, so nothing ever looked wrong when two of them were on
// screen together, and that is exactly why the divergence survived: the usage
// panel's cache-read total passes a billion after a day of heavy cache hits and
// printed "2300.00M", while the history modal beside it printed "2.30B" for the
// same tokens. The modal grew the extra tier because it sums a whole month.
//
// The four-tier version won. Below 1e9 it is the other two byte for byte, so
// nothing a normal session shows moves; above it, the reader stops counting
// zeroes. Negative and non-finite inputs are left rendering as they always did
// — no caller can produce one, and a guard here would dress a broken count up
// as a plausible number instead of letting it show.
//
// Built from `toFixed` and an ASCII suffix rather than `toLocaleString`: these
// land in padded table cells and a grouping separator that changes with the
// host's locale would change the column width with it.

import { roundedUnder } from "./pricing";

/**
 * Token count as a short magnitude — see the note above on the four tiers.
 *
 * ROUNDED FIRST, because a token count is a whole number and this is not always
 * handed one. The Usage panel's headline strip is animated (count-up.ts), and a
 * tween interpolates: the frames between 389,700 and 112 pass through 594.3268
 * and 113.99999952241691, and the sub-1000 tier printed those verbatim while
 * every tier above it was already fixed to one or two decimals by `toFixed`.
 * So switching from `month` to `today` counted down smoothly and then, for a
 * fifth of a second, showed a fifteen-digit float where a count belongs.
 *
 * The rounding goes before the tiers rather than inside the first one, so 999.6
 * reads "1.0k" like the 1000 it is rather than falling out of the bottom tier
 * as "1000". No integer input moves — which is every value this had before.
 * A non-finite input still renders as it always did: `Math.round` returns NaN
 * for NaN and ±Infinity for ±Infinity, and both fall through the comparisons to
 * exactly the strings this function has always produced for them.
 *
 * The same carry at the two tiers above (#1807): 999,950 is under a million,
 * and `toFixed(1)` printed it "1000.0k" where the million after it prints
 * "1.00M"; 999,995,000 printed "1000.00M" beside "1.00B". Each tier is judged
 * on the figure it would print, as fmtCost's are, and hands a figure that
 * rounds up to a thousand of its unit on to the next.
 */
export function fmtTokens(raw: number): string {
  const n = Math.round(raw);
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) {
    const k = roundedUnder(n / 1000, 1, 1000);
    if (k !== null) return `${k}k`;
  }
  if (n < 1_000_000_000) {
    const m = roundedUnder(n / 1_000_000, 2, 1000);
    if (m !== null) return `${m}M`;
  }
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}
