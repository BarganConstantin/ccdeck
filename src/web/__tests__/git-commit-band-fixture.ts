// What the lane's tests share: api-fix on a board, with a subagent in its
// folder and one in a worktree of its own, and the commits a lane is made of.
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload, RecentCommit } from "../types";

export const API = "e3200d5a-11bf-41d8-9bc9-36c533ef1f4e";
export const OTHER = "498737ff-0f4c-4a2b-9e47-1d6b6f0a9b31";
export const NOW = Date.now();
export const MIN = 60_000;
export const sha = (n: number) => n.toString(16).padStart(40, "a");
export const commit = (n: number, ago: number, over: Partial<RecentCommit> = {}): RecentCommit => ({
  sha: sha(n), short: sha(n).slice(0, 7), subject: `feat(auth): change ${n}`, at: NOW - ago, agentId: null, label: null, branch: "feature/auth-login",
  repo: "/w/shop-api/.git", ...over,
});

let seq = 0;
export const send = (s: GraphState, payload: HookPayload, at = NOW) =>
  applyEvent(s, { seq: ++seq, receivedAt: at, source: "hook", payload } as HookEnvelope);
export const lane = (sid: string, commits: RecentCommit[], repo: string | null = "/w/shop-api/.git") =>
  ({ hook_event_name: "GitRecentCommits", session_id: sid, repo, commits } as unknown as HookPayload);

/** api-fix on a board: its main card, a subagent in its folder and one in a
 *  worktree of its own, with the commits given. */
export function board(commits: RecentCommit[] = []): GraphState {
  let s = initialState();
  s = send(s, { hook_event_name: "SessionStart", session_id: API, cwd: "/w/shop-api-auth" });
  s = send(s, { hook_event_name: "SubagentStart", session_id: API, cwd: "/w/shop-api-auth", agent_id: "tw1", agent_type: "test-writer" });
  s = send(s, { hook_event_name: "SubagentStart", session_id: API, cwd: "/w/shop-api-docs", agent_id: "dw1", agent_type: "docs-writer" });
  s = send(s, { hook_event_name: "GitObserved", session_id: API, git: { state: "repo", topLevel: "/w/shop-api-auth", branch: "feature/auth-login", stale: 0 } } as HookPayload);
  s = send(s, { hook_event_name: "GitObserved", session_id: API, git: { subagent: "dw1", state: "repo", topLevel: "/w/shop-api-docs", branch: "docs/auth", stale: 0 } } as HookPayload);
  s.agents.get(API)!.sessionName = "api-fix";
  if (commits.length) s = send(s, lane(API, commits));
  return s;
}
