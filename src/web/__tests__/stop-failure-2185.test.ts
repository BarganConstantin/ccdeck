// #2185: a turn that stops on a login or usage-limit error, on the card.
//
// Every Claude Code session on a machine shares one login, and when it dies
// each running session ends its turn on "Login expired · Please run /login".
// Claude Code reports that with StopFailure, which runs INSTEAD of Stop — so
// before this the deck heard no ending at all and the cards went on reading
// live. These cases drive the real reducer with the payload Claude Code sends
// (the hooks reference's own StopFailure example, and the values its matcher
// table lists), then read the result the way the card, its note, the session
// list, the small face and a screen reader do.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";
import { stopError, stopFailureOf, stopKind, stopMessage, STOP_MESSAGE_MAX, switchCanCure } from "../../server/stop-failure.mjs";
import { sessionNoteShown, noteSource, noteTag } from "../session-note";
import { buildRows } from "../components/SessionList";
import AgentNode from "../components/AgentNode";
import { drawnState, faceSignal } from "../node-face";
import { agentAriaLabel } from "../agent-copy";
import { stopNoteText, stopRowLabel, stopTooltip } from "../stop-failure-copy";
// @ts-expect-error — .mjs server module, no types
import { createActivity } from "../../server/activity.mjs";

const SID = "s-stop";
let seq = 0;
let t = 1_800_000_000_000;

function send(state: GraphState, payload: Partial<HookPayload>, at = (t += 1_000)): void {
  applyEvent(state, { seq: ++seq, receivedAt: at, source: "hook", payload: { session_id: SID, provider: "claude", ...payload } as HookPayload } as HookEnvelope);
}

/** The StopFailure Claude Code sends, with `error` and the line it printed. */
const stopFailure = (error: string, last_assistant_message?: string, error_details?: string): Partial<HookPayload> => ({
  hook_event_name: "StopFailure",
  transcript_path: "/home/u/.claude/projects/-work-repo/s-stop.jsonl",
  cwd: "/work/repo",
  error,
  ...(error_details ? { error_details } : {}),
  ...(last_assistant_message ? { last_assistant_message } : {}),
});

/** A session in the middle of a turn. */
function board(): GraphState {
  seq = 0;
  const state = initialState();
  send(state, { hook_event_name: "SessionStart", cwd: "/work/repo" });
  send(state, { hook_event_name: "UserPromptSubmit", prompt: "fix the build" });
  send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "t1" });
  send(state, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "t1", tool_response: { stdout: "ok" } });
  return state;
}

const root = (state: GraphState): AgentNodeData => state.agents.get(SID)!;
const words = { sayWaiting: () => "Your turn", describeCall: (c: { name: string }) => ({ name: c.name }) };
const card = (a: AgentNodeData) => renderToStaticMarkup(createElement(ReactFlowProvider, null,
  createElement(AgentNode as never, { id: a.id, data: a, selected: false })));

describe("what a StopFailure says", () => {
  it("names the two errors a working login cures, and calls every other one an API error", () => {
    expect(stopKind("authentication_failed")).toBe("login");
    expect(stopKind("rate_limit")).toBe("usage-limit");
    for (const e of ["overloaded", "oauth_org_not_allowed", "account_on_hold", "billing_error", "invalid_request",
      "model_not_found", "server_error", "max_output_tokens", "cloud_credential_error", "unknown", "a_future_value"]) {
      expect(stopKind(e), e).toBe("api-error");
    }
    // Off the wire: an inherited name is not one of the two.
    expect(stopKind("constructor")).toBe("api-error");
    expect(stopKind(undefined)).toBe("api-error");
    expect(switchCanCure("login")).toBe(true);
    expect(switchCanCure("usage-limit")).toBe(true);
    expect(switchCanCure("api-error")).toBe(false);
  });

  it("keeps only an error shaped like one of Claude Code's values", () => {
    expect(stopError({ error: "rate_limit" })).toBe("rate_limit");
    expect(stopError({ error: "Rate Limit; rm -rf /" })).toBe("unknown");
    expect(stopError({ error: 42 })).toBe("unknown");
    expect(stopError({})).toBe("unknown");
  });

  it("quotes the line the terminal printed, then the details, as one line of plain text", () => {
    expect(stopMessage({ last_assistant_message: "API Error: Rate limit reached", error_details: "429 Too Many Requests" }))
      .toBe("API Error: Rate limit reached");
    expect(stopMessage({ error_details: "429 Too Many Requests" })).toBe("429 Too Many Requests");
    expect(stopMessage({ last_assistant_message: "  \n " , error_details: "401" })).toBe("401");
    expect(stopMessage({})).toBe("");
  });

  it("takes out terminal escapes, control and bidi characters, and anything shaped like a credential", () => {
    const said = stopMessage({
      last_assistant_message: "\u001b[31mLogin expired\u001b[0m ‮·\u0007 Please run /login\nBearer abc.def-123 sk-ant-oat01-SECRETSECRET",
    });
    expect(said).toBe("Login expired · Please run /login Bearer … sk-ant-…");
    const long = stopMessage({ last_assistant_message: "x".repeat(500) });
    expect([...long].length).toBe(STOP_MESSAGE_MAX);
    expect(long.endsWith("…")).toBe(true);
  });

  it("is nothing for any other event", () => {
    expect(stopFailureOf({ hook_event_name: "Stop", error: "rate_limit" }, 1)).toBeNull();
    expect(stopFailureOf(null, 1)).toBeNull();
    expect(stopFailureOf({ hook_event_name: "StopFailure", error: "authentication_failed", last_assistant_message: "Login expired · Please run /login" }, 7))
      .toEqual({ kind: "login", error: "authentication_failed", message: "Login expired · Please run /login", at: 7 });
  });
});

describe("a turn that ends on StopFailure", () => {
  for (const [error, kind, label] of [
    ["authentication_failed", "login", "Stopped · login expired"],
    ["rate_limit", "usage-limit", "Stopped · usage limit"],
    ["server_error", "api-error", "Stopped · API error"],
  ] as const) {
    it(`ends the turn and records why: ${error}`, () => {
      const s = board();
      send(s, stopFailure(error, "API Error: something"));
      const a = root(s);
      expect(a.state).toBe("done");
      expect(a.endedAt).toBeDefined();
      expect(a.stopFailure).toMatchObject({ kind, error, message: "API Error: something" });
      expect(stopRowLabel(a.stopFailure!)).toBe(label);
    });
  }

  it("settles a call the turn was still holding, as a Stop does", () => {
    const s = board();
    send(s, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a" }, tool_use_id: "t2" });
    send(s, stopFailure("authentication_failed"));
    const call = root(s).tools.find(c => c.id === "t2")!;
    expect(call.endedAt).toBeDefined();
  });

  it("is the end of a turn to the away-update too", () => {
    const activity = createActivity();
    activity.note({ hook_event_name: "UserPromptSubmit", session_id: "x" }, 1_000);
    expect(activity.busy(2_000)).toBe(true);
    activity.note({ hook_event_name: "StopFailure", session_id: "x", error: "authentication_failed" }, 3_000);
    expect(activity.busy(4_000)).toBe(false);
  });
});

describe("the stop comes down when the session does something again", () => {
  it("on the next prompt — the \"continue\" the note asks for", () => {
    const s = board();
    send(s, stopFailure("authentication_failed"));
    send(s, { hook_event_name: "UserPromptSubmit", prompt: "continue" });
    expect(root(s).stopFailure).toBeNull();
    expect(root(s).state).toBe("active");
  });

  it("on a tool call of the root's own", () => {
    const s = board();
    send(s, stopFailure("rate_limit"));
    send(s, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t9" });
    expect(root(s).stopFailure).toBeNull();
  });

  it("on a Stop: a turn that finished", () => {
    const s = board();
    send(s, stopFailure("server_error"));
    send(s, { hook_event_name: "Stop" });
    expect(root(s).stopFailure).toBeNull();
  });

  it("on a new start", () => {
    const s = board();
    send(s, stopFailure("authentication_failed"));
    send(s, { hook_event_name: "SessionStart", source: "resume" });
    expect(root(s).stopFailure).toBeNull();
  });

  it("and a newer stop replaces it", () => {
    const s = board();
    send(s, stopFailure("rate_limit"));
    send(s, { hook_event_name: "UserPromptSubmit", prompt: "continue" });
    // Outside the re-delivery window: an ending that close to the last one,
    // with a prompt between, is refused as a copy of it, as a Stop is.
    send(s, stopFailure("authentication_failed"), t += 10_000);
    expect(root(s).stopFailure?.kind).toBe("login");
  });
});

describe("what does not take the stop down", () => {
  it("a background subagent working on: it does not run the failed turn again", () => {
    const s = board();
    send(s, { hook_event_name: "SubagentStart", agent_id: "bg-1", agent_type: "general-purpose" });
    send(s, stopFailure("authentication_failed"));
    send(s, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "x" }, tool_use_id: "b1", agent_id: "bg-1" });
    send(s, { hook_event_name: "PostToolUse", tool_name: "Grep", tool_input: { pattern: "x" }, tool_use_id: "b1", agent_id: "bg-1" });
    expect(root(s).stopFailure?.kind).toBe("login");
  });

  it("Claude Code's idle reminder a minute later, which is about the same turn", () => {
    const s = board();
    send(s, stopFailure("authentication_failed"));
    send(s, { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }, t += 60_000);
    expect(root(s).stopFailure?.kind).toBe("login");
    expect(root(s).waiting?.kind).toBe("idle");
  });

  it("a copy of an older prompt arriving late", () => {
    const s = board();
    const promptAt = t;
    send(s, stopFailure("authentication_failed"));
    send(s, { hook_event_name: "UserPromptSubmit", prompt: "fix the build" }, promptAt - 500);
    expect(root(s).stopFailure?.kind).toBe("login");
  });

  it("the restore snapshot calling the session idle after a restart", () => {
    const s = board();
    send(s, stopFailure("authentication_failed"));
    applyEvent(s, { seq: ++seq, receivedAt: t += 1_000, source: "internal", payload: {
      hook_event_name: "ClaudeSessionRecovered", provider: "claude", session_id: SID, recovery_active: false, snapshot_observed_at: t,
    } as HookPayload } as HookEnvelope);
    expect(root(s).stopFailure?.kind).toBe("login");
  });

  it("an older StopFailure arriving after the newer turn began", () => {
    const s = board();
    const failedAt = t + 1_000;
    send(s, { hook_event_name: "UserPromptSubmit", prompt: "next" }, failedAt + 5_000);
    send(s, stopFailure("authentication_failed"), failedAt);
    expect(root(s).stopFailure ?? null).toBeNull();
    expect(root(s).state).toBe("active");
  });
});

describe("where the stop is said", () => {
  const stopped = () => {
    const s = board();
    send(s, stopFailure("authentication_failed", "Login expired · Please run /login"));
    return s;
  };

  it("on the card, with what Claude Code said and what to do in the tooltip", () => {
    const html = card(root(stopped()));
    expect(html).toContain('class="stop-row"');
    expect(html).toContain("Stopped · login expired");
    expect(html).toContain("It said: “Login expired · Please run /login”");
    expect(html).toContain("Type “continue” in this session once a working login is active.");
  });

  it("instead of the idle row a minute later, which says the same turn ended", () => {
    const s = stopped();
    send(s, { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }, t += 60_000);
    const html = card(root(s));
    expect(html).toContain('class="stop-row"');
    expect(html).not.toContain("waiting-row");
  });

  it("in the session's note, over Claude Code's recap", () => {
    const s = stopped();
    const a = root(s);
    a.recap = { text: "Fixed the build config.", at: (a.stopFailure!.at) + 5 * 60_000 };
    const note = sessionNoteShown(a)!;
    expect(note.kind).toBe("stopped");
    expect(noteTag(note.kind)).toBe("stopped");
    expect(note.text).toBe(stopNoteText(a.stopFailure!));
    expect(note.text).toBe("Login expired. Type “continue” in this session once a working login is active.");
    expect(noteSource(note)).toBe("Claude Code's StopFailure hook: “Login expired · Please run /login”");
  });

  it("in the session list, as the row's note", () => {
    const row = buildRows(stopped(), t).find(r => r.sessionId === SID)!;
    expect(row.status?.kind).toBe("stopped");
    expect(row.state, "the row's mark is a tick beside the stop").toBe("err");
    expect(row.recap).toBeNull();
  });

  it("on the small face, as a failure", () => {
    expect(faceSignal(root(stopped()), undefined, words as never)).toEqual({
      tone: "err", long: "Stopped · login expired", short: "Login expired",
    });
  });

  it("in the card's spoken name, in place of done", () => {
    const said = agentAriaLabel(root(stopped()), t);
    expect(said).toContain(", stopped, login expired — type “continue” in this session once a working login is active, ");
    expect(said).not.toMatch(/, done,/);
  });

  it("as a failure in the card's ring, pill and mark, while the turn still counts as ended", () => {
    const a = root(stopped());
    expect(a.state).toBe("done");
    expect(drawnState(a)).toBe("err");
    const html = card(a);
    expect(html).toContain('class="agent-node state-err"');
    expect(html).toContain('class="state-pill state-err"');
    expect(html).toContain('class="state-mark" data-kind="err"');
    expect(html).not.toContain("state-pill state-done");
  });

  it("nowhere once the session goes on", () => {
    const s = stopped();
    send(s, { hook_event_name: "UserPromptSubmit", prompt: "continue" });
    const a = root(s);
    expect(card(a)).not.toContain("stop-row");
    expect(sessionNoteShown(a)?.kind).not.toBe("stopped");
    expect(agentAriaLabel(a, t)).not.toContain("stopped");
    expect(drawnState(a)).toBe("active");
  });

  it("with advice that fits each kind", () => {
    const tip = (error: string) => stopTooltip(stopFailureOf({ hook_event_name: "StopFailure", error }, 1)!);
    expect(tip("rate_limit")).toContain("once the limit resets or another account is active");
    expect(tip("overloaded")).toContain("API error (overloaded)");
    expect(tip("overloaded")).toContain("to run the turn again");
  });
});
