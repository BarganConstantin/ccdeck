// The accounts panel's one request slot, and the two attributes it puts on
// every control a request makes inert (#518).
//
// Lifted out of AccountsPanel.tsx unchanged: the tag of the request that is
// out, the ref a handler reads it through before the next render, the claim
// and the release around every request, and pressProps. What that buys is the
// writer count. The slot has exactly two writers, and the whole of #518 is that
// every control asks it the same question — "is somebody else working" — so a
// third writer anywhere in the panel would be the second answer the issue asks
// against. The setter and the ref are private to this file now; the panel gets
// the tag to draw, the two operations, and the one spelling of the attributes.
import { useCallback, useRef, useState } from "react";

import { pressAccepted, pressState } from "./panel-press";

export function useRequestSlot() {
  // The tag of the one request the panel has out, or null. A switch is one of
  // them now rather than a flag of its own: #518 needs every control to answer
  // the same question — "is somebody else working" — and two flags cannot.
  const [busy, setBusy] = useState<string | null>(null);

  // The same fact as `busy`, where a handler can read it without waiting for a
  // render. #518 leaves the working control enabled, so a second press reaches
  // the handler and the handler is what has to refuse it.
  const busyRef = useRef<string | null>(null);
  /** Take the panel's one request slot, or refuse the press. */
  const claim = useCallback((tag: string) => {
    if (!pressAccepted(busyRef.current)) return false;
    busyRef.current = tag;
    setBusy(tag);
    return true;
  }, []);
  const release = useCallback(() => { busyRef.current = null; setBusy(null); }, []);

  /**
   * The two attributes #518 puts on every control that a request makes inert.
   *
   * Spread rather than written out per button, because the whole of that fix is
   * that there is ONE answer: inert while somebody else is working, busy and
   * still focusable while it is your own request. A control that spelled either
   * half by hand would be the second answer the issue asks against.
   */
  const pressProps = (tag: string, working = false) => {
    const s = pressState(busy, tag);
    return { disabled: s.disabled, "aria-busy": s.busy || working };
  };

  return { busy, claim, release, pressProps };
}
