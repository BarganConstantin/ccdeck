/** A removed card stays hidden while its underlying session history remains intact. */
export const REMOVED_NODES_KEY = "agent-dag.removedNodes";

export function readRemovedNodes(store: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const value = JSON.parse(store?.getItem(REMOVED_NODES_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}

export function saveRemovedNodes(store: Pick<Storage, "setItem"> | null, removed: Set<string>): void {
  try { store?.setItem(REMOVED_NODES_KEY, JSON.stringify([...removed])); } catch { /* disabled storage */ }
}

export function visibleBoard<N extends { id: string; data: { parentId?: string; sessionId?: string } }, E extends { source: string; target: string }>(
  nodes: N[], edges: E[], removed: ReadonlySet<string>,
): { nodes: N[]; edges: E[] } {
  const parents = new Map(nodes.map(node => [node.id, node.data.parentId]));
  const hidden = new Set(removed);
  const isHidden = (id: string): boolean => {
    if (hidden.has(id)) return true;
    const visited = new Set<string>([id]);
    let parent = parents.get(id);
    while (parent && !visited.has(parent)) {
      if (hidden.has(parent)) { hidden.add(id); return true; }
      visited.add(parent);
      parent = parents.get(parent);
    }
    return false;
  };
  const visible = nodes.filter(node => !isHidden(node.id) && !isHidden(node.data.sessionId ?? node.id));
  const ids = new Set(visible.map(node => node.id));
  return { nodes: visible, edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
}
