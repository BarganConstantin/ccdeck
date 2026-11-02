// A top bar chip's arrival and departure (V4's motion rules, top bar chip): a
// chip that comes enters with opacity and 4px of x over --dur-base, and one that
// leaves runs out over --dur-exit with its neighbours closing over the gap.
// TRANSITIONS on a slot's data attribute (topbar-status.css, .chip-slot), never
// keyframes, so a chip that is told to go twice in a row, or come back while it
// is leaving, simply reverses from where it is.
//
// The slot is mounted off, a frame later `data-on` takes it to its resting
// look; on `show` going false it loses `data-on`, keeps the LAST children it
// was given (the thing that went is no longer in the caller's data) for
// CHIP_EXIT_MS, and then is gone. The width closes with a grid track from 1fr to
// 0fr and a margin that takes back the bar's gap (--chip-gap, set by the group
// that holds the chips), so the neighbours move over by the chip's width and
// the gap together, and nothing jumps when the slot unmounts.
//
// Nothing here is a live region or a name: the chip inside keeps both.
import { useEffect, useRef, useState, type ReactNode } from "react";

/** --dur-exit (tokens.css), in ms. A test holds the two equal. */
export const CHIP_EXIT_MS = 150;

export default function ChipPresence({ show, className, onExited, children }: {
  show: boolean;
  /** Joined to the slot's own class, so a group's own rules (`.status`) can
   *  ride on the element that animates. */
  className?: string;
  /** Told once the exit has run out and the slot is gone. */
  onExited?: () => void;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(show);
  const [on, setOn] = useState(false);
  const last = useRef(children);
  if (show) last.current = children;
  const exited = useRef(onExited);
  exited.current = onExited;
  useEffect(() => {
    if (show) {
      setMounted(true);
      let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setOn(true)); });
      return () => cancelAnimationFrame(frame);
    }
    setOn(false);
    const timer = window.setTimeout(() => { setMounted(false); exited.current?.(); }, CHIP_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [show]);
  if (!mounted) return null;
  return (
    <span className={className ? `chip-slot ${className}` : "chip-slot"} data-on={on || undefined}>
      {last.current}
    </span>
  );
}
