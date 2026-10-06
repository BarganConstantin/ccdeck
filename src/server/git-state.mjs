// The git view's reads for a resolved repository, cached per worktree and
// marked stale by what the agents do.
//
// NO POLLING. A repository changes when somebody changes it, and the deck
// hears most of those somebodies: every Edit, Write, MultiEdit, NotebookEdit,
// Bash and PowerShell call an agent finishes, and every Codex patch or
// command. A command whose folder is inside a worktree marks that worktree
// stale — and every worktree sharing its repository, since a commit or a
// branch made in one is history in all of them. An edit marks only the
// worktree holding the file it edited, and only its working tree: an edit
// cannot move a branch, so the history and HEAD stay as they were read
// (git-watch.mjs decides which events count, and how far). The next read
// recomputes; until then the last answer stands. A change made in the user's
// own terminal is caught by the short age limit below, the next time somebody
// asks, rather than by a timer.
//
// The stale counter on each worktree is what the page compares to know an open
// view is out of date: it goes up by one per mark, and rides on the repository
// every read answers with and on the GitObserved event.
//
// A read that started before a mark is not trusted after it: each cached
// answer records the mark count (`epoch`) it began at, and a worktree marked
// since then is stale for it, whichever finished first. The same holds for a
// read still running: an asker after a mark starts a read of its own rather
// than share one that may have looked before the change the mark is for.
import { codexCwdInWorkspace } from "./log-election.mjs";
import { filterNames, readUpstream, resolveRepo } from "./git-repo.mjs";
import { countEntries, readCommit, readCommitFileDiff, readFileDiff, readLog, readStatus } from "./git-reads.mjs";

/** How long an answer is trusted with no mark at all — the bound on how late a
 *  change made outside any agent is noticed by a read. */
export const MAX_AGE_MS = 15_000;
const MAX_FOLDERS = 512;
const MAX_WORKTREES = 256;

let epoch = 0;
let now = () => Date.now();
const folders = new Map();   // folder -> { at, start, result } | { pending, start }
const worktrees = new Map(); // topLevel -> { commonDir, marked, treeMarked, stale, status, counted, log, filters }
/** The reads an edit can change: the working tree's. The rest — the history,
 *  the filter drivers, the repository and its HEAD — only a command can. */
const TREE_SLOTS = new Set(["status", "counted"]);

/** Whether `path` is `root` or inside it, by the platform's own rules. */
const inside = (path, root) => typeof root === "string" && root !== "" && codexCwdInWorkspace(path, root);

function worktree(repo) {
  let wt = worktrees.get(repo.topLevel);
  if (!wt) {
    wt = { commonDir: repo.commonDir, marked: 0, treeMarked: 0, stale: 0, status: null, counted: null, log: null, filters: null };
    worktrees.set(repo.topLevel, wt);
    while (worktrees.size > MAX_WORKTREES) worktrees.delete(worktrees.keys().next().value);
  }
  return wt;
}

/** The last mark that counts for one of a worktree's reads: every mark for
 *  the working tree's, a command's alone for the rest. */
const markOf = (wt, slot) => (TREE_SLOTS.has(slot) ? Math.max(wt.marked, wt.treeMarked) : wt.marked);

/** Whether an answer that began at `start` and landed `at` still holds. */
const holds = (entry, wt, slot) => Boolean(entry) && now() - entry.at < MAX_AGE_MS && (!wt || markOf(wt, slot) < entry.start);

/**
 * The repository `folder` is in — git-repo.mjs's answer plus `upstream` and
 * `stale` — or the reason there is none. Concurrent askers share one read.
 */
export async function repoOf(folder) {
  const hit = folders.get(folder);
  // Shared only while no mark has come since it began: which worktree it is
  // in is not known yet, so any mark counts.
  if (hit?.pending && epoch < hit.start) return hit.pending.then(withStale, () => ({ state: "error" }));
  if (hit?.result && holds(hit, hit.result.state === "repo" ? worktrees.get(hit.result.topLevel) : null)) {
    return withStale(hit.result);
  }
  const start = epoch + 1;
  const pending = (async () => {
    const r = await resolveRepo(folder);
    if (r.state !== "repo") return r;
    return { ...r, upstream: await readUpstream(r.topLevel, r.head.branch) };
  })();
  folders.set(folder, { pending, start });
  // Only the newest read of a folder writes its answer down.
  const current = () => folders.get(folder)?.pending === pending;
  try {
    const result = await pending;
    if (current()) {
      folders.delete(folder);
      // Transient failures are never kept: the next ask tries again.
      if (result.state !== "timeout" && result.state !== "error") {
        folders.set(folder, { at: now(), start, result });
        while (folders.size > MAX_FOLDERS) folders.delete(folders.keys().next().value);
      }
    }
    if (result.state === "repo") worktree(result);
    return withStale(result);
  } catch {
    if (current()) folders.delete(folder);
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
  if (hit?.pending && markOf(wt, slot) < hit.start) return hit.pending;
  if (hit && !hit.pending && holds(hit, wt, slot)) return hit.value;
  const start = epoch + 1;
  const pending = compute();
  wt[slot] = { pending, start };
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

/** The status with each entry's line counts (git-reads.mjs countEntries) —
 *  what the status route answers. Cached apart from the plain status, which
 *  the diff lookups and the collision check read without paying for counts. */
export const countedStatusOf = (repo) => cached(repo, "counted", async () => {
  const status = await statusOf(repo);
  if (!status?.ok) return status;
  return { ...status, entries: await countEntries(repo.topLevel, status.entries, { filters: await filtersOf(repo) }) };
});

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
 *
 * `tree: true` is an edit's mark: only the worktrees `cwd` (the edited file)
 * is inside, or `tops`, and only their working tree's reads.
 */
export function markStale(cwd, tops = [], { tree = false } = {}) {
  const e = ++epoch;
  const hit = (top) => (typeof cwd === "string" && inside(cwd, top)) || tops.includes(top);
  const marked = [];
  if (tree) {
    for (const [top, wt] of worktrees) {
      if (!hit(top)) continue;
      wt.treeMarked = e;
      wt.stale += 1;
      marked.push(top);
    }
    return marked;
  }
  const commons = new Set();
  for (const [top, wt] of worktrees) if (hit(top)) commons.add(wt.commonDir);
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
