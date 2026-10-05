// The git view's reads for a resolved repository, cached per worktree and
// marked stale by what the agents do.
//
// NO POLLING. A repository changes when somebody changes it, and the deck
// hears most of those somebodies: every Edit, Write, MultiEdit, NotebookEdit
// and Bash call an agent finishes, and every Codex patch or command. Each one
// whose folder is inside a worktree marks that worktree stale — and every
// worktree sharing its repository, since a commit or a branch made in one is
// history in all of them (git-watch.mjs decides which events count). The next
// read recomputes; until then the last answer stands. A change made in the
// user's own terminal is caught by the short age limit below, the next time
// somebody asks, rather than by a timer.
//
// The stale counter on each worktree is what the page compares to know an open
// view is out of date: it goes up by one per mark, and rides on the repository
// every read answers with and on the GitObserved event.
//
// A read that started before a mark is not trusted after it: each cached
// answer records the mark count (`epoch`) it began at, and a worktree marked
// since then is stale for it, whichever finished first.
import { codexCwdInWorkspace } from "./log-election.mjs";
import { filterNames, readUpstream, resolveRepo } from "./git-repo.mjs";
import { readCommit, readCommitFileDiff, readFileDiff, readLog, readStatus } from "./git-reads.mjs";

/** How long an answer is trusted with no mark at all — the bound on how late a
 *  change made outside any agent is noticed by a read. */
export const MAX_AGE_MS = 15_000;
const MAX_FOLDERS = 512;
const MAX_WORKTREES = 256;

let epoch = 0;
let now = () => Date.now();
const folders = new Map();   // folder -> { at, start, result } | { pending }
const worktrees = new Map(); // topLevel -> { commonDir, marked, stale, status, log, filters }

/** Whether `path` is `root` or inside it, by the platform's own rules. */
const inside = (path, root) => typeof root === "string" && root !== "" && codexCwdInWorkspace(path, root);

function worktree(repo) {
  let wt = worktrees.get(repo.topLevel);
  if (!wt) {
    wt = { commonDir: repo.commonDir, marked: 0, stale: 0, status: null, log: null, filters: null };
    worktrees.set(repo.topLevel, wt);
    while (worktrees.size > MAX_WORKTREES) worktrees.delete(worktrees.keys().next().value);
  }
  return wt;
}

/** Whether an answer that began at `start` and landed `at` still holds. */
const holds = (entry, wt) => Boolean(entry) && now() - entry.at < MAX_AGE_MS && (!wt || wt.marked < entry.start);

/**
 * The repository `folder` is in — git-repo.mjs's answer plus `upstream` and
 * `stale` — or the reason there is none. Concurrent askers share one read.
 */
export async function repoOf(folder) {
  const hit = folders.get(folder);
  if (hit?.pending) return hit.pending.then(withStale, () => ({ state: "error" }));
  if (hit && holds(hit, hit.result.state === "repo" ? worktrees.get(hit.result.topLevel) : null)) {
    return withStale(hit.result);
  }
  const start = epoch + 1;
  const pending = (async () => {
    const r = await resolveRepo(folder);
    if (r.state !== "repo") return r;
    return { ...r, upstream: await readUpstream(r.topLevel, r.head.branch) };
  })();
  folders.set(folder, { pending });
  try {
    const result = await pending;
    if (folders.get(folder)?.pending === pending) folders.delete(folder);
    // Transient failures are never kept: the next ask tries again.
    if (result.state !== "timeout" && result.state !== "error") {
      folders.set(folder, { at: now(), start, result });
      while (folders.size > MAX_FOLDERS) folders.delete(folders.keys().next().value);
    }
    if (result.state === "repo") worktree(result);
    return withStale(result);
  } catch {
    if (folders.get(folder)?.pending === pending) folders.delete(folder);
    return { state: "error" };
  }
}

function withStale(result) {
  if (result.state !== "repo") return result;
  return { ...result, stale: worktrees.get(result.topLevel)?.stale ?? 0 };
}

/** A per-worktree cached read: `slot` names the cache, `compute` fills it. */
async function cached(repo, slot, compute) {
  const wt = worktree(repo);
  const hit = wt[slot];
  if (hit?.pending) return hit.pending;
  if (hit && holds(hit, wt)) return hit.value;
  const start = epoch + 1;
  const pending = compute();
  wt[slot] = { pending };
  try {
    const value = await pending;
    if (wt[slot]?.pending === pending) wt[slot] = value?.ok === false ? null : { at: now(), start, value };
    return value;
  } catch {
    if (wt[slot]?.pending === pending) wt[slot] = null;
    return { ok: false, reason: "error" };
  }
}

const filtersOf = (repo) => cached(repo, "filters", () => filterNames(repo.topLevel));

export const logOf = (repo) => cached(repo, "log", () => readLog(repo.topLevel, repo.head));

export const statusOf = (repo) => cached(repo, "status", async () => readStatus(repo.topLevel, { filters: await filtersOf(repo) }));

/** One file's diff. Not cached: it is asked for one file at a time, and the
 *  status it is checked against already is. */
export async function fileDiffOf(repo, entry) {
  return readFileDiff(repo.topLevel, entry, { filters: await filtersOf(repo), hasHead: !repo.head.unborn });
}

export const commitOf = (repo, sha) => readCommit(repo.topLevel, sha);

export const commitFileDiffOf = (repo, commit, file) => readCommitFileDiff(repo.topLevel, commit, file);

/**
 * Mark stale every worktree `cwd` is inside, and every worktree sharing a
 * repository with one of those; forget what was learned about folders that
 * were not repositories near `cwd` (a `git init` or a clone there changes
 * that). `tops` are worktrees to mark whatever `cwd` says — the session's own,
 * which a symlinked spelling of `cwd` might not match. Answers the top levels
 * marked.
 */
export function markStale(cwd, tops = []) {
  const e = ++epoch;
  const commons = new Set();
  for (const [top, wt] of worktrees) {
    if ((typeof cwd === "string" && inside(cwd, top)) || tops.includes(top)) commons.add(wt.commonDir);
  }
  const marked = [];
  for (const [top, wt] of worktrees) {
    if (!commons.has(wt.commonDir)) continue;
    wt.marked = e;
    wt.stale += 1;
    marked.push(top);
  }
  if (typeof cwd === "string" && cwd) {
    for (const [folder, entry] of folders) {
      if (entry.result && entry.result.state !== "repo" && (inside(folder, cwd) || inside(cwd, folder))) folders.delete(folder);
    }
  }
  return marked;
}

/** The repository a folder is in as `{ top, commonDir }`, or null when it is
 *  in none — the shape the commit recorder asks for (agent-git-record.mjs),
 *  answered from the same cache. */
export async function repoTopOf(folder) {
  const r = await repoOf(folder);
  return r.state === "repo" ? { top: r.topLevel, commonDir: r.commonDir } : null;
}

/** The stale counter of the worktree at `topLevel`, 0 for one never read. */
export const staleCount = (topLevel) => worktrees.get(topLevel)?.stale ?? 0;

/** Forget everything, for a Clear and for the tests. */
export function clearGitState() {
  folders.clear();
  worktrees.clear();
}

/** The clock the age limit reads, replaced by the tests. */
export function setGitClock(fn) {
  now = typeof fn === "function" ? fn : () => Date.now();
}
