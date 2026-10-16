import { readStored, writeStored } from './storage';
import { TEXT_SIZE_INCREASE, currentTextSize } from './reading-preferences';

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
  return Math.round(Math.min(most, Math.max(DETAILS_WIDTH.min, Number.isFinite(width) ? width : standardDetailsWidth())));
}

/** The standard width at the reader's text size: 12px more for each pixel of
 *  larger text, as the deck's panels take (styles/reading.css), so a call's
 *  time keeps to one line. Smaller text keeps the standard. */
export function standardDetailsWidth(): number {
  return DETAILS_WIDTH.standard + 12 * Math.max(0, TEXT_SIZE_INCREASE[currentTextSize()]);
}

/** The width this browser last left the panel at, or the standard one. */
export function readDetailsWidth(): number {
  const stored = Number(readStored(KEY));
  return Number.isFinite(stored) && stored >= DETAILS_WIDTH.min && stored <= DETAILS_WIDTH.max ? Math.round(stored) : standardDetailsWidth();
}

export function writeDetailsWidth(width: number): void {
  writeStored(KEY, String(Math.round(width)));
}
