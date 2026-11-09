import { describe, expect, it } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
// @ts-expect-error — plain .mjs module, no types
import { summarizeSessions } from "../../server/session-summary.mjs";

const T0 = 2_000_000;
const event = (seq: number, payload: Partial<HookPayload>): HookEnvelope => ({
  seq, receivedAt: T0 + seq * 1000, source: "hook",
  payload: { session_id: "enriched", provider: "codex", ...payload },
} as HookEnvelope);
const summary = (events: HookEnvelope[]) => summarizeSessions(events, { now: T0 + 60_000 });

describe("session summaries wait for a session before showing its enrichment", () => {
  it.each<Partial<HookPayload>>([
    { hook_event_name: "ModelObserved", model: "observed-model" },
    { hook_event_name: "SessionNamed", sessionName: "Fix search" },
    { hook_event_name: "UsageObserved", usage: { input_tokens: 42 } },
    { hook_event_name: "ContextObserved", context: { msgsUser: 1 } },
    { hook_event_name: "ActivityObserved", activity: { text: "Reading", at: T0 } },
    { hook_event_name: "JobObserved", job: null },
    { hook_event_name: "SessionRecapped", recap: { text: "Done", at: T0 } },
    { hook_event_name: "OutputObserved", kind: "text", at: T0 },
  ])("$hook_event_name alone makes no session in either fold", (payload) => {
    const events = [event(1, payload)];
    const board = events.reduce(applyEvent, initialState());
    expect(board.agents.size).toBe(0);
    expect(summary(events)).toEqual([]);
  });

  it("keeps the newest model and name for real traffic without adopting a scan's provider or start time", () => {
    const events = [
      event(1, { hook_event_name: "ModelObserved", provider: "claude", model: "old-model" }),
      event(2, { hook_event_name: "ModelObserved", model: "observed-model" }),
      event(3, { hook_event_name: "SessionNamed", sessionName: "Fix search" }),
      event(4, { hook_event_name: "UserPromptSubmit", prompt: "go", cwd: "/repo/search" }),
    ];
    const root = events.reduce(applyEvent, initialState()).agents.get("enriched")!;
    expect(root.provider).toBe("codex");
    expect(root.model).toBe("observed-model");
    expect(summary(events)).toEqual([expect.objectContaining({
      id: "enriched", provider: root.provider, model: root.model, name: root.sessionName,
      state: "working", startedAt: events[3].receivedAt, since: events[3].receivedAt,
      cwd: "/repo/search", lastEventAt: events[3].receivedAt,
    })]);
  });

  it("adopts pending metadata on active recovery, with snapshot facts taking precedence", () => {
    const events = [
      event(1, { hook_event_name: "ModelObserved", model: "old-model" }),
      event(2, { hook_event_name: "SessionNamed", sessionTitle: "Recovered work" }),
      event(3, { hook_event_name: "CodexSessionRecovered", recovery_active: false }),
    ];
    expect(summary(events)).toEqual([]);
    events.push(event(4, { hook_event_name: "CodexSessionRecovered", recovery_active: true, model: "current-model" }));
    expect(summary(events)).toEqual([expect.objectContaining({
      provider: "codex", state: "working", model: "current-model", name: "Recovered work",
      startedAt: events[3].receivedAt,
    })]);
  });

  it("clears pending values along with sessions and keeps later scans from resurrecting them", () => {
    const events = [
      event(1, { hook_event_name: "ModelObserved", model: "forgotten-model" }),
      event(2, { hook_event_name: "__clear" }),
      event(3, { hook_event_name: "ContextObserved", context: { msgsUser: 1 } }),
    ];
    expect(summary(events)).toEqual([]);
    events.push(event(4, { hook_event_name: "SessionStart" }));
    expect(summary(events)).toEqual([expect.objectContaining({ provider: "codex", model: null, state: "idle" })]);
  });
});
