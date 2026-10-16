// The deck's stylesheet as the suite reads it.
//
// styles.css is a list of parts, each a contiguous stretch of what was one
// fifteen-thousand-line file, imported in the order they cascade. Joined in
// that order they are that file byte for byte. So a test that pins a rule, a
// count or an order asks for the sheet, not for the part that happens to hold
// the rule today. It then keeps meaning the same thing when a rule moves
// between parts. The test that names a part is the one that means that part.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WEB_DIR = fileURLToPath(new URL("../", import.meta.url));

/** One `@import` line of the list: the part's path, relative to src/web. */
const IMPORT = /^@import "\.\/(styles\/[a-z0-9-]+\.css)";/gm;

let parts: [string, string][] | null = null;

/** `[path relative to src/web, text]` for every part, in cascade order. */
export function sheetParts(): readonly [string, string][] {
  parts ??= [...readFileSync(`${WEB_DIR}styles.css`, "utf8").matchAll(IMPORT)]
    .map(m => [m[1], readFileSync(`${WEB_DIR}${m[1]}`, "utf8")]);
  return parts;
}

let joined: string | null = null;

/** The whole sheet: every part, in order, with nothing between them. */
export function sheetText(): string {
  joined ??= sheetParts().map(([, text]) => text).join("");
  return joined;
}

/** Legacy geometry/type checks inspect the Default reading profile, not a
 * browser's computed style. Resolve only our explicitly neutral defaults —
 * the text, panel and card increments (0px), the floored small sizes' `max(-1px, …)`
 * and the density factor `* var(--ui-space, 1)` — arbitrary calc(), other variables and malformed values
 * remain untouched so those checks still fail on unrecognized changes. Browser
 * tests verify the actual cascade for each non-default reading profile. */
export function defaultReadingSheetText(): string {
  return sheetText().replace(
    /calc\((\d+(?:\.\d+)?px) \+ max\(-?\d+px, var\(--ui-text-increase, 0px\)\)\)/g,
    "$1",
  ).replace(
    /calc\((\d+(?:\.\d+)?px) \+ var\(--ui-(?:text|panel|card)-increase, 0px\)\)/g,
    "$1",
  ).replace(/calc\((-?\d+(?:\.\d+)?px) \* var\(--ui-space, 1\)\)/g, "$1").replace(/ \+ var\(--ui-panel-increase, 0px\)/g, "")
    .replace(/max\((\d+(?:\.\d+)?px), \1\)/g, "$1");
}
