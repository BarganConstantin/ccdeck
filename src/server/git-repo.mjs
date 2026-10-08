// Which repository a folder is in, and where its HEAD points.
//
// A session knows the folder it runs in and nothing else. The questions the git
// view asks are about the repository around that folder — its top level, its
// git directory, the common directory a linked worktree shares with the main
// checkout, its name and its HEAD — and each comes from git itself, run in that
// folder through git-run.mjs. Nothing here reads files under .git by hand: a
// reftable repository keeps no HEAD file worth reading, and git's own answer is
// the one the user's terminal gives.
import { basename, dirname, resolve } from "node:path";
import { canonicalCwd } from "./canonical-path.mjs";
import { classifyFailure, git } from "./git-run.mjs";

/** How long the short form of a SHA is, the way the card and the log print it. */
export const SHORT_SHA = 7;

const lines = (s) => s.split("\n").map((l) => l.replace(/\r$/, ""));

/**
 * The repository `folder` belongs to. Never throws; answers one of
 *
 *   { state: "repo", topLevel, gitDir, commonDir, linkedWorktree, name,
 *     mainName, folder, folderName, nameDiffers, head, empty }
 *   { state: "gone" | "no-git" | "not-a-repo" | "bare" | "unsafe" | "timeout" | "error" }
 *
 * `name` is the basename of the top level and `folderName` the basename of the
 * folder the session runs in; `nameDiffers` says the two are not the same word,
 * which is a subfolder of the repository or a worktree folder named for its
 * branch. `mainName` is the main checkout's name, which a linked worktree's
 * top level does not carry. `head` is { branch, detached, sha, short, unborn }:
 * a branch name with no commit yet is unborn, and a detached HEAD has no branch.
 * `empty` is a repository with no commits on any branch, tag or remote.
 */
export async function resolveRepo(folder) {
  if (typeof folder !== "string" || folder === "") return { state: "gone" };
  const real = await canonicalCwd(folder).catch(() => null);
  const cwd = typeof real === "string" && real ? real : folder;
  const where = await git("rev-parse", ["--show-toplevel", "--absolute-git-dir", "--git-common-dir"], { cwd });
  if (!where.ok) return { state: classifyFailure(where) };
  const [top, gd, cd] = lines(where.stdout.trim());
  if (!top || !gd || !cd) return { state: "error" };
  const topLevel = resolve(top);
  const gitDir = resolve(gd);
  const commonDir = resolve(cwd, cd);
  const head = await readHead(topLevel);
  if (!head) return { state: "error" };
  const empty = head.unborn ? !(await anyCommit(topLevel)) : false;
  const name = basename(topLevel);
  const folderName = basename(cwd);
  return {
    state: "repo",
    topLevel,
    gitDir,
    commonDir,
    linkedWorktree: gitDir !== commonDir,
    name,
    mainName: mainCheckoutName(commonDir, name),
    folder: cwd,
    folderName,
    nameDiffers: folderName !== name,
    head,
    empty,
  };
}

/** The main checkout's folder name: the parent of a `.git` common directory,
 *  or of any hidden one (a bare repository kept as `.bare` beside the
 *  worktrees made from it), else a bare repository's own name without `.git`. */
function mainCheckoutName(commonDir, fallback) {
  const base = basename(commonDir);
  if (base.startsWith(".")) return basename(dirname(commonDir)) || fallback;
  return base.replace(/\.git$/i, "") || fallback;
}

/**
 * HEAD for the worktree at `topLevel`: { branch, detached, sha, short, unborn },
 * or null when git could not say. Two reads, because neither answers both
 * halves: symbolic-ref names the branch (and exits 1 for a detached HEAD), and
 * rev-parse names the commit (and fails for a branch with no commit yet).
 */
export async function readHead(topLevel) {
  const [sym, sha] = await Promise.all([
    git("symbolic-ref", ["-q", "HEAD"], { cwd: topLevel }),
    git("rev-parse", ["-q", "--verify", "HEAD^{commit}"], { cwd: topLevel }),
  ]);
  const ref = sym.ok ? sym.stdout.trim() : "";
  // Exit 1 with nothing said is symbolic-ref's "HEAD is detached"; anything
  // else is a failure, and a HEAD git could not read is not a detached one.
  if (!sym.ok && !(sym.code === 1 && !sym.stderr.trim())) return null;
  const commit = sha.ok ? sha.stdout.trim() : "";
  if (!commit && !ref) return null;
  return {
    branch: ref ? ref.replace(/^refs\/heads\//, "") : null,
    detached: !ref,
    sha: commit || null,
    short: commit ? commit.slice(0, SHORT_SHA) : null,
    unborn: !commit,
  };
}

/** Whether any branch, tag or remote-tracking branch names a commit. */
async function anyCommit(topLevel) {
  const r = await git("for-each-ref", ["--count=1", "--format=%(objectname)", "refs/heads", "refs/tags", "refs/remotes"], { cwd: topLevel });
  return r.ok && r.stdout.trim() !== "";
}

/**
 * The clean/smudge filter drivers the configuration visible from `topLevel`
 * defines, for git-run.mjs to empty on the reads that compare working-tree
 * content. Reading configuration runs nothing. An empty list when it cannot be
 * read, which costs only the neutralising and never a read.
 */
export async function filterNames(topLevel) {
  const r = await git("config", ["-z", "--name-only", "--get-regexp", "^filter\\."], { cwd: topLevel });
  if (!r.ok) return [];
  const names = new Set();
  for (const key of r.stdout.split("\0")) {
    const m = /^filter\.(.+)\.[^.]+$/s.exec(key.trim());
    if (m) names.add(m[1]);
  }
  return [...names];
}

/**
 * The upstream of `branch` and how far HEAD is from it, from the refs already
 * on disk — the deck never fetches, so this is as fresh as the last fetch
 * somebody else made. { name, ahead, behind, gone } or null for a branch with
 * no upstream.
 */
export async function readUpstream(topLevel, branch) {
  if (!branch) return null;
  const r = await git("for-each-ref", ["--format=%(upstream)%00%(upstream:short)%00%(upstream:track,nobracket)", `refs/heads/${branch}`], { cwd: topLevel });
  if (!r.ok) return null;
  const [full, short, track] = r.stdout.replace(/\n$/, "").split("\0");
  if (!full) return null;
  const ahead = Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(track ?? "")?.[1] ?? 0);
  return { name: short || full, ahead, behind, gone: /\bgone\b/.test(track ?? "") };
}

/** The remotes whose default branch counts, in order: origin, then the
 *  canonical one of a fork. */
const DEFAULT_REMOTES = ["origin", "upstream"];

/**
 * The branch the repository's remote calls its default — what `origin/HEAD`
 * points at, as the clone (or `git remote set-head`) left it — without the
 * remote's name: "main", "development". Read from the refs on disk; the deck
 * never asks the remote. Origin's first, then upstream's, then any remote's;
 * null when no remote names one.
 */
export async function readDefaultBranch(topLevel) {
  const r = await git("for-each-ref", ["--format=%(refname)%00%(symref)", "refs/remotes/*/HEAD"], { cwd: topLevel });
  if (!r.ok) return null;
  const found = new Map();
  for (const line of r.stdout.split("\n")) {
    const [ref, target] = line.split("\0");
    const m = /^refs\/remotes\/(.+)\/HEAD$/.exec(ref ?? "");
    if (!m || !target?.startsWith(`refs/remotes/${m[1]}/`)) continue;
    const name = target.slice(`refs/remotes/${m[1]}/`.length);
    if (name && name !== "HEAD") found.set(m[1], name);
  }
  for (const remote of DEFAULT_REMOTES) if (found.has(remote)) return found.get(remote);
  return found.values().next().value ?? null;
}
