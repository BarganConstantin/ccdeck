// The Claude quota server as one text, for the assertions that say what it
// does NOT do.
//
// quota.mjs is being taken apart one concern at a time, the way the usage and
// accounts panels were, and the pieces land in the files listed below. An
// assertion that means "the quota server does this" reads the file that owns
// the code, and a move is invisible to it. A negative, a count or a slice
// cannot do that: "the quota server keeps no private reset label", asked of
// quota.mjs alone, passes vacuously the moment the code it guards moves out of
// it — which is the one outcome a negative must never have. So those read this
// instead: quota.mjs and every file lifted out of it, in one string, so
// whatever file now owns the code is still inside the sweep.
//
// Raw rather than comment-stripped, for the reason accounts-surface.ts gives:
// the tests that read the module each strip it their own way, and keep doing
// so over this. Files are joined by a newline and nothing else, which is what
// clientText does, so a line-anchored pattern cannot span two.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `src/server`, with a trailing separator, resolved from this file. */
export const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));

/** quota.mjs and what was lifted out of it, relative to `src/server`. A file
 *  extracted from quota.mjs is added here in the same change. */
export const QUOTA_FILES = [
  "quota.mjs",
  "quota-shape.mjs",
] as const;

let joined: string | null = null;

/** Every file in QUOTA_FILES, raw, joined by a newline. */
export function quotaSurface(): string {
  joined ??= QUOTA_FILES.map(rel => readFileSync(`${SERVER_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
