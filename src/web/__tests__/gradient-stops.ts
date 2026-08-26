// Reading the colour stops out of a gradient token, for every sweep that
// measures something against one.
//
// Five files in this suite ask the stylesheet what colour a node or the topbar
// is painted, and all five got the answer the same way: a regex for `var(--x)`
// or `#rrggbb` run over the token's value, ending in `?? []`. Five copies of
// one grammar, and therefore five copies of one blind spot.
//
// #649 found the blind spot. Neither notation occurs inside an `oklch()`, so
// respelling --node-grad or --topbar-grad in the notation a designer reaches
// for next — one this repo has no rule against — matched nothing, and `?? []`
// turned "I could not read this" into "there is nothing here". A sweep
// quantified over nothing passes. #662 fixed two of the five by making the
// reader FAIL on a value it cannot read, naming the token and quoting it. The
// other three were left, and #664 / #665 are what they did instead:
//
//   control-edges.test.ts kept `?? []` for both tokens. Respelling --node-grad
//   left its two text sweeps still running — they keep three panel tiers as
//   well — and quietly dropped the two node beds from them: 25 of 25 passed,
//   no crash, no error, nothing in the file to say two beds had gone. That is
//   the same defect contrast-floors' --text-dim sweep had, with the same
//   silence. Respelling --topbar-grad instead threw `Cannot read properties of
//   undefined` from four cases, because that half of the file indexes `top[0]`
//   and `top[1]` — one token, both failure modes, one reader.
//
//   session-hue.test.ts looks its beds up by name in a Record the stops build,
//   so an empty read left `beds["--node-grad stop 0"]` undefined and four cases
//   threw the same bare TypeError, out of `over()`, naming neither the token
//   nor the notation.
//
//   quiet-signals.test.ts was worse than either. Its sparkline ratio is
//   `Math.min(...stops.map(…))`, and `Math.min()` of nothing is Infinity — so
//   one case asserted a fabricated Infinity against its 3:1 floor and PASSED,
//   and the case beside it failed with `expected Infinity to be less than
//   Infinity`, which does not even look like a read failure.
//
// So the grammar lives here once, and it fails rather than answering. What it
// gained on the way is the case #662's author flagged and could not close from
// where they stood: a gradient respelled with `color-mix()` does not empty a
// `var(--x)` regex — the `var(--x)` INSIDE the mix still matches — so
// `linear-gradient(180deg, color-mix(in srgb, var(--panel) 60%, var(--bg)),
// var(--bg-soft))` scraped as THREE stops, two of which are the ingredients of
// one, and every sweep would have measured against beds the sheet never paints.
// Not skipped: misread, which is the failure mode a floor cannot catch because
// the numbers all look plausible. A regex cannot tell those apart, so this
// reader stopped being a regex. It takes the gradient apart the way the CSS
// grammar does — split the argument list at the commas that are not inside
// parentheses, drop the leading direction, strip each stop's position — and
// then asks of each POSITIONAL stop whether it is a notation the callers can
// resolve. A color-mix() stop is one stop, and it is one this reader refuses by
// name.
//
// Every message names the theme, the token and its whole value, because the
// entire reason #649 existed is that a colour notation nobody anticipated is
// exactly the change that produces the failure — and the message is what tells
// the next person that is what happened.
import { expect } from "vitest";

/** The leading arguments of a gradient that are not colours: the direction or
 *  angle, the shape and extent of a radial one, a conic `from`, and the
 *  `in <space>` interpolation a modern sheet may write. Anything unrecognised
 *  falls through to the stop check below and is refused BY NAME, which is the
 *  safe direction for a reader to be wrong in. */
const DIRECTION = new RegExp("^(?:" + [
  "to(?:\\s+(?:top|bottom|left|right))+",
  "-?[\\d.]+(?:deg|rad|grad|turn)",
  "(?:circle|ellipse)(?:\\s+(?:closest|farthest)-(?:side|corner))?(?:\\s+at\\s+[\\s\\S]+)?",
  "(?:closest|farthest)-(?:side|corner)(?:\\s+at\\s+[\\s\\S]+)?",
  "at\\s+[\\s\\S]+",
  "from\\s+-?[\\d.]+(?:deg|rad|grad|turn)",
  "in\\s+[\\w-]+(?:\\s+(?:shorter|longer|increasing|decreasing)\\s+hue)?",
].join("|") + ")$", "i");

/** A length or percentage where a stop states where it sits. A stop may carry
 *  two of them, which is why the caller strips twice. */
const POSITION = /\s+-?[\d.]+(?:%|px|r?em|v[wh]|vmin|vmax|ch|ex|pt|pc|cm|mm|in|q)$/i;

/** A bare position on its own is an interpolation hint — the midpoint between
 *  two stops — and not a stop. */
const HINT = /^-?[\d.]+(?:%|px|r?em|v[wh]|vmin|vmax|ch|ex|pt|pc|cm|mm|in|q)$/i;

/** A stop this reader will hand back: one the five callers' own `resolve()` can
 *  turn into an rgba. `var()` with a fallback is deliberately NOT here — no
 *  caller resolves one, so accepting it would move the failure from this
 *  message into somebody's colour parser. */
const COLOUR = /^(?:var\(\s*--[\w-]+\s*\)|#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8}))$/i;

const GRADIENT = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(([\s\S]*)\)$/i;

/** A comma-separated list split at the commas that are not inside parentheses.
 *  This is the whole reason a `color-mix()` stop can be seen as ONE stop rather
 *  than as the two tokens it is mixed from. */
export function topLevelArgs(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(a => a.length > 0);
}

export interface StopsWanted {
  /** Exactly this many, for a caller whose LABELS are the stops — "the light
   *  end" and "the dark end" are two names, and a third stop would be announced
   *  as a second dark end and quietly measured as one. */
  exactly?: number;
  /** At least this many. Two by default: a single colour is not a gradient and
   *  every caller here reads a top and a bottom. More than two is the sheet's
   *  business, not this reader's. */
  atLeast?: number;
}

/** The one sentence every failure below starts from, so the token and its value
 *  are quoted the same way whichever way the read went wrong. */
const about = (theme: string, token: string, value: string) =>
  `${theme} ${token} is \`${value}\` — `;

const orElse =
  "so every floor quantified over these stops would measure nothing, or measure something the sheet does not paint. " +
  "Teach this reader (__tests__/gradient-stops.ts) the notation the sheet now writes rather than letting the sweeps go vacuous";

/**
 * The colour stops of a gradient token, in order, or a failure that says which
 * value defeated the reader and how.
 *
 * `tokens` is the caller's own resolved `:root` map for `theme` — every one of
 * the five reads the two theme blocks slightly differently, and that is their
 * business; what they now share is the grammar of the value they find there.
 */
export function gradientStops(
  token: string,
  theme: string,
  tokens: Record<string, string>,
  wanted: StopsWanted = {},
): string[] {
  const value = tokens[token];
  expect(value, `${theme} declares no ${token} for this sweep to read stops out of`).toBeTruthy();

  const grad = GRADIENT.exec(value.trim());
  expect(grad,
    `${about(theme, token, value)}this reader knows linear-, radial- and conic-gradient() and that is none of them, ${orElse}`)
    .not.toBeNull();

  const args = topLevelArgs(grad![1]);
  while (args.length > 0 && DIRECTION.test(args[0])) args.shift();

  const stops = args
    .filter(a => !HINT.test(a))
    .map(a => a.replace(POSITION, "").replace(POSITION, "").trim());

  const unreadable = stops.filter(s => !COLOUR.test(s));
  expect(unreadable,
    `${about(theme, token, value)}this reader knows var(--x) and #rrggbb, and each of these stops is neither, ${orElse}`)
    .toEqual([]);

  if (wanted.exactly !== undefined) {
    expect(stops.length,
      `${about(theme, token, value)}this sweep reads exactly ${wanted.exactly} stop(s) out of it and found ${stops.length}, ${orElse}`)
      .toBe(wanted.exactly);
  } else {
    const floor = wanted.atLeast ?? 2;
    expect(stops.length,
      `${about(theme, token, value)}this sweep reads ${floor} stop(s) or more out of it and found ${stops.length}, ${orElse}`)
      .toBeGreaterThanOrEqual(floor);
  }
  return stops;
}
