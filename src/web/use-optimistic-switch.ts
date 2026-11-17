import { useRef, useState } from "react";

/** A switch that flips at once and writes behind the flip (V4's motion rules,
 *  Switch). `committed` is what the store holds, null until it has said; `write`
 *  saves the new position and answers whether it took. The knob shows the
 *  position the press asked for while the write runs; a refused write drops it
 *  back to `committed`, and the same transition carries the knob home. */
export function useOptimisticSwitch(committed: boolean | null, write: (next: boolean) => Promise<boolean>) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const flying = useRef(false);
  const checked = pending ?? committed === true;
  const flip = async () => {
    if (committed === null || flying.current) return;
    flying.current = true;
    const next = !checked;
    setPending(next); setFailed(false);
    let ok = false;
    try { ok = await write(next); } catch { ok = false; }
    flying.current = false;
    setPending(null);
    if (!ok) setFailed(true);
  };
  return { checked, busy: pending !== null, failed, flip };
}
