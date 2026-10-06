// From a commit candidate to a line in the commit store: which repository it
// belongs to, whether the repo confirms it, and what the session had spent and
// how long it had worked when it was made.
//
// TWO HOOKS ARE INJECTED, because both need git and this module runs none:
//
//   resolveRepo(cwd) -> { top, commonDir } | null
//     the repository a folder is in: its worktree top level and its common
//     git directory (shared by every worktree of the repository). Without it a
//     candidate is not recorded — a line with no repository is a line no view
//     could ever place.
//
//   confirm({ ...candidate, cwd, repo }) -> { sha, authorTime } | null | false
//     the commit as the repo knows it: the full SHA and the author time in
//     ms. `null` means "could not tell" (git missing, a timeout) and the line
//     is kept with the short SHA git printed; `false` means the repo has no
//     such commit, and the candidate is dropped for that folder. Absent, every
//     line keeps its short SHA.
//
// Both may return a value or a promise, and a hook that throws counts as
// "could not tell".
import { realpath as realpathAsync } from "node:fs/promises";

const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The store line for one candidate.
 *
 * `durationFrom` names where the duration was measured from, so a view can say
 * so: "commit" (the session's previous commit), "session-start" (its newest
 * SessionStart), "first-seen" (the first event this deck saw — it joined the
 * session late, so the true start is unknown), or null when none is known.
 *
 * `cost` is the session's cumulative spend at the time (main thread and every
 * subagent): raw tokens and models, never priced here and never shown yet.
 *
 * `source` is "replay" for a commit found in the replayed events log rather
 * than seen as it was made; a live line carries none.
 *
 * @param {import("./agent-git-detect.mjs").CommitCandidate} c
 * @param {{ repo: string, top?: string | null, cwd: string, confirmed?: { sha: string, authorTime?: number | null } | null }} where
 * @param {import("./agent-git-facts.mjs").SessionSnapshot} [facts]
 * @param {{ at: number } | null} [previous] the session's newest stored commit
 * @param {{ source?: "replay" | null }} [opts]
 */
export function buildCommitRecord(c, where, facts = /** @type {any} */ ({}), previous = null, { source = null } = {}) {
  const sub = typeof c.agentId === "string" && c.agentId !== "";
  const confirmed = where.confirmed && typeof where.confirmed.sha === "string" && FULL_SHA.test(where.confirmed.sha) ? where.confirmed : null;
  let durationMs = null;
  let durationFrom = null;
  const since = (t, from) => {
    if (durationFrom === null && typeof t === "number" && Number.isFinite(t) && t <= c.at) { durationMs = c.at - t; durationFrom = from; }
  };
  if (previous) since(previous.at, "commit");
  since(facts?.startedAt, "session-start");
  since(facts?.firstSeenAt, "first-seen");
  const u = facts?.usage;
  return {
    v: 1,
    repo: where.repo,
    top: where.top ?? null,
    sha: confirmed ? confirmed.sha : c.shortSha,
    shaFull: !!confirmed,
    subject: c.subject ?? "",
    authorTime: confirmed && typeof confirmed.authorTime === "number" && Number.isFinite(confirmed.authorTime) ? confirmed.authorTime : null,
    branch: c.branch ?? null,
    detached: !!c.detached,
    sessionId: c.sessionId,
    agentId: sub ? c.agentId : null,
    label: sub ? facts?.agentType ?? null : facts?.sessionName || facts?.sessionTitle || null,
    agentType: sub ? facts?.agentType ?? null : null,
    model: c.model ?? facts?.model ?? null,
    kind: c.kind === "codex" ? "codex" : "claude",
    at: c.at,
    cwd: where.cwd,
    cost: u ? { usage: u.usage, usageByModel: u.usageByModel ?? null, model: u.model ?? null, at: u.at } : null,
    durationMs,
    durationFrom,
    confidence: "seen",
    amend: !!c.amend,
    subcommand: c.subcommand ?? "commit",
    ...(source === "replay" ? { source: "replay" } : {}),
  };
}

async function ask(fn, ...args) {
  try { return await fn(...args); } catch { return null; }
}

/**
 * Records candidates into a commit store, one at a time and in arrival order,
 * so two commits from one call measure their durations against each other.
 *
 * @param {{ store: ReturnType<typeof import("./agent-git-store.mjs").createCommitStore>,
 *           resolveRepo?: ((cwd: string) => any) | null,
 *           confirm?: ((c: object) => any) | null,
 *           realpath?: (p: string) => Promise<string> }} deps
 */
export function createCommitRecorder({ store, resolveRepo = null, confirm = null, realpath = realpathAsync }) {
  let hooks = { resolveRepo, confirm };
  let chain = Promise.resolve();

  /** The repository identity: the realpath of the common git directory, so two
   *  spellings of one repository (a symlinked folder, /tmp against
   *  /private/tmp) are one key. */
  async function repoKey(commonDir) {
    try { return await realpath(commonDir); } catch { return commonDir; }
  }

  async function recordOne(c, facts, replay, memoryOnly) {
    const { resolveRepo: resolve, confirm: check } = hooks;
    if (!resolve || !c || !Array.isArray(c.cwds) || !c.cwds.length) return null;
    // A commit found in the replayed log is kept only on the repo's word: the
    // folder it names may be another repository by now.
    if (replay && !check) return null;
    let chosen = null;
    for (const cwd of c.cwds) {
      const repo = await ask(resolve, cwd);
      if (!repo || typeof repo.commonDir !== "string" || !repo.commonDir) continue;
      const confirmed = check ? await ask(check, { ...c, cwd, repo }) : null;
      if (confirmed === false) continue;
      if (confirmed && typeof confirmed.sha === "string") { chosen = { cwd, repo, confirmed }; break; }
      // Unconfirmed: kept only when the folder was certain. A candidate that
      // could have come from several folders is placed by confirmation alone.
      if (!replay && !chosen && c.cwd === cwd) chosen = { cwd, repo, confirmed: null };
    }
    if (!chosen) return null;
    const repo = await repoKey(chosen.repo.commonDir);
    // Live commits arrive in order; a replayed one is timed from the session's
    // newest stored commit before it, not from one recorded after it.
    const previous = await store.lastForSession(c.sessionId, replay ? c.at : Infinity);
    const record = buildCommitRecord(c, { repo, top: chosen.repo.top ?? null, cwd: chosen.cwd, confirmed: chosen.confirmed }, facts, previous, { source: replay ? "replay" : null });
    const { added } = await store.append(record, { memoryOnly });
    return added ? record : null;
  }

  return {
    /** Record one candidate; answers the stored line, or null. Never rejects.
     *  `replay`: found in the replayed events log — recorded only when the
     *  repo confirms it, and marked `source: "replay"`. `memoryOnly`: held by
     *  the store in memory and never written (a deck with no events log). */
    record(candidate, facts, { replay = false, memoryOnly = false } = {}) {
      const next = chain.then(() => recordOne(candidate, facts, replay, memoryOnly)).catch(() => null);
      chain = next.then(() => {});
      return next;
    },
    /** Whether the store already holds this candidate's commit for the
     *  repository one of its folders is in. Never rejects. */
    async held(c) {
      const { resolveRepo: resolve } = hooks;
      if (!resolve || !c || !Array.isArray(c.cwds) || typeof c.shortSha !== "string") return false;
      try {
        for (const cwd of c.cwds) {
          const repo = await ask(resolve, cwd);
          if (!repo || typeof repo.commonDir !== "string" || !repo.commonDir) continue;
          if (await store.holds(await repoKey(repo.commonDir), c.shortSha)) return true;
        }
      } catch { /* could not tell: not held */ }
      return false;
    },
    /** Swap the git hooks in — the integration connects the real ones. */
    connect({ resolveRepo: r = hooks.resolveRepo, confirm: k = hooks.confirm } = {}) {
      hooks = { resolveRepo: r, confirm: k };
    },
    /** Whether there is anything to record into yet. */
    get connected() { return !!hooks.resolveRepo; },
    /** Resolves once every candidate handed in so far is settled. */
    settled() { return chain; },
  };
}
