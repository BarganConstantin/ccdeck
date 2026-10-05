// Which agent made each commit in a session's history, for the git view's log.
//
// Three levels, never blended, and each named on the commit it marks:
//
//   "seen"     the deck watched an agent make this commit (the commit store,
//              agent-git-store.mjs, holds its SHA);
//   "matched"  the deck watched an agent make a commit that an amend, a rebase
//              or a squash has since replaced with this one — same subject,
//              same author time (agent-git-rewrite.mjs);
//   "trailer"  the deck never saw it made, but the message's trailers name
//              Claude or Codex (agent-git-trailers.mjs).
//
// A commit the store accounts for is never marked from its trailers, whatever
// they say. A commit with neither is `agent: null` — no agent seen, which is
// not the same as "made by a person", and the view says so.
//
// The history is the last LOG_LIMIT commits (git-reads.mjs) — plus the
// session's own agent commits that are older than that window, so the commits
// the view opens on are always there. Those are read on their own and come
// after the window, each with `outsideWindow: true`; their parents may not be
// in the list at all.
//
// What the store keeps beyond this — the token snapshot and the folder it was
// made in — stays on the server: nothing here answers with a cost.
import { realpath } from "node:fs/promises";
import { agentCommitsFor } from "./agent-git-tap.mjs";
import { attributeCommits } from "./agent-git-rewrite.mjs";
import { trailerAttribution } from "./agent-git-trailers.mjs";
import { readCommitsBySha } from "./git-reads.mjs";

/** The most of a session's older commits read past the window, newest kept. */
export const OUTSIDE_WINDOW_MAX = 200;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" && v !== "" ? v : null);

/**
 * The `agent` a log commit carries:
 *   { sessionId, agentId, label, agentType, kind, model, durationMs, confidence: "seen" | "matched" }
 *   { agent: "claude" | "codex", confidence: "trailer" }
 *   null
 *
 * @param {{ record: any, confidence: "seen" | "matched" } | undefined} hit the store's claim on it
 * @param {unknown} trailers the commit's trailers, as git-reads.mjs parses them
 */
export function agentMark(hit, trailers) {
  if (hit && hit.record) {
    const r = hit.record;
    return {
      sessionId: r.sessionId,
      agentId: str(r.agentId),
      label: str(r.label),
      agentType: str(r.agentType),
      kind: r.kind === "codex" ? "codex" : "claude",
      model: str(r.model),
      durationMs: num(r.durationMs),
      confidence: hit.confidence,
    };
  }
  const t = trailerAttribution(Array.isArray(trailers) ? trailers : []);
  return t ? { agent: t.agent, confidence: "trailer" } : null;
}

/** A log commit as agent-git-rewrite.mjs compares it: the author time from
 *  git's strict ISO date, and no branch (the log does not say one). */
const asHistory = (c) => ({ sha: c.sha, subject: c.subject, authorTime: Date.parse(c.date), branch: null });

/**
 * The log's commits, each with its `agent`, followed by the session's own
 * agent commits that are older than the window (`outsideWindow: true`).
 *
 * @param {{ topLevel: string, commonDir: string, head?: { sha?: string | null } | null }} repo
 *   a resolved repository (git-repo.mjs)
 * @param {any[]} commits readLog's commits for it
 * @param {{ sessionId?: string | null, agentId?: string | null }} [whose] the
 *   session the view is open on, narrowed to one subagent by `agentId`
 */
export async function attributeHistory(repo, commits, { sessionId = null, agentId = null } = {}) {
  const listed = Array.isArray(commits) ? commits : [];
  let records = [];
  try {
    // The store keys a repository by the real path of its common directory.
    const key = await realpath(repo.commonDir).catch(() => repo.commonDir);
    records = await agentCommitsFor(key);
  } catch { /* no store to read: every commit is marked from its trailers */ }

  const hits = attributeCommits(records, listed.map(asHistory));
  const claimed = new Set([...hits.values()].map((h) => h.record));
  const inWindow = new Set(listed.map((c) => c.sha));
  const own = sessionId
    ? records.filter((r) => r.sessionId === sessionId && (!agentId || r.agentId === agentId) && !claimed.has(r))
    : [];

  let older = [];
  let olderHits = new Map();
  if (own.length) {
    // The store answers oldest first; the newest are the ones worth showing.
    const read = await readCommitsBySha(repo.topLevel, own.slice(-OUTSIDE_WINDOW_MAX).map((r) => r.sha), repo.head);
    if (read.ok) {
      const candidates = read.commits.filter((c) => !inWindow.has(c.sha));
      olderHits = attributeCommits(own, candidates.map(asHistory));
      older = candidates.filter((c) => olderHits.has(c.sha));
    }
  }

  return [
    ...listed.map((c) => ({ ...c, agent: agentMark(hits.get(c.sha), c.trailers) })),
    ...older.map((c) => ({ ...c, agent: agentMark(olderHits.get(c.sha), c.trailers), outsideWindow: true })),
  ];
}
