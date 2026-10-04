// Event → graph reducer. Pure-ish: same events in any order = same end state.
//
// This file is the order an event is applied in. The seq guard first; then
// what every event does whoever it belongs to — the waiting block's clear, the
// session's heartbeat, the facts Codex restates on any payload; then the
// server's transcript scans, which stop there; then the hook events, each after
// `resolveOwner` has named the agent it belongs to. What each event does is
// written beside the state it changes:
//
//   graph-state.ts         the state, and the keys it is filed under
//   agent-attribution.ts   which agent an event belongs to; roots and subagents
//   session-lifecycle.ts   SessionStart, prompts, Stop and SessionEnd
//   subagent-lifecycle.ts  SubagentStart and SubagentStop
//   tool-calls.ts          a call's start and outcome, and its history window
//   waiting-block.ts       Notification, and what clears the block it raises
//   transcript-events.ts   the server's transcript scans
//   board-sweeps.ts        the tick's sweeps and pruners, which no event drives
//
// The rest of the client imports what it reads of these from here.
import { extractModel } from "./payload-model";
import { initialState, type GraphState } from "./graph-state";
import { noteKeyedSubagent, resolveOwner } from "./agent-attribution";
import { applySessionStart, applyTurnEnd, applyUserPromptSubmit, noteSessionHeard } from "./session-lifecycle";
import { applySubagentStart, applySubagentStop } from "./subagent-lifecycle";
import { applyPreToolUse, applyToolOutcome, returnLentCalls } from "./tool-calls";
import {
  applyContextObserved, applyModelObserved, applyOutputObserved, applySessionNamed, applySessionRecapped,
  applyUsageObserved, stampSessionFacts,
} from "./transcript-events";
import { applyNotification, clearAnsweredWaiting } from "./waiting-block";
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
  clearAnsweredWaiting(state, name, p, sessionId);

  // Note that we heard from this session, which is a different question from
  // what the event says. It runs above the branches on purpose: the transcript
  // scans return early, the switch below ignores several names outright, and
  // every one of them is still the session's id arriving from a process that is
  // running. Attribution is irrelevant for the same reason — a subagent's
  // PreToolUse proves the session is there as surely as the root's.
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
  // A subagent naming itself on its own traffic settles, for the rest of the
  // session, that an event naming nobody is the root's — and the root takes
  // back what the stack lent its subagents before this said so. See
  // `keyedSubagents` in types.ts.
  if (noteKeyedSubagent(state, name, p, sessionId)) returnLentCalls(state, sessionId);

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
    case "Notification": applyNotification(state, p, sessionId, now); break;
  }

  return state;
}
