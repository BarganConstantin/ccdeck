// The three counts the top bar's start group draws after the wordmark (V4's
// Figma, Top bar): sessions waiting on you, sessions working, sessions done.
//
// Counted over SESSIONS (the roots), by the word the card wears (cardState), so
// a pill and the card it counts can never name different states: a session
// blocked on you is Waiting and nothing else, a running one Working, a finished
// one Done. A session that failed is none of the three; its card says Failed.
// Nor is one that has not had its first prompt: its card says Ready.
// Pure and importing no DOM, like ambient-counts.ts, so a bare-node test calls
// the rule the app runs.
import { cardState } from "./node-face";
import type { AgentNodeData } from "./types";

export interface SessionCounts {
  waiting: number;
  working: number;
  done: number;
}

/** The pills' words, as keys read with `t` where the pill is drawn, with the
 *  pill's figure as `count`: plural keys, because the word agrees with the
 *  figure in front of it in some languages (German "1 arbeitet", "2 arbeiten";
 *  Spanish "1 hecha", "2 hechas"). "waiting" is the catalog's own
 *  (board.queue.waiting), one word for any figure in all ten languages. */
export const WORKING_WORD_MSG = "board.counts.working";
export const DONE_WORD_MSG = "board.counts.done";

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
