// The session cluster layer as one text, for the assertions that say what it
// does NOT do.
//
// SessionClusters.tsx was taken apart the way the usage panel was: the words
// on a header went to cluster-header.ts, and the geometry — the boxes, the cap
// on the pill, and the two inline styles the layer writes — to
// cluster-bounds.ts. An assertion that means "the layer does this" reads the
// file that owns the code. A negative cannot: "the pill no longer shrinks with
// min(1, zoom)", asked of the component alone, passes vacuously now that the
// pill's style is built somewhere else — which is the one outcome a negative
// must never have. So those read this instead: the component and every file
// lifted out of it, in one string, so whatever file owns the code is still
// inside the sweep.
//
// Raw rather than comment-stripped, as usage-surface.ts is: the tests that read
// the layer each strip it their own way. Files are joined by a newline and
// nothing else, so a line-anchored pattern cannot span two.
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";

/** The component and what was lifted out of it, relative to `src/web`. A file
 *  extracted from SessionClusters.tsx is added here in the same change. */
export const CLUSTER_FILES = [
  "components/SessionClusters.tsx",
  "cluster-header.ts",
  "cluster-bounds.ts",
  "session-chrome.ts",
] as const;

let joined: string | null = null;

/** Every file in CLUSTER_FILES, raw, joined by a newline. */
export function clustersSurface(): string {
  joined ??= CLUSTER_FILES.map(rel => readFileSync(`${WEB_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
