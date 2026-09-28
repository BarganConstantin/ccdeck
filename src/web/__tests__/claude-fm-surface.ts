// Claude FM's player as one text, for the assertions that read its source.
//
// components/ClaudeFm.tsx is being taken apart one concern at a time, the way
// the usage, accounts and Browser Watch panels were, and the pieces land in the
// files listed below. A positive can read whichever file owns the code now; a
// negative, a count or a slice cannot. "Nothing here keeps a playing state in
// storage", asked of the component alone, passes vacuously the moment the state
// moves out of it — which is the one outcome a negative must never have. So
// those read this instead: the component and every file lifted out of it, in
// one string, so whatever file now owns the code is still inside the sweep.
//
// Raw rather than comment-stripped, because the tests that read the player each
// strip it their own way and keep doing so over this. Files are joined by a
// newline and nothing else, which is what clientText does, so a line-anchored
// pattern cannot span two.
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";

/** The component and what was lifted out of it, relative to `src/web`. A file
 *  extracted from ClaudeFm.tsx is added here in the same change. */
export const CLAUDE_FM_FILES = [
  "components/ClaudeFm.tsx",
  "use-fm-player.ts",
] as const;

let joined: string | null = null;

/** Every file in CLAUDE_FM_FILES, raw, joined by a newline. */
export function claudeFmSurface(): string {
  joined ??= CLAUDE_FM_FILES.map(rel => readFileSync(`${WEB_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
