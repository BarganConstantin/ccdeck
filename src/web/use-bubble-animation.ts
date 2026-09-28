// The slide a session makes out of the way of one that grew.
//
// Lifted out of App.tsx's `Inner`, where its state sat among the drag flags and
// the two operations on it sixty lines further down, past the zoom level. The
// flag turns the canvas's node transition on (`.canvas-wrap.bubbling` in
// styles.css) for the length of one push, so the reader sees why a card moved;
// a drag ends it early. Both writes are here now, and so is the timer.
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long a session takes to slide out of the way of one that grew.
 *
 * Long enough to be followed — the point of animating it at all is that the
 * user sees WHY a card moved — and short enough that the canvas is settled
 * again before they act on it. Mirrored in the .bubbling rule in styles.css.
 */
const BUBBLE_MS = 420;

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
