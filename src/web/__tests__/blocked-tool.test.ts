// "waiting 4m" tells you a session is stopped on you. It does not tell you what
// it wants, and that is the difference between a badge you glance at and one you
// act on — the whole of the corpus complaint this deck exists to answer was
// somebody unable to tell which of four terminals held the prompt and what it
// was asking for.
//
// The payload cannot help: `Notification` carries no tool_name, no tool_input
// and no tool_use_id. What the deck has instead is POSITION IN THE STREAM. CC
// runs PreToolUse and then asks the human, so the call the prompt is about is
// the newest one still in flight — and it stays in flight for the whole block,
// because the PostToolUse that would settle it is what the human's answer
// produces. `blockedCall` already walked that path for #361's attribution; this
// reads the same call for its NAME.
//
// The reason this file is longer than the change is that the two readings are
// not held to the same standard, and the tests are mostly about the gap:
//
//   attribution decides which later events clear the block. Wrong, and an alarm
//   the user can see is still standing clears early or late.
//   the printed name is read by somebody deciding whether to approve a command.
//   Wrong, and they approve `rm -rf` believing it was the `ls` on their screen.
//
// So the printed half carries a window the attribution does not, and the cases
// below pin the direction it fails in: when the guess is not safe, the deck says
// what CC said and nothing more. Silence is recoverable. A confident wrong
// sentence is not.
//
// No DOM — plain node, vitest — so this drives applyEvent directly.
import { describe, it, expect } from "vitest";
import { applyEvent, BLOCK_GUESS_WINDOW_MS, initialState } from "../reducer";
import type { GraphState } from "../reducer";
import { blockedToolLabel, blockedToolTooltip } from "../components/AgentNode";
import type { HookEnvelope, HookPayload, WaitingBlock } from "../types";

const SESSION = "sess-blocked-tool";

/** Verbatim from a real events.jsonl, both of them. */
const PERMISSION = { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" };
const IDLE = { notification_type: "idle_prompt", message: "Claude is waiting for your input" };

let seq = 0;

/** One event, with an explicit wall clock so a test can put a call and the
 *  prompt that follows it any distance apart. `receivedAt` is what the reducer
 *  stamps `startedAt` and `since` from, so it is the only clock here. */
function send(state: GraphState, payload: HookPayload, receivedAt: number): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt,
    source: "hook",
    payload: { session_id: SESSION, ...payload },
  };
  return applyEvent(state, env);
}

const T0 = 1_000_000;

/** A session mid-turn, with nothing in flight yet. */
function started(): GraphState {
  seq = 0;
  let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" }, T0);
  return send(state, { hook_event_name: "UserPromptSubmit", prompt: "clean the tree" }, T0 + 1);
}

const waiting = (state: GraphState): WaitingBlock => state.agents.get(SESSION)!.waiting!;

describe("the tool a permission prompt is about", () => {
  it("names the call that was in flight when the prompt landed", () => {
    let state = started();
    state = send(state, {
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1",
      tool_input: { command: "rm -rf node_modules" },
    }, T0 + 10);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, T0 + 12);

    const w = waiting(state);
    expect(w.tool?.name).toBe("Bash");
    // The preview is the deck's existing one-liner, not the raw input object.
    // The point of the field is that it fits in a sidebar row and an OS
    // notification body, and `rm -rf node_modules` is exactly the string that
    // makes somebody stop and read before answering.
    expect(w.tool?.preview).toContain("rm -rf node_modules");
  });

  it("still names the tool when the call had no arguments worth previewing", () => {
    let state = started();
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "ListMcpResources", tool_use_id: "t1" }, T0 + 10);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, T0 + 12);

    // The name alone is most of the value — it turns "waiting" into "waiting on
    // a tool call" — so an empty preview must not throw the whole guess away.
    expect(waiting(state).tool?.name).toBe("ListMcpResources");
    expect(waiting(state).tool?.preview).toBe("");
  });

  it("picks the newest of several calls in flight", () => {
    let state = started();
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1" }, T0 + 10);
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "t2" }, T0 + 11);
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t3" }, T0 + 12);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, T0 + 13);

    // Parallel tool calls are the normal case, not the exotic one, and the
    // permission prompt belongs to the one CC asked about last.
    expect(waiting(state).tool?.name).toBe("Bash");
  });

  it("says nothing when no call was in flight", () => {
    let state = started();
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, T0 + 10);

    // A prompt with nothing behind it in the stream — a deck started
    // mid-session, or a hook that never landed. The block is still real and
    // still shown; it just does not gain a name it cannot support.
    expect(waiting(state).tool).toBeUndefined();
    expect(waiting(state).message).toBe(PERMISSION.message);
  });

  it("says nothing when the call settled before the prompt arrived", () => {
    let state = started();
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" }, T0 + 10);
    state = send(state, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" }, T0 + 11);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, T0 + 12);

    // A settled call is out of `toolIndex`, which is the property the whole
    // inference rests on: the blocked call is the one that has NOT come back.
    expect(waiting(state).tool).toBeUndefined();
  });
});

describe("the window, which is the whole reason this is safe to print", () => {
  it("refuses a call that has been running far longer than a prompt gap", () => {
    let state = started();
    state = send(state, {
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1",
      tool_input: { command: "npm run build" },
    }, T0);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, T0 + BLOCK_GUESS_WINDOW_MS + 1);

    // The failure this prevents, and it is the only one that matters: a long
    // build is in flight, an unrelated prompt arrives, and the deck tells the
    // user their agent is asking about `npm run build`. It is not. PreToolUse
    // to permission prompt is milliseconds of CC's own control flow, so a gap
    // this size means the newest in-flight call is simply something else still
    // running.
    expect(waiting(state).tool).toBeUndefined();
    // The block itself is untouched — this only ever withholds the guess.
    expect(waiting(state).kind).toBe("permission");
    expect(waiting(state).since).toBe(T0 + BLOCK_GUESS_WINDOW_MS + 1);
  });

  it("accepts a call right at the edge of the window", () => {
    let state = started();
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" }, T0);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, T0 + BLOCK_GUESS_WINDOW_MS);

    // Pinned so the boundary is a decision rather than an accident of `>` vs
    // `>=`, and so widening the window is a deliberate edit to a named constant.
    expect(waiting(state).tool?.name).toBe("Bash");
  });

  it("refuses a call stamped after the prompt", () => {
    let state = started();
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" }, T0 + 50);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, T0 + 10);

    // Reachable rather than impossible: a replayed log and a live tab do not
    // share a clock. A call from the future is not evidence about a prompt in
    // the past, and "0s ago" is not evidence of anything.
    expect(waiting(state).tool).toBeUndefined();
  });
});

describe("the two kinds", () => {
  it("never names a tool on an idle block", () => {
    let state = started();
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" }, T0 + 10);
    state = send(state, { hook_event_name: "Notification", ...IDLE }, T0 + 12);

    // An idle prompt is the input box sitting empty after a turn ended. There
    // is no call under it to be asked about, and the newest one in flight
    // belongs to whatever the session was doing before — naming it would invent
    // a question nobody asked.
    expect(waiting(state).kind).toBe("idle");
    expect(waiting(state).tool).toBeUndefined();
  });
});

describe("re-delivery", () => {
  it("keeps the first guess when the same notification lands again", () => {
    let state = started();
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" }, T0 + 10);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, T0 + 12);
    // The copy arrives long enough later that re-deriving would now be refused
    // by the window — which is the point. One notification is delivered more
    // than once (a copy per deck sharing events.jsonl, plus the whole history
    // again on every tab that opens), and the block belongs to the moment it
    // was raised. A guess that changed on re-delivery would make the sidebar
    // disagree with itself between two tabs of the same deck.
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, T0 + 12 + BLOCK_GUESS_WINDOW_MS + 1);

    expect(waiting(state).tool?.name).toBe("Bash");
    expect(waiting(state).since).toBe(T0 + 12);
  });
});

describe("how the guess is worded", () => {
  const withTool = (tool?: { name: string; preview: string }): WaitingBlock =>
    ({ kind: "permission", message: PERMISSION.message, since: T0, ...(tool ? { tool } : {}) });

  it("puts the name first and the preview after it", () => {
    expect(blockedToolLabel(withTool({ name: "Bash", preview: "rm -rf node_modules" })))
      .toBe("Bash · rm -rf node_modules");
  });

  it("drops the separator when there is no preview", () => {
    // A trailing "Bash · " reads as a truncation and sends the user looking for
    // the rest of a sentence that does not exist.
    expect(blockedToolLabel(withTool({ name: "Bash", preview: "" }))).toBe("Bash");
  });

  it("is null when there is no guess, so callers render nothing at all", () => {
    expect(blockedToolLabel(withTool())).toBeNull();
    expect(blockedToolTooltip(withTool())).toBeNull();
  });

  it("hedges wherever it has room to", () => {
    // "Likely" is load-bearing and does not come out in a tidy-up. The deck
    // infers this from stream position, not from anything CC said, and the one
    // place a user would catch it lying is the place they are deciding whether
    // to approve a command.
    expect(blockedToolTooltip(withTool({ name: "Bash", preview: "rm -rf node_modules" })))
      .toBe("Likely on: Bash · rm -rf node_modules");
  });
});
