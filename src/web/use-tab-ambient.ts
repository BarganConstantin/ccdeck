// What the tab says while the deck is not on screen: a title and a favicon
// that name the sessions waiting on you and running, and whether the stream is
// alive. The rule lives in ambient.ts, where it can be tested; this is the DOM
// write the rule is not allowed to own.
//
// Moved out of App.tsx unchanged.
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { ambientSignal, FAVICON_HREF, type AmbientSignal } from "./ambient";
import { runningSessionCount, type BlockedSession } from "./ambient-counts";
import type { GraphState } from "./reducer";

export function useTabAmbient({ stateRef, waitingSessions, live }: {
  stateRef: MutableRefObject<GraphState>;
  /** The sessions blocked on you, as App.tsx counts them for the chip too. */
  waitingSessions: BlockedSession[];
  /** Whether the event stream is connected. */
  live: boolean;
}): void {
  const runningSessions = useMemo(
    () => runningSessionCount(stateRef.current.agents.values()),
    [stateRef.current, stateRef.current.revision],
  );
  // The tab strip — the only surface of this deck that is on screen while the
  // deck is not. The rule lives in ambient.ts, where it can be tested; this is
  // the DOM write the rule is not allowed to own.
  //
  // Comparing before writing is not defensive tidiness. This runs on the SSE
  // path and `running` churns under a title that is standing still: every
  // subagent that spawns or finishes moves it while the tab still says plain
  // ccdeck and still wears the blue mark. Assigning `document.title` rewrites
  // the <title> node and hands the browser a fresh tab label whether or not the
  // string changed, and a fresh icon href is a data URI to parse and rasterise
  // again. Both cost nothing on the frames where nothing moved, which is nearly
  // all of them.
  const ambientRef = useRef<AmbientSignal | null>(null);
  useEffect(() => {
    const next = ambientSignal({ waiting: waitingSessions.length, running: runningSessions, connected: live });
    const prev = ambientRef.current;
    ambientRef.current = next;
    if (prev?.title !== next.title) document.title = next.title;
    if (prev?.icon !== next.icon) {
      // Mutating href on the existing <link>, not swapping the node. Chrome,
      // Firefox and Safari all re-read the attribute; the replace-the-whole-
      // element dance is a workaround for browsers none of them still are, and
      // it costs a fresh parse of the data URI every time. If some browser in
      // the matrix is ever found ignoring this, THAT is the moment to adopt the
      // heavier version — not before.
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (link) link.href = FAVICON_HREF[next.icon];
    }
  }, [waitingSessions.length, runningSessions, live]);
}
