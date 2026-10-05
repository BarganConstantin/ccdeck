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
import type { GitCollisionRef, GitCollisions, GitFacts, HookPayload } from "./types";

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

const refFrom = (v: unknown): GitCollisionRef | null => {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const sessionId = str(r.sessionId);
  if (!sessionId) return null;
  return { sessionId, agentId: str(r.agentId) ?? null };
};
const REASONS = new Set(["same-worktree", "same-branch"]);

/** A GitCollisions payload's `collisions`, typed and with nothing else in it,
 *  or null for one this client cannot read. */
export function gitCollisionsFrom(raw: unknown): GitCollisions | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.quiet) || !Array.isArray(c.sharp)) return null;
  const out: GitCollisions = { quiet: [], sharp: [] };
  for (const q of c.quiet as Array<Record<string, unknown>>) {
    const other = refFrom(q?.with);
    if (!other || typeof q.reason !== "string" || !REASONS.has(q.reason)) continue;
    out.quiet.push({ agentId: str(q.agentId) ?? null, with: other, reason: q.reason as GitCollisions["quiet"][number]["reason"], branch: str(q.branch) ?? null });
  }
  for (const x of c.sharp as Array<Record<string, unknown>>) {
    const other = refFrom(x?.with);
    const files = Array.isArray(x?.files) ? (x.files as unknown[]).filter((f): f is string => typeof f === "string" && f !== "") : [];
    if (!other || !files.length) continue;
    out.sharp.push({ agentId: str(x.agentId) ?? null, with: other, files });
  }
  return out;
}

/**
 * GitCollisions: the agents a session can step on in git right now
 * (src/server/git-collisions.mjs), kept on the session's root card. Like
 * GitObserved it is the server's word and not the session's traffic: it
 * reaches sessions that did nothing (another session started editing the same
 * file), so it never clears a waiting block, never marks a session as heard
 * from, and never creates a card. Last value wins; an empty one takes the
 * marks away.
 */
export function applyGitCollisions(state: GraphState, p: HookPayload, sessionId: string): void {
  const collisions = gitCollisionsFrom(p.collisions);
  if (!collisions) return;
  const root = state.agents.get(rootAgentId(sessionId));
  if (!root) return;
  if (collisions.quiet.length || collisions.sharp.length) root.gitCollisions = collisions;
  else delete root.gitCollisions;
}
