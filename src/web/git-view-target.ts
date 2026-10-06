// Which repository an agent's git view is about, and whether there is one to
// open at all.
//
// A root card carries its session's repository (GitObserved, git-events.ts). A
// subagent carries its own only when it works in a folder of its own; one in
// its parent's folder reads its session's. A folder git cannot read — not a
// repository, git missing, a bare or unsafe one, a folder gone with no branch
// in its log — has no view to open: `g` there makes the glance's one line
// answer instead (GitGlance.tsx). Before the server has said anything the
// answer is "try": the view's own read says what is there.
import type { AgentNodeData, GitFacts } from "./types";
import type { GraphFocus } from "./git-view-types";

/** The facts the view reads for an agent: its own, or its session root's. */
export function gitFactsFor(agent: Pick<AgentNodeData, "git">, root: Pick<AgentNodeData, "git"> | null | undefined): GitFacts | undefined {
  return agent.git ?? root?.git;
}

/** Whether `g` may open the view on this agent. False only when the server
 *  has said its folder is one git cannot read. */
export function gitViewOpens(facts: GitFacts | undefined): boolean {
  return facts === undefined || facts.state === "repo";
}

/** A subagent's key inside its session — what the read routes call `agent` —
 *  or null for a session's main thread. */
export function subagentKey(agent: Pick<AgentNodeData, "id" | "sessionId" | "kind">): string | null {
  if (agent.kind !== "subagent") return null;
  const prefix = `${agent.sessionId}::`;
  return agent.id.startsWith(prefix) ? agent.id.slice(prefix.length) : null;
}

/** Whose work the view shows: from a main node the whole team, from a
 *  subagent that subagent alone until the reader widens it. */
export function gitFocus(agent: Pick<AgentNodeData, "id" | "sessionId" | "kind">, widened: boolean): GraphFocus {
  const key = subagentKey(agent);
  return { sessionId: agent.sessionId, agentIds: key && !widened ? [key] : null };
}
