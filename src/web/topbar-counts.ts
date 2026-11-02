// The three counts the top bar's start group draws after the wordmark (V4's
// Figma, Top bar): sessions waiting on you, sessions working, sessions done.
//
// Counted over SESSIONS (the roots), by the word the card wears (cardState), so
// a pill and the card it counts can never name different states: a session
// blocked on you is Waiting and nothing else, a running one Working, a finished
// one Done. A session that failed is none of the three; its card says Failed.
// Pure and importing no DOM, like ambient-counts.ts, so a bare-node test calls
// the rule the app runs.
import { cardState } from "./node-face";
import type { AgentNodeData } from "./types";

export interface SessionCounts {
  waiting: number;
  working: number;
  done: number;
}

/** English, the way the other V4 top bar words are held (QUICK_OPEN_PLACEHOLDER);
 *  "waiting" is the catalog's own (board.queue.waiting). */
export const WORKING_WORD = "working";
export const DONE_WORD = "done";

export function sessionCounts(agents: Iterable<AgentNodeData>): SessionCounts {
  const counts: SessionCounts = { waiting: 0, working: 0, done: 0 };
  for (const a of agents) {
    if (a.kind !== "root") continue;
    const tone = cardState(a).tone;
    if (tone === "waiting") counts.waiting++;
    else if (tone === "active") counts.working++;
    else if (tone === "done") counts.done++;
  }
  return counts;
}
