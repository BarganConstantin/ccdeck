// GitCollisions in the reducer: the server's word on who a session collides
// with in git, kept on the session's root card — and, like GitObserved, never
// read as the session doing anything: the server sends it to a session when
// ANOTHER session starts editing its file.
import { describe, expect, it } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { gitCollisionsFrom } from "../git-events";
import type { HookEnvelope, HookPayload } from "../types";

let seq = 0;
const env = (payload: HookPayload, receivedAt = 1_000): HookEnvelope => ({ seq: ++seq, receivedAt, payload } as HookEnvelope);
const apply = (state: GraphState, payload: HookPayload, at?: number) => applyEvent(state, env(payload, at));
const collisions = {
  quiet: [{ agentId: null, with: { sessionId: "s2", agentId: null }, reason: "same-worktree", branch: "main" }],
  sharp: [
    { agentId: null, with: { sessionId: "s2", agentId: null }, files: ["src/app.ts"] },
    { agentId: "ag1", with: { sessionId: "s3", agentId: "ag9" }, files: ["src/a.ts", "src/b.ts"] },
  ],
};
const board = () => {
  const s = initialState();
  apply(s, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/w/web-app" });
  apply(s, { hook_event_name: "SubagentStart", session_id: "s1", cwd: "/w/web-app", agent_id: "ag1", agent_type: "test-writer" });
  return s;
};

describe("GitCollisions", () => {
  it("keeps the session's collisions on its root card, and an empty one takes them away", () => {
    const s = board();
    apply(s, { hook_event_name: "GitCollisions", session_id: "s1", collisions } as HookPayload);
    expect(s.agents.get("s1")!.gitCollisions).toEqual(collisions);
    expect(s.agents.get("s1::ag1")!.gitCollisions).toBeUndefined();
    apply(s, { hook_event_name: "GitCollisions", session_id: "s1", collisions: { quiet: [], sharp: [] } } as HookPayload);
    expect(s.agents.get("s1")!.gitCollisions).toBeUndefined();
  });

  it("never creates a card, and ignores what it cannot read", () => {
    const s = board();
    apply(s, { hook_event_name: "GitCollisions", session_id: "elsewhere", collisions } as HookPayload);
    expect(s.agents.has("elsewhere")).toBe(false);
    apply(s, { hook_event_name: "GitCollisions", session_id: "s1", collisions } as HookPayload);
    apply(s, { hook_event_name: "GitCollisions", session_id: "s1", collisions: "nope" } as unknown as HookPayload);
    expect(s.agents.get("s1")!.gitCollisions).toEqual(collisions);
  });

  it("is not the session moving: it neither clears a waiting block nor stamps the session as heard", () => {
    const s = initialState();
    apply(s, { hook_event_name: "SessionStart", session_id: "w", cwd: "/w/web-app" }, 1_000);
    apply(s, { hook_event_name: "Notification", session_id: "w", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, 2_000);
    apply(s, { hook_event_name: "GitCollisions", session_id: "w", collisions } as HookPayload, 3_000);
    expect(s.agents.get("w")!.waiting).toBeTruthy();
    expect(s.agents.get("w")!.lastEventAt).toBe(2_000);
  });
});

describe("gitCollisionsFrom", () => {
  it("keeps only well-formed entries", () => {
    expect(gitCollisionsFrom({
      quiet: [
        { agentId: null, with: { sessionId: "s2", agentId: null }, reason: "same-branch", branch: "develop" },
        { agentId: null, with: { sessionId: "" }, reason: "same-worktree" },
        { agentId: null, with: { sessionId: "s2" }, reason: "next-door" },
      ],
      sharp: [
        { agentId: "ag1", with: { sessionId: "s2", agentId: "x" }, files: ["a.ts", 7, ""] },
        { agentId: "ag1", with: { sessionId: "s2" }, files: [] },
      ],
      extra: true,
    })).toEqual({
      quiet: [{ agentId: null, with: { sessionId: "s2", agentId: null }, reason: "same-branch", branch: "develop" }],
      sharp: [{ agentId: "ag1", with: { sessionId: "s2", agentId: "x" }, files: ["a.ts"] }],
    });
    expect(gitCollisionsFrom(null)).toBeNull();
    expect(gitCollisionsFrom({ quiet: [] })).toBeNull();
  });
});
