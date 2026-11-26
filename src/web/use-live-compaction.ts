// What the session's own screen shows while Chat is on and its turn is over
// (live-activity.ts says how each is read and when it ends):
// - a compaction: /compact typed in Term or sent from Chat, which the board
//   does not see as a turn;
// - a selection menu the agent draws itself, which the transcript Chat reads
//   does not hold (screen-status.ts screenMenu).
// One read for both, the one use-screen-status.ts makes while the session
// works, on the same timer; the two never run at once, so the screen is read
// once a second at most.
//
// A switch to another session, or the pane no longer live, starts again from
// nothing: the next read finds what that screen shows, with its own clock.
import { useEffect, useRef, useState } from "react";
import { compactionAfter, menuAfter, type CompactionSeen, type MenuSeen } from "./live-activity";
import { screenMenu, screenSpinner } from "./screen-status";
import { STATUS_POLL_MS } from "./use-screen-status";

export interface LiveCompactionOptions {
  /** Chat is on screen, the session is not at work, and its pane can be read. */
  on: boolean;
  /** The session's subjectKey: the read goes to it only. */
  subject: string;
  readScreen(subject: string): string | null;
}

/** What the screen shows of the session after its turn. */
export interface LiveScreen {
  /** Since when the conversation is being compacted, or null. */
  compacting: { since: number } | null;
  /** The choices of a menu at the foot of the screen, or null. */
  menu: readonly string[] | null;
}

interface Seen { compaction: CompactionSeen | null; menu: MenuSeen | null }

const NOTHING: Seen = { compaction: null, menu: null };
const NOTHING_SHOWN: LiveScreen = { compacting: null, menu: null };

export function useLiveScreen(o: LiveCompactionOptions): LiveScreen {
  const [seen, setSeen] = useState<Seen>(NOTHING);
  const read = useRef(o.readScreen);
  read.current = o.readScreen;
  const { on, subject } = o;
  useEffect(() => {
    setSeen(NOTHING);
    if (!on) return;
    const look = () => {
      const screen = read.current?.(subject) ?? null;
      const spinner = screen === null ? null : screenSpinner(screen);
      const menu = screen === null ? null : screenMenu(screen);
      const now = Date.now();
      setSeen(prev => {
        const compaction = compactionAfter(prev.compaction, spinner, now);
        const choices = menuAfter(prev.menu, menu);
        return compaction === prev.compaction && choices === prev.menu ? prev : { compaction, menu: choices };
      });
    };
    look();
    const timer = setInterval(look, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [on, subject]);
  if (!on || (!seen.compaction && !seen.menu)) return NOTHING_SHOWN;
  return { compacting: seen.compaction, menu: seen.menu?.options ?? null };
}

/** Since when the conversation is being compacted, or null when it is not. */
export function useLiveCompaction(o: LiveCompactionOptions): { since: number } | null {
  return useLiveScreen(o).compacting;
}
