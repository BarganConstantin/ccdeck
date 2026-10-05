// GitObserved in the reducer: the server's word on an agent's repository and
// branch, written onto the card it names and on no other — and never read as
// the session doing anything, because the server sends it to sessions that
// did nothing (a checkout in a shared folder, a deck restarting).
import { describe, expect, it } from "vitest";
import { applyEvent, initialState, sweepStaleSessions, type GraphState } from "../reducer";
import { gitFactsFrom } from "../git-events";
import type { HookEnvelope, HookPayload } from "../types";

let seq = 0;
const env = (payload: HookPayload, receivedAt = 1_000): HookEnvelope => ({ seq: ++seq, receivedAt, payload } as HookEnvelope);
const apply = (state: GraphState, payload: HookPayload, at?: number) => applyEvent(state, env(payload, at));
const repo = (over: Record<string, unknown> = {}) => ({
  state: "repo", topLevel: "/w/shop-api", name: "shop-api", mainName: "shop-api", folderName: "shop-api",
  nameDiffers: false, linkedWorktree: false, branch: "feature/bargan/VCRM-9090", detached: false, sha: "65fecee",
  unborn: false, empty: false, stale: 0, ...over,
});
const board = () => {
  const s = initialState();
  apply(s, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/w/shop-api" });
  apply(s, { hook_event_name: "SubagentStart", session_id: "s1", cwd: "/w/shop-api-docs", agent_id: "ag1", agent_type: "docs-sync" });
  return s;
};

describe("GitObserved", () => {
  it("puts the repository and branch on the session's card", () => {
    const s = board();
    apply(s, { hook_event_name: "GitObserved", session_id: "s1", git: repo() } as HookPayload);
    expect(s.agents.get("s1")!.git).toEqual(repo());
    expect(s.agents.get("s1::ag1")!.git).toBeUndefined();
  });

  it("puts a subagent's own worktree on the subagent's card, not the root's", () => {
    const s = board();
    apply(s, { hook_event_name: "GitObserved", session_id: "s1", git: { ...repo({ branch: "docs/rate-limits", topLevel: "/w/shop-api-docs", linkedWorktree: true }), subagent: "ag1" } } as HookPayload);
    expect(s.agents.get("s1::ag1")!.git).toMatchObject({ branch: "docs/rate-limits", linkedWorktree: true });
    expect(s.agents.get("s1::ag1")!.git).not.toHaveProperty("subagent");
    expect(s.agents.get("s1")!.git).toBeUndefined();
  });

  it("follows a checkout, a detached HEAD and a folder that stopped being a repository", () => {
    const s = board();
    apply(s, { hook_event_name: "GitObserved", session_id: "s1", git: repo() } as HookPayload);
    apply(s, { hook_event_name: "GitObserved", session_id: "s1", git: repo({ branch: null, detached: true, sha: "4e1b9c0", stale: 2 }) } as HookPayload);
    expect(s.agents.get("s1")!.git).toMatchObject({ branch: null, detached: true, sha: "4e1b9c0", stale: 2 });
    apply(s, { hook_event_name: "GitObserved", session_id: "s1", git: { state: "not-a-repo", stale: 0 } } as HookPayload);
    expect(s.agents.get("s1")!.git).toEqual({ state: "not-a-repo", stale: 0 });
  });

  it("never creates a card for a session or subagent the board does not hold", () => {
    const s = board();
    apply(s, { hook_event_name: "GitObserved", session_id: "elsewhere", git: repo() } as HookPayload);
    apply(s, { hook_event_name: "GitObserved", session_id: "s1", git: { ...repo(), subagent: "nobody" } } as HookPayload);
    expect(s.agents.has("elsewhere")).toBe(false);
    expect(s.agents.has("s1::nobody")).toBe(false);
  });

  it("is not the session moving: it neither clears a waiting block nor brings back a reaped session", () => {
    const s = initialState();
    apply(s, { hook_event_name: "SessionStart", session_id: "w", cwd: "/w/shop-api" }, 1_000);
    apply(s, { hook_event_name: "Notification", session_id: "w", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, 2_000);
    expect(s.agents.get("w")!.waiting).toBeTruthy();
    apply(s, { hook_event_name: "GitObserved", session_id: "w", git: repo() } as HookPayload, 3_000);
    expect(s.agents.get("w")!.waiting).toBeTruthy();
    expect(s.agents.get("w")!.lastEventAt).toBe(2_000);

    // Silent long enough to be reaped; a GitObserved afterwards must not
    // stand it back up the way a real event would.
    expect(sweepStaleSessions(s, 2_000 + 91 * 60_000, 90 * 60_000)).toBe(true);
    expect(s.agents.get("w")!.reaped).toBe(true);
    apply(s, { hook_event_name: "GitObserved", session_id: "w", git: repo({ branch: "other" }) } as HookPayload, 2_000 + 92 * 60_000);
    expect(s.agents.get("w")!.reaped).toBe(true);
    expect(s.agents.get("w")!.git?.branch).toBe("other");
  });

  it("ignores a payload it cannot read rather than writing half of it", () => {
    const s = board();
    for (const git of [undefined, null, "repo", { state: "maybe" }, { branch: "x" }]) {
      apply(s, { hook_event_name: "GitObserved", session_id: "s1", git } as unknown as HookPayload);
    }
    expect(s.agents.get("s1")!.git).toBeUndefined();
    expect(gitFactsFrom({ state: "gone", branch: "feature/x", fromLog: true, stale: "no", extra: 1 })).toEqual({ state: "gone", branch: "feature/x", fromLog: true, stale: 0 });
  });
});
