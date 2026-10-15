// How wide the stage is, and so how many columns the session gets.
//
// THE STAGE IS A WHOLE NUMBER OF CELLS WIDE. A terminal box sized in pixels
// leaves a ragged strip on the right that is neither a column nor margin, and
// a resize that lands between two cell counts redraws the TUI for nothing. So
// the width is chosen in columns and the pixels follow: 24px before column 1,
// the columns themselves, and a 20px lane after the last for the scrollbar
// (v3's `cols × cell + 44`). The navigator gets whatever is left.
//
// DETENTS, SOFTLY. The divider pulls toward 80, 100, 120 and 160 columns — the
// widths terminal programs are written and tested at, so a TUI redrawn there
// looks the way its authors saw it — but only within three columns of one.
// Anywhere else the width is free, a column at a time. v3's prototype allowed
// the four detents alone, so it could replay recordings made at exactly those
// sizes; a product has no recording to protect and every reason to let a
// reader settle at 112.
//
// THE NAVIGATOR KEEPS ITS ROOM. Beside the stage the board stays readable at
// 1:1 only above 320px; below that it folds to a rail of faces, which needs
// 168px. A narrow window (under 1100px) or an expanded stage asks for the rail
// on purpose. When not even 80 columns fit beside a rail, the stage takes the
// whole body and "‹ Board" leads its header — the takeover.
//
// THE CELL IS MEASURED, NEVER ASSUMED. 8 × 18 is what the deck's mono stack
// gives at 13.3px on DejaVu Sans Mono and on Menlo; SF Mono and Cascadia land
// elsewhere. The stage asks xterm for the cell it actually drew
// (use-terminal-session.ts) and this module is handed it, so the quantising
// above is to the real grid, not to a number that was right on one machine.
//
// THE WIDTH IS REMEMBERED AS COLUMNS. A fraction of the window would be a
// different column count on every window, and the column count is the thing
// a reader chose. It is kept per browser under the agent-dag.* namespace every
// key this client stores lives in (display-name.test.ts holds that line).
import { readStored, writeStored } from "./storage";

/** The column counts the divider is drawn toward. */
export const DETENTS = [80, 100, 120, 160] as const;

/** How many columns away a detent still pulls. */
export const DETENT_PULL = 3;

/** The narrowest stage before the takeover: the width terminal programs are
 *  written to fit. Below it Claude Code's own layout starts to wrap. */
export const MIN_COLS = 80;

/** Padding before the first column — the stage's text inset. */
export const INSET_LEFT = 24;
/** The lane after the last column, where xterm's scrollbar sits. */
export const INSET_RIGHT = 20;
export const INSET_X = INSET_LEFT + INSET_RIGHT;

/** The navigator at tiles density: every name at 1:1 with its subagents. */
export const NAV_MIN = 320;
/** The navigator at rail density: one column of faces. */
export const NAV_MIN_RAIL = 168;
/** What a stage opened at its default width leaves the board when it can:
 *  enough for two tile columns rather than the bare minimum. */
export const NAV_ROOM = 400;
/** Below this window width the navigator is a rail whatever the stage. */
export const NARROW_BELOW = 1100;

export const HEAD_H = 64;
export const HEAD_H_NARROW = 52;
/** The keys bar under the terminal. */
export const BAR_H = 36;
/** Vertical slack kept around the grid so its first and last rows never
 *  touch the header's rule or the bar's. */
const ROW_SLACK = 12;
/** The fewest rows the grid is ever given, so a squashed window still shows
 *  a prompt rather than a zero-row terminal. */
const MIN_ROWS = 5;
/** The fewest columns a takeover is ever given, for the same reason. */
const MIN_TAKEOVER_COLS = 20;

/** The cell xterm drew with, in CSS pixels. Fractional is fine. */
export interface Cell {
  w: number;
  h: number;
}

/** What the stage was measured at before xterm has drawn anything: the
 *  deck's mono stack at 13.3px, which is 8 × 18 where it was checked. Used for
 *  the very first frame only; the measured cell replaces it. */
export const ASSUMED_CELL: Cell = { w: 8, h: 18 };

export interface StageGeometryInput {
  /** The width the board and stage share (the body, not the window). */
  appW: number;
  /** The body's height, which the stage fills. */
  bodyH: number;
  cellW: number;
  cellH: number;
  /** The ⤢ control: give the stage everything the rail does not need. */
  expanded: boolean;
  /** A window under NARROW_BELOW. */
  narrow: boolean;
  /** The column count the reader last chose, or null for the default. */
  storedCols: number | null;
}

/** The columns a divider may land on in this window. */
export interface ColsRange {
  min: number;
  max: number;
  /** The detents inside [min, max], ascending. */
  detents: number[];
}

export interface StageGeometry {
  cols: number;
  rows: number;
  /** Whole pixels: the cells, rounded up, plus INSET_X. */
  stageW: number;
  navW: number;
  density: "tiles" | "rail";
  takeover: boolean;
  headH: number;
  /** Where the grid's first row sits below the header, centring the rows in
   *  the height they leave — also where every state card starts. */
  termTop: number;
  range: ColsRange;
}

const finite = (n: number, fallback: number) => (Number.isFinite(n) && n > 0 ? n : fallback);

/** The stage's pixel width for `cols` columns of `cellW`. Rounded up, so the
 *  last column is never clipped by a fraction of a pixel. */
export function stageWidthFor(cols: number, cellW: number): number {
  return Math.ceil(cols * finite(cellW, ASSUMED_CELL.w)) + INSET_X;
}

/** The most columns that leave the navigator `navMin` pixels. */
export function maxColsFor(appW: number, cellW: number, navMin: number): number {
  return Math.floor((appW - navMin - INSET_X) / finite(cellW, ASSUMED_CELL.w));
}

/** The range a divider may move through: MIN_COLS up to what leaves the
 *  navigator its minimum. Empty (max < min) when not even MIN_COLS fit. */
export function colsRange(appW: number, cellW: number, navMin: number): ColsRange {
  const max = maxColsFor(appW, cellW, navMin);
  return { min: MIN_COLS, max, detents: DETENTS.filter(d => d >= MIN_COLS && d <= max) };
}

/**
 * The column count a wanted width settles on: whole, inside the range, and
 * pulled onto a detent within DETENT_PULL of it.
 *
 * The nearest detent wins a tie between two, which with detents twenty or
 * more apart cannot happen; it is stated so the rule is total.
 */
export function snapCols(want: number, range: ColsRange): number {
  if (!Number.isFinite(want)) return range.min;
  const cols = Math.max(range.min, Math.min(range.max, Math.round(want)));
  let best: number | null = null;
  for (const d of range.detents) {
    if (Math.abs(d - want) > DETENT_PULL) continue;
    if (best === null || Math.abs(d - want) < Math.abs(best - want)) best = d;
  }
  return best ?? cols;
}

/**
 * The column count a divider at `x` asks for: the stage runs from the divider
 * to the right edge of `appW`, less its insets. `x` is measured from the left
 * of the same box `appW` is the width of.
 */
export function colsAtX(x: number, appW: number, cellW: number): number {
  return (appW - x - INSET_X) / finite(cellW, ASSUMED_CELL.w);
}

/**
 * One keyboard step of the divider. "wider" is the stage growing (the divider
 * moving left, ← and Home); each step goes to the next detent in that
 * direction, or to the range's end when there is none left — so the arrows
 * walk the widths worth stopping at, and the pointer is there for the rest.
 */
export function stepCols(cols: number, dir: "wider" | "narrower" | "widest" | "narrowest", range: ColsRange): number {
  if (dir === "widest") return range.max;
  if (dir === "narrowest") return range.min;
  if (dir === "wider") return range.detents.find(d => d > cols) ?? range.max;
  const below = range.detents.filter(d => d < cols);
  return below.length ? below[below.length - 1] : range.min;
}

/** The width a stage opens at when the reader has chosen none: the widest
 *  detent that still leaves the board `room`, else the narrowest detent that
 *  fits at all, else the range's floor. */
function defaultCols(range: ColsRange, appW: number, cellW: number, room: number): number {
  const roomy = range.detents.filter(d => appW - stageWidthFor(d, cellW) >= room);
  if (roomy.length) return roomy[roomy.length - 1];
  return range.detents[0] ?? range.min;
}

/**
 * The column count a remembered width becomes in this window. Inside the
 * range it is the reader's own number, pulled onto a detent when it is near
 * one. Wider than this window allows, it lands on the widest detent that fits
 * — a width remembered on a bigger screen means "as wide as is sensible", and
 * a detent is a width the TUI is designed at, where the clamp's leftover cell
 * count is not.
 */
function rememberedCols(stored: number, range: ColsRange): number {
  if (stored > range.max) return range.detents.length ? range.detents[range.detents.length - 1] : range.max;
  return snapCols(stored, range);
}

/**
 * The stage's geometry for one window: columns and rows, pixel widths, the
 * navigator's density, and where the grid sits. Pure; the stage and the
 * layout both call it with what they measured, and get the same answer.
 */
export function stageGeometry(input: StageGeometryInput): StageGeometry {
  const cellW = finite(input.cellW, ASSUMED_CELL.w);
  const cellH = finite(input.cellH, ASSUMED_CELL.h);
  const appW = Math.max(0, input.appW);
  const headH = input.narrow ? HEAD_H_NARROW : HEAD_H;
  const railWanted = input.narrow || input.expanded;
  const navMin = railWanted ? NAV_MIN_RAIL : NAV_MIN;

  // Beside a navigator at its own minimum first; failing that, beside a rail;
  // failing that, no navigator at all.
  let range = colsRange(appW, cellW, navMin);
  if (range.max < range.min && !railWanted) range = colsRange(appW, cellW, NAV_MIN_RAIL);
  const takeover = range.max < range.min;

  let cols: number;
  if (takeover) {
    cols = Math.max(MIN_TAKEOVER_COLS, Math.floor((appW - INSET_X) / cellW));
    range = { min: cols, max: cols, detents: [] };
  } else if (input.expanded) {
    cols = range.max;
  } else if (input.storedCols != null && Number.isFinite(input.storedCols)) {
    cols = rememberedCols(input.storedCols, range);
  } else {
    cols = defaultCols(range, appW, cellW, input.narrow ? NAV_MIN_RAIL : NAV_ROOM);
  }

  const stageW = takeover ? appW : stageWidthFor(cols, cellW);
  const navW = takeover ? 0 : appW - stageW;
  const avail = Math.max(0, input.bodyH - headH - BAR_H);
  const rows = Math.max(MIN_ROWS, Math.floor((avail - ROW_SLACK) / cellH));
  const termTop = Math.max(6, Math.floor((avail - rows * cellH) / 2));
  const density = railWanted || navW < NAV_MIN ? "rail" : "tiles";
  return { cols, rows, stageW, navW, density, takeover, headH, termTop, range };
}

/** Where the reader's chosen width is kept, as a column count. */
export const STAGE_COLS_KEY = "agent-dag.terminal.cols";

/** The remembered column count, or null when there is none worth trusting —
 *  absent, not a whole number, or outside what tmux would accept anyway. */
export function loadStageCols(read: (key: string) => string | null = readStored): number | null {
  const raw = read(STAGE_COLS_KEY);
  if (raw == null || !/^\d{1,3}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 20 && n <= 500 ? n : null;
}

/** Remember a chosen column count. A blocked store costs the memory, never
 *  the drag (storage.ts swallows the failure). */
export function saveStageCols(cols: number, write: (key: string, value: string) => void = writeStored): void {
  if (Number.isInteger(cols) && cols > 0) write(STAGE_COLS_KEY, String(cols));
}
