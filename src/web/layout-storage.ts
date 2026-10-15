// The canvas's arrangement, frame and viewport as localStorage holds them.
//
// Moved out of App.tsx's module scope: the storage half of the layout, beside
// the format half (stored-layout.ts, stored-viewport.ts), which parses and
// serialises what these read and write. Every read and write goes through
// storage.ts's guarded helpers, because the storage accessor itself can throw —
// a private window, blocked site data — and a layout that cannot be read is an
// empty one, not a crash.
import type { Frame } from "./layout";
import { parseLayoutFrame, parseStoredLayout, serializeLayout, type StoredLayout } from "./stored-layout";
import { parseStoredViewport, type StoredViewport } from "./stored-viewport";
import { readStored, removeStored, writeStored } from "./storage";

const LAYOUT_STORAGE_KEY = "agent-dag.layout";
/** The frame the stored layout was packed into columns for — see #995. */
const LAYOUT_FRAME_KEY = "agent-dag.layoutFrame";
const VIEWPORT_STORAGE_KEY = "agent-dag.viewport";

/** The stored arrangement. The format, its v1 migration and what a garbled
 *  value reads as are parseStoredLayout's (#1174); readStored is for the
 *  storage read itself, which can throw on its own, and reads a refusal as
 *  nothing stored — the empty layout. */
export function loadLayout(): StoredLayout {
  return parseStoredLayout(readStored(LAYOUT_STORAGE_KEY));
}

export function saveLayout(
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
): void {
  writeStored(LAYOUT_STORAGE_KEY, serializeLayout(positions, pinned));
}

/**
 * The frame the stored layout's column count was chosen for.
 *
 * Kept beside the layout rather than inside it because it answers a different
 * question: `loadLayout` restores WHERE the nodes were, this restores WHAT THE
 * BOARD WAS SHAPED FOR. A deck reopened on a different monitor restores a
 * perfectly valid set of coordinates that were packed for a frame this window
 * does not have, and without this there is nothing to compare the new frame
 * against — the board comes back as however many columns the old window wanted
 * and stays that way until R (#995).
 *
 * Null when absent, which is what every layout stored before this existed reads
 * as. That is "no evidence", not "a frame of zero": the reframe effect records
 * the first measurement and compares nothing.
 */
export function loadLayoutFrame(): Frame | null {
  return parseLayoutFrame(readStored(LAYOUT_FRAME_KEY));
}

export function saveLayoutFrame(frame: Frame): void {
  writeStored(LAYOUT_FRAME_KEY, JSON.stringify(frame));
}

/** The viewport the canvas was last left at, or null. What it has to be to
 *  count — and why a zero zoom does not — is parseStoredViewport's (#1006);
 *  readStored is for the storage read itself, which can throw on its own. */
export function loadViewport(): StoredViewport | null {
  return parseStoredViewport(readStored(VIEWPORT_STORAGE_KEY));
}

export function saveViewport(vp: { x: number; y: number; zoom: number }): void {
  writeStored(VIEWPORT_STORAGE_KEY, JSON.stringify(vp));
}

/** The three keys R empties, as the store holds them: null where a key is
 *  absent, which is a state to put back as much as a value is. */
export interface StoredArrangement {
  layout: string | null;
  frame: string | null;
  viewport: string | null;
}

/** Read before R clears them, for Re-arrange's Undo (rearrange-undo.ts). */
export function readStoredArrangement(): StoredArrangement {
  return {
    layout: readStored(LAYOUT_STORAGE_KEY),
    frame: readStored(LAYOUT_FRAME_KEY),
    viewport: readStored(VIEWPORT_STORAGE_KEY),
  };
}

/** Puts the three keys back exactly: a value rewritten, an absence removed. */
export function restoreStoredArrangement(stored: StoredArrangement): void {
  const put = (key: string, value: string | null) => (value === null ? removeStored(key) : writeStored(key, value));
  put(LAYOUT_STORAGE_KEY, stored.layout);
  put(LAYOUT_FRAME_KEY, stored.frame);
  put(VIEWPORT_STORAGE_KEY, stored.viewport);
}

export function clearStoredLayout(): void {
  // One removeStored per key, each with its own try, so a failure removing one
  // (quota / locked store) doesn't strand the other.
  removeStored(LAYOUT_STORAGE_KEY);
  removeStored(VIEWPORT_STORAGE_KEY);
  // The frame goes with the layout it describes. Left behind, it claims the
  // board that R is about to rebuild was packed for a window that may not be
  // the one on screen, and the first frame change would relayout again.
  removeStored(LAYOUT_FRAME_KEY);
}
