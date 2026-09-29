// The accounts panel as one text, for the assertions that say what it does NOT
// do.
//
// AccountsPanel.tsx is being taken apart one concern at a time, and the pieces
// land in the files listed below. An assertion that means "the panel does this"
// reads clientText(), and a move is invisible to it. A negative, a count or a
// slice cannot do that: "no control in the panel goes inert any other way",
// asked of the component alone, passes vacuously the moment the controls move
// out of it — which is the one outcome a negative must never have. So those
// read this instead: the component and every file lifted out of it, in one
// string, so whatever file now owns the code is still inside the sweep.
//
// Raw rather than comment-stripped. The tests that read the panel each strip it
// their own way — two of them drop comment lines instead of blanking them — and
// keep doing so over this. Files are joined by a newline and nothing else,
// which is what clientText does, so a line-anchored pattern cannot span two.
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";

/** The panel and what was lifted out of it, relative to `src/web`. A file
 *  extracted from AccountsPanel.tsx is added here in the same change. */
export const ACCOUNTS_FILES = [
  "components/AccountsPanel.tsx",
  "account-issue.ts",
  "account-freshness.ts",
  "components/AccountIssuePopover.tsx",
  "claude-accounts.ts",
  "components/AccountRow.tsx",
  "components/AccountsEmptyState.tsx",
  "auto-switch-threshold.ts",
  "components/AutoSwitchPolicy.tsx",
  "use-request-slot.ts",
  "use-account-menu.ts",
  "components/AccountMenuPopover.tsx",
  "components/AccountsHeader.tsx",
  "use-account-roster.ts",
  "use-account-switching.ts",
  "account-fold.ts",
  "account-lan.ts",
  "use-threshold-draft.ts",
  "use-roster-focus.ts",
  "account-refocus.ts",
  "use-panel-clock.ts",
] as const;

let joined: string | null = null;

/** Every file in ACCOUNTS_FILES, raw, joined by a newline. */
export function accountsSurface(): string {
  joined ??= ACCOUNTS_FILES.map(rel => readFileSync(`${WEB_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
