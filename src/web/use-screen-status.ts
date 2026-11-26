// The agent's own words for what it is doing, read off the pane's live screen
// while Chat shows a session at work (screen-status.ts says which line). The
// read is the one use-prompt-decision.ts makes, on its own slower timer: the
// words change a few times a turn, not every second.
//
// THE WORDS STAY UNTIL OTHERS COME. Claude Code redraws its footer as it goes,
// and a read between two frames finds no spinner line; the row keeps the words
// it had rather than flicker to "Working…" and back. They go when the turn
// does (`on` false) or the pane shows another session.
import { useEffect, useRef, useState } from "react";
import { screenStatus } from "./screen-status";

/** How often the screen is read while Chat shows a session at work. */
export const STATUS_POLL_MS = 1000;

export interface ScreenStatusOptions {
  /** Chat is on screen, the session works, and its pane can be read. */
  on: boolean;
  /** The session's subjectKey: the read goes to it only. */
  subject: string;
  readScreen(subject: string): string | null;
}

export function useScreenStatus(o: ScreenStatusOptions): string | null {
  const [words, setWords] = useState<string | null>(null);
  const read = useRef(o.readScreen);
  read.current = o.readScreen;
  const { on, subject } = o;
  useEffect(() => {
    setWords(null);
    if (!on) return;
    const look = () => {
      const screen = read.current?.(subject) ?? null;
      const found = screen === null ? null : screenStatus(screen);
      if (found) setWords(found);
    };
    look();
    const timer = setInterval(look, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [on, subject]);
  return on ? words : null;
}
