// The session recap froze at the moment it opened.
//
// Its summary was memoised on the board state's identity, and the board state
// is stateRef.current, which the reducer mutates in place and hands back
// unchanged — so the memo was computed once per open. The turn's usage that
// lands a few seconds after its Stop, a background subagent still working, a
// session that resumed under the open recap: none of it reached the numbers
// until the recap was closed and opened again. SessionList and the usage panel
// key on `state.revision` for exactly this reason.
//
// Run, not read: fake-react keeps the recap's hooks across renders the way
// React does, and the board is moved by the reducer.
import { describe, expect, it, vi } from "vitest";
import type { HookEnvelope, HookPayload } from "../types";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../components/use-modal-dismiss", () => ({
  useModalDismiss: () => ({ current: null }),
  useScrimDismiss: () => ({}),
}));

const { mount, all } = await import("./fake-react");
const { default: SessionSummary } = await import("../components/SessionSummary");
const { applyEvent, initialState } = await import("../reducer");

const SID = "recap-follows";
let seq = 0;
const send = (state: ReturnType<typeof initialState>, payload: HookPayload) =>
  applyEvent(state, { seq: ++seq, receivedAt: 1_000_000 + seq * 1_000, source: "hook", payload: { session_id: SID, ...payload } } as HookEnvelope);

/** The value a stat in the recap reads, by its label. */
const stat = (tree: unknown, label: string) =>
  all(tree, el => typeof el.type === "function" && el.props.label === label)[0]?.props.value;

describe("an open session recap follows the board", () => {
  it("counts the calls made after it opened", () => {
    let s = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1" });
    s = send(s, { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "t1", tool_response: {} });
    s = send(s, { hook_event_name: "Stop" } as HookPayload);
    const recap = mount(SessionSummary, { state: s, sessionId: SID, onClose: () => {} });
    expect(stat(recap.tree, "tool calls")).toBe(1);

    // The session resumes under the open recap; the board object is the same one.
    const same = s;
    s = send(s, { hook_event_name: "UserPromptSubmit", prompt: "and again" });
    s = send(s, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t2" });
    s = send(s, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "t2", error: "exit 1" } as HookPayload);
    expect(s).toBe(same);
    recap.rerender({ state: s, sessionId: SID, onClose: () => {} });
    expect(stat(recap.tree, "tool calls")).toBe(2);
    expect(stat(recap.tree, "prompts")).toBe(2);
    expect(stat(recap.tree, "errors")).toBe(1);
  });
});
