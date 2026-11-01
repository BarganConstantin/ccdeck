// How a session's context is said in one figure: "129k / 200k · 64%" (V4, owner
// answer 17). The Term header's chip says it today and the Inspector's Context
// tab will say it next, so the words are made in one place and the two cannot
// print two numbers for one fact. `fmtTokens` stays as it is for every other
// caller: it keeps a decimal under 100k ("61.4k"), which this figure does not.

/** Whole thousands, so "129k" and "200k" line up as a pair; a million is "1M",
 *  and "1.2M" past it, with no trailing ".0". Under a thousand the number as is. */
export function contextTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  // 999,500 would round to "1000k": it is a million, said as one.
  if (v < 999_500) return `${Math.round(v / 1000)}k`;
  return `${String(Math.round(v / 100_000) / 10)}M`;
}

/** How full the window is, as a whole percent held to 0..999 (a session can
 *  run past a window it was assumed to have). */
export function contextPercent(used: number, window: number): number {
  if (!(window > 0)) return 0;
  return Math.min(999, Math.max(0, Math.round((used / window) * 100)));
}

/** "129k / 200k · 64%"; with no window known, the used part alone, "129k". */
export function contextFigure(used: number, window?: number | null): string {
  if (!window || window <= 0) return contextTokens(used);
  return `${contextTokens(used)} / ${contextTokens(window)} · ${contextPercent(used, window)}%`;
}
