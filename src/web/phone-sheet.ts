// The phone sheet: Usage, This machine, the Inspector and Accounts at 640 and
// under come up from the bottom edge over Sessions, one at a time, and go back
// the same way. A flick closes one, whatever the distance; so does Esc.
//
// What is here is the rules, as plain functions the suite can call: when a
// release closes, how far a pull up gives, which sheet keeps the screen when a
// second one is asked for, what the Sessions door does with one up. The hook
// that wires them to the page is use-phone-sheets.ts.
import { motionToken, tokenMs } from "./rail-motion";

/** The four panels that are sheets on a phone. */
export type SheetName = "accounts" | "usage" | "machine" | "inspector";

/** Which sheets are open, by name. */
export type SheetFlags = Record<SheetName, boolean>;

/** Over this speed, in px per ms, a release closes the sheet, provided the
 *  finger also went MIN_FLICK_PX down. */
export const FLICK_SPEED = 0.11;
/** A flick is a drag that went this far down as well as fast: a tap whose
 *  finger moved a pixel or two in a frame is not one. */
export const MIN_FLICK_PX = 12;
/** A press becomes a drag only after this much vertical travel from where it
 *  began; under it the press is left alone, so a tap on the title is a tap. */
export const DRAG_SLOP_PX = 8;
/** Slower than a flick, a release past this share of the sheet's height closes
 *  it; under it, the sheet returns. */
export const CLOSE_SHARE = 0.4;
/** How far down from the sheet's top edge a drag may start: the handle's strip
 *  and the header under it, a fingertip's height. */
export const GRAB_ZONE_PX = 44;
/** Every name, in the order a sheet is looked for. */
export const SHEET_NAMES: readonly SheetName[] = ["accounts", "usage", "machine", "inspector"];

/** The times and the curve of the sheet, read from the tokens the CSS reads
 *  (tokens.css): a sheet comes up in the stage's open time, goes in its close
 *  time, and crossfades in the base time under reduced motion. */
export const sheetOpenMs = (): number => tokenMs("--dur-stage-in");
export const sheetCloseMs = (): number => tokenMs("--dur-stage-out");
export const sheetFadeMs = (): number => tokenMs("--dur-base");
export const sheetEase = (): string => motionToken("--ease-stage");

/** Whether a release closes the sheet: a flick (down at least MIN_FLICK_PX and
 *  faster than FLICK_SPEED), or a drag past CLOSE_SHARE of its height. `dy` is
 *  the drag in px (down is positive), `ms` how long the last stretch of it took
 *  and `moved` how far that stretch went. */
export function releaseCloses(dy: number, height: number, moved: number, ms: number): boolean {
  if (dy >= MIN_FLICK_PX && ms > 0 && moved / ms > FLICK_SPEED) return true;
  return height > 0 && dy > CLOSE_SHARE * height;
}

/** Whether a press that has travelled `travel` px vertically (either way) is a
 *  drag yet. */
export function dragStarts(travel: number): boolean {
  return Math.abs(travel) >= DRAG_SLOP_PX;
}

/** The sheet's offset for a drag of `dy`: 1:1 on the way down, from where it
 *  was grabbed, and a pull up resists, giving less the further it goes, with
 *  no hard stop. */
export function dragOffset(dy: number): number {
  if (dy >= 0) return dy;
  const pull = -dy;
  return -(pull * 24) / (pull + 24);
}

/** The sheet that is on top of the others when several are drawn: the last of
 *  SHEET_NAMES that is open. The four are `position: fixed` in one box and
 *  App draws them in that order, so the last one paints over the rest. */
export function topSheet(now: SheetFlags): SheetName | null {
  const open = SHEET_NAMES.filter(n => now[n]);
  return open.length > 0 ? open[open.length - 1] : null;
}

/** The sheet that keeps the screen when the flags change: the one opened last,
 *  else the one on top (what the reader sees). Others are closed by the caller. */
export function sheetToKeep(was: SheetFlags, now: SheetFlags): SheetName | null {
  const open = SHEET_NAMES.filter(n => now[n]);
  if (open.length === 0) return null;
  const opened = open.filter(n => !was[n]);
  return opened.length > 0 ? opened[opened.length - 1] : topSheet(now);
}

/** Accounts, asked for on a phone while a pane is up, takes the right of the
 *  deck back from the pane: the pane is the whole screen under the top bar, and
 *  a sheet over it would cover its header's buttons. True on the render in which
 *  Accounts turns open. */
export function accountsGivesPaneBack(a: { phone: boolean; accountsOpen: boolean; accountsWasOpen: boolean; paneOpen: boolean }): boolean {
  return a.phone && a.accountsOpen && !a.accountsWasOpen && a.paneOpen;
}

/** A press on the Sessions door. With a sheet up it means "go to Sessions":
 *  the sheet closes and the list stays open (opened if it was not), and the
 *  list is never toggled shut under a sheet. With none up it is the door's
 *  plain toggle. */
export function pressSessionsDoor(a: {
  sheet: SheetName | null;
  listOpen: boolean;
  closeSheet(): void;
  toggleList(): void;
}): void {
  if (a.sheet == null) { a.toggleList(); return; }
  a.closeSheet();
  if (!a.listOpen) a.toggleList();
}
