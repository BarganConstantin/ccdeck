// Event → graph reducer. Pure-ish: same events in any order = same end state.
import { extractModel } from "./payload-model";
import { initialState, rootAgentId, type GraphState } from "./graph-state";
import { ensureRoot, resolveOwner } from "./agent-attribution";
import { applySessionStart, applyTurnEnd, applyUserPromptSubmit, noteSessionHeard } from "./session-lifecycle";
import { applySubagentStart, applySubagentStop } from "./subagent-lifecycle";
import { applyPreToolUse, applyToolOutcome } from "./tool-calls";
import {
  applyContextObserved, applyModelObserved, applyOutputObserved, applySessionNamed, applySessionRecapped,
  applyUsageObserved, stampSessionFacts,
} from "./transcript-events";
import { clearsWaiting, WAITING_KEEPERS, waitingBlock, waitingKind } from "./waiting-block";
import type { HookEnvelope } from "./types";

// The board's state and the keys it is filed under are graph-state.ts's, where
// the modules this file applies events through can read them too. The rest of
// the client reads them from here, as it always has.
export { initialState, toolKey, type GraphState } from "./graph-state";
// And the tool-call history's public half, for the same readers.
export { findToolOnBoard, MAX_TOOLS_PER_AGENT, settlesInFlightCall, TOOL_BLOB_WINDOW } from "./tool-calls";
// And the sweeps, the pruners and the pause gate's note, for prune.ts, the tray
// and use-pause-gate.ts.
export {
  noteDroppedEvents, pruneDoneSessions, pruneOldAgents, STALE_SESSION_MS, sweepStaleSessions, sweepStaleTools,
  type ForgetSession,
} from "./board-sweeps";
// And how long a guess at the blocked call may be printed, for its tests.
export { BLOCK_GUESS_WINDOW_MS } from "./waiting-block";
// And the window a repeated prompt is one submission inside, for its tests.
export { PROMPT_REDELIVERY_WINDOW_MS } from "./redelivery";
// And each session's accent, which the canvas, the cards and the clusters draw.
export { sessionHue } from "./session-hue";

export function applyEvent(state: GraphState, env: HookEnvelope): GraphState {
  // `seq` is only monotonic *within one server process*. A restart re-derives
  // the counter by replaying events.jsonl, so after a log rotation or an
  // /api/clear the fresh counter can start far below the seq this tab already
  // saw — and the tab keeps its state (and the browser its Last-Event-ID)
  // across EventSource reconnects. A bare `seq <= lastSeq` guard therefore
  // dropped every live event from the new process and froze the canvas until
  // the counter organically climbed past the old value, which can take days.
  // The server stamps a per-boot `epoch`; a new one rebases the guard instead
  // of silencing the stream. Servers too old to stamp it send no epoch, and
  // those keep the plain monotonic behaviour.
  const epoch = env.epoch ?? null;
  if (epoch !== null && epoch !== state.seqEpoch) {
    state.seqEpoch = epoch;
    state.lastSeq = 0;
  } else if (env.seq <= state.lastSeq) {
    return state;
  }

  const p = env.payload ?? {};
  const now = env.receivedAt;
  const name = p.hook_event_name ?? "Unknown";

  if (name === "__clear") {
    // A new object, so identity alone already tells every memo to recompute —
    // but the counter carries on rather than restarting, because a memo that
    // cached at revision 7 must not be handed a fresh 0 and conclude nothing
    // has happened since.
    return { ...initialState(), lastSeq: env.seq, seqEpoch: state.seqEpoch, revision: state.revision + 1 };
  }

  state.totalEvents += 1;
  state.lastSeq = env.seq;
  state.revision += 1;

  const sessionId = p.session_id ?? "unknown";

  // Clear the waiting block here rather than adding a line to eight cases. A
  // badge that outlives the block is worse than no badge — it teaches the user
  // to distrust the one signal the deck exists to give — and a per-case list is
  // a list somebody forgets to extend the next time an event is added. This
  // also carries the whole idempotency story: a replayed log re-delivers every
  // notification, and each one is cleared again by whatever the session did
  // next, so a tab that opens mid-block ends up blocked and a tab that opens
  // after it was answered does not.
  //
  // WHOSE traffic it is decides it, not just what the event is called: a
  // subagent's tool call carries the root's session_id and used to land here as
  // the session "moving again", which erased the alarm while the human was still
  // being asked. `clearsWaiting` holds that rule.
  if (!WAITING_KEEPERS.has(name)) {
    const blocked = state.agents.get(rootAgentId(sessionId));
    if (blocked?.waiting && clearsWaiting(blocked.waiting, p, sessionId)) blocked.waiting = null;
  }

  // Note that we heard from this session, which is a different question from
  // what the event says. It runs above the branches on purpose: the three
  // *Observed events return early, the switch below ignores several names
  // outright, and every one of them is still the session's id arriving from a
  // process that is running. Attribution is irrelevant for the same reason — a
  // subagent's PreToolUse proves the session is there as surely as the root's.
  noteSessionHeard(state, sessionId, now);

  // Facts about the session that ride on whatever payload carries them. Above
  // the transcript scans on purpose: every one of those returns early, and two
  // of these three ride on them.
  stampSessionFacts(state, p, sessionId);

  // The server's transcript scans enrich the root and stop here: none of them
  // is the session's own traffic, so none is attributed to an owner, stamps a
  // provider or has a model read off it. See transcript-events.ts.
  switch (name) {
    case "ModelObserved": applyModelObserved(state, p, sessionId); return state;
    case "ContextObserved": applyContextObserved(state, p, sessionId); return state;
    case "SessionNamed": applySessionNamed(state, p, sessionId); return state;
    case "SessionRecapped": applySessionRecapped(state, p, sessionId); return state;
    case "OutputObserved": applyOutputObserved(state, p, sessionId, now); return state;
    case "UsageObserved": applyUsageObserved(state, p, sessionId); return state;
  }

  const owner = resolveOwner(state, p, now);

  // Stamp provider on first observation. Defaults to "claude" for legacy
  // events recorded before multi-provider support.
  if (!owner.provider) {
    owner.provider = p.provider === "codex" ? "codex" : "claude";
  }

  // Snapshot model whenever it shows up in the payload — we want the most
  // recent observation per owner since either CLI can switch models mid-session.
  const observedModel = extractModel(p);
  if (observedModel) owner.model = observedModel;

  switch (name) {
    case "SessionStart": applySessionStart(state, p, sessionId, now); break;
    case "UserPromptSubmit": applyUserPromptSubmit(state, p, sessionId, now); break;
    case "PreToolUse": applyPreToolUse(state, p, sessionId, owner, now); break;
    case "PostToolUse":
    case "PostToolUseFailure": applyToolOutcome(state, p, name, sessionId, now); break;
    case "SubagentStart": applySubagentStart(state, p, sessionId, now); break;
    case "SubagentStop": applySubagentStop(state, p, sessionId, now); break;
    case "Stop":
    case "SessionEnd": applyTurnEnd(state, name, sessionId, now); break;
    case "Notification": {
      // The deck has always received these and always dropped them, which is
      // why "which of the five agents is stuck on me" was the one question the
      // canvas could not answer. Two kinds arrive and both mean the session is
      // blocked on a human; nothing else in the payload is worth keeping (the
      // `model.subsSig` blob alone runs to ~5KB, and there is no tool_name, no
      // tool_input and no tool_use_id to say what the block is ON).
      const kind = waitingKind(p.notification_type);
      if (!kind) break;
      // Straight to the root the way Stop does, never through resolveOwner:
      // that function exists to attribute tool traffic to the deepest live
      // subagent and would hang the badge on whichever Task happened to be
      // running. The payload names no subagent, and the block is on the session
      // as a whole in any case.
      const root = ensureRoot(state, sessionId, now, false);
      const message = typeof p.message === "string" ? p.message : "";
      const prev = root.waiting;
      // One notification is delivered more than once — a copy per deck sharing
      // events.jsonl, plus the whole history again on every tab that opens —
      // and each copy carries its own seq, so the seq/epoch guard lets it
      // through. Re-stamping `since` would restart the "waiting 4m" readout
      // every time a duplicate landed. Math.min rather than "keep whichever
      // arrived first" so a copy delivered out of order settles on the same
      // answer: order-independence is this reducer's stated contract.
      //
      // A duplicate keeps the attribution the first copy computed, for the same
      // reason it keeps the earliest `since`: the block belongs to the moment it
      // was raised, and a copy landing later sees a session that has moved on —
      // the blocked call may have settled by then, leaving nothing in flight to
      // read. Re-deriving per copy would let a re-delivery quietly widen or
      // narrow what is allowed to clear the block.
      root.waiting = prev && prev.kind === kind && prev.message === message
        ? { ...prev, since: Math.min(prev.since, now) }
        : waitingBlock(state, sessionId, kind, message, now);
      break;
    }
  }

  return state;
}
