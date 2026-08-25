// Pure spotlight rules shared by snapshotToFlow (which decides which cards and
// edges wear `rf-spotlit-out`) and ToolBursts (which dims the bubbles on the
// same set). Kept out of App.tsx so they can be unit-tested without pulling in
// React Flow or the DOM — the reason visibility.ts, placement.ts and
// ambient-counts.ts live out here too.
import type { GraphState } from "./reducer";

/**
 * The spotlight lineage for an agent — itself, every ancestor up the parentId
 * chain, and every descendant under it. `null` means "no spotlight", and every
 * consumer reads it that way: a null lineage dims nothing at all.
 *
 * NULL FOR AN ID THE MAP DOES NOT HOLD, and that is the whole of #576. This
 * used to seed the set with `selectedId` and only then look the id up, so an id
 * that no longer named an agent produced a one-element lineage containing a
 * node that does not exist: the ancestor walk broke on its first iteration and
 * the descendant sweep matched nothing, but the set came back non-empty and
 * therefore live. `snapshotToFlow` asks `!lineage.has(a.id)` of every agent it
 * draws, so EVERY card on the canvas answered "out of lineage" — 16% opacity,
 * desaturated and blurred — every edge was written at 0.12, and every tool
 * bubble dimmed with them. The topbar ribbon reads the same dead id through the
 * same map and resolves to null, so it vanished at the same moment: a canvas
 * faded out to nothing with no selection anywhere on screen to explain it, and
 * nothing obvious to click to undo it (only Escape or a click on bare canvas,
 * neither of which a user with no visible selection has any reason to try).
 *
 * A lineage for an agent that does not exist is not a lineage, so it is not a
 * one-element set — it is nothing. The three ways an id gets stranded are
 * `pruneOldAgents`, `pruneDoneSessions` and a `__clear` arriving over SSE, and
 * this guard answers all three, including the one no selection prune can reach:
 * `__clear` empties the agent map, and an eviction rule that fires against an
 * empty map is one that cannot tell "everything is gone" from "nothing has
 * replayed yet". It costs one Map lookup in the normal path, on a map the walk
 * below is about to read anyway.
 */
export function spotlightLineage(state: GraphState, selectedId: string | null): Set<string> | null {
  if (!selectedId) return null;
  const selected = state.agents.get(selectedId);
  if (!selected) return null;
  const set = new Set<string>([selectedId]);
  // Walk up ancestors
  let cursor: string | undefined = selectedId;
  while (cursor) {
    const a = state.agents.get(cursor);
    if (!a?.parentId) break;
    if (set.has(a.parentId)) break;
    set.add(a.parentId);
    cursor = a.parentId;
  }
  // Walk down descendants (BFS over parentId)
  let added = true;
  while (added) {
    added = false;
    for (const a of state.agents.values()) {
      if (a.parentId && set.has(a.parentId) && !set.has(a.id)) {
        set.add(a.id);
        added = true;
      }
    }
  }
  return set;
}

/**
 * The union of every selected agent's lineage — the set the canvas actually
 * spotlights. Multi-select widens the spotlight without losing the "follow the
 * chain" semantics of a single click.
 *
 * A selection none of whose ids names a live agent produces no spotlight at
 * all, and a mixed one spotlights exactly the ids that are still there: the
 * dead ones contribute a null lineage, which contributes nothing to the union.
 */
export function spotlightUnion(state: GraphState, selectedIds: Iterable<string>): Set<string> | null {
  const union = new Set<string>();
  for (const id of selectedIds) {
    const l = spotlightLineage(state, id);
    if (l) for (const x of l) union.add(x);
  }
  return union.size > 0 ? union : null;
}
