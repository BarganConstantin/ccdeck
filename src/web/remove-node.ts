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

/** The removal set with `ids` taken back out of it — Undo, a session brought
 *  back from the session list, one that started waiting, one that went back to
 *  work (#1315). The SAME set when none of them was in it, so a caller can tell
 *  a change from a no-op without a storage write or a re-render for nothing. */
export function withoutRemovals(removed: Set<string>, ids: Iterable<string>): Set<string> {
  let next: Set<string> | null = null;
  for (const id of ids) {
    if (!removed.has(id)) continue;
    next ??= new Set(removed);
    next.delete(id);
  }
  return next ?? removed;
}

/** Removed sessions that have started waiting on the person at the deck. A
 *  removal takes a card off the board, not a session off anyone's hands: a
 *  permission prompt behind a removed card still rings the topbar alarm, and
 *  W or a click on that alarm would select a card that is not drawn. So the
 *  session comes back instead — the one thing on the board that needs you is
 *  never the one you hid. */
export function sessionsCalledBack(waiting: Iterable<{ id: string }>, hidden: ReadonlySet<string>): string[] {
  if (hidden.size === 0) return [];
  return [...waiting].filter(session => hidden.has(session.id)).map(session => session.id);
}

// ── live work wins over a removal (#1315) ──────────────────────────────────
//
// Remove is for clearing away what has happened, not for hiding what is still
// happening. A removed card that goes on working used to stay hidden for as
// long as it worked, and the board's one job is to show the work.

/** What `lastWorkedAt` reads off an agent: the stamps that only work writes. */
interface Worker extends Lineage {
  kind: "root" | "subagent";
  startedAt: number;
  tools: readonly { startedAt: number }[];
  prompts: readonly { at: number }[];
  lastOutputAt?: number;
}

/** When this agent last did something: the newest tool call it opened, prompt
 *  it was given or block of output the model wrote, and a subagent's own start.
 *  -Infinity for an agent that has done none of them.
 *
 *  WHAT IS LEFT OUT IS THE POINT. `lastEventAt` moves on every event carrying
 *  the session's id, and that includes the enrichment the server sends on its
 *  own schedule — a `UsageObserved` after a transcript scan, a `SessionRecapped`
 *  three minutes into a finished turn's silence — none of which is the session
 *  doing anything. Every `endedAt` is left out, the tools' as well as the
 *  agent's: an ending is not work, and two of the writers are the deck's own
 *  sweeps deciding that nothing is happening. `state` is left out because it
 *  outlives the work it describes: a terminal killed mid-turn reads `active`
 *  until `sweepStaleSessions` gives up on it ninety minutes later, and taking
 *  that card off the board is exactly what Remove is for.
 *
 *  A root's `startedAt` is left out for a narrower reason. A root is also made
 *  by a `Notification` or a `Stop` naming a session the deck had pruned, and
 *  neither of those is work. A subagent is only ever made by `SubagentStart`,
 *  so its start always is.
 *
 *  The newest entry of each list, never a scan: the reducer appends tool calls
 *  in arrival order and files prompts in time order (#1812), and this runs for
 *  every hidden agent on every revision. */
export function lastWorkedAt(agent: Worker): number {
  let at = agent.kind === "subagent" ? agent.startedAt : -Infinity;
  const call = agent.tools[agent.tools.length - 1];
  if (call && call.startedAt > at) at = call.startedAt;
  const prompt = agent.prompts[agent.prompts.length - 1];
  if (prompt && prompt.at > at) at = prompt.at;
  if (agent.lastOutputAt != null && agent.lastOutputAt > at) at = agent.lastOutputAt;
  return at;
}

/** When each id in the removal set was first seen there, which is the moment
 *  `removalsLiftedByWork` counts new work from. The SAME map when no id came or
 *  went, so the caller can keep it across renders for nothing.
 *
 *  Seen rather than stamped at the click, so that every way into the set is one
 *  rule. A card removed now counts from now. One read back from storage counts
 *  from the page's first look at it, so the history a reload replays — events
 *  the server received before the page was there — cannot read as new work and
 *  undo a removal the person made yesterday. An id that leaves the set (Bring
 *  back, a call-back, Clear) is forgotten, so removing it again starts again.
 *
 *  `now` is the page's clock, and the stamps it is compared with are the
 *  server's `receivedAt` and the transcript's own time for a block of output:
 *  one machine's clock, which the stale sweeps and the replay heuristic
 *  already take for granted. */
export function removalTimes(previous: ReadonlyMap<string, number>, removed: ReadonlySet<string>, now: number): ReadonlyMap<string, number> {
  let next: Map<string, number> | null = null;
  for (const id of removed) {
    if (previous.has(id)) continue;
    next ??= new Map(previous);
    next.set(id, now);
  }
  for (const id of previous.keys()) {
    if (removed.has(id)) continue;
    next ??= new Map(previous);
    next.delete(id);
  }
  return next ?? previous;
}

/** Removals that live work takes back (#1315): the ids to take out of the set
 *  because a card they hide has worked since they were made. Every marker that
 *  hides that card goes — its own, its ancestors', its session's — so it comes
 *  back with the cards it hangs from, and nothing else does. A sibling removed
 *  on its own stays removed, and so does every unrelated session.
 *
 *  Since the NEWEST of those markers, because that is the removal hiding the
 *  card now. Work done before it was on the board when that removal was made.
 *
 *  A card removed while it is running leaves, and comes back with the next
 *  thing it does rather than on the same frame. Returning it at once would make
 *  Remove a flicker on every running card, and would refuse to clear a card
 *  whose terminal died mid-turn, which the reducer holds `active` for ninety
 *  minutes and which will never do anything again. A card that is still
 *  working opens its next call or writes its next block within seconds; the
 *  longest it stays away is one long tool call, or one long think. */
export function removalsLiftedByWork(
  agents: ReadonlyMap<string, Worker>,
  hidden: Iterable<string>,
  removed: ReadonlySet<string>,
  since: ReadonlyMap<string, number>,
): string[] {
  if (removed.size === 0) return [];
  // A card that has not worked since the OLDEST removal has not worked since
  // any of them. That is every card that was history when it was removed — the
  // common case by far — and it is answered here without walking anything.
  let oldest = Infinity;
  for (const at of since.values()) if (at < oldest) oldest = at;
  const lifted = new Set<string>();
  for (const id of hidden) {
    const agent = agents.get(id);
    if (!agent) continue;
    const worked = lastWorkedAt(agent);
    if (worked <= oldest) continue;
    // The markers `removedBy` would find for this card: up its own lineage,
    // then up its session's.
    const markers: string[] = [];
    const visited = new Set<string>();
    const climb = (from: string | undefined) => {
      for (let at = from; at && !visited.has(at); at = agents.get(at)?.parentId) {
        visited.add(at);
        if (removed.has(at)) markers.push(at);
      }
    };
    climb(agent.id);
    climb(agent.sessionId);
    // A marker with no time is one `removalTimes` has not seen yet, which the
    // caller never lets happen. It reads as made after any work could have
    // been, so it lifts nothing rather than everything.
    let from = -Infinity;
    for (const marker of markers) from = Math.max(from, since.get(marker) ?? Infinity);
    if (worked > from) for (const marker of markers) lifted.add(marker);
  }
  return [...lifted];
}
