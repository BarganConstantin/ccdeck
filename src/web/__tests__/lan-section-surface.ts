// The Local network section as one text, for the assertions that say what it
// does NOT do.
//
// LanSyncSection.tsx is being taken apart one concern at a time, and the pieces
// that draw or drive the section land in the files listed below. An assertion
// that means "the section does this" reads the file that now owns the code. A
// negative, a count or a slice cannot do that: "the section adds no focus stop
// of its own", asked of the component alone, passes vacuously the moment the
// markup moves out of it — which is the one outcome a negative must never
// have. So those read this instead: the component and every file lifted out of
// it that draws or drives it, in one string, so whatever file now owns the
// code is still inside the sweep.
//
// The pure rules lifted out alongside them — lan-types, lan-round, lan-roster,
// lan-exchange, lan-share, lan-add-deck — are not here. They hold no markup
// and no handler, and every rule about them calls them.
//
// Raw rather than comment-stripped, as accounts-surface.ts is: the tests that
// read the section each strip it their own way. Files are joined by a newline
// and nothing else, so a line-anchored pattern cannot span two.
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";

/** The section and what was lifted out of it, relative to `src/web`. A file
 *  extracted from LanSyncSection.tsx that draws or drives it is added here in
 *  the same change. */
export const LAN_SECTION_FILES = [
  "components/LanSyncSection.tsx",
  "use-lan-section.ts",
  "components/LanDeckList.tsx",
  "components/LanPeek.tsx",
  "use-hover-peek.ts",
] as const;

let joined: string | null = null;

/** Every file in LAN_SECTION_FILES, raw, joined by a newline. */
export function lanSectionSurface(): string {
  joined ??= LAN_SECTION_FILES.map(rel => readFileSync(`${WEB_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
