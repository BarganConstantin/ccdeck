// The LAN feature's rules as one text, for the assertions that say what they do
// NOT do.
//
// lan-sync.mjs is being taken apart one concern at a time — the invite first,
// then which copy of a login wins, then the keys, proofs and seals two decks
// talk under — and the pieces land in the files listed below. An assertion
// that means "the rules do this" reads the file that owns the code. A negative
// cannot: "no rule declares isPresent", asked of lan-sync.mjs alone, passes
// vacuously the moment the code around it moves out of it — which is the one
// outcome a negative must never have. So those read this instead: lan-sync.mjs
// and every file lifted out of it, in one string.
//
// Raw rather than comment-stripped, for the reason accounts-surface.ts gives,
// and joined by a newline and nothing else so a line-anchored pattern cannot
// span two files.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `src/server`, with a trailing separator, resolved from this file. */
export const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));

/** lan-sync.mjs and what was lifted out of it, relative to `src/server`. A file
 *  extracted from lan-sync.mjs is added here in the same change. */
export const LAN_SYNC_FILES = [
  "lan-sync.mjs",
  "lan-invite.mjs",
  "lan-copies.mjs",
  "lan-wire.mjs",
] as const;

let joined: string | null = null;

/** Every file in LAN_SYNC_FILES, raw, joined by a newline. */
export function lanSyncSurface(): string {
  joined ??= LAN_SYNC_FILES.map(rel => readFileSync(`${SERVER_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
