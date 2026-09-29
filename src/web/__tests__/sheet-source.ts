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
