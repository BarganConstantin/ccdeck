// A compaction the session's own screen shows while Chat is on and its turn is
// over: /compact typed in Term or sent from Chat, which the board does not see
// as a turn (live-activity.ts says how it is read and when it ends). The read
// is the one use-screen-status.ts makes while the session works, on the same
// timer; the two never run at once, so the screen is read once a second at most.
//
// A switch to another session, or the pane no longer live, starts again from
// nothing: the next read finds the compaction again, with its own clock.
import { useEffect, useRef, useState } from "react";
import { compactionAfter, type CompactionSeen } from "./live-activity";
import { screenSpinner } from "./screen-status";
import { STATUS_POLL_MS } from "./use-screen-status";

export interface LiveCompactionOptions {
  /** Chat is on screen, the session is not at work, and its pane can be read. */
  on: boolean;
  /** The session's subjectKey: the read goes to it only. */
  subject: string;
  readScreen(subject: string): string | null;
}

/** Since when the conversation is being compacted, or null when it is not. */
export function useLiveCompaction(o: LiveCompactionOptions): { since: number } | null {
  const [seen, setSeen] = useState<CompactionSeen | null>(null);
  const read = useRef(o.readScreen);
  read.current = o.readScreen;
  const { on, subject } = o;
  useEffect(() => {
    setSeen(null);
    if (!on) return;
    const look = () => {
      const screen = read.current?.(subject) ?? null;
      const spinner = screen === null ? null : screenSpinner(screen);
      setSeen(prev => compactionAfter(prev, spinner, Date.now()));
    };
    look();
    const timer = setInterval(look, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [on, subject]);
  return on && seen ? seen : null;
}
