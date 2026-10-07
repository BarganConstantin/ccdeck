// Enrichment that arrives before its card. A session's model, name, usage,
// context, activity line and job are last-value-wins events, sent when they
// change; a page that joins a busy deck can be handed them before the first
// surviving event that puts the session's card on the board — the ring's own
// order, and the evicted values the server puts in front of the replay. The
// value waits for the card and lands on it the moment it exists, ahead of what
// the creating event says; it never creates a card, never outlives a session
// the board forgets, and cannot grow without bound.
import { describe, expect, it } from "vitest";
import { applyEvent, initialState, pruneDoneSessions, pruneOldAgents, type GraphState } from "../reducer";
import { foldEnrichment, PARKED_ENRICHMENT_MAX } from "../parked-enrichment";
import type { HookEnvelope, HookPayload } from "../types";
// @ts-expect-error — plain .mjs server module, no types
import { foldEnrichment as serverFold } from "../../server/evicted-enrichment.mjs";

let seq = 0;
const env = (payload: HookPayload, receivedAt = 1_000): HookEnvelope => ({ seq: ++seq, receivedAt, payload } as HookEnvelope);
const apply = (state: GraphState, payload: HookPayload, at?: number) => applyEvent(state, env(payload, at));
const start = (sid: string): HookPayload => ({ hook_event_name: "SessionStart", session_id: sid, cwd: "/w/shop-api" });
const toolCall = (sid: string, id = "t1"): HookPayload => ({
  hook_event_name: "PreToolUse", session_id: sid, cwd: "/w/shop-api", tool_name: "Read", tool_use_id: id,
  tool_input: { file_path: "/w/shop-api/a.ts" },
});
const model = (sid: string, m: string | null, extra: Record<string, unknown> = {}): HookPayload =>
  ({ hook_event_name: "ModelObserved", session_id: sid, model: m, ...extra } as HookPayload);
const named = (sid: string, sessionName: string | null, sessionTitle: string | null = null): HookPayload =>
  ({ hook_event_name: "SessionNamed", session_id: sid, sessionName, sessionTitle } as HookPayload);
const usage = (sid: string, input: number, extra: Record<string, unknown> = {}): HookPayload => ({
  hook_event_name: "UsageObserved", session_id: sid,
  usage: { input_tokens: input, output_tokens: input / 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  usageByModel: { "claude-opus-5-5": { input_tokens: input, output_tokens: input / 10 } },
  ...extra,
} as HookPayload);
const context = (sid: string, ctx: Record<string, unknown>): HookPayload =>
  ({ hook_event_name: "ContextObserved", session_id: sid, context: ctx } as HookPayload);
const activity = (sid: string, text: string, at: number): HookPayload =>
  ({ hook_event_name: "ActivityObserved", session_id: sid, activity: { text, source: "said", at } } as HookPayload);
const job = (sid: string, j: unknown): HookPayload => ({ hook_event_name: "JobObserved", session_id: sid, job: j } as HookPayload);

/** What the enrichment left on a session's card. */
const facts = (s: GraphState, sid: string) => {
  const a = s.agents.get(sid)!;
  return {
    model: a.model, sessionName: a.sessionName, sessionTitle: a.sessionTitle, usage: a.usage,
    usageByModel: a.usageByModel, context: a.context, activity: a.activity, job: a.job,
    contextWindow: a.contextWindow, approvalPolicy: a.approvalPolicy,
  };
};

/** The same events, once with the card there first and once with the card
 *  made by the last event: the second must end where the first does. */
function bothWays(events: HookPayload[], sid = "s1") {
  const watched = initialState();
  apply(watched, start(sid));
  for (const p of events) apply(watched, p);
  apply(watched, toolCall(sid));
  const late = initialState();
  for (const p of events) apply(late, p);
  expect(late.agents.has(sid)).toBe(false);
  apply(late, toolCall(sid));
  return { watched: facts(watched, sid), late: facts(late, sid), lateState: late };
}

describe("enrichment that arrives before its card", () => {
  it("puts an idle session's model, name and usage on its card once the card is created", () => {
    const { watched, late, lateState } = bothWays([
      model("s1", "claude-opus-5-5"),
      named("s1", "api-fix", "Fix the login flow"),
      usage("s1", 18_000),
    ]);
    expect(late.model).toBe("claude-opus-5-5");
    expect(late.sessionName).toBe("api-fix");
    expect(late.sessionTitle).toBe("Fix the login flow");
    expect(late.usage.inputTokens).toBe(18_000);
    expect(late).toEqual(watched);
    expect(lateState.parkedEnrichment.size).toBe(0);
  });

  it("lands every kind the way it would have on a card that was already there", () => {
    const { watched, late } = bothWays([
      context("s1", { msgsUser: 3, msgsAssistant: 4, toolUses: 5, toolResults: 5, systemReminders: 1, currentContextTokens: 40_000, memoryFiles: [{ path: "/w/CLAUDE.md", bytes: 10 }] }),
      activity("s1", "Reading the auth module", 5_000),
      job("s1", { id: "j1", state: "working", detail: "running the tests", updatedAt: 6_000 }),
      { hook_event_name: "UsageObserved", session_id: "s1", provider: "codex", model_context_window: 400_000, context_tokens: 12_000, approval_policy: "on-request" } as HookPayload,
    ]);
    expect(late.activity?.text).toBe("Reading the auth module");
    expect(late.job?.state).toBe("working");
    expect(late.context?.currentContextTokens).toBe(12_000);
    expect(late.contextWindow).toBe(400_000);
    expect(late.approvalPolicy).toBe("on-request");
    expect(late).toEqual(watched);
  });

  it("keeps the last word of each kind while it waits, read the way the card reads it", () => {
    const { watched, late } = bothWays([
      model("s1", "gpt-5.6", { model_context_window: 272_000, subagentModels: { a1: "claude-sonnet-5-5" } }),
      model("s1", "gpt-5.6-mini"),
      model("s1", null, { subagentModels: { a2: "claude-haiku-4-5" } }),
      named("s1", null, "Fix the login flow"),
      named("s1", "api-fix", null),
      named("s1", "fix the login flow", null),
      usage("s1", 1_000),
      usage("s1", 2_000, { usageByModel: null }),
      { hook_event_name: "UsageObserved", session_id: "s1", context_tokens: 9_000 } as HookPayload,
      context("s1", { msgsUser: 2, currentContextTokens: 5_000, memoryFiles: [{ path: "/w/AGENTS.md", bytes: 4 }] }),
      context("s1", { memoryFiles: [] }),
      activity("s1", "Newer line", 9_000),
      activity("s1", "Older line read late", 8_000),
      activity("s1", "   ", 10_000),
      job("s1", { id: "j1", state: "blocked", detail: "asks a question", needs: "Approve?", updatedAt: 1 }),
      job("s1", { state: "not-a-state" }),
      job("s1", null),
    ]);
    expect(late.model).toBe("gpt-5.6-mini");
    expect(late.contextWindow).toBe(272_000);
    expect(late.sessionName).toBe("fix the login flow");
    expect(late.sessionTitle).toBeUndefined();
    expect(late.usage.inputTokens).toBe(2_000);
    expect(late.usageByModel).toBeUndefined();
    expect(late.context?.memoryFiles).toEqual([]);
    expect(late.context?.msgsUser).toBe(2);
    expect(late.activity?.text).toBe("Newer line");
    expect(late.job).toBeUndefined();
    expect(late).toEqual(watched);
  });

  it("hands a subagent the model a waiting scan named for it", () => {
    const s = initialState();
    apply(s, model("s1", "claude-opus-5-5", { subagentModels: { ag1: "claude-sonnet-5-5" } }));
    apply(s, start("s1"));
    apply(s, { hook_event_name: "SubagentStart", session_id: "s1", cwd: "/w/shop-api", agent_id: "ag1", agent_type: "test-writer" });
    expect(s.agents.get("s1")!.model).toBe("claude-opus-5-5");
    expect(s.agents.get("s1::ag1")!.model).toBe("claude-sonnet-5-5");
  });

  it("lets what the creating event says win, being newer", () => {
    const s = initialState();
    apply(s, model("s1", "claude-sonnet-5-5"));
    apply(s, { ...toolCall("s1"), model: "claude-opus-5-5" });
    expect(s.agents.get("s1")!.model).toBe("claude-opus-5-5");
  });

  it("parks nothing for a card that is already on the board", () => {
    const s = initialState();
    apply(s, start("s1"));
    apply(s, model("s1", "claude-opus-5-5"));
    apply(s, named("s1", "api-fix"));
    expect(s.agents.get("s1")!.model).toBe("claude-opus-5-5");
    expect(s.parkedEnrichment.size).toBe(0);
  });

  it("still never creates a card", () => {
    const s = initialState();
    for (const p of [model("s1", "m"), named("s1", "n"), usage("s1", 1), context("s1", {}), activity("s1", "a", 1), job("s1", null)]) apply(s, p);
    expect(s.agents.size).toBe(0);
    expect(s.parkedEnrichment.get("s1")?.size).toBe(6);
  });

  it("is bounded: past the cap the session heard from longest ago goes first", () => {
    const s = initialState();
    for (let i = 0; i <= PARKED_ENRICHMENT_MAX; i++) apply(s, model(`old-${i}`, `m-${i}`));
    expect(s.parkedEnrichment.size).toBe(PARKED_ENRICHMENT_MAX);
    apply(s, toolCall("old-0"));
    apply(s, toolCall(`old-${PARKED_ENRICHMENT_MAX}`, "t2"));
    expect(s.agents.get("old-0")!.model).toBeUndefined();
    expect(s.agents.get(`old-${PARKED_ENRICHMENT_MAX}`)!.model).toBe(`m-${PARKED_ENRICHMENT_MAX}`);
  });

  it("refreshes a waiting session's place when it is heard from again, so a busy one is not the one dropped", () => {
    const s = initialState();
    apply(s, model("busy", "m-busy"));
    for (let i = 0; i < PARKED_ENRICHMENT_MAX - 1; i++) apply(s, model(`other-${i}`, "x"));
    apply(s, usage("busy", 5));
    apply(s, model("one-more", "y"));
    apply(s, toolCall("busy"));
    expect(s.agents.get("busy")!.model).toBe("m-busy");
    expect(s.agents.get("busy")!.usage.inputTokens).toBe(5);
  });

  it("goes with a session the board forgets", () => {
    const s = initialState();
    apply(s, start("gone"), 1_000);
    apply(s, { hook_event_name: "SessionEnd", session_id: "gone" }, 2_000);
    // As if something had filed a value for the session while its card was up.
    s.parkedEnrichment.set("gone", new Map([["ModelObserved", model("gone", "m")]]));
    const forgot: string[] = [];
    expect(pruneDoneSessions(s, 2_000 + 10 * 60_000, 0, 1_000, sid => forgot.push(sid))).toBe(true);
    expect(forgot).toEqual(["gone"]);
    expect(s.parkedEnrichment.size).toBe(0);
  });

  it("goes with a session the agent cap forgets whole", () => {
    const s = initialState();
    apply(s, start("gone"), 1_000);
    apply(s, { hook_event_name: "SessionEnd", session_id: "gone" }, 2_000);
    apply(s, start("stays"), 3_000);
    s.parkedEnrichment.set("gone", new Map([["ModelObserved", model("gone", "m")]]));
    expect(pruneOldAgents(s, 2_000 + 10 * 60_000, 1, 1_000)).toBe(true);
    expect(s.agents.has("gone")).toBe(false);
    expect(s.parkedEnrichment.size).toBe(0);
  });

  it("goes with the board when it is cleared", () => {
    const s = initialState();
    apply(s, model("s1", "m"));
    const cleared = applyEvent(s, env({ hook_event_name: "__clear" } as HookPayload));
    expect(cleared.parkedEnrichment.size).toBe(0);
    apply(cleared, toolCall("s1"));
    expect(cleared.agents.get("s1")!.model).toBeUndefined();
  });
});

describe("the page and the server fold a kind the same way", () => {
  // The server folds what the ring evicts into one payload per kind, and the
  // page folds what waits for a card; a page handed the server's fold must end
  // where a page that saw every event does.
  const runs: HookPayload[][] = [
    [model("s1", "gpt-5.6", { model_context_window: 272_000 }), model("s1", "gpt-5.6-mini"), model("s1", undefined as never, { model_context_window: 400_000 })],
    [named("s1", "api-fix", "api-fix"), named("s1", "web-ui", null), named("s1", null, "Fix it")],
    [usage("s1", 1), usage("s1", 2, { usageByModel: undefined }), { hook_event_name: "UsageObserved", session_id: "s1", context_tokens: 7 } as HookPayload],
    [context("s1", { msgsUser: 1, memoryFiles: [{ path: "/a", bytes: 1 }] }), context("s1", { currentContextTokens: 9, msgsUser: null })],
    [activity("s1", "b", 9), activity("s1", "a", 3)],
    [job("s1", { id: "j", state: "done", detail: "ok", result: "fine", updatedAt: 1 }), job("s1", "junk")],
  ];
  for (const run of runs) {
    it(`folds ${run[0].hook_event_name} identically, and the fold lands where the run does`, () => {
      const page = run.reduce<HookPayload | undefined>((acc, p) => foldEnrichment(acc, p), undefined)!;
      const server = run.reduce<HookPayload | undefined>((acc, p) => serverFold(acc, p), undefined);
      expect(JSON.parse(JSON.stringify(server))).toEqual(JSON.parse(JSON.stringify(page)));
      const watched = initialState();
      apply(watched, start("s1"));
      for (const p of run) apply(watched, p);
      const handed = initialState();
      apply(handed, start("s1"));
      apply(handed, JSON.parse(JSON.stringify(server)));
      expect(facts(handed, "s1")).toEqual(facts(watched, "s1"));
    });
  }
});
