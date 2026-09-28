// The canvas's arrangement, frame and viewport as localStorage holds them.
//
// Moved out of App.tsx's module scope: the storage half of the layout, beside
// the format half (stored-layout.ts, stored-viewport.ts), which parses and
// serialises what these read and write. Every read and write is wrapped,
// because the storage accessor itself can throw — a private window, blocked
// site data — and a layout that cannot be read is an empty one, not a crash.
import type { Frame } from "./layout";
import { parseLayoutFrame, parseStoredLayout, serializeLayout, type StoredLayout } from "./stored-layout";
import { parseStoredViewport, type StoredViewport } from "./stored-viewport";

const LAYOUT_STORAGE_KEY = "agent-dag.layout";
/** The frame the stored layout was packed into columns for — see #995. */
const LAYOUT_FRAME_KEY = "agent-dag.layoutFrame";
const VIEWPORT_STORAGE_KEY = "agent-dag.viewport";

/** The stored arrangement. The format, its v1 migration and what a garbled
 *  value reads as are parseStoredLayout's (#1174); the try is for the storage
 *  read itself, which can throw on its own. */
export function loadLayout(): StoredLayout {
  if (typeof window === "undefined") return { positions: [], pins: [] };
  try {
    return parseStoredLayout(window.localStorage.getItem(LAYOUT_STORAGE_KEY));
  } catch { return { positions: [], pins: [] }; }
}

export function saveLayout(
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, serializeLayout(positions, pinned));
  } catch { /* quota / private mode — ignore */ }
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
  if (typeof window === "undefined") return null;
  try {
    return parseLayoutFrame(window.localStorage.getItem(LAYOUT_FRAME_KEY));
  } catch { return null; }
}

export function saveLayoutFrame(frame: Frame): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(LAYOUT_FRAME_KEY, JSON.stringify(frame)); } catch {}
}

/** The viewport the canvas was last left at, or null. What it has to be to
 *  count — and why a zero zoom does not — is parseStoredViewport's (#1006);
 *  the try is for the storage read itself, which can throw on its own. */
export function loadViewport(): StoredViewport | null {
  if (typeof window === "undefined") return null;
  try {
    return parseStoredViewport(window.localStorage.getItem(VIEWPORT_STORAGE_KEY));
  } catch { return null; }
}

export function saveViewport(vp: { x: number; y: number; zoom: number }): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(vp)); } catch {}
}

export function clearStoredLayout(): void {
  if (typeof window === "undefined") return;
  // Per-key try/catch so a failure removing one (quota / locked store)
  // doesn't strand the other.
  try { window.localStorage.removeItem(LAYOUT_STORAGE_KEY); } catch {}
  try { window.localStorage.removeItem(VIEWPORT_STORAGE_KEY); } catch {}
  // The frame goes with the layout it describes. Left behind, it claims the
  // board that R is about to rebuild was packed for a window that may not be
  // the one on screen, and the first frame change would relayout again.
  try { window.localStorage.removeItem(LAYOUT_FRAME_KEY); } catch {}
}
