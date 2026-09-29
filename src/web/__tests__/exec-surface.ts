// The process layer as one text, for the assertions that say what it does NOT
// do.
//
// exec.mjs is being taken apart one concern at a time — how a command is
// spelled, how a child is stopped, how cmd.exe says "not found" — and the
// pieces land in the files listed below. An assertion that means "run does
// this" reads the file that owns the code. A negative cannot: "no spawn in the
// process layer sets this variable per child", asked of exec.mjs alone, passes
// vacuously the moment the spawn it guards moves out of it — which is the one
// outcome a negative must never have. So those read this instead: exec.mjs and
// every file lifted out of it, in one string.
//
// Raw rather than comment-stripped, for the reason accounts-surface.ts gives,
// and joined by a newline and nothing else so a line-anchored pattern cannot
// span two files.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `src/server`, with a trailing separator, resolved from this file. */
export const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));

/** exec.mjs and what was lifted out of it, relative to `src/server`. A file
 *  extracted from exec.mjs is added here in the same change. */
export const EXEC_FILES = [
  "exec.mjs",
  "exec-not-found.mjs",
  "exec-children.mjs",
  "exec-spec.mjs",
] as const;

let joined: string | null = null;

/** Every file in EXEC_FILES, raw, joined by a newline. */
export function execSurface(): string {
  joined ??= EXEC_FILES.map(rel => readFileSync(`${SERVER_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
