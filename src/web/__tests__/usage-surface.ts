// The usage panel as one text, for the assertions that say what it does NOT
// do.
//
// UsagePanel.tsx is being taken apart one concern at a time, the same way the
// accounts panel was, and the pieces land in the files listed below. An
// assertion that means "the panel does this" reads clientText() or the file
// that owns the code, and a move is invisible to it. A negative, a count or a
// slice cannot do that: "the panel keeps no private cost bar", asked of the
// component alone, passes vacuously the moment the code it guards moves out of
// it — which is the one outcome a negative must never have. So those read this
// instead: the component and every file lifted out of it, in one string, so
// whatever file now owns the code is still inside the sweep.
//
// Raw rather than comment-stripped, for the reason accounts-surface.ts gives:
// the tests that read the panel each strip it their own way, and keep doing so
// over this. Files are joined by a newline and nothing else, which is what
// clientText does, so a line-anchored pattern cannot span two.
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";

/** The panel and what was lifted out of it, relative to `src/web`. A file
 *  extracted from UsagePanel.tsx is added here in the same change. */
export const USAGE_FILES = [
  "components/UsagePanel.tsx",
  "components/QuotaBar.tsx",
  "use-quota.ts",
  "components/QuotaSections.tsx",
  "use-usage-range.ts",
  "use-count-up.ts",
  "components/UsagePeriodStrip.tsx",
  "components/UsageSessionBreakdown.tsx",
  "usage-session-join.ts",
  "components/UsageModelTable.tsx",
  "usage-prefs.ts",
] as const;

let joined: string | null = null;

/** Every file in USAGE_FILES, raw, joined by a newline. */
export function usageSurface(): string {
  joined ??= USAGE_FILES.map(rel => readFileSync(`${WEB_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
