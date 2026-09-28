// Browser Watch's server half as one text, for the assertions that say what it
// does NOT do.
//
// browser-watch.mjs is being taken apart one concern at a time, the way the
// panel was (see browser-watch-surface.ts, which is the client's half), and the
// pieces land in the files listed below. An assertion that means "the snapshot
// does this" reads the file that owns the code. A negative cannot: "no watch
// module can run a command", asked of browser-watch.mjs alone, passes
// vacuously the moment the code it guards moves out of it — which is the one
// outcome a negative must never have. So those read this instead:
// browser-watch.mjs and every file lifted out of it, in one string.
//
// The store (browser-watch-store.mjs) is not in the list. It was never part of
// browser-watch.mjs, and the assertions about it read it by name.
//
// Raw rather than comment-stripped, for the reason accounts-surface.ts gives,
// and joined by a newline and nothing else so a line-anchored pattern cannot
// span two files.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `src/server`, with a trailing separator, resolved from this file. */
export const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));

/** browser-watch.mjs and what was lifted out of it, relative to `src/server`.
 *  A file extracted from browser-watch.mjs is added here in the same change. */
export const WATCH_SERVER_FILES = [
  "browser-watch.mjs",
  "browser-watch-decks.mjs",
  "browser-watch-feed.mjs",
] as const;

let joined: string | null = null;

/** Every file in WATCH_SERVER_FILES, raw, joined by a newline. */
export function watchServerSurface(): string {
  joined ??= WATCH_SERVER_FILES.map(rel => readFileSync(`${SERVER_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
