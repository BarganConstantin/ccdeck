// The board's state, and the keys everything on it is filed under.
//
// Here rather than in reducer.ts so that the modules the reducer applies events
// through can read the same shape without importing the file that imports
// them. reducer.ts re-exports what the rest of the client reads.
import type { AgentNodeData, ToolCall } from "./types";

export interface GraphState {
  agents: Map<string, AgentNodeData>;
  /** `toolKey(session_id, tool_use_id)` → the call still in flight under it.
   *  Keyed on the pair and never on the bare id; see `toolKey`. The agent a
   *  call belongs to is the call's own `agentId`, which is what `blockedCall`
   *  reads. */
  toolIndex: Map<string, ToolCall>;
  /** Per-session LIFO stack of active subagent ids — used to attribute incoming
   *  PreToolUse to the deepest live subagent, since CC tool-call hooks don't
   *  carry agent_id themselves. */
  activeSubagentStack: Map<string, string[]>;
  /** Subagent node id → the `receivedAt` of a `SubagentStop` that arrived
   *  before the matching `SubagentStart`, so the Start can be told that this
   *  subagent is already over (#1023).
   *
   *  The two hook POSTs are separate processes and each spends up to 800 ms in
   *  `prove()`'s two-attempt challenge before posting, so a fast subagent's
   *  Stop overtaking its own Start needs no unusual conditions. Without a record
   *  of it, `SubagentStop` had nothing to write to — `lookupSubagent` refuses to
   *  manifest a node at end-of-life, and rightly — so the Stop was discarded and
   *  the Start that followed left an `active` node with no `endedAt` and no
   *  second Stop coming. `pruneOldAgents` needs `done` and `pruneDoneSessions`
   *  needs nothing live, so that pinned the WHOLE session on the board for the
   *  life of the tab.
   *
   *  Bounded by construction: an entry is written only by a Stop that found no
   *  node, consumed by the Start it was waiting for, and dropped by the next
   *  write once it is older than `HOOK_REDELIVERY_WINDOW_MS` — past which it
   *  could no longer be the same subagent anyway. */
  subagentTombstones: Map<string, number>;
  /** Session id → the enrichment that arrived before the session's card did,
   *  newest value per kind, in the order the card takes them when it is made
   *  (parked-enrichment.ts).
   *
   *  A session's model, name, usage, context, activity line and job are
   *  last-value-wins and sent when they change, so a page joining a busy deck
   *  can be handed them ahead of the first surviving event that draws the card
   *  — and an idle session sends none of them again.
   *
   *  Bounded: the newest PARKED_ENRICHMENT_MAX sessions, one value of each kind
   *  apiece; an entry goes when its card takes it, when its session leaves the
   *  board, and with the board on a clear. */
  parkedEnrichment: Map<string, Map<string, import("./types").HookPayload>>;
  /** Model observations that overtook SubagentStart. Only Start creates a node;
   * cap the pending entries so scans of old subagents cannot grow this forever. */
  pendingSubagentModels: Map<string, string>;
  lastSeq: number;
  /** Which server process the `lastSeq` counter belongs to — the `epoch` the
   *  envelopes carry. Stays null while talking to a server too old to stamp it. */
  seqEpoch: string | null;
  totalEvents: number;
  /**
   * How many times anything in here has changed. The one honest answer to
   * "should a memo recompute", and the reason it exists rather than `lastSeq`
   * being used for that.
   *
   * `applyEvent` mutates in place and returns the same object, so the state's
   * identity never moves and a `useMemo` keyed on it depends on its second dep
   * alone. That dep was `lastSeq` — which only the envelope path writes. The
   * four periodic sweeps mutate the same state and never touch it, so
   * every memo keyed that way kept its cached value after a sweep had changed
   * the thing it was computing from.
   *
   * The visible cost was the alarm surfaces. sweepStaleSessions exists to clear
   * a `waiting` block left by a terminal that died mid-prompt — its own comment
   * names the tab title and the favicon as the reason it was written — and the
   * memos feeding those two never recomputed, so on a quiet deck the title, the
   * favicon and the amber chip announced the block forever.
   *
   * Bumped by every writer, which is the whole contract: a mutation that does
   * not move this is a mutation nothing on screen will notice.
   */
  revision: number;
}

export function initialState(): GraphState {
  return {
    agents: new Map(),
    toolIndex: new Map(),
    activeSubagentStack: new Map(),
    subagentTombstones: new Map(),
    parkedEnrichment: new Map(),
    pendingSubagentModels: new Map(),
    lastSeq: 0,
    seqEpoch: null,
    totalEvents: 0,
    revision: 0,
  };
}

export function rootAgentId(sessionId: string): string {
  return sessionId;
}

export function subagentIdFor(sessionId: string, agentId: string): string {
  return `${sessionId}::${agentId}`;
}

/** The key `toolIndex` is written under: the session the call belongs to,
 *  joined to the `tool_use_id` the session named it by.
 *
 *  #1009. `toolIndex` used to be keyed on the bare `tool_use_id`, and a
 *  `tool_use_id` is not unique on this board. It is unique
 *  within ONE session, because within a session one process allocates it; the
 *  deck holds every session on the machine at once and those allocators have
 *  nothing in common. Codex is the plain case — the watcher forwards the
 *  rollout's own `call_id` straight through as `tool_use_id`, and two Codex
 *  sessions start counting from `call_1` each — but nothing makes a Claude
 *  session's ids disjoint from a Codex session's either.
 *
 *  What a collision did, driven through this reducer: two sessions each open a
 *  call under `call_1`, and the second `PreToolUse` finds the first session's
 *  call through `findTool`'s `toolIndex` lookup, decides it is looking at a
 *  re-delivery of a call it already has, and refreshes that call in place —
 *  renaming the FIRST session's bubble to the second session's tool and pushing
 *  nothing for the second, which is then drawn nowhere. The `PostToolUse` that
 *  followed then settled the first session's bubble with the second session's
 *  result. One call erased, one bubble carrying another session's answer, and
 *  no surface anywhere saying either happened.
 *
 *  NUL is the separator because it is the one byte neither half can carry.
 *  Both come out of JSON and both are ids in practice — UUIDs, `call_N`,
 *  `toolu_…` — so `:` and `::` are the ambiguous choices, not the safe ones:
 *  `::` is already how `subagentIdFor` builds an agent id, and the id
 *  `PreToolUse` synthesises for a call that has none
 *  (`${owner.id}:${owner.toolCount}`) puts a `:` inside the second half on
 *  purpose. A join that cannot be re-split is the whole point, since
 *  nothing ever parses this back apart — it is only ever compared.
 *
 *  Exported for the tests, which read the index directly and would otherwise
 *  each hand-roll the separator — the one way a suite can go green against a
 *  key shape the reducer no longer writes. */
export function toolKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}\u0000${toolUseId}`;
}
