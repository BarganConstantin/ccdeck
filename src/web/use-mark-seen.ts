// A session you have selected, or have open on the stage, is one you are
// looking at: its finished turn is seen (session-seen.ts), now and every time
// a turn ends under it, and again when the hidden tab comes back to the front.
// Here and not in the rail, so a rail that is shut still knows what you saw.
//
// The first run's baseline is taken here too, the first time the board holds a
// session: before paint, so the rail never draws a whole board as unseen.
import { useEffect, useLayoutEffect, type MutableRefObject } from "react";
import type { GraphState } from "./reducer";
import { baselineSeen, markSeen, turnEndedAt } from "./session-seen";

/** The root session ids behind some agent ids (a subagent's card is its session's). */
export function sessionsOf(state: GraphState, agentIds: Iterable<string | null>): Set<string> {
  const sessions = new Set<string>();
  for (const id of agentIds) {
    if (id == null) continue;
    const agent = state.agents.get(id);
    if (agent) sessions.add(agent.sessionId);
    // The stage names a session, not a card; keep it even if its root is gone.
    else sessions.add(id);
  }
  return sessions;
}

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useMarkSeen(stateRef: MutableRefObject<GraphState>, agentIds: readonly (string | null)[], revision: number): void {
  useBeforePaint(() => {
    const roots: [string, number | null][] = [];
    for (const a of stateRef.current.agents.values()) if (a.kind === "root") roots.push([a.sessionId, turnEndedAt(a)]);
    baselineSeen(roots);
  }, [revision, stateRef]);
  const key = agentIds.join("\n");
  useEffect(() => {
    const mark = () => {
      for (const id of agentIds) {
        if (id == null) continue;
        const agent = stateRef.current.agents.get(id);
        const root = agent && stateRef.current.agents.get(agent.sessionId);
        if (root) markSeen(root.sessionId, turnEndedAt(root));
      }
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [key, revision, stateRef]);
}
