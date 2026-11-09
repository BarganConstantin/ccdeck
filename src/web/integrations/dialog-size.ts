// How big a tracker's dialog is, and how a reader changes it: the arithmetic
// the host (IntegrationModal) and its resize handles share, apart from React
// so a test can read it.
//
// THE SIZE. Until the reader chooses one, 88 % of the window each way, never
// past 1680 x 1120. A size the reader chose (an edge or a corner dragged, the
// keyboard, the Size menu) is remembered per provider and per browser. Either
// way the dialog stays at least 720 x 480 and at most the window less 16 on
// each side: a window smaller than that shrinks the dialog with it, and the
// remembered size comes back when the window grows again. integrations.css
// does the same clamp from the same numbers, so the window can change size
// without any script; the functions here are what a drag and the keyboard
// read while they run.
//
// THE PLACE. The dialog opens centred. Dragging an edge keeps the opposite
// edge where it was, so the dialog moves off centre; that offset lives only
// as long as the dialog is open and is held inside the window the same way.
// The header never moves it.
import { readStored, removeStored, writeStored } from "../storage";

export interface Size { width: number; height: number }
export interface Rect extends Size { left: number; top: number }
/** Where the dialog is, as the CSS says it: an offset from the centred place. */
export interface Offset { x: number; y: number }
/** The window the dialog sits in, and the band at its top it keeps clear of
 *  (the desktop app's title bar, where a press drags the window). */
export interface Room { width: number; height: number; top?: number }
/** An edge or a corner, by compass point. */
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
/** What the reader chose, per provider: a size, the whole window, or nothing
 *  (the default, which follows the window). */
export type ChosenSize = Size | "fill" | null;
/** The Size menu's three sizes. */
export type SizePreset = "default" | "fill" | "smaller";

export const DIALOG_MIN: Readonly<Size> = { width: 720, height: 480 };
export const DIALOG_CAP: Readonly<Size> = { width: 1680, height: 1120 };
/** The default's share of the window, each way. */
export const DIALOG_SHARE = 0.88;
/** What the dialog leaves free on every side of the window. */
export const WINDOW_GAP = 16;
/** One arrow press in keyboard mode, and one with Shift. */
export const SIZE_STEP = 32;
export const SIZE_STEP_LARGE = 128;
/** At this width and under, the dialog is the phone's full-screen sheet and
 *  nothing resizes it. */
export const SHEET_QUERY = "(max-width: 640px)";
export const EDGES: readonly Edge[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

const topOf = (room: Room) => Math.max(0, room.top ?? 0);

/** The most the dialog can be: the window less 16 on each side, under the
 *  title bar when there is one. */
export function largestSize(room: Room): Size {
  return {
    width: Math.max(0, Math.floor(room.width - 2 * WINDOW_GAP)),
    height: Math.max(0, Math.floor(room.height - topOf(room) - 2 * WINDOW_GAP)),
  };
}

/** The least: 720 x 480, or the largest when the window is smaller than that. */
export function smallestSize(room: Room): Size {
  const most = largestSize(room);
  return { width: Math.min(DIALOG_MIN.width, most.width), height: Math.min(DIALOG_MIN.height, most.height) };
}

const within = (value: number, least: number, most: number) => Math.min(most, Math.max(least, Number.isFinite(value) ? value : least));

/** A size held between the smallest and the largest the window allows. */
export function clampSize(size: Size, room: Room): Size {
  const least = smallestSize(room);
  const most = largestSize(room);
  return { width: Math.round(within(size.width, least.width, most.width)), height: Math.round(within(size.height, least.height, most.height)) };
}

/** 88 % of the window each way, never past 1680 x 1120, within the limits. */
export function defaultSize(room: Room): Size {
  return clampSize({
    width: Math.min(room.width * DIALOG_SHARE, DIALOG_CAP.width),
    height: Math.min(room.height * DIALOG_SHARE, DIALOG_CAP.height),
  }, room);
}

/** The size on screen in this window for what the reader chose. */
export function shownSize(chosen: ChosenSize, room: Room): Size {
  if (chosen === "fill") return largestSize(room);
  return chosen ? clampSize(chosen, room) : defaultSize(room);
}

/** Where a dialog of `size` sits when nothing has moved it: centred under the
 *  title bar. */
export function centredRect(size: Size, room: Room): Rect {
  const top = topOf(room);
  return { ...size, left: (room.width - size.width) / 2, top: top + (room.height - top - size.height) / 2 };
}

/** A rect held inside the window: its size clamped, then moved in from any
 *  side it crosses, so the header, its × and the toolbar stay in view. */
export function keepInRoom(rect: Rect, room: Room): Rect {
  const size = clampSize(rect, room);
  const left = within(rect.left, WINDOW_GAP, room.width - WINDOW_GAP - size.width);
  const top = within(rect.top, topOf(room) + WINDOW_GAP, room.height - WINDOW_GAP - size.height);
  return { ...size, left, top };
}

/** The offset the CSS gives the dialog for a rect: from the place the scrim's
 *  centring puts it, which is the middle of the whole window. */
export function offsetOf(rect: Rect, room: Room): Offset {
  return { x: Math.round(rect.left - (room.width - rect.width) / 2), y: Math.round(rect.top - (room.height - rect.height) / 2) };
}

/** The rect on screen for a size and an offset, or centred without one. */
export function rectOf(size: Size, offset: Offset | null, room: Room): Rect {
  if (!offset) return keepInRoom(centredRect(size, room), room);
  return keepInRoom({ ...size, left: (room.width - size.width) / 2 + offset.x, top: (room.height - size.height) / 2 + offset.y }, room);
}

/** Dragging an edge or a corner by (dx, dy) from where the drag started. The
 *  sides named follow the pointer; the opposite sides stay where they were,
 *  and a side stops at the limits rather than pushing the other one. */
export function dragRect(start: Rect, edge: Edge, dx: number, dy: number, room: Room): Rect {
  const least = smallestSize(room);
  const minLeft = WINDOW_GAP;
  const maxRight = room.width - WINDOW_GAP;
  const minTop = topOf(room) + WINDOW_GAP;
  const maxBottom = room.height - WINDOW_GAP;
  let { left, top, width, height } = start;
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  if (edge.includes("e")) width = within(start.width + dx, least.width, Math.max(least.width, maxRight - left));
  if (edge.includes("w")) {
    width = within(start.width - dx, least.width, Math.max(least.width, right - minLeft));
    left = right - width;
  }
  if (edge.includes("s")) height = within(start.height + dy, least.height, Math.max(least.height, maxBottom - top));
  if (edge.includes("n")) {
    height = within(start.height - dy, least.height, Math.max(least.height, bottom - minTop));
    top = bottom - height;
  }
  return keepInRoom({ left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) }, room);
}

/** The sides a drag of this edge moves, as the CSS reads them: "s e". */
export function edgeSides(edge: Edge): string {
  return edge.split("").join(" ");
}

/** One arrow press in keyboard mode: Right and Down grow the dialog, Left and
 *  Up shrink it, by 32 (128 with Shift), about its centre and kept in the
 *  window. Null for any other key. */
export function stepRect(rect: Rect, key: string, large: boolean, room: Room): Rect | null {
  const step = large ? SIZE_STEP_LARGE : SIZE_STEP;
  const dw = key === "ArrowRight" ? step : key === "ArrowLeft" ? -step : 0;
  const dh = key === "ArrowDown" ? step : key === "ArrowUp" ? -step : 0;
  if (!dw && !dh) return null;
  const size = clampSize({ width: rect.width + dw, height: rect.height + dh }, room);
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return keepInRoom({ ...size, left: Math.round(cx - size.width / 2), top: Math.round(cy - size.height / 2) }, room);
}

/** Which of the Size menu's sizes is on, if any. */
export function presetOf(chosen: ChosenSize): SizePreset | null {
  if (chosen == null) return "default";
  if (chosen === "fill") return "fill";
  return chosen.width === DIALOG_MIN.width && chosen.height === DIALOG_MIN.height ? "smaller" : null;
}

/** What choosing one of the menu's sizes remembers. */
export function chosenFor(preset: SizePreset): ChosenSize {
  return preset === "default" ? null : preset === "fill" ? "fill" : { ...DIALOG_MIN };
}

/** The custom properties integrations.css sizes and places the dialog from.
 *  The CSS clamps them to the window, so they hold what was chosen. */
export function sizeProperties(chosen: ChosenSize, offset: Offset | null): Record<string, string> {
  const css: Record<string, string> = {};
  if (chosen === "fill") { css["--ig-w"] = "100vw"; css["--ig-h"] = "100dvh"; }
  else if (chosen) { css["--ig-w"] = `${chosen.width}px`; css["--ig-h"] = `${chosen.height}px`; }
  if (offset) { css["--ig-x"] = `${offset.x}px`; css["--ig-y"] = `${offset.y}px`; }
  return css;
}

const key = (kind: string) => `agent-dag.integrations.${kind}.dialog-size`;
const LONGEST = 100_000;
const fair = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= LONGEST;

/** The size this provider's dialog was left at in this browser, or null for
 *  the default. Anything unreadable is the default. */
export function readChosenSize(kind: string): ChosenSize {
  const raw = readStored(key(kind));
  if (raw == null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === "fill") return "fill";
    if (value && typeof value === "object") {
      const { width, height } = value as { width?: unknown; height?: unknown };
      if (fair(width) && fair(height)) return { width: Math.round(width), height: Math.round(height) };
    }
  } catch { /* not ours: the default */ }
  return null;
}

/** Remembers what was chosen; null forgets it, back to the default. */
export function writeChosenSize(kind: string, chosen: ChosenSize): void {
  if (chosen == null) removeStored(key(kind));
  else writeStored(key(kind), JSON.stringify(chosen === "fill" ? "fill" : { width: Math.round(chosen.width), height: Math.round(chosen.height) }));
}
