// The Sessions list's width, the reader's to drag (internal #103).
//
// The list was --rail-w wide and nothing else: 264 at Compact and tighter, 288
// at Default and Comfortable. A board of long session names lost the end of
// every one of them, and a short list held room the board could use. Its right
// edge now drags it, RAIL_W.min to RAIL_W.max (components/RailEdge.tsx), and
// the width is kept in this browser. With nothing kept, the list is the
// density's width, as before.
//
// WHAT IS KEPT is the list's own width, before larger text's
// --ui-panel-increase: the column adds that on top as it always has, so a list
// dragged at Default text is the same list, plus the increase, at Larger.
//
// THE WINDOW HAS THE LAST WORD. Drawn, the list takes at most WINDOW_SHARE of
// the window, and never less than the density's width for it, so a window made
// narrower narrows the list with it. What is kept is untouched, and a wider
// window gives it back. A drag also keeps MAIN_MIN of the board or the pane
// beside it, measured as the drag starts.
//
// The accounts panel, which shares the column, keeps the density's width.
import { useCallback, useEffect, useState } from "react";
import { readStored, removeStored, writeStored } from "./storage";

/** Where the reader's width is kept: the list's width in px, a number. */
export const RAIL_WIDTH_KEY = "agent-dag.sessionListWidth";
/** The range the edge drags the list in. */
export const RAIL_W = { min: 224, max: 560 } as const;
/** An arrow key moves the edge this far; with Shift, RAIL_KEY_STEP_BIG. */
export const RAIL_KEY_STEP = 8;
export const RAIL_KEY_STEP_BIG = 32;
/** What a drag leaves of the board or the pane beside the list, at least. */
export const MAIN_MIN = 400;
/** The most of the window the list is drawn at. */
export const WINDOW_SHARE = 0.4;

export function clampRailWidth(width: number): number {
  return Math.round(Math.max(RAIL_W.min, Math.min(RAIL_W.max, width)));
}

/** A kept width, or null for none, an older value or one that does not read. */
export function parseRailWidth(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? clampRailWidth(n) : null;
}

/** The most the list is drawn at in a window `viewport` px wide: WINDOW_SHARE
 *  of it, never under the density's width, never over RAIL_W.max. */
export function railCap(density: number, viewport: number): number {
  if (!(viewport > 0)) return RAIL_W.max;
  return Math.min(RAIL_W.max, Math.max(density, Math.floor(viewport * WINDOW_SHARE)));
}

/** The width the list is drawn at: the reader's, else the density's, held to
 *  the window's cap. */
export function fitRailWidth(chosen: number | null, density: number, cap: number): number {
  return Math.min(chosen ?? density, Math.max(density, cap));
}

/** The most a drag from `start` may widen the list to, with `main` px of board
 *  or pane beside it and `cap` from the window: it keeps MAIN_MIN of the main
 *  area, and a drag that starts with less than that may only narrow. */
export function dragMax(start: number, main: number, cap: number): number {
  const room = Number.isFinite(main) ? start + main - MAIN_MIN : RAIL_W.max;
  return Math.max(RAIL_W.min, Math.min(cap, RAIL_W.max, Math.max(start, room)));
}

/** Esc while the edge is dragged, heard from the window wherever the focus is
 *  (a press takes none; in Workspace the terminal keeps it), and kept from the
 *  terminal and the deck's own Esc. A drag is not a modal, so it does not go
 *  through useModalDismiss; a panel's drag hears its Esc the same way
 *  (panel-place.ts). Returns how to stop listening. */
export function listenForDragEscape(cancel: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}

/** The reader's kept width (null for none), and the two ways to change it. */
export function useRailWidthChoice(): { chosen: number | null; choose: (width: number) => void; reset: () => void } {
  const [chosen, setChosen] = useState<number | null>(() => parseRailWidth(readStored(RAIL_WIDTH_KEY)));
  const choose = useCallback((width: number) => {
    const value = clampRailWidth(width);
    setChosen(value);
    writeStored(RAIL_WIDTH_KEY, String(value));
  }, []);
  const reset = useCallback(() => {
    setChosen(null);
    removeStored(RAIL_WIDTH_KEY);
  }, []);
  return { chosen, choose, reset };
}

/** The window's cap on the list (railCap), re-read when the window resizes. A
 *  number, so a resize that leaves it where it was renders nothing. */
export function useRailCap(density: number): number {
  const read = () => railCap(density, typeof window !== "undefined" && typeof window.innerWidth === "number" ? window.innerWidth : 0);
  const [cap, setCap] = useState(read);
  useEffect(() => {
    setCap(read());
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onResize = () => setCap(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [density]); // eslint-disable-line react-hooks/exhaustive-deps
  return cap;
}
