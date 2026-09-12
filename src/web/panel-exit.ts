// Keeping a panel on screen long enough to leave.
//
// A panel that is rendered by `{open && <Panel/>}` cannot animate out: the
// moment `open` goes false the element is gone and there is nothing left to
// animate. Every exit on this deck has lived with that — the modals fade IN and
// vanish OUT — and it does not matter for something that covers the screen and
// is dismissed deliberately. It matters for a side panel, because closing one
// moves the whole canvas 288px, and a layout change that happens in a single
// frame is the one thing motion is actually for.
//
// So the panel stays mounted for the length of its exit and is told it is
// leaving. The decision is a pure function of three things and nothing else, so
// it can be reasoned about without a renderer.
import { useEffect, useRef, useState } from "react";

/** What a panel should be doing right now.
 *
 *  `gone` is not the same as `!open`: a panel that has just been asked to close
 *  is `leaving`, still mounted, and carrying the class that runs its exit. */
export type PanelPhase = "gone" | "entering" | "here" | "leaving";

/**
 * The next phase, given what was asked for and where the panel is now.
 *
 * REOPENING MID-EXIT IS THE CASE WORTH NAMING. A panel closed and reopened
 * inside its own exit window must come straight back rather than finish
 * leaving and then re-enter — the second is a flicker, and it is what a
 * timeout that only ever fires would produce. `leaving` + `open` therefore
 * lands on `here` and not on `entering`: the panel never went anywhere, so
 * replaying its entrance would animate a movement that did not happen.
 */
export function nextPhase(open: boolean, phase: PanelPhase): PanelPhase {
  if (open) return phase === "gone" ? "entering" : phase === "leaving" ? "here" : phase;
  return phase === "gone" ? "gone" : "leaving";
}

/** Whether a phase means the panel is in the DOM. */
export function isMounted(phase: PanelPhase): boolean {
  return phase !== "gone";
}

/**
 * The hook the panel's owner uses.
 *
 * `exitMs` must be the exit animation's own duration. Longer leaves an
 * invisible panel holding a grid column open; shorter cuts the animation off
 * partway, which reads as a stutter rather than as a close.
 */
export function usePanelPresence(open: boolean, exitMs: number): PanelPhase {
  const [phase, setPhase] = useState<PanelPhase>(() => (open ? "here" : "gone"));
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setPhase(p => nextPhase(open, p));
  }, [open]);

  useEffect(() => {
    if (phase !== "leaving") return;
    // A close that is interrupted by a reopen clears this on the way past —
    // the cleanup runs when `phase` changes, which is what a reopen does.
    timer.current = window.setTimeout(() => setPhase("gone"), exitMs);
    return () => { if (timer.current != null) window.clearTimeout(timer.current); };
  }, [phase, exitMs]);

  // `entering` is a one-frame state: the class that runs the entrance is
  // applied on mount and the animation carries itself, so nothing needs to
  // wait for it. Settling immediately keeps a reopen from being told it is
  // still entering when it is not.
  useEffect(() => {
    if (phase === "entering") setPhase("here");
  }, [phase]);

  return phase;
}
