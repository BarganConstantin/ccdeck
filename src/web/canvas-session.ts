import type { AgentNodeData } from "./types";

/** Grouping is a view concern: never change a Codex thread's sessionId. */
export function canvasSessions(agents: Iterable<AgentNodeData>): Map<string, string> {
  const rows = [...agents], byId = new Map(rows.map(a => [a.id, a]));
  const groups = new Map<string, string>();
  for (const row of rows) groups.set(row.id, conversationOf(row, byId).sessionId);
  return groups;
}

/** Native terminals belong to the main conversation. Child threads retain
 * their own IDs in the graph and tools, including when a saved pane names one. */
export function terminalSessionId(agents: ReadonlyMap<string, AgentNodeData>, id: string): string {
  const row = agents.get(id) ?? [...agents.values()].find(a => a.sessionId === id);
  return row ? conversationOf(row, agents).sessionId : id;
}


function conversationOf(row: AgentNodeData, agents: ReadonlyMap<string, AgentNodeData>): AgentNodeData {
  let current = row;
  const seen = new Set<string>();
  while (current.provider === "codex" && current.parentId) {
    if (seen.has(current.id)) return row;
    seen.add(current.id);
    const parent = agents.get(current.parentId);
    if (!parent || parent.provider !== "codex") break;
    current = parent;
  }
  return current;
}
