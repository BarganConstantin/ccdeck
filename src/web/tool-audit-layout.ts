import { readStored, writeStored } from './storage';

/** How wide the details panel may be dragged, in CSS pixels. */
export const DETAILS_WIDTH = { min: 320, standard: 380, max: 1600 } as const;
/** The report always keeps this much beside the details, so the list never collapses. */
export const REPORT_MIN = 420;
/** The draggable line between them; `.ta-workspace` gives it this track. */
const SPLITTER = 8;
const KEY = 'agent-dag.tool-activity.details-width';

/** A width the panel can actually take in a workspace `room` pixels wide. */
export function clampDetails(width: number, room: number): number {
  const most = Math.max(DETAILS_WIDTH.min, Math.min(DETAILS_WIDTH.max, room - REPORT_MIN - SPLITTER));
  return Math.round(Math.min(most, Math.max(DETAILS_WIDTH.min, Number.isFinite(width) ? width : DETAILS_WIDTH.standard)));
}

/** The width this browser last left the panel at, or the standard one. */
export function readDetailsWidth(): number {
  const stored = Number(readStored(KEY));
  return Number.isFinite(stored) && stored >= DETAILS_WIDTH.min && stored <= DETAILS_WIDTH.max ? Math.round(stored) : DETAILS_WIDTH.standard;
}

export function writeDetailsWidth(width: number): void {
  writeStored(KEY, String(Math.round(width)));
}
