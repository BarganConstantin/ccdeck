// Usage and This machine in a side column, in Workspace (owner, 2026-11-08).
//
// On the Board the two sit in the right column with the Inspector (panel-place.css).
// In Workspace they dock instead, in one column between the pane and the
// Inspector: the terminal makes room and reflows, and nothing covers the
// Inspector, the pane's header or its answer row. The first panel opened
// opens the column at its width (320 to start); the second shares it with the
// split between them; closing both takes the column away and the pane has the
// width back.
//
// WHAT THE READER CAN DO WITH IT, and what is kept in the browser for next time:
// - the column's left edge drags its width, 280 to 420;
// - the 8 px split drags the share of the height, each part at least 120;
// - the chevron folds a part to its header, which keeps a one-line live
//   summary, and the other part takes the height;
// - ⧉ pops a part out: it floats over the view, as on the Board, and drags by
//   its header anywhere in the view; ⧉ again or a double click on its header
//   docks it back.
// Width, split, fold and which parts float are this view's alone; the Board
// keeps its own floating places. Whether a panel is open is one flag for both
// views, so a panel open on one side of the switch is open on the other:
// docked in Workspace, floating at its Board place on the Board.
//
// WINDOWS. Under 1320 the column takes the Inspector's place (App holds the
// Inspector's sheet while the column is up and gives it back when the column
// goes). Under 1024 one part is open at a time, the other folded, without
// rewriting what is stored: a wider window shows both again.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readStored, writeStored } from "./storage";

export type SidePanel = "usage" | "machine";
export const SIDE_PANELS: readonly SidePanel[] = ["usage", "machine"];

/** Where Workspace's column keeps itself. */
export const SIDE_KEY = "agent-dag.workspaceSide";
/** The column's width: where it starts, and the range its edge drags in. */
export const SIDE_W = { start: 320, min: 280, max: 420 } as const;
/** The least height a part keeps beside the other. */
export const PART_MIN = 120;
/** The split between the two parts, and the step the keys move it and the
 *  column's edge by. */
export const SPLIT_H = 8;
export const KEY_STEP = 8;
/** Under this width one part is open at a time. */
export const ONE_PART_BELOW = 1024;

export interface SideState {
  /** The column's width, in px. */
  width: number;
  /** Usage's share of the height the two parts have between them, 0 to 1. */
  split: number;
  /** A part folded to its header. */
  fold: Record<SidePanel, boolean>;
  /** A part popped out: floating over the view, not in the column. */
  float: Record<SidePanel, boolean>;
}

export const SIDE_START: SideState = {
  width: SIDE_W.start,
  split: 0.5,
  fold: { usage: false, machine: false },
  float: { usage: false, machine: false },
};

export function clampWidth(width: number): number {
  return Math.round(Math.max(SIDE_W.min, Math.min(SIDE_W.max, width)));
}

/** Usage's share for a split `top` px into `room` px of parts, each kept at
 *  least PART_MIN; an even share when the room cannot hold two of them. */
export function splitFor(top: number, room: number): number {
  if (!(room >= 2 * PART_MIN)) return 0.5;
  const at = Math.max(PART_MIN, Math.min(room - PART_MIN, top));
  return Math.round((at / room) * 1000) / 1000;
}

const bool = (v: unknown) => v === true;

/** A stored column, or the start for a missing, older or unreadable one. */
export function parseSide(raw: string | null): SideState {
  if (!raw) return SIDE_START;
  try {
    const v = JSON.parse(raw) as Partial<SideState>;
    const width = Number.isFinite(v.width) ? clampWidth(v.width as number) : SIDE_START.width;
    const split = Number.isFinite(v.split) && (v.split as number) > 0 && (v.split as number) < 1 ? (v.split as number) : SIDE_START.split;
    const fold = { usage: bool(v.fold?.usage), machine: bool(v.fold?.machine) };
    const float = { usage: bool(v.float?.usage), machine: bool(v.float?.machine) };
    return { width, split, fold, float };
  } catch {
    return SIDE_START;
  }
}

/** How each panel is drawn: over the Board as before, a part of the column, or
 *  popped out of it over the view. */
export type DockMode = "board" | "docked" | "float";

export interface SideLayout {
  /** The column is drawn: Workspace, and a panel docked in it. */
  on: boolean;
  mode: Record<SidePanel, DockMode>;
  /** Folded as drawn: the stored fold, and under ONE_PART_BELOW the part not
   *  in use. */
  folded: Record<SidePanel, boolean>;
  /** Both parts are docked and open, so the split between them is drawn. */
  split: boolean;
}

/**
 * The column as it is drawn, from what is stored and what is on screen. Pure,
 * for the table in side-column.test.ts. `mounted` is a panel in the document
 * (open, or leaving); `last` the part the reader used last, which keeps the
 * one open part under ONE_PART_BELOW.
 */
export function layoutOf(p: {
  workspace: boolean;
  mounted: Record<SidePanel, boolean>;
  state: SideState;
  narrow: boolean;
  last: SidePanel;
}): SideLayout {
  const mode = {} as Record<SidePanel, DockMode>;
  for (const k of SIDE_PANELS) mode[k] = !p.workspace ? "board" : p.state.float[k] ? "float" : "docked";
  const docked = (k: SidePanel) => p.mounted[k] && mode[k] === "docked";
  const both = docked("usage") && docked("machine");
  const folded = { ...p.state.fold };
  if (p.narrow && both && !folded.usage && !folded.machine) folded[p.last === "usage" ? "machine" : "usage"] = true;
  for (const k of SIDE_PANELS) if (mode[k] !== "docked") folded[k] = false;
  return {
    on: docked("usage") || docked("machine"),
    mode,
    folded,
    split: both && !folded.usage && !folded.machine,
  };
}

/** What a panel is told about its place: how it is drawn, and its header's
 *  buttons. Absent, a panel is the Board's. */
export interface PanelDock {
  mode: DockMode;
  folded: boolean;
  fold: () => void;
  unfold: () => void;
  popOut: () => void;
  dock: () => void;
  /** On the Board while the Inspector is open: folds the opened panel back to
   *  its row at the top of the right column (inspector-fold.ts). */
  refold?: () => void;
}

export interface SideColumn extends SideLayout {
  width: number;
  /** Usage's share of the height, for the split's position. */
  share: number;
  dock: Record<SidePanel, PanelDock>;
  /** The edge's drag or keys settled on a width. */
  setWidth: (width: number) => void;
  /** The split's drag or keys settled on a share. */
  setShare: (share: number) => void;
}

/**
 * The column's state for App: stored, and turned into a layout for what is on
 * screen. `workspace` is Workspace up off a phone. Entering Workspace by the
 * switch docks every open panel (a panel opened on the Board docks here); a
 * reload in Workspace keeps the parts that were floating.
 */
export function useSideColumn(p: {
  workspace: boolean;
  open: Record<SidePanel, boolean>;
  mounted: Record<SidePanel, boolean>;
  narrow: boolean;
}): SideColumn {
  const [state, setState] = useState<SideState>(() => parseSide(readStored(SIDE_KEY)));
  const [last, setLast] = useState<SidePanel>("usage");
  const change = useCallback((next: (s: SideState) => SideState) => {
    setState(prev => {
      const value = next(prev);
      if (value !== prev) writeStored(SIDE_KEY, JSON.stringify(value));
      return value;
    });
  }, []);
  // The part opened last is the one in use.
  const openBefore = useRef(p.open);
  useEffect(() => {
    for (const k of SIDE_PANELS) if (p.open[k] && !openBefore.current[k]) setLast(k);
    openBefore.current = p.open;
  }, [p.open.usage, p.open.machine]); // eslint-disable-line react-hooks/exhaustive-deps
  // Into Workspace by the switch: what is open docks.
  const wasWorkspace = useRef(p.workspace);
  useEffect(() => {
    if (p.workspace && !wasWorkspace.current) {
      change(s => (s.float.usage || s.float.machine ? { ...s, float: { usage: false, machine: false } } : s));
    }
    wasWorkspace.current = p.workspace;
  }, [p.workspace, change]);

  const layout = layoutOf({ workspace: p.workspace, mounted: p.mounted, state, narrow: p.narrow, last });
  const dock = useMemo(() => {
    const of = (k: SidePanel): PanelDock => ({
      mode: layout.mode[k],
      folded: layout.folded[k],
      fold: () => change(s => ({ ...s, fold: { ...s.fold, [k]: true } })),
      unfold: () => { setLast(k); change(s => (s.fold[k] ? { ...s, fold: { ...s.fold, [k]: false } } : s)); },
      popOut: () => change(s => ({ ...s, float: { ...s.float, [k]: true } })),
      dock: () => { setLast(k); change(s => ({ ...s, float: { ...s.float, [k]: false } })); },
    });
    return { usage: of("usage"), machine: of("machine") };
  }, [layout.mode.usage, layout.mode.machine, layout.folded.usage, layout.folded.machine, change]); // eslint-disable-line react-hooks/exhaustive-deps
  const setWidth = useCallback((width: number) => {
    const w = clampWidth(width);
    change(s => (s.width === w ? s : { ...s, width: w }));
  }, [change]);
  const setShare = useCallback((share: number) => {
    change(s => (s.split === share ? s : { ...s, split: share }));
  }, [change]);
  return { ...layout, width: state.width, share: state.split, dock, setWidth, setShare };
}
