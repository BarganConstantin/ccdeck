// The LAN sockets as one text, for the assertions that say what they do NOT
// do.
//
// lan-socket.mjs is being taken apart one concern at a time — the line both
// halves speak, then the calling half — and the pieces land in the files
// listed below. An assertion that means "the listener does this" or "a
// dialler does this" reads the file that owns the code. A negative cannot: "no
// refusal is read off the map with a bare bracket", asked of lan-socket.mjs
// alone, passes vacuously the moment the code it guards moves out of it —
// which is the one outcome a negative must never have. So those read this
// instead: lan-socket.mjs and every file lifted out of it, in one string.
//
// Raw rather than comment-stripped, for the reason accounts-surface.ts gives,
// and joined by a newline and nothing else so a line-anchored pattern cannot
// span two files.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `src/server`, with a trailing separator, resolved from this file. */
export const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));

/** lan-socket.mjs and what was lifted out of it, relative to `src/server`. A
 *  file extracted from lan-socket.mjs is added here in the same change. */
export const LAN_SOCKET_FILES = [
  "lan-socket.mjs",
  "lan-lines.mjs",
  "lan-call.mjs",
] as const;

let joined: string | null = null;

/** Every file in LAN_SOCKET_FILES, raw, joined by a newline. */
export function lanSocketSurface(): string {
  joined ??= LAN_SOCKET_FILES.map(rel => readFileSync(`${SERVER_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
