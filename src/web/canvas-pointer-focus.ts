// The canvas's answer to a mouse press that would focus the canvas itself
// (#434), and the list of focus candidates it predicts the browser's walk with.
//
// Moved out of App.tsx unchanged; <main> hands it to onMouseDownCapture. It was
// a useCallback with no deps and closed over nothing, so it is a plain function
// here, with the one identity for the life of the page it already had.
import type React from "react";

/** What a mouse press can put focus on: the elements the browser looks for,
 *  walking up from whatever was pressed, when it decides where a click's focus
 *  goes. Written out here because releasePointerFocus has to predict that walk
 *  before the browser makes it — a press whose nearest candidate is the canvas
 *  itself is one the canvas should not answer (#434).
 *
 *  `[tabindex]` is the entry that makes the rule work at all: <main> carries
 *  tabindex="-1" for the skip link, which is exactly what puts it in this list.
 *  The disabled controls are excluded because the browser skips them too and
 *  keeps walking — a click on a disabled button lands its focus on the nearest
 *  enabled ancestor, which on this canvas is <main>. */
const FOCUS_CANDIDATES = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "summary",
  "[tabindex]",
].join(",");

/** The pointer half of the skip link's focus target (#434).
 *
 *  `tabIndex={-1}` is on <main> so the skip link has somewhere to land, and
 *  it buys a second thing nobody asked for: an element a MOUSE can focus. A
 *  click on empty canvas parked focus on the canvas with nothing on screen to
 *  say so, and the next keystroke — any keystroke, including the ones the
 *  deck has no shortcut for — made the browser change its mind about
 *  `:focus-visible` for the element that was already focused. Selectors 4
 *  allows exactly that, and Chrome does it: the ring the skip link needs lit
 *  up around the whole window on a press the user reads as re-layout or a
 *  theme swap, and stayed until focus moved.
 *
 *  So the fix is here and not in the stylesheet, which cannot reach this.
 *  `:focus-visible` is the browser's own judgement, re-made AFTER focus has
 *  landed, so no selector can tell the two arrivals apart — CSS could only
 *  overrule the ring with `outline: none`, and the sheet is allowed exactly
 *  one of those (#368 pins the count, because a rule that quietly removes a
 *  focus ring is how the search field lost its own). Dropping the ring
 *  altogether is not on offer either: #381 put it there because landing
 *  somewhere with no sign you landed is the failure the skip link exists to
 *  fix. What is left is to take away the arrival that was never wanted. The
 *  ring is untouched, and the one path that can still reach it is the
 *  programmatic focus it was written for.
 *
 *  Capture phase, which is a measurement and not a preference: React Flow's
 *  pan handler calls stopImmediatePropagation() on the pane's mousedown, so a
 *  bubbling handler on <main> never sees the click that causes this at all.
 *  Cancelling the default costs the canvas nothing — panning, node drags,
 *  onPaneClick and the context menu all run off events of their own, and none
 *  of them is a default action. */
export function releasePointerFocus(e: React.MouseEvent<HTMLElement>): void {
  // What the browser is about to focus: the nearest focus candidate at or
  // above the press. <main> is one of them — that is what tabindex="-1"
  // means — so a press that finds anything else found a real control, and a
  // real control keeps the click-to-focus every other control on the page
  // has. Asked with closest() rather than from a list of our own, because
  // the browser's own answer is the one that has to be predicted here.
  const target = e.target as Element | null;
  if (!target?.closest || target.closest(FOCUS_CANDIDATES) !== e.currentTarget) return;
  e.preventDefault();
  // And the other half: clicking empty canvas has always been how the mouse
  // puts focus down — canvas-keys.ts calls it the only route back to <body>
  // that existed before Escape learned to release one. Cancelling the
  // default focus on its own would leave the search box or a card still
  // holding it, so the click would stop meaning what it has always meant.
  (document.activeElement as HTMLElement | null)?.blur?.();
}
