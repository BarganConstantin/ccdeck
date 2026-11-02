// The phone sheet: Usage, This machine, the Inspector and Accounts at 640 and
// under come up from the bottom edge over Sessions, one at a time, and go back
// the same way. A flick closes one, whatever the distance; so does Esc.
//
// What is here is the rules, as plain functions the suite can call: when a
// release closes, how far a pull up gives, which sheet keeps the screen when a
// second one is asked for. The hook that wires them to the page is
// use-phone-sheets.ts.

/** The four panels that are sheets on a phone. */
export type SheetName = "accounts" | "usage" | "machine" | "inspector";

/** Which sheets are open, by name. */
export type SheetFlags = Record<SheetName, boolean>;

/** Over this speed, in px per ms, a release closes the sheet whatever the
 *  distance it was dragged. */
export const FLICK_SPEED = 0.11;
/** Slower than that, a release past this share of the sheet's height closes
 *  it; under it, the sheet returns. */
export const CLOSE_SHARE = 0.4;
/** Open and close, in ms, and the curve both ride. */
export const SHEET_OPEN_MS = 280;
export const SHEET_CLOSE_MS = 200;
export const SHEET_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Under reduced motion the sheet crossfades and does not travel. */
export const SHEET_FADE_MS = 200;
/** How far down from the sheet's top edge a drag may start: the handle's strip
 *  and the header under it, a fingertip's height. */
export const GRAB_ZONE_PX = 44;
/** Every name, in the order a sheet is looked for. */
export const SHEET_NAMES: readonly SheetName[] = ["accounts", "usage", "machine", "inspector"];

/** Whether a release closes the sheet: a flick (down, faster than FLICK_SPEED),
 *  or a drag past CLOSE_SHARE of its height. `dy` is the drag in px (down is
 *  positive), `ms` how long the last stretch of it took and `moved` how far
 *  that stretch went. */
export function releaseCloses(dy: number, height: number, moved: number, ms: number): boolean {
  if (ms > 0 && moved / ms > FLICK_SPEED) return true;
  return height > 0 && dy > CLOSE_SHARE * height;
}

/** The sheet's offset for a drag of `dy`: 1:1 on the way down, from where it
 *  was grabbed, and a pull up resists, giving less the further it goes, with
 *  no hard stop. */
export function dragOffset(dy: number): number {
  if (dy >= 0) return dy;
  const pull = -dy;
  return -(pull * 24) / (pull + 24);
}

/** The sheet that keeps the screen when the flags change: the one opened last,
 *  else the one that was already up. Others are closed by the caller. */
export function sheetToKeep(was: SheetFlags, now: SheetFlags): SheetName | null {
  const open = SHEET_NAMES.filter(n => now[n]);
  if (open.length === 0) return null;
  const opened = open.filter(n => !was[n]);
  return (opened.length > 0 ? opened[opened.length - 1] : open[0]);
}
