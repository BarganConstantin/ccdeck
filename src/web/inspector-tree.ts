// The Inspector's Agents tab: who started whom, as a tree of the session's
// agents, and the words around it.
//
// Read off the agents the deck already holds (`parentId` on each), so it adds
// no data of its own. Only agents of the selected one's session are drawn: a
// Codex child session is a root with a parent in another session, and its tree
// is its own.
import type { AgentNodeData } from "./types";
import { UNPRICED_LABEL, fmtCost } from "./pricing";
import { costChip } from "./card-cost";

export interface TreeRow {
  agent: AgentNodeData;
  /** 0 for the root, 1 for its children, 2 for theirs. */
  depth: number;
  /** One flag per gutter column, outermost first, the last being the row's own:
   *  whether the agent at that level has a later sibling, which is whether its
   *  tree line runs on past this row to reach it. */
  more: boolean[];
}

/** The session's agents in the order they read: the root, then each child under
 *  it, oldest first, every child's own children right after it. An agent whose
 *  parent is not in the session (evicted, or not yet seen) hangs off the root
 *  rather than vanishing. */
export function agentTree(agents: ReadonlyMap<string, AgentNodeData>, sessionId: string): TreeRow[] {
  const inSession: AgentNodeData[] = [];
  for (const a of agents.values()) if (a.sessionId === sessionId) inSession.push(a);
  const root = inSession.find(a => a.kind === "root") ?? agents.get(sessionId);
  if (!root) return [];
  const ids = new Set(inSession.map(a => a.id));
  const kids = new Map<string, AgentNodeData[]>();
  for (const a of inSession) {
    if (a === root) continue;
    const parent = a.parentId && ids.has(a.parentId) && a.parentId !== a.id ? a.parentId : root.id;
    const list = kids.get(parent);
    if (list) list.push(a); else kids.set(parent, [a]);
  }
  for (const list of kids.values()) list.sort((x, y) => x.startedAt - y.startedAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (a: AgentNodeData, more: boolean[]) => {
    // A parent chain that loops would never end; each agent is drawn once.
    if (seen.has(a.id)) return;
    seen.add(a.id);
    rows.push({ agent: a, depth: more.length, more });
    const list = kids.get(a.id) ?? [];
    list.forEach((k, i) => walk(k, [...more, i < list.length - 1]));
  };
  walk(root, []);
  return rows;
}

/** The head row's qualifier: how many agents the root started, in words. */
export function subagentCount(rows: readonly TreeRow[]): string {
  const n = rows.length - 1;
  return n <= 0 ? "no subagents" : `${n} subagent${n === 1 ? "" : "s"}`;
}

/** The session's cost as the root's card prints it (card-cost.ts), or null when
 *  the card prints none. */
export function sessionCostLabel(root: AgentNodeData): string | null {
  const chip = costChip(root);
  if (!chip) return null;
  return chip.kind === "unpriced" ? UNPRICED_LABEL : `${fmtCost(chip.total)}${chip.floor ? "+" : ""}`;
}
