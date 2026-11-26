// SessionStart with `source: "compact"` (session-lifecycle.ts applySessionStart):
// Claude Code says it once a compaction is over. A session resting after a
// /compact stays at rest, as its terminal shows it, rather than reading as at
// work until the next idle notice; one compacted inside a turn stays at work;
// and a session the board first hears of this way starts as any other does.
import { describe, expect, it } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { HookPayload } from "../types";

const S = "5e5510aa-0000-4000-8000-c0mpact00001";

function rig() {
  const state = initialState();
  let seq = 0;
  const send = (p: Partial<HookPayload> & { hook_event_name: string }, at = ++seq * 1000) =>
    applyEvent(state, { seq: ++seq, receivedAt: at, source: "hook", payload: { provider: "claude", session_id: S, cwd: "/w/paycore", ...p } as HookPayload });
  return { state, send, root: () => state.agents.get(S)! };
}

describe("a compaction's SessionStart", () => {
  it("leaves a session resting after /compact at rest, its turn's ending kept", () => {
    const r = rig();
    r.send({ hook_event_name: "SessionStart", source: "startup" });
    r.send({ hook_event_name: "UserPromptSubmit", prompt: "fix the test" });
    r.send({ hook_event_name: "Stop" }, 10_000);
    const ended = r.root().endedAt;
    r.send({ hook_event_name: "SessionStart", source: "compact" }, 40_000);
    expect(r.root().state).toBe("done");
    expect(r.root().endedAt).toBe(ended);
    expect(r.root().lastTurnEndAt).toBe(10_000);
  });

  it("leaves a session compacted inside a turn at work", () => {
    const r = rig();
    r.send({ hook_event_name: "SessionStart", source: "startup" });
    r.send({ hook_event_name: "UserPromptSubmit", prompt: "fix the test" });
    r.send({ hook_event_name: "SessionStart", source: "compact" });
    expect(r.root().state).toBe("active");
  });

  it("still starts a session again after /clear, and one first heard of by its compaction", () => {
    const r = rig();
    r.send({ hook_event_name: "SessionStart", source: "startup" });
    r.send({ hook_event_name: "UserPromptSubmit", prompt: "fix the test" });
    r.send({ hook_event_name: "Stop" }, 10_000);
    r.send({ hook_event_name: "SessionStart", source: "clear" }, 40_000);
    expect(r.root().state).toBe("active");
    const late = rig();
    late.send({ hook_event_name: "SessionStart", source: "compact" });
    expect(late.root().state).toBe("active");
    expect(late.root().synthetic).toBe(false);
  });
});
