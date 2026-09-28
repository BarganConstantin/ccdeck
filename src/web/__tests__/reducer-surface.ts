// The reducer as one text, for the assertions that say what it does NOT do.
//
// reducer.ts is being taken apart one concern at a time, the same way the
// accounts and usage panels were, and the pieces land in the files listed
// below. An assertion that means "the reducer does this" reads clientText() or
// the file that owns the code, and a move is invisible to it. A negative cannot
// do that: "the reducer never reads `.replay`", asked of reducer.ts alone,
// passes vacuously the moment the code it guards moves out of it — which is the
// one outcome a negative must never have. So those read this instead: reducer.ts
// and every file lifted out of it, in one string, so whatever file now owns the
// code is still inside the sweep.
//
// Raw rather than comment-stripped, for the reason accounts-surface.ts gives.
// Files are joined by a newline and nothing else, which is what clientText
// does, so a line-anchored pattern cannot span two.
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";

/** The reducer and what was lifted out of it, relative to `src/web`. A file
 *  extracted from reducer.ts is added here in the same change. */
export const REDUCER_FILES = [
  "reducer.ts",
  "usage-wire.ts",
  "payload-model.ts",
  "graph-state.ts",
  "tool-calls.ts",
  "board-sweeps.ts",
] as const;

let joined: string | null = null;

/** Every file in REDUCER_FILES, raw, joined by a newline. */
export function reducerSurface(): string {
  joined ??= REDUCER_FILES.map(rel => readFileSync(`${WEB_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
