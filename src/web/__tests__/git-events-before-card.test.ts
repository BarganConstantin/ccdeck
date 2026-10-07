// A git event that arrives before its card. GitObserved and GitCollisions are
// last-value-wins state the ring keeps past the hook events it evicts, so a
// page opened on a busy deck can be handed a session's branch or collisions
// before the first event that puts the session's card on the board. The value
// waits for the card and lands on it the moment it exists — and it still never
// creates one, never outlives a session the board forgets, and cannot grow
// without bound.
import { describe, expect, it } from "vitest";
import { applyEvent, initialState, pruneDoneSessions, pruneOldAgents, type GraphState } from "../reducer";
import { PARKED_GIT_MAX } from "../git-events";
import type { HookEnvelope, HookPayload } from "../types";

let seq = 0;
const env = (payload: HookPayload, receivedAt = 1_000): HookEnvelope => ({ seq: ++seq, receivedAt, payload } as HookEnvelope);
const apply = (state: GraphState, payload: HookPayload, at?: number) => applyEvent(state, env(payload, at));
const repo = (branch: string, over: Record<string, unknown> = {}) => ({
  state: "repo", topLevel: "/w/shop-api", name: "shop-api", mainName: "shop-api", folderName: "shop-api",
  nameDiffers: false, linkedWorktree: false, branch, detached: false, sha: "65fecee",
  unborn: false, empty: false, stale: 0, ...over,
});
const observed = (sid: string, git: Record<string, unknown>) => ({ hook_event_name: "GitObserved", session_id: sid, git } as HookPayload);
const collided = (sid: string, collisions: unknown) => ({ hook_event_name: "GitCollisions", session_id: sid, collisions } as HookPayload);
const sharp = {
  quiet: [],
  sharp: [{ agentId: null, with: { sessionId: "s2", agentId: null }, files: ["src/app.ts"] }],
};
const none = { quiet: [], sharp: [] };
const toolCall = (sid: string, id = "t1") => ({ hook_event_name: "PreToolUse", session_id: sid, cwd: "/w/shop-api", tool_name: "Read", tool_use_id: id, tool_input: { file_path: "/w/shop-api/a.ts" } } as HookPayload);

describe("a git event that arrives before its card", () => {
  it("puts the branch on a session's card once the card is created", () => {
    const s = initialState();
    apply(s, observed("s1", repo("feature/bargan/VCRM-9090")));
    expect(s.agents.has("s1")).toBe(false);
    // The first surviving event of a session the page joined late makes its card.
    apply(s, toolCall("s1"));
    expect(s.agents.get("s1")!.git).toEqual(repo("feature/bargan/VCRM-9090"));
    expect(s.parkedGit.size).toBe(0);
  });

  it("puts the collisions on the session's card once the card is created", () => {
    const s = initialState();
    apply(s, collided("s1", sharp));
    apply(s, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/w/web-app" });
    expect(s.agents.get("s1")!.gitCollisions).toEqual(sharp);
    expect(s.parkedGit.size).toBe(0);
  });

  it("puts a subagent's own worktree on the subagent's card when it starts, not on the root's", () => {
    const s = initialState();
    apply(s, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/w/shop-api" });
    apply(s, observed("s1", { ...repo("docs/rate-limits", { linkedWorktree: true }), subagent: "ag1" }));
    expect(s.agents.has("s1::ag1")).toBe(false);
    apply(s, { hook_event_name: "SubagentStart", session_id: "s1", cwd: "/w/shop-api-docs", agent_id: "ag1", agent_type: "docs-sync" });
    expect(s.agents.get("s1::ag1")!.git).toMatchObject({ branch: "docs/rate-limits", linkedWorktree: true });
    expect(s.agents.get("s1::ag1")!.git).not.toHaveProperty("subagent");
    expect(s.agents.get("s1")!.git).toBeUndefined();
  });

  it("takes a subagent's own worktree back when it is in its session's folder again, on its card or while it waits", () => {
    const s = initialState();
    apply(s, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/w/shop-api" });
    apply(s, { hook_event_name: "SubagentStart", session_id: "s1", cwd: "/w/shop-api", agent_id: "ag1", agent_type: "docs-sync" });
    apply(s, observed("s1", repo("main")));
    apply(s, observed("s1", { ...repo("docs/rate-limits", { linkedWorktree: true }), subagent: "ag1" }));
    expect(s.agents.get("s1::ag1")!.git?.branch).toBe("docs/rate-limits");
    apply(s, observed("s1", { subagent: "ag1", state: "repo", sameAsRoot: true, stale: 0 }));
    expect(s.agents.get("s1::ag1")!.git).toBeUndefined();
    expect(s.agents.get("s1")!.git?.branch).toBe("main");
    // Before the card exists: the parked value goes, and nothing is parked for it.
    apply(s, observed("s1", { ...repo("docs/x", { linkedWorktree: true }), subagent: "ag2" }));
    apply(s, observed("s1", { subagent: "ag2", state: "repo", sameAsRoot: true, stale: 0 }));
    expect(s.parkedGit.has("s1::ag2")).toBe(false);
    apply(s, { hook_event_name: "SubagentStart", session_id: "s1", cwd: "/w/shop-api", agent_id: "ag2", agent_type: "porter" });
    expect(s.agents.get("s1::ag2")!.git).toBeUndefined();
  });

  it("keeps only the last word while it waits: a newer value replaces it, an empty collision list takes it away", () => {
    const s = initialState();
    apply(s, observed("s1", repo("main")));
    apply(s, observed("s1", repo("feature/auth-login")));
    apply(s, collided("s1", sharp));
    apply(s, collided("s1", none));
    apply(s, toolCall("s1"));
    expect(s.agents.get("s1")!.git?.branch).toBe("feature/auth-login");
    expect(s.agents.get("s1")!.gitCollisions).toBeUndefined();
    expect(s.parkedGit.size).toBe(0);
  });

  it("parks nothing for a card that is already on the board", () => {
    const s = initialState();
    apply(s, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/w/shop-api" });
    apply(s, observed("s1", repo("main")));
    apply(s, collided("s1", sharp));
    expect(s.agents.get("s1")!.git?.branch).toBe("main");
    expect(s.parkedGit.size).toBe(0);
  });

  it("still never creates a card, and ignores what it cannot read", () => {
    const s = initialState();
    apply(s, observed("s1", { state: "maybe" }));
    apply(s, collided("s1", "nope"));
    expect(s.agents.size).toBe(0);
    expect(s.parkedGit.size).toBe(0);
  });

  it("is bounded: past the cap the oldest waiting value goes first", () => {
    const s = initialState();
    for (let i = 0; i <= PARKED_GIT_MAX; i++) apply(s, observed(`old-${i}`, repo(`b-${i}`)));
    expect(s.parkedGit.size).toBe(PARKED_GIT_MAX);
    apply(s, toolCall("old-0"));
    apply(s, toolCall(`old-${PARKED_GIT_MAX}`, "t2"));
    expect(s.agents.get("old-0")!.git).toBeUndefined();
    expect(s.agents.get(`old-${PARKED_GIT_MAX}`)!.git?.branch).toBe(`b-${PARKED_GIT_MAX}`);
  });

  it("refreshes a waiting value's place when it is restated, so a busy session is not the one evicted", () => {
    const s = initialState();
    apply(s, observed("busy", repo("main")));
    for (let i = 0; i < PARKED_GIT_MAX - 1; i++) apply(s, observed(`other-${i}`, repo("x")));
    apply(s, collided("busy", sharp));
    apply(s, observed("one-more", repo("y")));
    apply(s, toolCall("busy"));
    expect(s.agents.get("busy")!.git?.branch).toBe("main");
    expect(s.agents.get("busy")!.gitCollisions).toEqual(sharp);
  });

  it("goes with a session the board forgets", () => {
    const s = initialState();
    apply(s, { hook_event_name: "SessionStart", session_id: "gone", cwd: "/w/shop-api" }, 1_000);
    // A subagent's worktree, waiting for a Start that never came.
    apply(s, observed("gone", { ...repo("docs/x"), subagent: "ag1" }), 1_100);
    apply(s, { hook_event_name: "SessionEnd", session_id: "gone" }, 2_000);
    const forgot: string[] = [];
    expect(pruneDoneSessions(s, 2_000 + 10 * 60_000, 0, 1_000, sid => forgot.push(sid))).toBe(true);
    expect(forgot).toEqual(["gone"]);
    expect(s.parkedGit.size).toBe(0);
  });

  it("goes with a session the agent cap forgets whole", () => {
    const s = initialState();
    apply(s, { hook_event_name: "SessionStart", session_id: "gone", cwd: "/w/shop-api" }, 1_000);
    apply(s, observed("gone", { ...repo("docs/x"), subagent: "ag1" }), 1_100);
    apply(s, { hook_event_name: "SessionEnd", session_id: "gone" }, 2_000);
    apply(s, { hook_event_name: "SessionStart", session_id: "stays", cwd: "/w/shop-api" }, 3_000);
    expect(pruneOldAgents(s, 2_000 + 10 * 60_000, 1, 1_000)).toBe(true);
    expect(s.agents.has("gone")).toBe(false);
    expect(s.parkedGit.size).toBe(0);
  });

  it("goes with the board when it is cleared", () => {
    const s = initialState();
    apply(s, observed("s1", repo("main")));
    const cleared = applyEvent(s, env({ hook_event_name: "__clear" } as HookPayload));
    expect(cleared.parkedGit.size).toBe(0);
    apply(cleared, toolCall("s1"));
    expect(cleared.agents.get("s1")!.git).toBeUndefined();
  });
});
