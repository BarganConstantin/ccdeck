import { useEffect, useRef, useState } from "react";

// V4's motion rules for a wait: the Loader says nothing for the first 150 ms
// (--delay-loader), so a quick answer never flashes it; once drawn it stays at
// least 300 ms, so it is never a blink; and it leaves over --dur-exit, never
// removed at full opacity. The numbers are the tokens' (styles/tokens.css).
export const LOADER_DELAY_MS = 150;
export const LOADER_MIN_SHOWN_MS = 300;
export const LOADER_EXIT_MS = 150;

/** Whether to draw the Loader for a wait that is `busy`, and whether it is on
 *  its way out. `draw` stays true through `leaving`, so the caller keeps the
 *  element mounted until the fade is done. */
export function useWaitingLoader(busy: boolean): { draw: boolean; leaving: boolean } {
  const [draw, setDraw] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (busy) {
      setLeaving(false);
      if (draw) return;
      const id = setTimeout(() => { shownAt.current = Date.now(); setDraw(true); }, LOADER_DELAY_MS);
      return () => clearTimeout(id);
    }
    if (!draw) return;
    let exit: ReturnType<typeof setTimeout> | undefined;
    const wait = Math.max(0, LOADER_MIN_SHOWN_MS - (Date.now() - shownAt.current));
    const id = setTimeout(() => {
      setLeaving(true);
      exit = setTimeout(() => { setDraw(false); setLeaving(false); }, LOADER_EXIT_MS);
    }, wait);
    return () => { clearTimeout(id); if (exit) clearTimeout(exit); };
  }, [busy]);
  return { draw, leaving };
}
