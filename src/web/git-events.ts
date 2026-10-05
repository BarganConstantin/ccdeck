// GitObserved: the server's word on which repository and branch an agent's
// folder is in (src/server/git-watch.mjs), written onto the agent it names.
//
// Applied BEFORE anything that treats an event as the session moving. The
// server sends one for every session sharing a worktree when one of them checks
// out a branch, and after its own boot for sessions that ended long ago, so it
// is never evidence that THIS session did anything: it does not clear a
// waiting block, does not stamp the session as heard from (which would bring a
// reaped session back), and never creates a card — a session or a subagent the
// board does not hold is left alone.
import { rootAgentId, subagentIdFor, type GraphState } from "./graph-state";
import type { GitFacts, HookPayload } from "./types";

const STATES = new Set<GitFacts["state"]>(["repo", "not-a-repo", "gone", "no-git", "bare", "unsafe"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** The facts a payload's `git` carries, typed and with nothing else in them,
 *  or null for one that is not a GitObserved this client can read. */
export function gitFactsFrom(raw: unknown): GitFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.state !== "string" || !STATES.has(g.state as GitFacts["state"])) return null;
  const facts: GitFacts = { state: g.state as GitFacts["state"], stale: typeof g.stale === "number" && Number.isFinite(g.stale) ? g.stale : 0 };
  const branch = g.branch === null ? null : str(g.branch);
  const sha = g.sha === null ? null : str(g.sha);
  const fields: Partial<GitFacts> = {
    topLevel: str(g.topLevel), name: str(g.name), mainName: str(g.mainName), folderName: str(g.folderName),
    nameDiffers: bool(g.nameDiffers), linkedWorktree: bool(g.linkedWorktree), branch, detached: bool(g.detached),
    sha, unborn: bool(g.unborn), empty: bool(g.empty), fromLog: bool(g.fromLog),
  };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) (facts as unknown as Record<string, unknown>)[k] = v;
  return facts;
}

export function applyGitObserved(state: GraphState, p: HookPayload, sessionId: string): void {
  const facts = gitFactsFrom(p.git);
  if (!facts) return;
  const key = str(p.git?.subagent);
  const agent = state.agents.get(key ? subagentIdFor(sessionId, key) : rootAgentId(sessionId));
  if (!agent) return;
  agent.git = facts;
}
