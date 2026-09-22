// ModelObserved's `subagentModels` had never been run by the suite (#1173).
//
// The server's transcript scan sends ModelObserved `{ model, subagentModels }`:
// the root's model, or null when the scan found none, and a map from each
// subagent's key to the model its own lines were written by. The key is the
// agentId in `subagents/agent-<id>.jsonl`, or, for a transcript that wrote its
// sidechains inline, the legacy `parentToolUseID`. The reducer puts each model
// on the node it names, `<sessionId>::<key>` — the same id SubagentStart gives
// the node, from `agent_id` or, failing that, `parent_tool_use_id`.
//
// Every reducer test that sent ModelObserved sent a root model string and
// nothing else, so the loop was dead code as far as the suite knew: the key
// form could drift away from the one the node is created under and every
// subagent card would lose its model chip, and `model: null` — which the server
// sends whenever it knows only subagent models — could start wiping the root's
// chip, with nothing going red.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;
let seq = 0;

function send(state: GraphState, payload: HookPayload): GraphState {
  const env: HookEnvelope = { seq: ++seq, receivedAt: T0 + seq, source: "hook", payload: { session_id: "s1", ...payload } };
  return applyEvent(state, env);
}

/** What `maybeResolveModel` pushes: the root's model, possibly null, and the
 *  subagent map exactly as the scan built it. */
function modelObserved(state: GraphState, model: string | null, subagentModels: Record<string, unknown>): GraphState {
  return send(state, { hook_event_name: "ModelObserved", model, subagentModels } as unknown as HookPayload);
}

/** A session with its root on Opus 5 and one subagent announced. */
function withSubagent(start: Partial<HookPayload>): GraphState {
  seq = 0;
  let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
  state = modelObserved(state, "claude-opus-5", {});
  return send(state, { hook_event_name: "SubagentStart", agent_type: "Explore", ...start });
}

describe("ModelObserved puts each subagent's model on that subagent", () => {
  it("keys the node on the agentId the subagents/ directory names it by", () => {
    let state = withSubagent({ agent_id: "a1b2c3" });
    state = modelObserved(state, "claude-opus-5", { a1b2c3: "claude-haiku-4-5" });

    expect(state.agents.get("s1::a1b2c3")!.model).toBe("claude-haiku-4-5");
    // The root is on its own model. The map is the reason one ModelObserved
    // can carry two: a Haiku child of an Opus session is the ordinary case.
    expect(state.agents.get("s1")!.model).toBe("claude-opus-5");
  });

  it("keys it on the parentToolUseID a transcript with inline sidechains names it by", () => {
    // A SubagentStart with no agent_id is keyed on its parent_tool_use_id, and
    // the scan's legacy half keys the same subagent the same way.
    let state = withSubagent({ parent_tool_use_id: "toolu_42" });
    expect(state.agents.has("s1::toolu_42")).toBe(true);
    state = modelObserved(state, null, { toolu_42: "claude-sonnet-5" });

    expect(state.agents.get("s1::toolu_42")!.model).toBe("claude-sonnet-5");
  });

  it("leaves the root's model alone when the scan found none for it", () => {
    // The server sends `model: null` whenever it knows subagent models and not
    // the root's — a session whose last lines were all delegated. That means
    // "nothing to say about the root", never "the root has no model".
    let state = withSubagent({ agent_id: "a1b2c3" });
    state = modelObserved(state, null, { a1b2c3: "claude-haiku-4-5" });

    expect(state.agents.get("s1")!.model).toBe("claude-opus-5");
    expect(state.agents.get("s1::a1b2c3")!.model).toBe("claude-haiku-4-5");
  });

  it("creates nothing for a value that is not a model or a key that names no subagent", () => {
    // Only SubagentStart creates a subagent, which is what keeps a stray key
    // from manufacturing a node. A key the board does not have, and a value
    // that is not a string, change nothing and throw nothing.
    let state = withSubagent({ agent_id: "a1b2c3" });
    const before = state.agents.size;
    expect(() => {
      state = modelObserved(state, null, { a1b2c3: 42, zzz: "claude-haiku-4-5" });
    }).not.toThrow();

    expect(state.agents.size).toBe(before);
    expect(state.agents.has("s1::zzz")).toBe(false);
    expect(state.agents.get("s1::a1b2c3")!.model).toBeUndefined();
  });
});

describe("a subagent's model that arrives before its SubagentStart", () => {
  it("is dropped, and the SubagentStart that follows does not recover it (known loss, #1178)", () => {
    // PINNED AS IT IS, NOT AS IT SHOULD BE. The loop only writes to a node that
    // exists, and the server does not send the map again while its signature is
    // unchanged (`subsSig` in maybeResolveModel), so a ModelObserved that
    // overtakes its SubagentStart leaves that subagent without a model until
    // some other subagent changes the map. That goes against the order
    // independence reducer.ts states on its first line; #1178 is the fix. When
    // it lands, this case flips to expecting the Haiku chip.
    seq = 0;
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
    state = modelObserved(state, "claude-opus-5", { late: "claude-haiku-4-5" });
    expect(state.agents.has("s1::late")).toBe(false);

    state = send(state, { hook_event_name: "SubagentStart", agent_id: "late", agent_type: "Explore" });
    expect(state.agents.get("s1::late")!.model).toBeUndefined();
  });
});
