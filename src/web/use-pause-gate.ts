// Freezing the canvas, and what that costs the graph underneath it.
//
// Extracted from App.tsx's `Inner` unchanged. It was three declarations and a
// callback sitting between a filter-bar ref and a clock, under a section banner
// about neither, which is how a 5,485-line component is read: by scrolling past
// the thing you are not looking for. The behaviour here is exactly what shipped
// — the same two `useState` calls in the same order, the same `useCallback` with
// the same dependency — so the hook order `Inner` presents to React is
// unchanged. Nothing about the pause moved; only where it is written down.
import { useCallback, useState, type MutableRefObject } from "react";

import { createPauseGate, type PauseGate } from "./pause";
import { applyEvent, noteDroppedEvents, settlesInFlightCall, type GraphState } from "./reducer";
import type { HookEnvelope } from "./types";

export interface PauseControls {
  /** The gate itself, and the source of truth for whether the deck is paused.
   *  Callers read `size` and `dropped` off it for the button's title, and
   *  `accept` from the event stream. */
  pauseGate: PauseGate<HookEnvelope>;
  /** The gate's flag mirrored into state, so a toggle re-renders. */
  paused: boolean;
  togglePause: () => void;
}

/**
 * Pause freezes the canvas; it does not drop the connection. The gate owns both
 * the flag and the held events so the SSE handler can read the current pause
 * state out of a ref — see pause.ts for why closing over the state variable
 * instead made every toggle replay the server's whole ring buffer. `paused`
 * mirrors the gate for rendering; the gate stays the source of truth.
 *
 * Lazily, for the reason spelled out at `initialGraph`: a `useRef` argument is
 * re-evaluated on every render (#612). The gate is mutated in place and never
 * replaced, so the value itself is the handle.
 *
 * `protect` is the payload half of the ceiling's eviction rule (#676): the gate
 * drops the oldest event it holds, and the oldest events of a pause are the
 * outcomes of the calls that were already running when it began. Nothing
 * re-delivers those, so a dropped one leaves its call in-flight forever. The
 * gate cannot recognise them — it reads `seq` and `epoch` — so the graph is
 * asked, through the ref, which during a pause is frozen at exactly the set of
 * calls that were open at the freeze.
 */
export function usePauseGate(stateRef: MutableRefObject<GraphState>): PauseControls {
  const pauseGate = useState(() => createPauseGate<HookEnvelope>({
    protect: env => settlesInFlightCall(stateRef.current, env),
  }))[0];
  const [paused, setPaused] = useState(false);
  const togglePause = useCallback(() => {
    // Read before the toggle: a resume clears the gate's count along with its
    // queue, so afterwards there is nothing left to ask about this hold.
    const holed = pauseGate.paused && pauseGate.dropped > 0;
    const held = pauseGate.setPaused(!pauseGate.paused);
    // Before the drain, not after. Every call still in flight is about to be
    // handed a run with a hole in it, and the drain is what settles the ones
    // whose outcomes did survive — which clears the flag again for each of
    // them, leaving it only where the deck genuinely does not know (#676).
    if (holed) noteDroppedEvents(stateRef.current);
    for (const env of held) stateRef.current = applyEvent(stateRef.current, env);
    setPaused(pauseGate.paused);
  }, [pauseGate, stateRef]);

  return { pauseGate, paused, togglePause };
}
