// The board's tool calls: the two events that open and settle them, how many
// each agent keeps, how a call is found again, and the in-flight index entries
// an agent lets go of when it leaves.
//
// `toolIndex` holds exactly the calls that have not settled, and more than one
// reader leans on that — `blockedCall` to decide who a permission prompt is
// about, the pause gate to decide which held events to protect — so the two
// releases here only ever drop an entry that still points at the call being
// released (#443).
import { explicitSubagentKey } from "./agent-attribution";
import { subagentIdFor, toolKey, type GraphState } from "./graph-state";
import { extractUsage } from "./usage-wire";
import type { AgentNodeData, HookEnvelope, HookPayload, ToolCall } from "./types";

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
 *  keeps counting every call ever made, so the totals on the cards stay honest,
 *  and `toolErrorCount` and `toolCountByName` count over the same lifetime so a
 *  figure printed beside it does too (#1809). */
export const MAX_TOOLS_PER_AGENT = 200;

/** Write a call's outcome, and keep its agent's lifetime failure count in step
 *  with it (#1809): counted when the call turns failed, taken back when a late
 *  outcome overturns a failure the deck had guessed, and untouched by a write
 *  that changes nothing. `a` is the agent whose `tools` holds the call. */
function setOk(a: AgentNodeData | undefined, t: ToolCall, ok: boolean): void {
  const failed = t.ok === false;
  t.ok = ok;
  if (a && failed === ok) a.toolErrorCount = (a.toolErrorCount ?? 0) + (ok ? -1 : 1);
}

/** The agent whose `tools` holds `t`: the one it was pushed on, since a call
 *  never moves and `agentId` is stamped with that agent at the push. */
function holderOf(state: GraphState, t: ToolCall): AgentNodeData | undefined {
  return t.agentId == null ? undefined : state.agents.get(t.agentId);
}

/** One more (or, with -1, one fewer) of `a`'s calls counted under `name`. */
function countToolName(a: AgentNodeData, name: string, delta: 1 | -1): void {
  const byName = a.toolCountByName ??= new Map();
  const n = (byName.get(name) ?? 0) + delta;
  if (n > 0) byName.set(name, n);
  else byName.delete(name);
}

/**
 * The `ToolCall` carrying `id`, searched across every agent on the board, or
 * null. First match in agent insertion order.
 *
 * OUT HERE RATHER THAN INLINE WHERE THE MODAL'S TOOL IS RESOLVED (App.tsx then,
 * use-dialogs.ts now) BECAUSE OF WHAT IT COSTS (#997). The tool modal's render
 * body resolves the open tool on every render, and cannot skip it —
 * `modalOpenRef` reads the result later in the same render — while `setNow`
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
 * NOT `toolIndex`, which is O(1) but answers a different question: it holds
 * only the calls still in flight, where the modal opens settled ones too.
 *
 * KEYED ON THE AGENT AS WELL AS THE ID (#1483). A tool_use_id is only unique
 * within one session — Codex forwards the rollout's own call_id, and nothing
 * keeps two sessions' ids apart — so a walk that returned the first call on the
 * board with the clicked id opened another session's call whenever two shared
 * one; #1009 had fixed the same collision in the in-flight index. Both places
 * that open the modal know whose call they are showing (a bubble carries its
 * agent, the detail panel lists one agent's calls), so the modal is opened by
 * both, and the lookup reads that one agent's list and no other. A call whose
 * agent has left the board is not found at all, and the modal closes rather
 * than showing somebody else's.
 *
 * Here rather than in a hook also so it can be measured without a DOM — the
 * same reason `usage-range.ts` gives for living outside its component.
 */
export function findToolOnBoard(agents: Map<string, AgentNodeData>, agentId: string, id: string): ToolCall | null {
  return agents.get(agentId)?.tools.find(t => t.id === id) ?? null;
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
function trimTools(state: GraphState, a: AgentNodeData): void {
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
      releaseToolId(state, a, t);
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
function findTool(state: GraphState, owner: AgentNodeData, id: string): ToolCall | null {
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
  for (const t of a.tools) releaseToolId(state, a, t);
}

/** Drop `t`'s entry from `toolIndex` if, and only if, the entry is still `t` —
 *  the guard both releases above need, for the reason `releaseToolIds` gives:
 *  one `tool_use_id` can name two calls, and a release by id alone can evict
 *  the live one (#443). */
function releaseToolId(state: GraphState, a: AgentNodeData, t: ToolCall): void {
  const key = toolKey(a.sessionId, t.id);
  if (state.toolIndex.get(key) === t) state.toolIndex.delete(key);
}

/** What a call left without an outcome says when the deck itself dropped events
 *  while it was paused (#676). It is the one cause the deck can vouch for, so
 *  the stale sweep and the turn end both say it in place of their own reading
 *  of the silence. */
const DROPPED_OUTCOME_PREVIEW = "no result reached the deck — events were dropped while the deck was paused";

/** Settle a call whose outcome is never coming: failed, ended at `endedAt`, and
 *  saying `cause` — or `DROPPED_OUTCOME_PREVIEW` when the deck dropped events
 *  while the call was open, which outranks any reading of the silence. The two
 *  callers are the two pieces of evidence the deck has that no outcome is on
 *  its way: `sweepStaleTools` (the session went silent) and `applyTurnEnd`
 *  (the turn that made the call ended).
 *
 *  Out of the live index too, since the id is no longer held open. A late
 *  outcome still lands — the PostToolUse handler falls back to scanning the
 *  session's tool lists and resurrects the call, un-saying this. Keyed on the
 *  session, not the bare id (#1009): the id namespace is shared across every
 *  session on the board, so a bare delete would release another session's live
 *  call. */
export function settleUnanswered(
  state: GraphState, a: AgentNodeData, t: ToolCall, endedAt: number, cause: string,
): void {
  t.endedAt = endedAt;
  setOk(a, t, false);
  t.errorPreview = t.outcomeGap ? DROPPED_OUTCOME_PREVIEW : cause;
  state.toolIndex.delete(toolKey(a.sessionId, t.id));
}

/** Whether this envelope is the answer to a call the graph is still waiting on
 *  — a `PostToolUse` / `PostToolUseFailure` whose id is in flight right now.
 *
 *  Written for the pause gate's `protect` (#676) and exported so
 *  use-pause-gate.ts and the tests ask the same question of the same graph
 *  rather than each spelling it out. The gate reads `seq` and `epoch` and nothing else on purpose; this
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

/** A tool call starting, on the agent `resolveOwner` attributed it to. A call
 *  this session already holds under the same id is refreshed in place rather
 *  than pushed again. */
export function applyPreToolUse(state: GraphState, p: HookPayload, sessionId: string, owner: AgentNodeData, now: number): void {
  // The same tool_use_id can be delivered more than once — several live
  // decks appending to one events.jsonl, a hook retry, a log replay after a
  // restart. The seq/epoch guard atop `applyEvent` only rejects a replay of the
  // *same* seq, so those re-deliveries used to append a second ToolCall
  // under an id the agent already had, and the damage was permanent:
  // `toolIndex` kept only the newest copy, so PostToolUse could never
  // settle the earlier ones, `sweepStaleTools` later stamped them failed
  // (a red × on calls that actually succeeded), and both `toolCount` and
  // the in-flight backlog counted every copy. Treat a known id as the call
  // we already have and refresh it in place instead.
  const known = p.tool_use_id ? findTool(state, owner, p.tool_use_id) : null;
  if (known) {
    if (p.tool_name && known.name === "?") {
      known.name = p.tool_name;
      // Recounted under the name it has now, on the agent that holds it.
      const holder = holderOf(state, known);
      if (holder) {
        countToolName(holder, "?", -1);
        countToolName(holder, known.name, 1);
      }
    }
    // Never reopen a call that has already settled, and never re-attach a
    // payload `trimTools` released — nothing would ever drop it again.
    if (known.endedAt == null && !known.trimmed && p.tool_input !== undefined) {
      known.input = p.tool_input;
      known.inputPreview = shortPreview(p.tool_input);
    }
    return;
  }
  // Only a genuinely new call gets past here, so `toolCount` still advances
  // exactly once per pushed entry and the synthesised id below stays unique.
  const id = p.tool_use_id ?? `${owner.id}:${owner.toolCount}`;
  // `explicitSubagentId` records what the payload said rather than where
  // `owner` came from, and is derived from the key rather than from the
  // resolved node so it still names the right subagent when that subagent
  // never announced itself — which is the same id `clearsWaiting` compares
  // against. See its declaration in types.ts.
  const explicit = explicitSubagentKey(p);
  const tc: ToolCall = {
    id,
    name: p.tool_name ?? "?",
    input: p.tool_input,
    inputPreview: shortPreview(p.tool_input),
    agentId: owner.id,
    explicitSubagentId: explicit ? subagentIdFor(sessionId, explicit) : undefined,
    startedAt: now,
  };
  owner.tools.push(tc);
  owner.toolCount += 1;
  countToolName(owner, tc.name, 1);
  owner.state = "active";
  // Filed under this session's name (#1009). `owner.sessionId` rather than
  // the local `sessionId` so the write and every later read — `findTool`,
  // `trimTools`, `releaseToolIds`, the sweep — all spell the key off the
  // same field on the same node. They are the same string: `resolveOwner`
  // only ever returns a node of `p.session_id ?? "unknown"`.
  state.toolIndex.set(toolKey(owner.sessionId, id), tc);
  trimTools(state, owner);
}

/** A tool call's outcome — `PostToolUse` or `PostToolUseFailure`, which `name`
 *  says — settling the call this session filed under the id, or resurrecting
 *  it off an agent's history when the stale sweep got there first. Applied
 *  once per call, however many copies of the outcome arrive. */
export function applyToolOutcome(state: GraphState, p: HookPayload, name: string, sessionId: string, now: number): void {
  const id = p.tool_use_id;
  if (!id) return;
  const key = toolKey(sessionId, id);
  let tc = state.toolIndex.get(key);
  let resurrected = false;
  // If the tool isn't in the live index it may have been swept stale
  // — look it up in its owner's tools array and resurrect it. Without
  // this, a slow PostToolUse arriving after the 90s stale cutoff was
  // silently dropped and the tool stayed marked failed forever even
  // when it actually completed.
  //
  // THIS SESSION'S agents only (#1009). The scan used to walk every agent on
  // the board and settle the first `tools` entry whose bare id matched, so a
  // session whose own copy of the id had already settled reached across and
  // stamped its result — response, `ok`, `endedAt`, and the sweep's un-reap
  // — onto an unrelated session's live bubble. That is the same collision
  // the key above closes, arriving by the other door: keying the map alone
  // would have left this scan as a second, slower path to the same wrong
  // call. A subagent carries its root's `sessionId`, so a root's late
  // outcome still finds a call drawn under a subagent of the same session,
  // which is the case the resurrection exists for.
  if (!tc) {
    for (const a of state.agents.values()) {
      if (a.sessionId !== sessionId) continue;
      const found = a.tools.find(x => x.id === id);
      if (found) { tc = found; resurrected = true; break; }
    }
  }
  if (!tc) return;
  // Everything below this line runs exactly once per call, because a second
  // copy of one outcome is not a second outcome.
  //
  // This event USED TO BE the only one of the four the reducer hardens against
  // re-delivery that did ARITHMETIC. `PreToolUse` refreshes a known id in
  // place so `toolCount` advances once, `UserPromptSubmit` declines to
  // re-append a prompt it already has, and `pushActive` declines to re-push
  // a key — but the bottom of this block ran `addUsage(owner.usage, …)`,
  // which is `+=`, so every surplus copy added the call's tokens to its
  // owner again and cost is computed from those tokens. #685 took that
  // addition out entirely: a session's tokens now have exactly one writer,
  // the transcript pass, and it assigns. What is left here is still not
  // idempotent for free — `endedAt`, `ok` and the sweep's un-reaping all
  // have to happen once — so the guard stays and is checked below.
  //
  // The discriminator is `outcomeApplied` and it has to be, because every
  // cheaper test is wrong. `endedAt != null` is what the sweep writes too,
  // so refusing on it would delete the whole resurrection path #436 depends
  // on: a call the sweep gave up on is the case where a late outcome MUST
  // land and un-say the failure. Absence from `toolIndex` is what both the
  // sweep and the first delivery of this event leave behind, so `resurrected`
  // is true for a late outcome and for a duplicate alike and separates
  // nothing. Keeping the entry in `toolIndex` to recognise the second copy is
  // not available either — #361 reads that map as "exactly the calls that
  // have not settled" to decide which subagent a permission prompt belongs
  // to, and a settled call left in it outranks the blocked one. What is left
  // is to record that an outcome was applied, on the call, at the moment it
  // is applied, which is what the sweep by construction never does.
  //
  // It is the OBJECT that carries the flag and not the id, which matters
  // because one `tool_use_id` can name two `ToolCall`s: a `PreToolUse`
  // re-delivered after its call settled finds nothing in `toolIndex` and
  // pushes a fresh call on whichever agent is live by then (#443). An id-keyed
  // "already seen" set would swallow the second object's first real outcome;
  // a flag on the object cannot.
  if (tc.outcomeApplied) return;
  tc.outcomeApplied = true;
  // An outcome landed, so whatever the deck dropped while this call was
  // open, it was not this call's answer (#676). The flag is a statement
  // about not knowing, and this is the event that ends the not knowing —
  // left standing it would eventually have the sweep describing a gap on a
  // call that has been settled since, and would survive `sweepStaleTools`
  // un-reaping the call when a late outcome overturns its guess.
  tc.outcomeGap = undefined;
  tc.endedAt = now;
  setOk(holderOf(state, tc), tc, name === "PostToolUse");
  // A response arriving for an already-trimmed call must not re-attach the
  // blob we just released — nothing would ever drop it again.
  if (!tc.trimmed) tc.response = p.tool_response;
  if (name === "PostToolUseFailure") {
    tc.errorPreview = shortPreview(p.tool_response);
  } else if (resurrected) {
    // A late success — clear the "stale" marker the sweep wrote.
    tc.errorPreview = undefined;
  }
  // Recorded ON THE CALL and added to nobody (#685). A finished Task is the
  // one tool result that carries a `usage` object, and it is tempting to
  // read it as what the subagent spent — it is not. It is the subagent's
  // LAST API turn: measured against the subagent's own transcript, 181,387
  // cache-read tokens here against 13,410,312 in the file, 1.4% of the
  // bill. Adding it to the parent therefore did two wrong things at once —
  // it charged the parent for tokens the transcript pass already counts
  // under `subagents/`, and it charged 1.4% of them — and because
  // `UsageObserved` assigns, the next pass 2.5 s later took the number
  // away again. That oscillation, $0.4675 → $0.0175, is what #685 reported.
  const usage = extractUsage(p.tool_response);
  if (usage) tc.usage = usage;
  // The key this handler looked the call up by, which is also the key
  // `PreToolUse` filed it under: the resurrection path above only accepts a
  // call off an agent of this same session, so the two agree on both halves.
  state.toolIndex.delete(key);
}
