// How big the git view and its three panes are, and how that is remembered.
//
// The panel takes 60% of the window by default and the canvas keeps the rest;
// inside it the history takes 42% of the height and the files list 40% of the
// width under it. All three dividers move by pointer or keyboard, every pane
// keeps a floor (no pane under 220px, the history under 120px, the canvas
// beside the panel under 360px), and the choice is kept in the deck's own
// preferences in this browser. (The diff keeps its wrap toggle itself.)
//
// The fractions are of the box each divider actually resizes — the panel of the
// window, the history of the box it shares with the panes under it, the files
// of the row they share with the diff — so a clamp worked out here is the one
// the layout applies.
import { readStored, writeStored } from "./storage";

export interface GitViewPrefs {
  /** The panel's width, as a fraction of the window. */
  w: number;
  /** The history's height, as a fraction of the history + files box. */
  graphH: number;
  /** The files list's width, as a fraction of the row it shares with the diff. */
  filesW: number;
}

export const GIT_VIEW_DEFAULTS: Readonly<GitViewPrefs> = { w: 0.6, graphH: 0.42, filesW: 0.4 };

/** Below this window width the view is a full sheet over the canvas. */
export const SHEET_BELOW = 1100;
export const PANEL_MIN = 560;
export const CANVAS_MIN = 360;
export const PANE_MIN = 220;
export const GRAPH_MIN = 120;
export const FILES_MAX = 520;
/** The band an inner divider takes between the panes it divides. */
export const SPLIT_BAND = 9;

export const GIT_VIEW_PREFS_KEY = "agent-dag.gitView";

const fraction = (v: unknown, fallback: number) =>
  (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1 ? v : fallback);

/** The stored preferences, each field checked on its own: one bad value costs
 *  that value and nothing else. */
export function parseGitViewPrefs(raw: string | null): GitViewPrefs {
  let o: Record<string, unknown> = {};
  try { const v = raw ? JSON.parse(raw) : null; if (v && typeof v === "object") o = v as Record<string, unknown>; } catch { /* a broken store is a default */ }
  return {
    w: fraction(o.w, GIT_VIEW_DEFAULTS.w),
    graphH: fraction(o.graphH, GIT_VIEW_DEFAULTS.graphH),
    filesW: fraction(o.filesW, GIT_VIEW_DEFAULTS.filesW),
  };
}

export const readGitViewPrefs = (): GitViewPrefs => parseGitViewPrefs(readStored(GIT_VIEW_PREFS_KEY));
export const writeGitViewPrefs = (p: GitViewPrefs): void => {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  writeStored(GIT_VIEW_PREFS_KEY, JSON.stringify({ w: round(p.w), graphH: round(p.graphH), filesW: round(p.filesW) }));
};

export const isSheet = (windowW: number): boolean => windowW < SHEET_BELOW;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
/** Like clamp, but when the box is too small for both floors the upper bound
 *  wins: the canvas beside the panel keeps its 360px before the panel keeps
 *  its 560px. */
const clampHiWins = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The panel's width in px for a stored fraction. `room` is how much of the
 *  window the panel and the canvas share (the window less a left column). */
export function panelWidth(w: number, windowW: number, room: number): number {
  return Math.round(clampHiWins(windowW * w, PANEL_MIN, room - CANVAS_MIN));
}

/** The bounds each divider moves between, in px of what it resizes. */
export function edgeBounds(windowW: number, room: number) {
  const max = Math.max(0, room - CANVAS_MIN);
  return { min: Math.min(PANEL_MIN, max), max };
}
/** `box` is the history + files box, `row` the files + diff row, each with
 *  the divider's own band in it. */
export function graphBounds(box: number) {
  return { min: GRAPH_MIN, max: Math.max(GRAPH_MIN, box - SPLIT_BAND - PANE_MIN) };
}
export function filesBounds(row: number) {
  return { min: PANE_MIN, max: Math.max(PANE_MIN, Math.min(FILES_MAX, row - SPLIT_BAND - PANE_MIN)) };
}

export type SplitterKind = "edge" | "graph" | "files";

/**
 * Where a divider goes for a key, as the size of what it resizes.
 *
 * The keys speak in screen positions — Home sends a divider to its leftmost or
 * topmost place, an arrow right moves it right — and the sizes follow: the
 * panel's own left edge moving left makes the panel wider, the other two
 * dividers moving right or down make the pane before them bigger.
 */
export function splitterTarget(
  kind: SplitterKind,
  move: { step: number } | { to: "min" | "max" | "reset" },
  current: number,
  bounds: { min: number; max: number },
  resetTo: number,
): number {
  const grows = kind === "edge" ? -1 : 1;
  if ("to" in move) {
    if (move.to === "reset") return clamp(resetTo, bounds.min, bounds.max);
    const leftmost = kind === "edge" ? bounds.max : bounds.min;
    const rightmost = kind === "edge" ? bounds.min : bounds.max;
    return move.to === "min" ? leftmost : rightmost;
  }
  return clamp(current + grows * move.step, bounds.min, bounds.max);
}

/** A size for a divider, clamped to its bounds — for a pointer drag. */
export const clampTo = (px: number, bounds: { min: number; max: number }) => clamp(px, bounds.min, bounds.max);
