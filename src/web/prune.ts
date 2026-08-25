// Pure cache-eviction rules shared by the position cache, the pin cache and
// the node-size cache. Kept out of App.tsx so they can be unit-tested without
// pulling in React Flow or the DOM.

/** Anything that can answer "how many agents do I know about, and is this one
 *  of them" — a Map of agents keyed by id, or a plain Set of ids. */
type LiveIds = { readonly size: number; has(id: string): boolean };

/** Anything keyed by node id that can drop an entry — the position, pin and
 *  size Maps, and the Set of ids whose position is still a placeholder. */
type IdCache = { keys(): Iterable<string>; delete(id: string): unknown };

/**
 * Drop cached entries whose agent no longer exists — unless the graph is empty.
 *
 * Both caches are seeded from localStorage during the very first render, while
 * the event log is still replaying over SSE, so at that moment the agent map is
 * legitimately empty. Pruning against it would delete every position the user
 * had arranged and hand the whole canvas back to dagre on each reload. An empty
 * graph carries no information about what is stale, so it evicts nothing.
 */
export function pruneStaleEntries(cache: IdCache, live: LiveIds): void {
  if (live.size === 0) return;
  for (const id of Array.from(cache.keys())) {
    if (!live.has(id)) cache.delete(id);
  }
}

/**
 * Drop selected ids whose agent no longer exists.
 *
 * The selection is one more cache keyed by node id, and until #576 it was the
 * one with no eviction rule at all: `setSelectedIds` had exactly two writers,
 * a click and an explicit clear, so an id survived every eviction that could
 * take the agent out from under it — `pruneOldAgents`, `pruneDoneSessions` and
 * a `__clear` arriving over SSE. What that left behind was a selection the user
 * could neither see (the topbar ribbon reads the same id through the same map,
 * so it resolves to null and disappears) nor act on, and one that came back to
 * life if a session evicted while still open later produced another event —
 * `pruneDoneSessions` documents that case, and a reborn session keeps its id,
 * so the old selection silently re-attached and spotlit it.
 *
 * Unguarded, unlike `pruneStaleEntries` above, and deliberately: positions and
 * pins are restored from localStorage before the event log has replayed, so an
 * empty agent map means "nothing has arrived yet" for them. A selection is
 * never restored from anywhere — it can only be created by clicking a card that
 * exists — so for this cache an empty map means every card that could have been
 * selected is gone, which is exactly the `__clear` case and exactly when the
 * selection should go too. Returns the SAME set when nothing was dropped, so
 * `setSelectedIds(prev => pruneSelection(prev, agents))` bails out of the
 * re-render on the overwhelming majority of ticks.
 */
export function pruneSelection(selected: ReadonlySet<string>, live: LiveIds): Set<string> {
  let stale = false;
  for (const id of selected) {
    if (!live.has(id)) { stale = true; break; }
  }
  if (!stale) return selected as Set<string>;
  const next = new Set<string>();
  for (const id of selected) {
    if (live.has(id)) next.add(id);
  }
  return next;
}

/**
 * The node ids a live agent map can legitimately produce on the canvas.
 *
 * The size cache is keyed by React Flow node id, and this canvas renders two
 * kinds of node: one card per agent, plus one invisible per-session drag
 * handle with the id `group:<sessionId>`. Pruning that cache against the agent
 * map alone would therefore evict every session handle on one frame and
 * re-measure it on the next, so the handle ids are named here explicitly.
 */
export function measuredNodeIds(
  agents: Iterable<{ id: string; sessionId: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const a of agents) {
    ids.add(a.id);
    ids.add(`group:${a.sessionId}`);
  }
  return ids;
}
