// How wide an integration panel's detail column is (#2178), per storage key
// (a panel names its own: "jira"), the way
// Tool activity keeps its details width (tool-audit-layout.ts): dragged on the
// splitter, remembered per browser, and never so wide the list goes under its
// floor.
import { readStored, removeStored, writeStored } from "../storage";

/** The detail column's bounds, in CSS pixels. */
export const DETAIL_WIDTH = { min: 320, max: 1600 } as const;
/** Until the reader drags it, the detail takes this share of the workspace,
 *  within DETAIL_WIDTH, and never so much that the list goes under LIST_MIN:
 *  capped at 440, a wide modal's detail was a narrow column beside a list
 *  with room to spare. */
export const DETAIL_SHARE = 0.5;
/** The CSS for that share, which the split uses until a width is stored. */
export const AUTO_DETAIL_CSS = autoDetailCss();

function validShare(share: number): number {
  return Number.isFinite(share) && share > 0 && share < 1 ? share : DETAIL_SHARE;
}

/** Automatic width in CSS, decided during render rather than after paint. */
export function autoDetailCss(share = DETAIL_SHARE): string {
  return `clamp(${DETAIL_WIDTH.min}px, ${validShare(share) * 100}%, ${DETAIL_WIDTH.max}px)`;
}
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
  return Math.round(Math.min(most, Math.max(DETAIL_WIDTH.min, Number.isFinite(width) ? width : room * DETAIL_SHARE)));
}

/** The width the detail takes in a workspace `room` pixels wide before the
 *  reader has dragged it: the share, within the bounds. */
export function autoDetail(room: number, share = DETAIL_SHARE): number {
  return clampDetail(room * validShare(share), room);
}

/** The width the reader dragged the detail to, or null while it is automatic. */
export function readDetailWidth(storageKey: string): number | null {
  const raw = readStored(key(storageKey));
  if (raw == null) return null;
  const stored = Number(raw);
  return Number.isFinite(stored) && stored >= DETAIL_WIDTH.min && stored <= DETAIL_WIDTH.max ? Math.round(stored) : null;
}

/** Remembers a dragged width, or, given null, goes back to the automatic one. */
export function writeDetailWidth(storageKey: string, width: number | null): void {
  if (width == null) removeStored(key(storageKey));
  else writeStored(key(storageKey), String(Math.round(width)));
}
