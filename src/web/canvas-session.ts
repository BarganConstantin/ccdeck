import type { AgentNodeData } from "./types";

/** Grouping is a view concern: never change a Codex thread's sessionId. */
export function canvasSessions(agents: Iterable<AgentNodeData>): Map<string, string> {
  const rows = [...agents], byId = new Map(rows.map(a => [a.id, a]));
  const groups = new Map<string, string>();
  for (const row of rows) {
    let current = row;
    const seen = new Set<string>();
    while (current.provider === "codex" && current.parentId) {
      if (seen.has(current.id)) { current = row; break; }
      seen.add(current.id);
      const parent = byId.get(current.parentId);
      if (!parent || parent.provider !== "codex") break;
      current = parent;
    }
    groups.set(row.id, current.sessionId);
  }
  return groups;
}
