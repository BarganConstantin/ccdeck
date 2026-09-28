// The ccusage server as one text, for the assertions that say what it does NOT
// do.
//
// ccusage.mjs is being taken apart one concern at a time, the way quota.mjs
// was, and the pieces land in the files listed below. An assertion that means
// "the ccusage read does this" reads the file that owns the code, and a move is
// invisible to it. A negative, a count or a slice cannot do that: "the install
// never reaches for a shell", asked of ccusage.mjs alone, passes vacuously the
// moment the code it guards moves out of it — which is the one outcome a
// negative must never have. So those read this instead: ccusage.mjs and every
// file lifted out of it, in one string, so whatever file now owns the code is
// still inside the sweep.
//
// Raw rather than comment-stripped, for the reason accounts-surface.ts gives.
// Files are joined by a newline and nothing else, which is what clientText
// does, so a line-anchored pattern cannot span two.
import { readFileSync } from "node:fs";

import { SERVER_DIR } from "./quota-surface";

/** ccusage.mjs and what was lifted out of it, relative to `src/server`. A file
 *  extracted from ccusage.mjs is added here in the same change. */
export const CCUSAGE_FILES = [
  "ccusage.mjs",
  "ccusage-failure.mjs",
  "ccusage-install.mjs",
] as const;

let joined: string | null = null;

/** Every file in CCUSAGE_FILES, raw, joined by a newline. */
export function ccusageSurface(): string {
  joined ??= CCUSAGE_FILES.map(rel => readFileSync(`${SERVER_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
