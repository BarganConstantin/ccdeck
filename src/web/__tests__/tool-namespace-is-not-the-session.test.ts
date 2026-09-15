// A TOOL'S ARGUMENTS ARE NOT THE SESSION'S FACTS.
//
// extractModel recurses the whole envelope to depth 6 looking for a `model`
// string. `tool_input` and `tool_response` are part of that envelope — and they
// are the only two fields on the wire carrying arbitrary foreign nested data,
// both declared `any` in types.ts. So a tool called WITH a model id, or one
// that returned a model id, renamed the session that called it:
//
//   after ModelObserved:                     gpt-5.6-sol
//   after a tool_input naming another model: claude-opus-4-5
//   after a nested tool_response model:      o3-mini
//
// The first was an ordinary MCP call — `mcp__openai__chat` with
// `tool_input: { model: "claude-opus-4-5", messages: [...] }`.
//
// And it re-priced the session, not only the chip: usage-models.ts falls back
// to `[{ model: a.model, usage: a.usage }]` whenever usageByModel is absent,
// which is every Codex session, so the whole bill was recomputed at the stolen
// rate — $14.50 to $22.50 on a 2M/400K/5M session.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope } from "../types";

const env = (seq: number, payload: Record<string, unknown>): HookEnvelope =>
  ({ seq, receivedAt: 1_700_000_000_000 + seq * 1000, source: "hook", payload } as never);

const started = (id: string, model: string, provider?: string) => {
  let s = initialState();
  s = applyEvent(s, env(1, { hook_event_name: "SessionStart", session_id: id, cwd: "/tmp", ...(provider ? { provider } : {}) }));
  s = applyEvent(s, env(2, { hook_event_name: "ModelObserved", session_id: id, model }));
  expect(s.agents.get(id)?.model, "the session starts correctly labelled").toBe(model);
  return s;
};

describe("a tool call carrying a model id", () => {
  it("does not rename the session through tool_input", () => {
    let s = started("A", "gpt-5.6-sol", "codex");
    s = applyEvent(s, env(3, {
      hook_event_name: "PreToolUse", session_id: "A", cwd: "/tmp",
      tool_name: "mcp__openai__chat", tool_use_id: "t1",
      tool_input: { model: "claude-opus-4-5", messages: [{ role: "user", content: "hi" }] },
    }));
    expect(s.agents.get("A")?.model).toBe("gpt-5.6-sol");
  });

  it("does not rename the session through tool_response, however deep", () => {
    let s = started("B", "claude-sonnet-5");
    s = applyEvent(s, env(3, {
      hook_event_name: "PreToolUse", session_id: "B", cwd: "/tmp",
      tool_name: "Bash", tool_use_id: "t9", tool_input: { command: "echo hi" },
    }));
    s = applyEvent(s, env(4, {
      hook_event_name: "PostToolUse", session_id: "B", tool_use_id: "t9",
      tool_response: { result: { deep: { nested: { model: "o3-mini" } } } },
    }));
    expect(s.agents.get("B")?.model).toBe("claude-sonnet-5");
  });

  it("leaves a session with no model yet unlabelled rather than borrowing one", () => {
    // The sharpest case: a Codex session before any response_item names its
    // model is exactly the state with nothing to overwrite, so a borrowed id
    // would look like a real observation.
    let s = initialState();
    s = applyEvent(s, env(1, { hook_event_name: "SessionStart", session_id: "C", cwd: "/tmp", provider: "codex" }));
    s = applyEvent(s, env(2, {
      hook_event_name: "PreToolUse", session_id: "C", cwd: "/tmp",
      tool_name: "mcp__anthropic__messages", tool_use_id: "t1",
      tool_input: { model: "claude-opus-4-5" },
    }));
    expect(s.agents.get("C")?.model ?? null).toBeNull();
  });
});

describe("and the envelope's own model is still read", () => {
  it("takes a top-level model", () => {
    let s = initialState();
    s = applyEvent(s, env(1, { hook_event_name: "SessionStart", session_id: "D", cwd: "/tmp" }));
    s = applyEvent(s, env(2, { hook_event_name: "PreToolUse", session_id: "D", cwd: "/tmp",
      tool_name: "Bash", tool_use_id: "t1", model: "claude-opus-5" }));
    expect(s.agents.get("D")?.model).toBe("claude-opus-5");
  });

  it("still finds one nested outside the tool's namespace", () => {
    // The recursion exists because both CLIs surface the model on different
    // keys per event; only the tool's own two fields are excluded, so a model
    // sitting anywhere else in the envelope is still read.
    let s = initialState();
    s = applyEvent(s, env(1, { hook_event_name: "SessionStart", session_id: "E", cwd: "/tmp" }));
    s = applyEvent(s, env(2, {
      hook_event_name: "PreToolUse", session_id: "E", cwd: "/tmp",
      tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "echo hi" },
      message: { model: "claude-sonnet-5" },
    }));
    expect(s.agents.get("E")?.model).toBe("claude-sonnet-5");
  });

  it("and a Task's own usage still reaches the tool call it belongs to", () => {
    // extractUsage is NOT changed: its only caller passes p.tool_response as
    // the root, deliberately, and assigns to the TOOL CALL rather than to the
    // session. Breaking that would have been the cost of an over-broad fix.
    let s = initialState();
    s = applyEvent(s, env(1, { hook_event_name: "SessionStart", session_id: "F", cwd: "/tmp" }));
    s = applyEvent(s, env(2, { hook_event_name: "PreToolUse", session_id: "F", cwd: "/tmp",
      tool_name: "Task", tool_use_id: "t5", tool_input: { prompt: "go" } }));
    s = applyEvent(s, env(3, { hook_event_name: "PostToolUse", session_id: "F", tool_use_id: "t5",
      tool_response: { usage: { input_tokens: 1000, output_tokens: 200 } } }));
    const tc = [...s.agents.values()].flatMap(a => a.tools).find(t => t.id === "t5");
    expect(tc?.usage?.inputTokens).toBe(1000);
    expect(tc?.usage?.outputTokens).toBe(200);
  });
});
