// A figure that counts to its new value rather than jumping to it: the usage
// panel's five headline numbers.
//
// Lifted out of UsagePanel.tsx unchanged. The frames are count-up.ts's; this is
// React's half of it — the value on screen right now, so a second change counts
// on from where the number is rather than from where the last count began, and
// the one paint that snaps.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { countTo, prefersReducedMotion } from "./count-up";

/** A layout effect in the browser, and nothing on the server, where the suite
 *  draws components to markup and a layout effect only warns. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * A figure that counts to its new value instead of teleporting to it.
 *
 * A poll can move a total while somebody is looking at it, and a count says
 * which way and roughly how far. A change of period counts too: it used to
 * snap, on the reasoning that two periods are different quantities, and the
 * note in the effect below says why it stopped.
 *
 * See count-up.ts for what deliberately does not animate — the first paint, a
 * change too small to read, and the tables.
 */
export function useCountUp(value: number, { countIn = false }: {
  /** Count up from zero when the figure first appears, rather than snapping
   *  to it — for a dialog somebody opened to read these numbers, where the
   *  count is the arrival (#1713). The first markup still carries the value,
   *  so what a server render or a test draws is the number itself. */
  countIn?: boolean;
} = {}): number {
  const [shown, setShown] = useState(value);
  // What is on screen right now, so a second change starts a count from where
  // the number IS rather than from where the last one began.
  const currentRef = useRef(value);
  const firstRef = useRef(true);

  useEffect(() => {
    currentRef.current = shown;
  }, [shown]);

  // To zero before the first paint, so a count-in never shows the final
  // figure for a frame and then drops to zero to count it again. Not for a
  // reader who asked for less motion: their figure simply appears.
  useBeforePaint(() => {
    if (!countIn || prefersReducedMotion()) return;
    currentRef.current = 0;
    setShown(0);
  }, []);

  useEffect(() => {
    // ONLY THE FIRST PAINT SNAPS. Pressing `month` or `all` counts too — the
    // figures ride up to twelve thousand or back down to three hundred, which
    // is the one place in this panel where the size of the difference between
    // two periods is worth feeling. It was a snap at first, on the reasoning
    // that two periods are different quantities rather than one that moved;
    // that reasoning is sound and the motion is still better, because the
    // reader pressed the button and is watching the number they asked for.
    if (firstRef.current) {
      firstRef.current = false;
      if (countIn) return countTo(0, value, v => { currentRef.current = v; setShown(v); });
      currentRef.current = value;
      setShown(value);
      return;
    }
    const stop = countTo(currentRef.current, value, v => {
      currentRef.current = v;
      setShown(v);
    });
    return stop;
  }, [value]);

  return shown;
}
