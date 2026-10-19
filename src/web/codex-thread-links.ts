import { adoptCwd, ensureRoot } from "./agent-attribution";
import type { GraphState } from "./graph-state";
import type { HookPayload } from "./types";

/** Codex children remain independent sessions for lifecycle, tools and spend. */
export function linkCodexThread(state: GraphState, p: HookPayload, now: number): void {
  const child = p.session_id, parent = p.parent_session_id;
  if (p.provider !== "codex" || typeof child !== "string" || !child ||
      typeof parent !== "string" || !parent || child === parent) return;
  const existing = state.agents.get(child);
  if (existing?.provider && existing.provider !== "codex") return;
  if (existing?.parentId && existing.parentId !== parent) return;
  const seen = new Set([child]);
  for (let id: string | undefined = parent; id;) {
    if (seen.has(id)) return;
    seen.add(id);
    const ancestor = state.agents.get(id);
    if (ancestor?.provider && ancestor.provider !== "codex") return;
    id = ancestor?.parentId;
  }
  const node = ensureRoot(state, child, now, true);
  node.provider = "codex";
  node.parentId = parent;
  adoptCwd(node, p);
  const name = p.agent_nickname || p.agent_role;
  if (typeof name === "string" && name.trim()) node.label = name;
  const root = state.agents.get(parent);
  if (root) root.childCount = [...state.agents.values()].filter(a => a.parentId === parent).length;
}
