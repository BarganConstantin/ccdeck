// A figure that counts to its new value rather than jumping to it: the usage
// panel's five headline numbers.
//
// Lifted out of UsagePanel.tsx unchanged. The frames are count-up.ts's; this is
// React's half of it — the value on screen right now, so a second change counts
// on from where the number is rather than from where the last count began, and
// the one paint that snaps.
import { useEffect, useRef, useState } from "react";
import { countTo } from "./count-up";

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
export function useCountUp(value: number): number {
  const [shown, setShown] = useState(value);
  // What is on screen right now, so a second change starts a count from where
  // the number IS rather than from where the last one began.
  const currentRef = useRef(value);
  const firstRef = useRef(true);

  useEffect(() => {
    currentRef.current = shown;
  }, [shown]);

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
