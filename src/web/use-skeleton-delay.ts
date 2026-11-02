import { useEffect, useState } from "react";

/**
 * True once a wait has lasted `delayMs`, and false in the very render the wait
 * ends.
 *
 * A skeleton for a wait that is over in 10 ms is a flicker, so it only shows
 * once the wait is real. The delay is a timer set when the wait starts and
 * cleared when it ends or the component goes away; the flag it sets is state,
 * which the effect clears one commit after `pending` turns false. So the answer
 * is gated on `pending` as well: the render that carries the answer already
 * draws it, instead of keeping the skeleton for one more frame.
 */
export function useSkeletonDelay(pending: boolean, delayMs: number): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!pending) { setArmed(false); return; }
    const id = window.setTimeout(() => setArmed(true), delayMs);
    return () => window.clearTimeout(id);
  }, [pending, delayMs]);
  return pending && armed;
}
