// A press anywhere else closes a popover.
//
// The one dismissal a popover needs that a modal does not: a modal has a
// backdrop to catch the click, and a popover has nothing. The topbar speaker's
// SoundMenu (gone since 2026-10-07) and AnchoredPopover each wrote the listener
// out, the same rule twice; it is here once, with the reasons for its shape:
//
//  - `pointerdown` rather than `click`: a press that starts outside should
//    dismiss even if the pointer travels back in before release, and `click` on
//    a control elsewhere in the topbar would otherwise fire against a popover
//    that is still up;
//  - on window and in the capture phase, so a press on a control that stops
//    propagation still closes the popover first;
//  - never for the control that opened it. Its own onClick already toggles, and
//    letting both run would close the popover and immediately reopen it.
//
// Focus is left where the press put it: it landed on something the user chose.
// Escape, the Tab trap and the focus hand-back are useModalDismiss's.
import { useEffect, useRef, type RefObject } from "react";

/** Anything that can say whether a node is inside it — an element, in the app. */
interface Container { contains(other: Node | null): boolean }

/**
 * Whether a press on `target` is outside both the popover and its opener.
 *
 * A press with no target is not one: there is nothing to say it landed
 * anywhere. Exported for its test; the hook below is its one caller.
 */
export function pressIsOutside(
  target: Node | null,
  popover: Container | null | undefined,
  opener: Container | null | undefined,
): boolean {
  if (!target) return false;
  if (popover?.contains(target)) return false;
  if (opener?.contains(target)) return false;
  return true;
}

/**
 * Call `onOutside` for every press outside `popover` and outside the element
 * `opener` returns.
 *
 * `opener` is asked at each press rather than once, so a popover that finds its
 * anchor by id follows a row re-rendered under it. Both callbacks are read
 * through refs, so the listener is attached once for the popover's life and
 * always calls the latest of each.
 */
export function useOutsidePress(
  popover: RefObject<HTMLElement | null>,
  opener: () => HTMLElement | null | undefined,
  onOutside: () => void,
): void {
  const openerRef = useRef(opener);
  openerRef.current = opener;
  const outsideRef = useRef(onOutside);
  outsideRef.current = onOutside;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (pressIsOutside(e.target as Node | null, popover.current, openerRef.current())) outsideRef.current();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [popover]);
}
