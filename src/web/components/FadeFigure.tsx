// A meter's figure and fill when a new reading arrives, as V4's motion spec has
// them: the fill eases to it on --dur-slow, the number crossfades on --dur-base
// (the old figure out, the new one in, opacity only, never counting through the
// values between), and a change under one point jumps. Reduced motion jumps
// everything; the first paint, and a panel reopened, show the value as it is.
import { useEffect, useRef, useState } from "react";
import { motionToken, tokenMs } from "../rail-motion";
import { prefersReducedMotion } from "../viewport-motion";

/** A change smaller than this many points is not worth moving for. */
export const JUMP_UNDER = 1;

/** Whether a reading from `from` to `to` moves (true) or jumps (false). */
export function movesBetween(from: number, to: number, reduced: boolean): boolean {
  return !reduced && Math.abs(to - from) >= JUMP_UNDER;
}

/** True while the fill should jump rather than ease: the change since the
 *  last render is under a point, or the reader asked for less motion. The
 *  element carries it as data-jump, and the sheet drops the transition. */
export function useFillJump(value: number): boolean {
  const last = useRef(value);
  const jump = !movesBetween(last.current, value, prefersReducedMotion());
  useEffect(() => { last.current = value; }, [value]);
  return jump;
}

/** The figure's text, crossfading to a new one on --dur-base when `value`
 *  moved a point or more. Both texts share one grid cell, so nothing shifts. */
export function FadeFigure({ text, value, className }: { text: string; value: number; className?: string }) {
  const prevText = useRef(text);
  const prevValue = useRef(value);
  const cur = useRef<HTMLSpanElement>(null);
  const [old, setOld] = useState<string | null>(null);
  const oldEl = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const wasText = prevText.current;
    const wasValue = prevValue.current;
    prevText.current = text;
    prevValue.current = value;
    if (wasText === text) return;
    if (!movesBetween(wasValue, value, prefersReducedMotion()) || !cur.current?.animate) { setOld(null); return; }
    const timing = { duration: tokenMs("--dur-base"), easing: motionToken("--ease") };
    cur.current.animate([{ opacity: 0 }, { opacity: 1 }], timing);
    setOld(wasText);
  }, [text, value]);

  useEffect(() => {
    if (old == null || !oldEl.current?.animate) return;
    const a = oldEl.current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: tokenMs("--dur-base"), easing: motionToken("--ease"), fill: "forwards" });
    const done = () => setOld(null);
    a.addEventListener("finish", done);
    return () => { a.removeEventListener("finish", done); a.cancel(); };
  }, [old]);

  return (
    <span className={`fade-figure${className ? ` ${className}` : ""}`}>
      <span ref={cur} className="fade-figure-in">{text}</span>
      {old != null && <span ref={oldEl} className="fade-figure-out" aria-hidden>{old}</span>}
    </span>
  );
}
