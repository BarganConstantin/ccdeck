// A Compact followed to its end, one run per session (chat-actions.ts says how
// a run starts and ends). Chat's ⋯ starts one, and so does /compact typed in
// the box, for a session whose compaction the deck can follow.
//
// LOOKED AT ONLY WHILE WATCHED. The compaction's line is read off the screen
// only while Chat shows the session (use-live-compaction.ts), so the run is
// stepped only then (`watching`). In Term, or while the pane cannot be read,
// it waits as it is, and a line that had gone starts its wait again when Chat
// is back: a compaction that ended out of sight is judged by the record Chat
// reads on its return, never by the time it was not looked at.
//
// Each end is handed to `onEnd` once, with the session it was for.
import { useEffect, useRef, useState } from "react";
import type { ChatTurn } from "./components/chat/chat-model";
import { compactRun, compactStep, type CompactEnd, type CompactRun } from "./chat-actions";

export interface CompactRunOptions {
  /** The session's key, its draft's: one run per session. */
  session: string;
  /** Chat shows the session and its screen is read. */
  watching: boolean;
  /** The conversation as read. */
  turns: readonly ChatTurn[];
  /** The screen shows the compaction's line now. */
  compacting: boolean;
  /** The /compact sent was not taken in time, and Chat says so. */
  untaken: boolean;
  onEnd(end: CompactEnd, session: string): void;
}

export interface CompactRunView {
  /** A run of this session's is under way. */
  running: boolean;
  /** Begins a run for this session; false, and nothing begun, while one is under way. */
  start(): boolean;
}

export function useCompactRun(o: CompactRunOptions): CompactRunView {
  const [runs, setRuns] = useState<Record<string, CompactRun>>({});
  // Read and written at once, so two presses before a render begin one run.
  const held = useRef(runs);
  // Moves when a run is due another look with no new fact.
  const [tick, setTick] = useState(0);
  const onEnd = useRef(o.onEnd);
  onEnd.current = o.onEnd;
  const { session, watching, turns, compacting, untaken } = o;
  const run = runs[session];
  const put = (key: string, next: CompactRun | null) => {
    const all = { ...held.current };
    if (next) all[key] = next;
    else delete all[key];
    held.current = all;
    setRuns(all);
  };
  useEffect(() => {
    if (!run) return;
    if (!watching) {
      if (run.goneAt !== undefined) put(session, { at: run.at, marks: run.marks, seen: run.seen });
      return;
    }
    const step = compactStep(run, { turns, compacting, untaken }, Date.now());
    if (step.run !== run) put(session, step.run);
    if (step.end) onEnd.current(step.end, session);
    if (step.next === undefined) return;
    const timer = setTimeout(() => setTick(n => n + 1), Math.max(0, step.next - Date.now()) + 50);
    return () => clearTimeout(timer);
    // `put` is made anew each render and reads only the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, session, watching, turns, compacting, untaken, tick]);
  return {
    running: run !== undefined,
    start: () => {
      if (held.current[session]) return false;
      put(session, compactRun(turns, Date.now()));
      return true;
    },
  };
}
