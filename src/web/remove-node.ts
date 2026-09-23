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

interface Lineage { id: string; parentId?: string; sessionId?: string }

/** Whether a removal takes this item off the board: it was removed itself, it
 *  descends from something removed, or its whole session was. The one rule
 *  both the cards and the agent visibility set are filtered by. */
function removedBy(items: readonly Lineage[], removed: ReadonlySet<string>): (item: Lineage) => boolean {
  const parents = new Map(items.map(item => [item.id, item.parentId]));
  const hidden = new Set(removed);
  const underRemoved = (id: string): boolean => {
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
  return item => underRemoved(item.id) || underRemoved(item.sessionId ?? item.id);
}

/** Every agent a removal hides. Subtracted from the canvas's single visibility
 *  set, so the cards, the tool bubbles drawn beside them and the layout all
 *  drop a removed agent together — filtering only the cards left its bubbles
 *  on the board with nothing to hang from. */
export function removalHiddenIds(agents: Iterable<Lineage>, removed: ReadonlySet<string>): Set<string> {
  if (removed.size === 0) return new Set();
  const items = [...agents];
  const isRemoved = removedBy(items, removed);
  return new Set(items.filter(isRemoved).map(item => item.id));
}

export function visibleBoard<N extends { id: string; data: { parentId?: string; sessionId?: string } }, E extends { source: string; target: string }>(
  nodes: N[], edges: E[], removed: ReadonlySet<string>,
): { nodes: N[]; edges: E[] } {
  const lineageOf = (node: N): Lineage => ({ id: node.id, parentId: node.data.parentId, sessionId: node.data.sessionId });
  const isRemoved = removedBy(nodes.map(lineageOf), removed);
  const visible = nodes.filter(node => !isRemoved(lineageOf(node)));
  const ids = new Set(visible.map(node => node.id));
  return { nodes: visible, edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
}
