// Whether the canvas keeps framing the board by itself.
//
// Lifted out of App.tsx's `Inner` unchanged, bar one dependency: the resume
// listed `rf`, which it never read. `Inner` reads the flag in four places,
// turns it off from four and back on from three, and every one of those went
// through the two operations below already — so what moving it buys is that
// the only code that writes the flag is those two, here, beside the rule that
// it is never stored. `Inner` gets the ref to read, the state to draw the chip
// from, and the operations.
import { useCallback, useEffect, useRef, useState } from "react";

import { removeStored } from "./storage";

const AUTOFIT_KEY = "agent-dag.autoFitDisabled";

/**
 * @param fitLeft Frames the board, the way the deck's own fits do. Resuming
 *   refits at once rather than waiting for the next thing to move.
 */
export function useAutoFitSwitch(fitLeft: (duration?: number) => void) {
  // Sticky "user took the wheel" flag. Once the user manually pans, zooms,
  // or drags a node, autofitting is suspended until they hit the recenter
  // button, or the chip the canvas shows while it is off.
  //
  // NOT PERSISTED (#820). It was, "so a refresh respects the user's
  // preference", and what that bought was a pan from some earlier day still in
  // force across every reload after it: new sessions landing off to one side
  // of a mostly empty canvas that said nothing about why, the only sign a tint
  // on a 14px crosshair. A pan is a decision about this look at the board, not
  // a setting, so every load starts with the canvas fitting again. The key
  // older builds wrote is cleared once, below, so it stops meaning anything.
  const autoFitDisabledRef = useRef(false);
  const [autoFitDisabled, setAutoFitDisabled] = useState(false);
  useEffect(() => { removeStored(AUTOFIT_KEY); }, []);
  const disableAutoFit = useCallback(() => {
    if (autoFitDisabledRef.current) return;
    autoFitDisabledRef.current = true;
    setAutoFitDisabled(true);
  }, []);
  const enableAutoFitAndRefit = useCallback(() => {
    autoFitDisabledRef.current = false;
    setAutoFitDisabled(false);
    fitLeft(400);
  }, [fitLeft]);

  return { autoFitDisabled, autoFitDisabledRef, disableAutoFit, enableAutoFitAndRefit };
}
