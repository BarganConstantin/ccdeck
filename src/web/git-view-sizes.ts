// How big the git view and its panes are, which look it wears, and how that
// is remembered.
//
// The panel takes 60% of the window by default and the canvas keeps the rest;
// inside it the history takes 42% of the height and the files list 40% of the
// width under it. All three dividers move by pointer or keyboard, every pane
// keeps a floor (no pane under 220px, the history under 120px, the canvas
// beside the panel under 360px), and the choice is kept in the deck's own
// preferences in this browser. (The diff keeps its wrap toggle itself.)
//
// The Fork look keeps sizes of its own, so switching looks never moves the
// other's dividers: a wider panel (72% of the window), a sidebar column on the
// left (264px, shown by default only where the panel has room for it beside a
// readable history), the history over the inspector at 35%, the inspector's
// tab and whether it is folded away.
//
// The fractions are of the box each divider actually resizes — the panel of the
// window, the history of the box it shares with the panes under it, the files
// of the row they share with the diff — so a clamp worked out here is the one
// the layout applies.
import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "./storage";
import type { GitInspectorTab, GitLook } from "./git-view-types";

export interface GitViewPrefs {
  /** The panel's width, as a fraction of the window. */
  w: number;
  /** The history's height, as a fraction of the history + files box. */
  graphH: number;
  /** The files list's width, as a fraction of the row it shares with the diff. */
  filesW: number;
  /** Which look the view wears. */
  look: GitLook;
  /** The Fork look's panel width, as a fraction of the window. */
  fkW: number;
  /** The Fork look's history height, as a fraction of the history + inspector box. */
  fkGraphH: number;
  /** The Fork look's sidebar column, in px. */
  sidebarW: number;
  /** Whether the reader showed (true) or hid (false) the sidebar; null until
   *  they choose, which leaves it to the panel's width. */
  sidebarShown: boolean | null;
  /** The Fork look's inspector tab. */
  inspectorTab: GitInspectorTab;
  /** The Fork look's inspector folded away, the history taking its room. */
  inspectorCollapsed: boolean;
}

export const GIT_VIEW_DEFAULTS: Readonly<GitViewPrefs> = {
  w: 0.6, graphH: 0.42, filesW: 0.4,
  look: "deck", fkW: 0.72, fkGraphH: 0.35, sidebarW: 264, sidebarShown: null, inspectorTab: "changes", inspectorCollapsed: false,
};

/** Below this window width the view is a full sheet over the canvas. */
export const SHEET_BELOW = 1100;
export const PANEL_MIN = 560;
export const CANVAS_MIN = 360;
export const PANE_MIN = 220;
export const GRAPH_MIN = 120;
export const FILES_MAX = 520;
/** The band an inner divider takes between the panes it divides. */
export const SPLIT_BAND = 9;

/** The Fork look's sidebar column: its floating panel plus 8px each side. */
export const SIDEBAR_MIN = 176;
export const SIDEBAR_MAX = 436;
/** Under this panel width the Fork sidebar starts hidden: the history beside
 *  it needs 600px. */
export const SIDEBAR_AUTO_BELOW = 1000;
/** The Fork look's floors: the history over the inspector. */
export const FK_HISTORY_MIN = 110;
export const FK_INSPECTOR_MIN = 160;

export const GIT_VIEW_PREFS_KEY = "agent-dag.gitView";

const fraction = (v: unknown, fallback: number) =>
  (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1 ? v : fallback);
const oneOf = <T extends string>(v: unknown, all: readonly T[], fallback: T): T =>
  (typeof v === "string" && (all as readonly string[]).includes(v) ? v as T : fallback);
const px = (v: unknown, lo: number, hi: number, fallback: number) =>
  (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(Math.max(v, lo), hi)) : fallback);

/** The stored preferences, each field checked on its own: one bad value costs
 *  that value and nothing else. */
export function parseGitViewPrefs(raw: string | null): GitViewPrefs {
  let o: Record<string, unknown> = {};
  try { const v = raw ? JSON.parse(raw) : null; if (v && typeof v === "object") o = v as Record<string, unknown>; } catch { /* a broken store is a default */ }
  const d = GIT_VIEW_DEFAULTS;
  return {
    w: fraction(o.w, d.w),
    graphH: fraction(o.graphH, d.graphH),
    filesW: fraction(o.filesW, d.filesW),
    look: oneOf(o.look, ["deck", "fork"] as const, d.look),
    fkW: fraction(o.fkW, d.fkW),
    fkGraphH: fraction(o.fkGraphH, d.fkGraphH),
    sidebarW: px(o.sidebarW, SIDEBAR_MIN, SIDEBAR_MAX, d.sidebarW),
    sidebarShown: typeof o.sidebarShown === "boolean" ? o.sidebarShown : null,
    // A tab the inspector does not draw (File Tree, before its reads) opens
    // on Changes there (FkInspector.tsx).
    inspectorTab: oneOf(o.inspectorTab, ["commit", "changes", "tree"] as const, d.inspectorTab),
    inspectorCollapsed: o.inspectorCollapsed === true,
  };
}

export const readGitViewPrefs = (): GitViewPrefs => parseGitViewPrefs(readStored(GIT_VIEW_PREFS_KEY));
export const writeGitViewPrefs = (p: GitViewPrefs): void => {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  writeStored(GIT_VIEW_PREFS_KEY, JSON.stringify({
    w: round(p.w), graphH: round(p.graphH), filesW: round(p.filesW),
    look: p.look, fkW: round(p.fkW), fkGraphH: round(p.fkGraphH), sidebarW: Math.round(p.sidebarW),
    ...(p.sidebarShown === null ? {} : { sidebarShown: p.sidebarShown }),
    inspectorTab: p.inspectorTab, inspectorCollapsed: p.inspectorCollapsed,
  }));
};

// ── one value for the page ──────────────────────────────────────────────
// The view and Settings › Appearance read and write the same preferences, so
// the look switched in one is the look the other shows, at once.
let current: GitViewPrefs | null = null;
const listeners = new Set<() => void>();
const snapshot = (): GitViewPrefs => (current ??= readGitViewPrefs());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The preferences now, outside React. */
export const gitViewPrefsNow = snapshot;

/** Keep new preferences: stored, and every reader re-rendered. */
export function setGitViewPrefs(next: GitViewPrefs): void {
  current = next;
  writeGitViewPrefs(next);
  for (const l of listeners) l();
}

/** The preferences, re-rendering the caller when they change. */
export function useGitViewPrefs(): GitViewPrefs {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Switch the view's look, from its own button, `f` or Settings. */
export function setGitLook(look: GitLook): void {
  const p = snapshot();
  if (p.look !== look) setGitViewPrefs({ ...p, look });
}

export const isSheet = (windowW: number): boolean => windowW < SHEET_BELOW;

/** Whether the Fork sidebar is shown: the reader's choice when they made one,
 *  else only where the panel is wide enough for it beside the history. A
 *  sheet starts with it hidden, and the reader's ≡ there lasts the open. */
export function sidebarShownFor(prefs: Pick<GitViewPrefs, "sidebarShown">, panelW: number, sheet: boolean, sheetChoice: boolean | null): boolean {
  if (sheet) return sheetChoice ?? false;
  return prefs.sidebarShown ?? panelW >= SIDEBAR_AUTO_BELOW;
}

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
/** The Fork look's history over its inspector: `box` holds both (the
 *  divider there is an invisible handle and takes no room). */
export function fkGraphBounds(box: number) {
  return { min: FK_HISTORY_MIN, max: Math.max(FK_HISTORY_MIN, box - FK_INSPECTOR_MIN) };
}
/** The Fork sidebar column, never leaving the history beside it under 360px. */
export function sidebarBounds(panelW: number) {
  return { min: SIDEBAR_MIN, max: Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, panelW - 360)) };
}

export type SplitterKind = "edge" | "graph" | "files" | "sidebar";

/**
 * Where a divider goes for a key, as the size of what it resizes.
 *
 * The arrows speak in screen positions — an arrow right moves the divider
 * right — and the sizes follow: the panel's own left edge moving left makes
 * the panel wider, the other dividers moving right or down make the pane
 * before them bigger. Home and End speak in the size the divider reports
 * (WAI-ARIA window splitter): Home gives the pane it controls its least size,
 * End its most, whichever side of the divider that pane is on.
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
    return move.to === "min" ? bounds.min : bounds.max;
  }
  return clamp(current + grows * move.step, bounds.min, bounds.max);
}

/** A size for a divider, clamped to its bounds — for a pointer drag. */
export const clampTo = (px: number, bounds: { min: number; max: number }) => clamp(px, bounds.min, bounds.max);
