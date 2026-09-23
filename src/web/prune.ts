// Pure cache-eviction rules shared by the position cache, the pin cache and
// the node-size cache. Kept out of App.tsx so they can be unit-tested without
// pulling in React Flow or the DOM.

/** Anything that can answer "how many agents do I know about, and is this one
 *  of them" — a Map of agents keyed by id, or a plain Set of ids. */
import { recapNoteId } from "./recap-note";
import { AGENT_CAP, AGENT_GRACE_MS, DONE_SESSION_CAP, DONE_SESSION_GRACE_MS } from "./board-limits";
import {
  pruneDoneSessions, pruneOldAgents, STALE_SESSION_MS, sweepStaleSessions, sweepStaleTools,
  type ForgetSession, type GraphState,
} from "./reducer";

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
  agents: Iterable<{ id: string; sessionId: string; kind?: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const a of agents) {
    ids.add(a.id);
    ids.add(`group:${a.sessionId}`);
    // A root's recap note is a node too, and is measured like one.
    if (a.kind === "root") ids.add(recapNoteId(a.id));
  }
  return ids;
}

/**
 * Every id a canvas node can hold while these agents live: the agents, and each
 * root's recap note.
 *
 * The caches pruned against this — positions, placeholders, pins — are keyed by
 * node id, and a recap note is a node with no agent of its own. Pruned against
 * the agent map alone it lost its place on every pass, was laid out again the
 * next, and forgot where somebody had dragged it. Kept for as long as its root
 * is, open or not, so a note somebody dragged returns to that spot when it is
 * put away and brought back. Where the LAYOUT put a note is forgotten while it
 * is closed (snapshotToFlow), so an undragged note comes back beside its card.
 */
export function liveNodeIds(agents: Iterable<{ id: string; kind?: string }>): Set<string> {
  const ids = new Set<string>();
  for (const a of agents) {
    ids.add(a.id);
    if (a.kind === "root") ids.add(recapNoteId(a.id));
  }
  return ids;
}

// ── the tick's whole sweep, in one place (#1175) ────────────────────────────

/**
 * What one 250 ms tick evicts from the board.
 *
 * `changed` is whether anything moved, which is what tells the page to render.
 * `forgotten` is the whole-session ids the two pruners dropped, in the order
 * they dropped them — the list the page POSTs to `/api/forget`.
 */
export interface SweepResult {
  changed: boolean;
  forgotten: string[];
}

/**
 * The four sweeps the tick runs, on the shipped constants, with the ids they
 * evicted collected.
 *
 * ORDER AND CONSTANTS ARE THE POINT, so they are here rather than written out
 * inside a React effect where nothing can run them. Both staleness sweeps ask
 * the same question — is this session still there? — about two things that die
 * together, so they share STALE_SESSION_MS (#436): asking it on two clocks
 * failed a session's tool calls an hour and a half before the deck was willing
 * to call that session gone, and stamped a red × on every `Bash` slower than a
 * minute and a half.
 *
 * AND THE SERVER IS TOLD WHAT LEFT (#1024). Both pruners drop whole sessions,
 * and the server keeps two caches that gate an emit on "has this changed" — a
 * session's name and each subagent's model. Nothing told them the page had
 * forgotten a session, so a session evicted while idle and then resumed never
 * got a `SessionNamed` again and showed as unnamed in the sidebar and on the
 * card for the rest of the day, recoverable only by reloading the tab. #445's
 * own measurement: 7 of 20 evicted sessions went on to emit more events.
 *
 * One list for the whole tick rather than one per pruner, because the two run
 * back to back and a cap coming down by six is six ids, not six requests. An
 * empty list is the caller's signal to send nothing at all.
 */
export function sweepTick(state: GraphState, t: number): SweepResult {
  let changed = sweepStaleTools(state, t, STALE_SESSION_MS);
  if (sweepStaleSessions(state, t, STALE_SESSION_MS)) changed = true;
  const forgotten: string[] = [];
  const forget: ForgetSession = sid => { forgotten.push(sid); };
  // Prune long-finished agents so memory does not grow over multi-day sessions.
  if (pruneOldAgents(state, t, AGENT_CAP, AGENT_GRACE_MS, forget)) changed = true;
  // And keep the canvas to the last few finished sessions, so a long day of
  // work does not bury the running ones under everything already done.
  if (pruneDoneSessions(state, t, DONE_SESSION_CAP, DONE_SESSION_GRACE_MS, forget)) changed = true;
  return { changed, forgotten };
}
