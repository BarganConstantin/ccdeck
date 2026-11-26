// A coordinator whose subagents report back: Claude Code hands each report to
// the session that started the subagent as a turn of its own, wrapped in
// <agent-message from="…">, through the hook a person's typing arrives on. The
// deck took it for a prompt, and the coordinator's card was titled
// `<agent-message from="…`. It is a system event, as a background task's
// notice is (#834): left out of the prompts, the first words and the task.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState } from "../reducer";
import { injectedPrompt, typedPrompts } from "../injected-prompt";
import { faceTask, sessionTask } from "../rail-row-copy";
import type { GraphState, HookEnvelope, HookPayload } from "../types";

const REPORT = ['<agent-message from="Smell lens B13">', "Found 3 smells in src/web/canvas-flow.ts.", "</agent-message>"].join("\n");

let seq = 0;
const send = (state: GraphState, sid: string, payload: Partial<HookPayload>, at: number) =>
  applyEvent(state, {
    seq: ++seq,
    receivedAt: at,
    payload: { session_id: sid, ...payload } as HookPayload,
  } as HookEnvelope);

describe("recognising another agent's message", () => {
  it("names the agent a report came back from", () => {
    expect(injectedPrompt(REPORT)).toEqual({ label: "message from Smell lens B13" });
  });

  it("recognises it after the line Claude Code puts before another session's message", () => {
    const text = `Another Claude session sent a message while you were working:\n${REPORT}`;
    expect(injectedPrompt(text)?.label).toBe("message from Smell lens B13");
  });

  it("recognises a teammate's message and keeps its summary", () => {
    const text = '<teammate-message teammate_id="researcher" color="blue" summary="Found the cause">\nThe cache is stale.\n</teammate-message>';
    expect(injectedPrompt(text)).toEqual({ label: "message from researcher", detail: "Found the cause" });
  });

  it("recognises another session's message, by its sender when it names one", () => {
    expect(injectedPrompt('<cross-session-message from="api-worker">\nDone.\n</cross-session-message>')?.label).toBe("message from api-worker");
    expect(injectedPrompt("<cross-session-message>\nDone.\n</cross-session-message>")?.label).toBe("message from another session");
    expect(injectedPrompt("<agent-message>\nDone.\n</agent-message>")?.label).toBe("message from another agent");
  });

  it("reads the sender's name back from the tag's escapes", () => {
    expect(injectedPrompt('<agent-message from="Lens &quot;A&quot; &amp; B">\nok\n</agent-message>')?.label).toBe('message from Lens "A" & B');
  });

  it("leaves a human's words alone, even words that mention the tag", () => {
    expect(injectedPrompt('why does <agent-message from="x"> show on my card?')).toBeNull();
    expect(injectedPrompt('look: <agent-message from="x">\nhi\n</agent-message>')).toBeNull();
    expect(injectedPrompt("<agent-messages are noisy>")).toBeNull();
  });

  it("keeps only the typed prompts", () => {
    const list = [{ text: "review issue 142 with five lenses" }, { text: REPORT }];
    expect(typedPrompts(list).map(p => p.text)).toEqual(["review issue 142 with five lenses"]);
  });
});

describe("a coordinator's card once its subagents report back", () => {
  it("says what the person asked, not the report's markup", () => {
    seq = 0;
    let s = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/srv/five-coordinator" }, 1_000);
    s = send(s, "s1", { hook_event_name: "UserPromptSubmit", prompt: "review issue 142 with five lenses" }, 2_000);
    s = send(s, "s1", { hook_event_name: "UserPromptSubmit", prompt: REPORT }, 3_000);
    const root = s.agents.get("s1")!;
    expect(root.prompts.map(p => p.text)).toEqual(["review issue 142 with five lenses", REPORT]);
    expect(sessionTask(root)).toBe("review issue 142 with five lenses");
    expect(faceTask(root)).toBe("review issue 142 with five lenses");
  });

  it("never takes a report for the session's first words", () => {
    seq = 0;
    let s = send(initialState(), "s2", { hook_event_name: "SessionStart", cwd: "/srv/peer" }, 1_000);
    s = send(s, "s2", { hook_event_name: "UserPromptSubmit", prompt: REPORT }, 2_000);
    expect(s.agents.get("s2")!.firstPrompt).toBeUndefined();
    expect(faceTask(s.agents.get("s2")!)).not.toContain("<agent-message");
    s = send(s, "s2", { hook_event_name: "UserPromptSubmit", prompt: "now fix them" }, 3_000);
    expect(s.agents.get("s2")!.firstPrompt).toBe("now fix them");
  });
});
