// The machine panel as one text, for the assertions that say what it does NOT
// do.
//
// MachinePanel.tsx is being taken apart one concern at a time, and the pieces
// land in the files listed below. An assertion that means "the panel does
// this" reads the file that now owns the code. A negative cannot do that: "the
// panel reads no process list", asked of the component alone, passes
// vacuously the moment the reading moves out of it — which is the one outcome
// a negative must never have. So those read this instead: the component and
// every file lifted out of it, in one string.
//
// Raw rather than comment-stripped, as accounts-surface.ts is: the tests that
// read the panel each strip it their own way. Files are joined by a newline
// and nothing else, so a line-anchored pattern cannot span two.
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";

/** The panel and what was lifted out of it, relative to `src/web`. A file
 *  extracted from MachinePanel.tsx is added here in the same change. */
export const MACHINE_PANEL_FILES = [
  "components/MachinePanel.tsx",
  "machine-snapshot.ts",
  "machine-readings.ts",
] as const;

let joined: string | null = null;

/** Every file in MACHINE_PANEL_FILES, raw, joined by a newline. */
export function machinePanelSurface(): string {
  joined ??= MACHINE_PANEL_FILES.map(rel => readFileSync(`${WEB_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
