// How wide an integration panel's list column is (#2178), per storage key
// (a panel names its own: "jira"): dragged on the divider between the list
// and the detail, or moved with its arrow keys, remembered per browser, and
// held between 280px and 60 % of the room, the detail taking the rest. Until
// the reader drags it the list takes what the provider's automatic detail
// share leaves. Resizing the dialog keeps the list's width and gives or takes
// the difference from the detail.
import { readStored, removeStored, writeStored } from "../storage";

/** The list column's bounds: at least 280px, at most 60 % of the room. */
export const LIST_WIDTH = { min: 280, share: 0.6 } as const;
/** One arrow press on the divider, and one with Shift. */
export const LIST_STEP = 32;
export const LIST_STEP_LARGE = 128;
/** Until the reader drags it, the detail takes this share of the room and the
 *  list the rest, within the list's bounds. A provider can name its own. */
export const DETAIL_SHARE = 0.5;
/** The line between them: 1px (V4's Figma), with a wider hand target (integrations.css). */
export const SPLITTER = 1;
/** Below this the detail is a screen of its own with a Back, not a column. */
export const DRILL_IN_QUERY = "(max-width: 899px)";

function validShare(share: number): number {
  return Number.isFinite(share) && share > 0 && share < 1 ? share : DETAIL_SHARE;
}

const percent = (fraction: number) => `${Math.round(fraction * 10000) / 100}%`;

/** The most the list can take in a room `room` pixels wide. */
export function listMost(room: number): number {
  return Math.max(LIST_WIDTH.min, Math.floor(room * LIST_WIDTH.share));
}

/** A width the list can take in a room `room` pixels wide. */
export function clampList(width: number, room: number): number {
  const wanted = Number.isFinite(width) ? width : room * (1 - DETAIL_SHARE);
  return Math.round(Math.min(listMost(room), Math.max(LIST_WIDTH.min, wanted)));
}

/** The list's width before the reader has dragged it: what the provider's
 *  detail share leaves, within the bounds. */
export function autoList(room: number, detailShare = DETAIL_SHARE): number {
  return clampList(room * (1 - validShare(detailShare)), room);
}

/** The CSS for a list width the grid holds to its bounds as the dialog
 *  changes size, decided during render rather than after paint. */
export function listCss(width: number | null, detailShare = DETAIL_SHARE): string {
  const wanted = width == null ? percent(1 - validShare(detailShare)) : `${Math.round(width)}px`;
  return `clamp(${LIST_WIDTH.min}px, ${wanted}, ${percent(LIST_WIDTH.share)})`;
}

const key = (storageKey: string) => `agent-dag.integrations.${storageKey}.list-width`;
/** Where the width was kept when the divider measured the detail. Read once,
 *  so a width dragged before is not lost, and forgotten at the next drag. */
const oldKey = (storageKey: string) => `agent-dag.integrations.${storageKey}.detail-width`;
const LONGEST = 10_000;

/** What the reader left: the list's width, or a detail width kept from before. */
export type SplitWidth = { list: number } | { detail: number } | null;

function storedNumber(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= LIST_WIDTH.min && n <= LONGEST ? Math.round(n) : null;
}

/** The width the reader dragged the list to, or null while it is automatic. */
export function readSplitWidth(storageKey: string): SplitWidth {
  const list = storedNumber(readStored(key(storageKey)));
  if (list != null) return { list };
  const detail = storedNumber(readStored(oldKey(storageKey)));
  return detail != null ? { detail } : null;
}

/** Remembers a dragged list width, or, given null, goes back to the automatic
 *  one. Either way a detail width kept from before is forgotten. */
export function writeListWidth(storageKey: string, width: number | null): void {
  removeStored(oldKey(storageKey));
  if (width == null) removeStored(key(storageKey));
  else writeStored(key(storageKey), String(Math.round(width)));
}

/** The list's CSS width for what was left. */
export function splitCss(width: SplitWidth, detailShare = DETAIL_SHARE): string {
  if (width && "list" in width) return listCss(width.list);
  if (width && "detail" in width) return `clamp(${LIST_WIDTH.min}px, calc(100% - ${SPLITTER}px - ${width.detail}px), ${percent(LIST_WIDTH.share)})`;
  return listCss(null, detailShare);
}

/** The list's width in pixels for what was left, in a room `room` wide. */
export function splitList(width: SplitWidth, room: number, detailShare = DETAIL_SHARE): number {
  if (width && "list" in width) return clampList(width.list, room);
  if (width && "detail" in width) return clampList(room - SPLITTER - width.detail, room);
  return autoList(room, detailShare);
}
