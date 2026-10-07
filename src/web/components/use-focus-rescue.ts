// A press whose answer takes its own control away, arriving later as a render
// rather than as a promise the press can wait on (#1762).
//
// Settings › Notifications' "Enable" becomes a status word once the browser's prompt is
// answered, and Usage history's "Try again" leaves with the error branch it
// sits in once a retry works. Both unmounted under the reader: focus fell to
// <body>, the dialog's trap sent the next Tab to its first stop, and a screen
// reader said nothing. The rule is panel-press.ts's (#518) — a control the
// update takes away hands focus to the nearest thing that outlived it — and
// only when focus was actually dropped, so a reader who moved on while the
// answer was out is left where they put themselves.
import { useEffect, useRef, type RefObject } from "react";
import { focusDropped } from "../panel-press";

/**
 * @param gone Whether the pressed control is no longer drawn.
 * @param target The surviving element focus goes to, or a function that puts
 *   it there when where that is has to be worked out at the time.
 * @returns What the press calls, so that only a press is rescued — a control
 *   that went without being pressed took no focus with it.
 */
export function useFocusRescue(gone: boolean, target: RefObject<HTMLElement | null> | (() => void)) {
  const armed = useRef(false);
  useEffect(() => {
    if (!gone || !armed.current) return;
    armed.current = false;
    if (!focusDropped(document.activeElement?.tagName ?? null)) return;
    if (typeof target === "function") target(); else target.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone]);
  return () => { armed.current = true; };
}
