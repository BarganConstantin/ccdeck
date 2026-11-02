// The slide a session makes out of the way of one that grew.
//
// Lifted out of App.tsx's `Inner`, where its state sat among the drag flags and
// the two operations on it sixty lines further down, past the zoom level. The
// flag turns the canvas's node transition on (`.canvas-wrap.bubbling` in
// styles.css) for the length of one push, so the reader sees why a card moved;
// a drag ends it early. Both writes are here now, and so is the timer.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * How long a session takes to slide out of the way of one that grew.
 *
 * Long enough to be followed — the point of animating it at all is that the
 * user sees WHY a card moved — and short enough that the canvas is settled
 * again before they act on it. Mirrored in the .bubbling rule in
 * canvas-motion.css, and the camera's Slow (V4's motion spec: neighbours move
 * in Slow on the stage curve).
 */
const BUBBLE_MS = 400;

/** How long the board holds its `closing` mark after a card has gone: the 100ms
 *  hold before the neighbours move (canvas-motion.css) and their Slow, with the
 *  same margin the push has. */
const CLOSE_HOLD_MS = 100;
const CLOSE_MS = CLOSE_HOLD_MS + BUBBLE_MS + 80;

/**
 * Whether a card has just left the board, for the length of the move that
 * closes its gap. A card leaves with its opacity (search-and-banners.css) and
 * its neighbours follow after a hold, so the board is not pulled shut under
 * the fade; the canvas carries `closing` for that move and the sheet puts the
 * hold on the cards' transition. Read in a layout effect, so the mark is on
 * before the frame in which the neighbours' new places are first painted.
 */
export function useClosingGap(visible: ReadonlySet<string>): boolean {
  const [closing, setClosing] = useState(false);
  const before = useRef<ReadonlySet<string>>(visible);
  const timer = useRef<number | null>(null);
  useLayoutEffect(() => {
    const last = before.current;
    before.current = visible;
    let gone = false;
    for (const id of last) if (!visible.has(id)) { gone = true; break; }
    if (!gone) return;
    setClosing(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setClosing(false), CLOSE_MS);
  }, [visible]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  return closing;
}

export function useBubbleAnimation() {
  // While true, node movement is animated instead of instant. Held only for
  // the length of the transition: a permanent transition would make dragging
  // lag behind the cursor.
  const [bubbling, setBubbling] = useState(false);
  const bubbleTimerRef = useRef<number | null>(null);
  const endBubble = useCallback(() => {
    if (bubbleTimerRef.current) { window.clearTimeout(bubbleTimerRef.current); bubbleTimerRef.current = null; }
    setBubbling(false);
  }, []);
  const onBubble = useCallback((movedSessions: string[]) => {
    if (movedSessions.length === 0) return;
    // Raised from inside a useMemo, so the state change has to leave the
    // render pass before React sees it.
    queueMicrotask(() => {
      setBubbling(true);
      if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = window.setTimeout(() => setBubbling(false), BUBBLE_MS + 80);
    });
  }, []);
  useEffect(() => () => { if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current); }, []);

  return { bubbling, endBubble, onBubble };
}
