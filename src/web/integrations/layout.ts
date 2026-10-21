// How wide an integration panel's detail column is (#2178), per storage key
// (a panel names its own: "jira"), the way
// Tool activity keeps its details width (tool-audit-layout.ts): dragged on the
// splitter, remembered per browser, and never so wide the list goes under its
// floor.
import { readStored, writeStored } from "../storage";

/** The detail column's bounds, in CSS pixels. */
export const DETAIL_WIDTH = { min: 320, standard: 440, max: 1600 } as const;
/** The list always keeps this much beside the detail. */
export const LIST_MIN = 420;
/** The draggable line between them. */
export const SPLITTER = 8;
/** Below this the detail is a screen of its own with a Back, not a column. */
export const DRILL_IN_QUERY = "(max-width: 899px)";

const key = (storageKey: string) => `agent-dag.integrations.${storageKey}.detail-width`;

/** A width the detail can take in a workspace `room` pixels wide. */
export function clampDetail(width: number, room: number): number {
  const most = Math.max(DETAIL_WIDTH.min, Math.min(DETAIL_WIDTH.max, room - LIST_MIN - SPLITTER));
  return Math.round(Math.min(most, Math.max(DETAIL_WIDTH.min, Number.isFinite(width) ? width : DETAIL_WIDTH.standard)));
}

export function readDetailWidth(storageKey: string): number {
  const stored = Number(readStored(key(storageKey)));
  return Number.isFinite(stored) && stored >= DETAIL_WIDTH.min && stored <= DETAIL_WIDTH.max ? Math.round(stored) : DETAIL_WIDTH.standard;
}

export function writeDetailWidth(storageKey: string, width: number): void {
  writeStored(key(storageKey), String(Math.round(width)));
}
