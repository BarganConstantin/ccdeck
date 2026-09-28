// Whether a session is waiting on its human, what it is waiting on, and what
// counts as the human having answered.
//
// Only a `Notification` raises a block, and it names nobody — no agent, no tool
// — so who asked, and about what, are read off the calls still in flight when it
// lands. Everything else the session does is weighed by `clearAnsweredWaiting`
// on the way into `applyEvent`, except the transcript scans in `WAITING_KEEPERS`.
import { ensureRoot, explicitSubagentKey } from "./agent-attribution";
import { rootAgentId, subagentIdFor, type GraphState } from "./graph-state";
import { salientInput } from "./tool-input";
import type { BlockedTool, HookPayload, ToolCall, WaitingBlock } from "./types";

/** The two `notification_type` values Claude Code emits, as the chore each one
 *  actually is. Anything else is a kind nobody here has seen and would have no
 *  wording for, so it sets no block rather than a badge that says nothing. */
function waitingKind(notificationType: unknown): WaitingBlock["kind"] | null {
  if (notificationType === "permission_prompt") return "permission";
  // The agent asked a question and stopped for the answer, and the message
  // carries the question itself — "ccdeck needs your input: which improvements
  // to prioritize: all three, or specific ones?". This used to fall through to
  // `null`, so the session showed no block at all: no chip, no sidebar row, no
  // notification. On a machine running `bypassPermissions` — where Claude Code
  // never asks to run anything — it is the ONLY kind that fires, so the whole
  // blocked-session feature was dead there. Measured on one real log: 1683
  // events, all bypassPermissions, five of these and a single permission
  // prompt in the entire history.
  if (notificationType === "agent_needs_input") return "asked";
  if (notificationType === "idle_prompt") return "idle";
  return null;
}

/** Events that are NOT proof the session moved, and so must leave a waiting
 *  block standing whoever they are attributed to. `Notification` is the one that
 *  sets it. The three *Observed events are the server's own transcript scans,
 *  not session traffic: it starts one for every hook payload that carries a
 *  `transcript_path`, the notification included, so treating them as movement
 *  would clear the block a second or two after it was set and no badge would
 *  ever survive long enough to be read. Everything else — a prompt, a tool call,
 *  a subagent, a Stop — is the session moving again; `clearsWaiting` below
 *  decides whether that movement is also evidence the HUMAN moved. */
const WAITING_KEEPERS = new Set([
  "Notification", "ModelObserved", "ContextObserved", "UsageObserved",
  // Same story, fourth scanner: SessionNamed comes off the transcript cursor,
  // not off session traffic. A session parked on a permission prompt is exactly
  // when the deck has time to notice its name, and clearing the badge there
  // would hide the one thing the card is trying to say.
  "SessionNamed",
  // And the recap, which is written precisely BECAUSE nothing is moving: three
  // minutes after a turn ended, with the "Your turn" badge already up. It is
  // the badge's explanation, not the end of it.
  "SessionRecapped",
  // And the output watch, the fifth scanner (#1444). It polls the transcript
  // every 1.5s and reports each block the model finished writing, and the block
  // that raises a prompt — the tool call being asked about, the question itself
  // — is written just BEFORE the prompt, so the next tick usually reports it
  // after the badge is up. Nothing the model writes can mean the human answered
  // unless a hook says so first: the tool's result, the next prompt, a Stop.
  "OutputObserved",
]);

/**
 * Which subagent a permission prompt landing right now is about, or undefined
 * when the root asked (or when we cannot tell, which is the same answer as far
 * as the clear rule is concerned).
 *
 * `Notification` names nobody — no agent_id, no tool_name, no tool_use_id — so
 * the only thing left to read is where it sits in the stream. CC runs the
 * PreToolUse hook BEFORE it asks the human for permission, so the call that is
 * about to block is the newest one still in flight on this session, and whoever
 * that call's payload named is the one waiting on an answer.
 *
 * Deliberately NOT the top of `activeSubagentStack`, which is the attribution
 * rule everything else here uses: with three Tasks running in parallel the stack
 * top is a one-in-three guess about which of them asked, whereas the newest
 * in-flight call is the one whose PreToolUse fired milliseconds ago. The only
 * way it picks wrong is another agent starting a call inside that gap, and both
 * ways of being wrong are bounded by what the deck did before #361: attribute to
 * a sibling and that sibling's traffic clears the block early (today's bug, now
 * needing a millisecond race to happen at all), attribute to nobody and only
 * root-level traffic clears it (the plain #361 rule).
 *
 * The call's own `explicitSubagentId` decides whose it is, not the node it was
 * drawn under. Those differ for exactly the case that matters here: while a Task
 * is live, the root's own tool calls carry no agent_id and are attributed to the
 * subagent by the stack heuristic — so reading the owner would hand a prompt the
 * ROOT raised to whichever Task happened to be running, and let that Task's
 * traffic clear it. Payload attribution both ways, or the rule contradicts
 * itself.
 */
function blockedCall(state: GraphState, sessionId: string): ToolCall | null {
  let newest: ToolCall | null = null;
  for (const tc of state.toolIndex.values()) {
    // `toolIndex` holds every session's in-flight calls in one map — its KEYS
    // name a session (#1009), its values do not — and holds exactly the calls
    // that have not settled: PostToolUse and the stale sweep both delete. So the
    // session filter stays a filter over the values, read off the owner the call
    // is actually drawn under rather than off the key it was filed by.
    const owner = tc.agentId ? state.agents.get(tc.agentId) : undefined;
    if (!owner || owner.sessionId !== sessionId) continue;
    if (!newest || tc.startedAt > newest.startedAt) newest = tc;
  }
  return newest;
}

/**
 * How stale the newest in-flight call may be and still be printed as the thing
 * the human is being asked about.
 *
 * The attribution above needs no window. CC fires PreToolUse and then asks, so
 * the blocked call is the newest in flight — and it STAYS in flight for the
 * whole block, because the PostToolUse that would settle it is what the human's
 * answer produces. Any window at all is therefore about the OTHER direction:
 * the newest in-flight call when the prompt lands may be a genuinely
 * long-running one — a build, a test run, a fetch — that nobody is being asked
 * about, and on a session with no PreToolUse captured (a deck started
 * mid-session, a hook that timed out) that is the only candidate there is.
 *
 * Thirty seconds is chosen against the gap being measured, not against how long
 * blocks last: PreToolUse to permission prompt is milliseconds of CC's own
 * control flow. Anything older is a different call still running, and naming it
 * would print a confident sentence about the wrong command. Widening this trades
 * a silence the user can recover from — CC's own sentence, which is what they
 * had before — for a lie they cannot detect.
 */
export const BLOCK_GUESS_WINDOW_MS = 30_000;

/** What the prompt is most likely about, when the stream implies it recently
 *  enough to print. See `BlockedTool` in types.ts for why this is held to a
 *  stricter standard than the attribution that reads the same call. */
function blockedToolOf(call: ToolCall | null, now: number): BlockedTool | undefined {
  if (!call || !call.name) return undefined;
  if (now - call.startedAt > BLOCK_GUESS_WINDOW_MS) return undefined;
  // A call that started after the notification landed cannot be the one it is
  // about. Clock skew between a replayed log and this tab makes that reachable
  // rather than impossible, and "0s from now" is not evidence of anything.
  if (call.startedAt > now) return undefined;
  // `inputPreview` is the JSON-shaped one `shortPreview` builds for the modal,
  // where the reader wants the object. Here the string is read as a sentence —
  // in a tooltip and in a desktop notification — and
  // `{"command":"rm -rf node_modules"}` buries the four words that decide the
  // answer inside punctuation. tool-input.ts returns the line a person reads,
  // and null for a shape with nothing worth reading, which leaves the tool name
  // standing on its own rather than beside a fragment of JSON.
  return { name: call.name, preview: salientInput(call.input) ?? "" };
}

/** A fresh block, attributed. Only a `permission` block is ever about one agent:
 *  an idle prompt is the session's own input box sitting empty, which belongs to
 *  nobody underneath it. The field is left off entirely rather than set to
 *  undefined so a block with no subagent behind it is the same object it has
 *  always been. */
function waitingBlock(
  state: GraphState, sessionId: string, kind: WaitingBlock["kind"], message: string, now: number,
): WaitingBlock {
  // An idle block is the session's input box sitting empty. There is no call
  // under it to name, and the newest one still in flight belongs to whatever
  // the session was doing before the turn ended — so neither field is read.
  if (kind !== "permission") return { kind, message, since: now };
  const call = blockedCall(state, sessionId);
  const block: WaitingBlock = { kind, message, since: now };
  // A call whose payload named nobody is the root's own, and root-level traffic
  // already clears the block — there is nothing to name.
  if (call?.explicitSubagentId) block.subagentId = call.explicitSubagentId;
  const tool = blockedToolOf(call, now);
  if (tool) block.tool = tool;
  return block;
}

/**
 * Is this event evidence the human dealt with `w`?
 *
 * #361: it used to be enough that the event was not a keeper, keyed on nothing
 * but `hook_event_name` and `session_id`. A subagent's tool call carries the
 * ROOT's session_id — and on a real log 79% of PreToolUse and PostToolUse
 * events are subagent-attributed — so in any session running a Task the alarm
 * was wiped milliseconds after it was raised, while the human was still looking
 * at the prompt in the terminal. Nothing re-raises it: the notification is not
 * re-sent, and since #348 the idle_prompt that follows is not an alarm.
 *
 * The two kinds are different claims and are answered by different evidence:
 *
 *  - `permission` says a specific agent is stopped until the human answers. Only
 *    the root's own traffic, or traffic from the very subagent that asked, can
 *    mean the answer arrived; a sibling Task working away means nothing at all.
 *  - `idle` says nothing is happening — the input box has been empty for a
 *    minute. ANY traffic on the session falsifies that directly, including a
 *    subagent's, so it keeps the old rule. Being wrong in that direction is also
 *    the cheap one: an idle block is not an alarm post-#348, it only sorts the
 *    sidebar and prints "waiting 3m", and printing that over a session whose
 *    subagents are visibly working is the lie worth avoiding.
 */
function clearsWaiting(w: WaitingBlock, p: HookPayload, sessionId: string): boolean {
  // `idle` is the only kind ANY traffic falsifies. The other two are claims
  // that a specific agent is stopped until a human answers, so they need the
  // narrow rule below — an `asked` block wiped by a sibling subagent's tool
  // call is #361 again, and it would be worse here because the message the
  // block carries is the question itself.
  if (w.kind === "idle") return true;
  const key = explicitSubagentKey(p);
  // Root-level traffic — every UserPromptSubmit, Stop, SessionStart, SessionEnd
  // and the root's own tool calls, none of which carries an agent_id or a
  // parent_tool_use_id. This is the whole of what used to clear it correctly.
  if (key == null) return true;
  // Subagent-attributed traffic clears only the block that subagent itself
  // raised, which is what the human answering a subagent's prompt produces:
  // its PostToolUse if they approved, its next call or its SubagentStop if they
  // denied. Siblings, and every subagent when the root is the one asking, leave
  // it standing.
  return w.subagentId != null && subagentIdFor(sessionId, key) === w.subagentId;
}

/** Take the session's waiting block down when this event is evidence the human
 *  answered it: any event but a keeper, judged by `clearsWaiting`. */
export function clearAnsweredWaiting(state: GraphState, name: string, p: HookPayload, sessionId: string): void {
  if (!WAITING_KEEPERS.has(name)) {
    const blocked = state.agents.get(rootAgentId(sessionId));
    if (blocked?.waiting && clearsWaiting(blocked.waiting, p, sessionId)) blocked.waiting = null;
  }
}

/** A `Notification`: the session is blocked on its human, and this is the one
 *  event that raises the block. Kept at the earliest `since` and the first
 *  copy's attribution however many copies arrive. */
export function applyNotification(state: GraphState, p: HookPayload, sessionId: string, now: number): void {
  // The deck has always received these and always dropped them, which is
  // why "which of the five agents is stuck on me" was the one question the
  // canvas could not answer. Two kinds arrive and both mean the session is
  // blocked on a human; nothing else in the payload is worth keeping (the
  // `model.subsSig` blob alone runs to ~5KB, and there is no tool_name, no
  // tool_input and no tool_use_id to say what the block is ON).
  const kind = waitingKind(p.notification_type);
  if (!kind) return;
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
}
