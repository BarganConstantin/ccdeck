// When two live agents can step on each other in git — computed fresh from what
// is true right now, so a warning clears by itself the moment it stops being
// true: a session ends, the file is committed, the agents diverge.
//
// QUIET: two live agents of different sessions share a working tree (the same
// git top level), or have the same branch of one repository checked out in two
// worktrees. Sharing a folder is often intentional, so this is a mark, not an
// alarm. A session's own subagents share its folder by design and are not
// paired with it or with each other here.
//
// SHARP: two agents running at the same time — two sessions, or two subagents
// of one session — both edited the same file since it was last committed.
// That is where one agent's work quietly undoes another's. A session and its
// own subagent are not paired: the session handed that work over. "Since it was
// last committed" comes from the caller, as each file's last commit time
// (`lastCommittedAt`) or, failing that, whether git reports the file as changed
// now (`isDirty`); with neither there is no evidence, and nothing is sharp.
//
// Different worktrees on different branches never collide: their files are
// different files, and their branches different branches.
//
// Pure. Paths are compared the way the platform compares them — case-folded on
// Windows and macOS, exact on Linux — and reported as the first agent spelled
// them.
import { posix, win32 } from "node:path";

const WINDOWS_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** One spelling of a path for comparing. */
function pathKey(p, platform) {
  if (typeof p !== "string" || !p) return null;
  const flavour = WINDOWS_ABS.test(p) ? win32 : posix;
  let n = flavour.normalize(p);
  if (n.length > 1 && /[\\/]$/.test(n) && !/^[A-Za-z]:[\\/]$/.test(n)) n = n.slice(0, -1);
  return platform === "win32" || platform === "darwin" ? n.toLowerCase() : n;
}

/**
 * @typedef {object} LiveAgent
 * @property {string} sessionId
 * @property {string | null} [agentId]   null for the session's main thread
 * @property {boolean} [live]            false leaves the agent out
 * @property {{ top: string, commonDir: string } | null} [repo]
 * @property {string | null} [branch]    null on a detached HEAD
 * @property {{ path: string, at: number }[]} [edits]  agent-git-edits.mjs editsFor rows
 */

/**
 * @param {LiveAgent[]} agents
 * @param {{ lastCommittedAt?: ((path: string) => number | null | undefined) | Map<string, number | null>,
 *           isDirty?: ((path: string) => boolean) | Set<string>,
 *           platform?: string }} [opts]
 * @returns {{
 *   quiet: { a: { sessionId: string, agentId: string | null }, b: { sessionId: string, agentId: string | null },
 *            reason: "same-worktree" | "same-branch", top: string | null, commonDir: string, branch: string | null }[],
 *   sharp: { a: { sessionId: string, agentId: string | null }, b: { sessionId: string, agentId: string | null }, files: string[] }[],
 * }}
 */
export function collisionFacts(agents, { lastCommittedAt, isDirty, platform = process.platform } = {}) {
  const quiet = [];
  const sharp = [];
  if (!Array.isArray(agents)) return { quiet, sharp };

  const list = [];
  for (const a of agents) {
    if (!a || typeof a !== "object" || typeof a.sessionId !== "string" || !a.sessionId || a.live === false) continue;
    const repo = a.repo && typeof a.repo.top === "string" && typeof a.repo.commonDir === "string" ? a.repo : null;
    const edits = new Map();
    for (const e of Array.isArray(a.edits) ? a.edits : []) {
      if (!e || typeof e.path !== "string" || typeof e.at !== "number") continue;
      const k = pathKey(e.path, platform);
      const held = edits.get(k);
      if (!held || e.at > held.at) edits.set(k, { path: e.path, at: e.at });
    }
    list.push({
      ref: { sessionId: a.sessionId, agentId: typeof a.agentId === "string" && a.agentId ? a.agentId : null },
      repo,
      top: repo ? pathKey(repo.top, platform) : null,
      common: repo ? pathKey(repo.commonDir, platform) : null,
      branch: typeof a.branch === "string" && a.branch ? a.branch : null,
      edits,
    });
  }

  const committedAt = typeof lastCommittedAt === "function" ? lastCommittedAt
    : lastCommittedAt instanceof Map ? p => lastCommittedAt.get(p) : null;
  const dirty = typeof isDirty === "function" ? isDirty : isDirty instanceof Set ? p => isDirty.has(p) : null;
  const sinceCommit = (path, atA, atB) => {
    if (committedAt) {
      const t = committedAt(path);
      return typeof t !== "number" || !Number.isFinite(t) || (atA > t && atB > t);
    }
    return dirty ? !!dirty(path) : false;
  };

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const sameSession = a.ref.sessionId === b.ref.sessionId;

      if (!sameSession && a.repo && b.repo) {
        if (a.top === b.top) {
          quiet.push({ a: a.ref, b: b.ref, reason: "same-worktree", top: a.repo.top, commonDir: a.repo.commonDir, branch: a.branch === b.branch ? a.branch : null });
        } else if (a.common === b.common && a.branch && a.branch === b.branch) {
          quiet.push({ a: a.ref, b: b.ref, reason: "same-branch", top: null, commonDir: a.repo.commonDir, branch: a.branch });
        }
      }

      if (!committedAt && !dirty) continue;
      // A session and its own subagent: the session handed the work over.
      if (sameSession && (a.ref.agentId === null || b.ref.agentId === null)) continue;
      const files = [];
      for (const [k, ea] of a.edits) {
        const eb = b.edits.get(k);
        if (eb && sinceCommit(ea.path, ea.at, eb.at)) files.push(ea.path);
      }
      if (files.length) sharp.push({ a: a.ref, b: b.ref, files: files.sort() });
    }
  }
  return { quiet, sharp };
}
