// The usage-history modal as one text, for the assertions that say what it
// does NOT do.
//
// UsageHistoryModal.tsx is being taken apart one concern at a time, the way
// the usage panel and the accounts panel were, and the pieces land in the
// files listed below. A positive assertion reads the file that owns the code.
// A negative or a count cannot: "the modal prints no bare ccusage failure",
// asked of the component alone, passes vacuously the moment the code it
// guards moves out of it. So those read this instead — the modal and every
// file lifted out of it, in one string.
//
// Raw rather than comment-stripped, for the reason accounts-surface.ts gives:
// the tests that read the modal each strip it their own way. Joined by a
// newline and nothing else, which is what clientText does, so a line-anchored
// pattern cannot span two files.
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";

/** The modal and what was lifted out of it, relative to `src/web`, the modal
 *  first. A file extracted from UsageHistoryModal.tsx is added here in the
 *  same change. */
export const USAGE_HISTORY_FILES = [
  "components/UsageHistoryModal.tsx",
  "usage-history.ts",
  "use-ccusage.ts",
  "components/UsageDayDetail.tsx",
] as const;

let joined: string | null = null;

/** Every file in USAGE_HISTORY_FILES, raw, joined by a newline. */
export function usageHistorySurface(): string {
  joined ??= USAGE_HISTORY_FILES.map(rel => readFileSync(`${WEB_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
