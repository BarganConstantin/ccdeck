// Browser Watch as one text, for the assertions that read the panel's source.
//
// BrowserWatchModal.tsx is being taken apart one concern at a time, the way the
// usage and accounts panels were, and the pieces land in the files listed
// below. A positive about what the panel does can read whichever file now owns
// the code; a negative, a count or a slice cannot. "Every clock in this panel
// is 24-hour", asked of the dialog alone, passes vacuously the moment the clock
// moves out of it — which is the one outcome a negative must never have. So
// those read this instead: the dialog and every file lifted out of it, in one
// string, so whatever file now owns the code is still inside the sweep.
//
// Raw rather than comment-stripped, because the tests that read the panel did
// so raw and keep doing so over this. Files are joined by a newline and nothing
// else, which is what clientText does, so a line-anchored pattern cannot span
// two.
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";

/** The dialog and what was lifted out of it, relative to `src/web`. A file
 *  extracted from BrowserWatchModal.tsx is added here in the same change. */
export const BROWSER_WATCH_FILES = [
  "components/BrowserWatchModal.tsx",
  "browser-watch-model.ts",
  "use-browser-watch.ts",
  "components/RemoteControl.tsx",
  "components/BrowserWatchOverview.tsx",
  "components/BrowserWatchProfiles.tsx",
  "components/BrowserWatchFindings.tsx",
  "components/BrowserWatchFeed.tsx",
] as const;

let joined: string | null = null;

/** Every file in BROWSER_WATCH_FILES, raw, joined by a newline. */
export function browserWatchSurface(): string {
  joined ??= BROWSER_WATCH_FILES.map(rel => readFileSync(`${WEB_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
