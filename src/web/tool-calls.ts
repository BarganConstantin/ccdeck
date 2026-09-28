// The board's tool calls: how many each agent keeps, how a call is found again,
// and the in-flight index entries an agent lets go of when it leaves.
//
// `toolIndex` holds exactly the calls that have not settled, and more than one
// reader leans on that — `blockedCall` to decide who a permission prompt is
// about, the pause gate to decide which held events to protect — so the two
// releases here only ever drop an entry that still points at the call being
// released (#443).
import { toolKey, type GraphState } from "./graph-state";
import type { AgentNodeData, HookEnvelope, ToolCall } from "./types";

export function shortPreview(input: any, max = 80): string {
  if (input == null) return "";
  if (typeof input === "string") return input.length > max ? input.slice(0, max - 1) + "…" : input;
  try {
    const s = JSON.stringify(input);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  } catch {
    return String(input);
  }
}

/** How many ToolCalls we keep per agent. A root session left open all day
 *  makes thousands of calls and nothing used to drop any of them — the agent
 *  caps (`pruneOldAgents`, `pruneDoneSessions`) only evict whole finished
 *  agents/sessions, so one long-lived session grew forever. The canvas only
 *  draws the last handful of bubbles and the detail panel renders one DOM row
 *  per entry, so a bounded window is all the UI can show anyway; `toolCount`
 *  keeps counting every call ever made, so the totals on the cards stay honest. */
export const MAX_TOOLS_PER_AGENT = 200;

/**
 * The `ToolCall` carrying `id`, searched across every agent on the board, or
 * null. First match in agent insertion order.
 *
 * OUT HERE RATHER THAN INLINE IN App.tsx BECAUSE OF WHAT IT COSTS (#997). The
 * tool modal's render body resolves the open tool on every render, and cannot
 * skip it — `modalOpenRef` reads the result on the next line — while `setNow`
 * re-renders the deck four times a second whether or not anything is happening.
 * The form this replaces was
 *
 *     Array.from(agents.values()).flatMap(a => a.tools).find(t => t.id === id)
 *
 * which builds an array of every agent and then a flat array of every tool on
 * the board before it looks at the first one. With `AGENT_CAP` at 200 and
 * `MAX_TOOLS_PER_AGENT` at 200 that is a 40,000-entry copy, four times a
 * second, to answer a question that stops at the first hit. Walking stops at the
 * agent that owns the call and allocates nothing.
 *
 * NOT `toolIndex`, which is O(1) and answers this exact question. It would
 * change the ANSWER: that map is keyed by tool_use_id with no session scope and
 * keeps only the newest copy (#1009, open), where this returns the first match
 * in insertion order. Picking a side in that belongs with #1009, not here.
 *
 * Here rather than in App.tsx also so it can be measured without a DOM — the
 * same reason `usage-range.ts` gives for living outside its component.
 */
export function findToolOnBoard(agents: Map<string, AgentNodeData>, id: string): ToolCall | null {
  for (const a of agents.values()) {
    const hit = a.tools.find(t => t.id === id);
    if (hit) return hit;
  }
  return null;
}

/** How many of those retained calls keep their full `tool_input` /
 *  `tool_response` blobs. Those two fields are the only heavy ones — the
 *  server ingests payloads up to 5MB, so a few big Reads or a chatty Bash run
 *  are megabytes each — and the tool modal is the only reader. Everything else
 *  on a ToolCall (name, the 80-char previews, timing, ok, usage) is tiny and
 *  is kept for the whole window, so the bubbles, the activity strip, the
 *  sparkline, the recap and the search index are unaffected. */
export const TOOL_BLOB_WINDOW = 25;

/** Bound one agent's tool history in place. Drops the oldest entries once the
 *  list passes `MAX_TOOLS_PER_AGENT`, and releases the heavy input/response
 *  blobs of every entry older than `TOOL_BLOB_WINDOW`, flagging them so the
 *  modal can say the payload was dropped rather than render an empty box. */
export function trimTools(state: GraphState, a: AgentNodeData): void {
  const tools = a.tools;
  if (tools.length > MAX_TOOLS_PER_AGENT) {
    const dropped = tools.splice(0, tools.length - MAX_TOOLS_PER_AGENT);
    for (const t of dropped) {
      // An evicted call can still be in-flight; leaving it in the live index
      // would strand an entry no PostToolUse or stale sweep can ever reach.
      //
      // Only where the index still points at THIS call, which is the guard #443
      // put on `releaseToolIds` and flagged as missing here. A `tool_use_id` does
      // not belong to one `ToolCall` for good: a `PreToolUse` re-delivered after
      // its call settled finds nothing in `toolIndex` and pushes a second call
      // under the same id, re-pointing the index at it. Deleting by id alone
      // then let the eviction of the OLD copy — which this loop reaches on a
      // window that is 200 calls wide and says nothing about the new one — strand
      // the live call: gone from `toolIndex`, so its own `PostToolUse` could only
      // find it by the resurrection scan and the stale sweep could never settle
      // it.
      //
      // The guard compares the call itself, not the agent holding it: the
      // surviving copy can sit on the very agent whose history is being trimmed
      // — `resolveOwner` hands a re-delivered `PreToolUse` back to the root
      // whenever no subagent is live — so agent equality would hold for both
      // copies and guard nothing.
      const key = toolKey(a.sessionId, t.id);
      if (state.toolIndex.get(key) === t) state.toolIndex.delete(key);
    }
  }
  // Entries below the blob window are always trimmed already, so this walks
  // back only over the ones that just crossed it (normally exactly one).
  for (let i = tools.length - TOOL_BLOB_WINDOW - 1; i >= 0; i--) {
    const t = tools[i];
    if (t.trimmed) break;
    t.input = undefined;
    t.response = undefined;
    t.trimmed = true;
  }
}

/** Find the ToolCall already recorded under `id`, or null if this is the first
 *  time we see it. `toolIndex` answers for every call of THIS SESSION still in
 *  flight no matter which agent owns it; a call that has already settled (or was
 *  swept stale) is gone from the index, so fall back to the resolved owner's own
 *  history, newest first. Anything older than that window was evicted by
 *  `trimTools` and is deliberately not resurrected — it is off the board for
 *  good.
 *
 *  The session in the lookup key is the owner's and not a parameter, which is
 *  the same thing: every caller resolved `owner` from this payload, and both
 *  `ensureRoot` and `ensureSubagent` stamp the node with the session it was
 *  created under. A subagent therefore carries its root's `sessionId`, so the
 *  index still answers across the agents of one session — which it has to, since
 *  `resolveOwner` can hand a re-delivered `PreToolUse` to a different agent than
 *  the one that opened the call (#443). */
export function findTool(state: GraphState, owner: AgentNodeData, id: string): ToolCall | null {
  const live = state.toolIndex.get(toolKey(owner.sessionId, id));
  if (live) return live;
  for (let i = owner.tools.length - 1; i >= 0; i--) {
    if (owner.tools[i].id === id) return owner.tools[i];
  }
  return null;
}

/** Drop an agent's tool ids out of the two id-keyed maps, for an agent that is
 *  about to be removed from `state.agents`. Both pruners call this
 *  immediately before their `agents.delete`, which is the symmetry `trimTools`
 *  already keeps when it evicts a call out of the per-agent window.
 *
 *  Until #443 neither pruner touched either map, so a call still in flight when
 *  its agent was evicted left an entry nothing could ever reach again: not
 *  `PostToolUse`, whose fallback resurrects from `state.agents` and so needs the
 *  agent to still be there; not either sweep, which both iterate `state.agents`;
 *  not `trimTools`, which only ever runs from its own agent's `PreToolUse`; and
 *  not the garbage collector, because the map held the last strong reference to
 *  a `ToolCall` that still carried its whole `tool_input`. `sweepStaleTools`
 *  rests part of its safety argument on this ("the bubble goes with the agent
 *  when the session is pruned") and the bubble did go — the index entry did not.
 *
 *  Worth doing, but this is tidiness rather than a leak anyone is feeling. To
 *  orphan anything, a pruner has to delete an agent that is `done` while it
 *  still holds an unsettled call, and on Claude the ordinary killed-mid-call
 *  session does not qualify: no `Stop` arrives for it, so it stays `active` and
 *  unprunable until `sweepStaleSessions` reaps it — and `sweepStaleTools` runs
 *  first on the same tick against the same window (#436), so it has already
 *  settled and released those calls by the time the root turns `done`. Replaying
 *  this machine's entire 21-hour events.jsonl with both pruners live evicted 16
 *  agents and orphaned exactly nothing. What is left over is Codex, where the
 *  sweep deliberately abstains (#397) and pruning is therefore the only bound on
 *  a call nobody ever answered the approval prompt for, and the Claude case where
 *  a `PostToolUse` went missing but the `Stop` that ends the agent still landed.
 *  One entry per such call: 244 bytes at this log's median `tool_input`, 8.5 KB
 *  at its p99.
 *
 *  WHY EACH DELETE IS CONDITIONAL RATHER THAN BY ID. A tool id does not belong
 *  to one `ToolCall` object for good. `findTool` consults `toolIndex` first and
 *  the owner's own list only after, so a re-delivered `PreToolUse` for an id that
 *  has already settled finds neither — the index entry went with the settle —
 *  and `resolveOwner` then hands it to whoever the attribution stack names NOW,
 *  which is a different agent whenever a subagent started in between. That pushes
 *  a second `ToolCall` under the same id and re-points the index at it, while
 *  the first object stays in the old agent's `tools` array. Deleting
 *  by id alone would let the pruning of a long-finished agent quietly evict a
 *  live call belonging to one that is still running, and `toolIndex` is read for
 *  precisely the calls that have NOT settled: `blockedCall` walks it to
 *  decide which subagent a permission prompt is about, so the next prompt would
 *  lose the agent it belongs to (#361). Requiring the index to still point at
 *  THIS call keeps the release to entries the departing agent actually still
 *  owns.
 *
 *  The late `PostToolUse` this file protects everywhere else is unaffected. For
 *  an agent that survives, nothing here runs at all; for one that does not, the
 *  event was already a no-op, since the resurrection scan looks through
 *  `state.agents` and the agent is gone from it — the call is off the board, and
 *  settling a bubble nothing draws is not a thing worth keeping a map for. */
export function releaseToolIds(state: GraphState, a: AgentNodeData): void {
  for (const t of a.tools) {
    const key = toolKey(a.sessionId, t.id);
    if (state.toolIndex.get(key) === t) state.toolIndex.delete(key);
  }
}

/** Whether this envelope is the answer to a call the graph is still waiting on
 *  — a `PostToolUse` / `PostToolUseFailure` whose id is in flight right now.
 *
 *  Written for the pause gate's `protect` (#676) and exported so App.tsx and
 *  the tests ask the same question of the same graph rather than each spelling
 *  it out. The gate reads `seq` and `epoch` and nothing else on purpose; this
 *  is the payload half of the question, and it belongs next to the map it
 *  reads.
 *
 *  `toolIndex` is the right map and not merely a convenient one: it holds
 *  exactly the calls that have not settled, and during a pause nothing is
 *  applied, so it is frozen at the set of calls that were open when the freeze
 *  began. That is the set whose settling events sit at the head of the hold and
 *  the set the ceiling was eating.
 *
 *  It under-reports rather than over-reports, and that is the safe direction: a
 *  call already evicted from the index — swept, or slid out of `trimTools`'s
 *  200-call window — is one the deck stopped tracking long before this pause,
 *  and spending a held slot on an outcome for it would cost a fresh event to
 *  protect something the resume cannot draw any better. */
export function settlesInFlightCall(state: GraphState, env: HookEnvelope): boolean {
  const p = env?.payload;
  const name = p?.hook_event_name;
  if (name !== "PostToolUse" && name !== "PostToolUseFailure") return false;
  const id = p?.tool_use_id;
  if (typeof id !== "string" || id.length === 0) return false;
  // The same `?? "unknown"` `applyEvent` and `resolveOwner` use, because the key
  // this asks about has to be the one `PreToolUse` wrote. An envelope with no
  // session at all lands on the "unknown" root, and its calls are in flight
  // under that name like any other session's.
  return state.toolIndex.has(toolKey(p?.session_id ?? "unknown", id));
}
