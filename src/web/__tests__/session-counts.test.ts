// The server's own waiting and running counts (session-counts.mjs), on the
// rules session-counts-mirror.test.ts does not reach: the clocks, the replay,
// the reasons a count cannot be told, and the bound.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createSessionCounts, MAX_SESSIONS, RUNNING_CAP_MS, WAITING_EXPIRE_MS } from "../../server/session-counts.mjs";

const T0 = Date.parse("2026-10-18T09:00:00Z");
const ev = (session: string, name: string, extra: Record<string, unknown> = {}) => ({ session_id: session, hook_event_name: name, ...extra });
const ready = (opts = {}) => { const c = createSessionCounts(opts); c.markReady(); return c; };
const counts = (c: any, at: number) => { const r = c.reading(at); return "unknown" in r ? r : { running: r.running, waiting: r.waiting }; };

describe("waiting", () => {
  it("counts a permission prompt and a question, and not an idle prompt", () => {
    const c = ready();
    c.note(ev("a", "UserPromptSubmit"), T0);
    c.note(ev("a", "Notification", { notification_type: "permission_prompt" }), T0 + 1);
    c.note(ev("b", "UserPromptSubmit"), T0);
    c.note(ev("b", "Notification", { notification_type: "agent_needs_input", message: "which?" }), T0 + 1);
    c.note(ev("c", "Stop"), T0);
    c.note(ev("c", "Notification", { notification_type: "idle_prompt" }), T0 + 1);
    expect(counts(c, T0 + 2)).toEqual({ running: 0, waiting: 2 });
  });

  it("is cleared by the session's next event that is not a transcript scan", () => {
    const c = ready();
    c.note(ev("a", "Notification", { notification_type: "permission_prompt" }), T0);
    for (const scan of ["ModelObserved", "ContextObserved", "UsageObserved", "SessionNamed", "SessionRecapped", "OutputObserved", "ActivityObserved", "JobObserved", "Notification"]) {
      c.note(ev("a", scan), T0 + 1);
      expect(counts(c, T0 + 1).waiting, scan).toBe(1);
    }
    c.note(ev("a", "PostToolUse", { tool_use_id: "t" }), T0 + 2);
    expect(counts(c, T0 + 2).waiting).toBe(0);
  });

  it("stops counting a block after two hours with nothing from its session", () => {
    const c = ready();
    c.note(ev("a", "Notification", { notification_type: "permission_prompt" }), T0);
    expect(counts(c, T0 + WAITING_EXPIRE_MS).waiting).toBe(1);
    expect(counts(c, T0 + WAITING_EXPIRE_MS + 1).waiting).toBe(0);
  });

  it("rebuilds from a replayed ring, so a block raised before a restart still counts", () => {
    const ring = [
      { seq: 1, receivedAt: T0, payload: ev("a", "UserPromptSubmit") },
      { seq: 2, receivedAt: T0 + 1, payload: ev("a", "PreToolUse", { tool_use_id: "t" }) },
      { seq: 3, receivedAt: T0 + 2, payload: ev("a", "Notification", { notification_type: "permission_prompt" }) },
      { seq: 4, receivedAt: T0 + 3, payload: null },
    ];
    const c = createSessionCounts();
    c.seed(ring);
    c.markReady();
    expect(counts(c, T0 + 10)).toEqual({ running: 0, waiting: 1 });
  });
});

describe("running", () => {
  it("is a session with a turn open, until its Stop", () => {
    const c = ready();
    c.note(ev("a", "UserPromptSubmit"), T0);
    c.note(ev("a", "PreToolUse", { tool_use_id: "t" }), T0 + 1);
    expect(counts(c, T0 + 2).running).toBe(1);
    c.note(ev("a", "Stop"), T0 + 3);
    expect(counts(c, T0 + 4).running).toBe(0);
  });

  it("is not a session silent for 30 minutes: a CLI that crashed never sends its Stop", () => {
    const c = ready();
    c.note(ev("a", "UserPromptSubmit"), T0);
    expect(counts(c, T0 + RUNNING_CAP_MS).running).toBe(1);
    expect(counts(c, T0 + RUNNING_CAP_MS + 1).running).toBe(0);
  });

  it("forgets everything at a clear", () => {
    const c = ready();
    c.note(ev("a", "UserPromptSubmit"), T0);
    c.note({ hook_event_name: "__clear" }, T0 + 1);
    expect(counts(c, T0 + 2)).toEqual({ running: 0, waiting: 0 });
  });
});

describe("what cannot be told", () => {
  it("is `starting` until the ring has been read", () => {
    const c = createSessionCounts();
    expect(c.reading(T0)).toEqual({ unknown: "starting" });
    c.markReady();
    expect(c.reading(T0)).toEqual({ running: 0, waiting: 0, sampledAt: T0 });
  });

  it("is `no-capture` when neither Claude's hooks nor the Codex watcher feeds the deck", () => {
    const c = createSessionCounts({ capture: () => false });
    c.markReady();
    expect(c.reading(T0)).toEqual({ unknown: "no-capture" });
  });
});

describe("the bound", () => {
  it("keeps the sessions heard from most recently, and no more than MAX_SESSIONS", () => {
    const c = ready();
    for (let i = 0; i < MAX_SESSIONS + 50; i++) c.note(ev(`s${i}`, "UserPromptSubmit"), T0 + i);
    expect(c.size()).toBe(MAX_SESSIONS);
    expect(counts(c, T0 + MAX_SESSIONS + 50).running).toBe(MAX_SESSIONS);
  });

  it("ignores what is not a hook payload", () => {
    const c = ready();
    for (const junk of [null, undefined, 42, "x", [], { hook_event_name: 7 }]) c.note(junk, T0);
    expect(counts(c, T0)).toEqual({ running: 1, waiting: 0 });
    // The one object above is a session called "unknown" heard from once, as
    // the page would draw it; the rest are nothing.
  });
});
