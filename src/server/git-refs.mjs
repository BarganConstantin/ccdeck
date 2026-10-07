// The git view's sidebar read: every branch, remote-tracking branch, tag,
// stash, worktree and submodule of a session's repository, as the sidebar
// lists them.
//
// Read-only like every other read (git-run.mjs): the folder is the session's,
// resolved by the route, and nothing here names a revision a request sent. Six
// small reads, each capped in time and in bytes:
//
//   for-each-ref   branches with their upstream and how far they are from it
//                  (from the refs on disk: the deck never fetches), which
//                  worktree holds each, remote-tracking branches, tags and
//                  whether each is annotated; at most MAX_REFS, in git's order
//   config         the remotes' names, so a remote called `team/eu` keeps its
//                  slash; and .gitmodules, read as a file of its own
//   log -g         the stash, which is the reflog of refs/stash — what
//                  `git stash list` prints, without starting a command that
//                  can also drop or clear one
//   worktree list  every worktree, locked or prunable
//   ls-files -s    the commit each submodule is pinned at, asked only for the
//                  paths .gitmodules names, so a repository of a million files
//                  answers a few lines. `submodule status` is never run: it
//                  starts a git inside every submodule
//
// A list that could not be read comes back empty and is named in `unread`; a
// list cut at its cap is named in `clipped`. Only a failed ref read fails the
// whole answer.
import { access } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { git } from "./git-run.mjs";
import { readFailure } from "./git-reads.mjs";
import { MAX_AGE_MS } from "./git-state.mjs";

/** The most branches, remote-tracking branches and tags one answer lists. */
export const MAX_REFS = 2000;
export const MAX_STASHES = 200;
export const MAX_WORKTREES = 200;
export const MAX_SUBMODULES = 500;

const REFS_BYTES = 4 << 20;
const SMALL_BYTES = 1 << 20;

const REF_FORMAT = [
  "%(refname)", "%(objectname)", "%(*objectname)", "%(upstream)", "%(upstream:short)",
  "%(upstream:track,nobracket)", "%(HEAD)", "%(symref)", "%(worktreepath)",
  "%(objecttype)", "%(*objecttype)",
].join("%00") + "%00";

const US = "\x1f";

/** A path .gitmodules names that can be handed back to git as a path inside
 *  the repository: relative, and never climbing out of it. */
const insidePath = (p) => typeof p === "string" && p !== "" && !isAbsolute(p) && !/^[\\/]/.test(p)
  && !p.split(/[\\/]/).includes("..") && !/[\0\n\r]/.test(p);

/** `s` without `prefix`, which the caller has checked it starts with. */
const after = (s, prefix) => s.slice(prefix.length);

/** Every record of the ref read: `[refname, sha, peeled, upstream, upstreamShort, track, head, symref, worktree, type, peeledType]`. */
export function parseRefRecords(stdout) {
  return String(stdout ?? "").split("\0\n").filter((r) => r.trim() !== "").map((r) => r.replace(/^\n/, "").split("\0"));
}

/** `ahead 2, behind 1` / `gone` / `` as numbers and a flag. */
export function parseTrack(track) {
  const t = String(track ?? "");
  return {
    ahead: Number(/ahead (\d+)/.exec(t)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(t)?.[1] ?? 0),
    gone: /\bgone\b/.test(t),
  };
}

/** The remotes a `config -z --get-regexp ^remote\.` answer names. */
export function parseRemoteNames(stdout) {
  const names = new Set();
  for (const entry of String(stdout ?? "").split("\0")) {
    const key = entry.split("\n")[0];
    const m = /^remote\.(.+)\.(url|pushurl|fetch)$/is.exec(key);
    if (m) names.add(m[1]);
  }
  return [...names];
}

/** The remote a `refs/remotes/…` name belongs to: the longest configured
 *  remote whose name it starts with, else its first segment. */
export function splitRemoteRef(rest, remotes) {
  let best = null;
  for (const r of remotes) if (rest.startsWith(`${r}/`) && (!best || r.length > best.length)) best = r;
  const remote = best ?? rest.split("/")[0];
  return { remote, name: rest.slice(remote.length + 1) };
}

/** How many records past the cap the ref read asks for: a remote's HEAD is
 *  one of them and is not listed, so the read reaches past it to tell a list
 *  cut at the cap from one that ends there. */
export const REF_SLACK = 33;

/** The ref read, as the answer's branches, remotes and tags. `asked` is how
 *  many records the read was capped at: a read that filled it may have more. */
export function refsFrom(records, { remoteNames = [], maxRefs = MAX_REFS, asked = Infinity } = {}) {
  const branches = [];
  const byRemote = new Map(remoteNames.map((n) => [n, []]));
  const tags = [];
  let listed = 0;
  let clipped = false;
  for (const [ref, obj, peeled, upstream, upstreamShort, track, head, symref, worktree, type, peeledType] of records) {
    if (!ref || !/^[0-9a-f]{40,64}$/.test(obj ?? "")) continue;
    // origin/HEAD and its kind point at a branch listed on its own.
    if (symref) continue;
    if (listed >= maxRefs) { clipped = true; break; }
    listed++;
    if (ref.startsWith("refs/heads/")) {
      const t = parseTrack(track);
      branches.push({
        name: after(ref, "refs/heads/"),
        sha: obj,
        current: head === "*",
        upstream: upstream ? upstreamShort || upstream : null,
        ahead: t.ahead,
        behind: t.behind,
        gone: Boolean(upstream) && t.gone,
        // git prints a folder with forward slashes on Windows too; spelled
        // as the repository's own top level is, so the two compare.
        worktree: worktree ? resolve(worktree) : null,
      });
    } else if (ref.startsWith("refs/remotes/")) {
      const { remote, name } = splitRemoteRef(after(ref, "refs/remotes/"), remoteNames);
      if (!name) continue;
      if (!byRemote.has(remote)) byRemote.set(remote, []);
      byRemote.get(remote).push({ name, sha: obj });
    } else if (ref.startsWith("refs/tags/")) {
      // A tag of a tree or a blob (or of another tag) names no commit: said,
      // so the sidebar never asks the history for it.
      const named = (peeled ? peeledType : type) || "commit";
      tags.push({ name: after(ref, "refs/tags/"), sha: peeled || obj, annotated: Boolean(peeled), ...(named !== "commit" ? { target: named } : {}) });
    }
  }
  if (records.length >= asked) clipped = true;
  const remotes = [...byRemote].map(([name, list]) => ({ name, branches: list })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { branches, remotes, tags, clipped };
}

/** The stash's reflog: `[{ index, sha, subject, date }]`. */
export function parseStashes(stdout, max = MAX_STASHES) {
  const out = [];
  for (const record of String(stdout ?? "").split("\0")) {
    const [selector, sha, subject, date] = record.replace(/^\n+/, "").split(US);
    const index = /@\{(\d+)\}$/.exec(selector ?? "")?.[1];
    if (index === undefined || !/^[0-9a-f]{40,64}$/.test(sha ?? "")) continue;
    out.push({ index: Number(index), sha, subject: subject ?? "", date: date ?? "" });
    if (out.length > max) break;
  }
  return out;
}

/** `worktree list --porcelain -z`: `[{ path, branch, sha, locked, prunable, bare }]`. */
export function parseWorktrees(stdout) {
  const out = [];
  let cur = null;
  for (const field of String(stdout ?? "").split("\0")) {
    if (field === "") { if (cur) out.push(cur); cur = null; continue; }
    const sp = field.indexOf(" ");
    const key = sp < 0 ? field : field.slice(0, sp);
    const value = sp < 0 ? "" : field.slice(sp + 1);
    if (key === "worktree") { if (cur) out.push(cur); cur = { path: value, branch: null, sha: null, locked: false, prunable: false, bare: false }; continue; }
    if (!cur) continue;
    if (key === "HEAD") cur.sha = /^[0-9a-f]{40,64}$/.test(value) ? value : null;
    else if (key === "branch") cur.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "locked") cur.locked = true;
    else if (key === "prunable") cur.prunable = true;
    else if (key === "bare") cur.bare = true;
  }
  if (cur) out.push(cur);
  return out;
}

/** `.gitmodules` as `config -z --get-regexp` reads it: `[{ name, path }]`, in
 *  the file's order. A name may hold dots; the key's last part is the field. */
export function parseGitmodules(stdout) {
  const byName = new Map();
  for (const entry of String(stdout ?? "").split("\0")) {
    const nl = entry.indexOf("\n");
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const value = nl < 0 ? "" : entry.slice(nl + 1);
    const m = /^submodule\.(.+)\.([^.]+)$/s.exec(key);
    if (!m || m[2].toLowerCase() !== "path") continue;
    if (!byName.has(m[1])) byName.set(m[1], value);
  }
  return [...byName].map(([name, path]) => ({ name, path }));
}

/** `ls-files -s -z`: the gitlinks (mode 160000), path → commit. */
export function parseGitlinks(stdout) {
  const out = new Map();
  for (const record of String(stdout ?? "").split("\0")) {
    const m = /^160000 ([0-9a-f]{40,64}) \d\t(.+)$/s.exec(record);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

const exists = (p) => access(p).then(() => true, () => false);

async function readStashes(topLevel, max) {
  const has = await git("for-each-ref", ["--count=1", "--format=%(objectname)", "refs/stash"], { cwd: topLevel, maxBytes: SMALL_BYTES });
  if (!has.ok) return { ok: false };
  if (!has.stdout.trim()) return { ok: true, list: [], clipped: false };
  const r = await git("log", ["-g", "-z", `--max-count=${max + 1}`, "--format=%gd%x1f%H%x1f%gs%x1f%cI", "refs/stash", "--"], { cwd: topLevel, maxBytes: SMALL_BYTES });
  if (!r.ok) return { ok: false };
  const all = parseStashes(r.stdout, max);
  return { ok: true, list: all.slice(0, max), clipped: all.length > max };
}

async function readWorktrees(topLevel, max) {
  const r = await git("worktree", ["list", "--porcelain", "-z"], { cwd: topLevel, maxBytes: SMALL_BYTES });
  if (!r.ok) return { ok: false };
  const all = parseWorktrees(r.stdout).filter((w) => !w.bare && w.path);
  const kept = all.slice(0, max).map((w) => ({ ...w, path: resolve(w.path) }));
  const list = await Promise.all(kept.map(async (w) => ({
    path: w.path,
    name: basename(w.path) || w.path,
    branch: w.branch,
    sha: w.sha,
    current: w.path === topLevel,
    locked: w.locked,
    prunable: w.prunable,
    missing: !(await exists(w.path)),
  })));
  return { ok: true, list, clipped: all.length > max };
}

async function readSubmodules(topLevel, max) {
  const cfg = await git("config", ["-z", "-f", ".gitmodules", "--get-regexp", "^submodule\\."], { cwd: topLevel, maxBytes: SMALL_BYTES });
  // No .gitmodules, or one without entries: git says so with exit 1.
  if (!cfg.ok) return cfg.code === 1 ? { ok: true, list: [], clipped: false } : { ok: false };
  const named = parseGitmodules(cfg.stdout).filter((m) => insidePath(m.path));
  const asked = named.slice(0, max + 1);
  if (!asked.length) return { ok: true, list: [], clipped: false };
  const r = await git("ls-files", ["-s", "-z", "--", ...asked.map((m) => m.path)], { cwd: topLevel, maxBytes: SMALL_BYTES });
  if (!r.ok) return { ok: false };
  const links = parseGitlinks(r.stdout);
  const all = asked.filter((m) => links.has(m.path)).map((m) => ({ path: m.path, name: m.name, sha: links.get(m.path) }));
  return { ok: true, list: all.slice(0, max), clipped: all.length > max || named.length > max + 1 };
}

/**
 * The sidebar's lists for the repository at `repo.topLevel`:
 *   { ok: true, branches, remotes, tags, stashes, worktrees, submodules, clipped, unread }
 * or { ok: false, reason } when the refs themselves could not be read.
 * `clipped` and `unread` name lists (`refs`, `stashes`, `worktrees`,
 * `submodules`) cut at their cap or not read at all.
 */
export async function readRefs(repo, { maxRefs = MAX_REFS, maxStashes = MAX_STASHES, maxWorktrees = MAX_WORKTREES, maxSubmodules = MAX_SUBMODULES } = {}) {
  const cwd = repo.topLevel;
  const [refs, remoteCfg, stashes, worktrees, submodules] = await Promise.all([
    git("for-each-ref", [`--count=${maxRefs + REF_SLACK}`, `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes", "refs/tags"], { cwd, maxBytes: REFS_BYTES }),
    git("config", ["-z", "--get-regexp", "^remote\\."], { cwd, maxBytes: SMALL_BYTES }),
    readStashes(cwd, maxStashes),
    readWorktrees(cwd, maxWorktrees),
    readSubmodules(cwd, maxSubmodules),
  ]);
  if (!refs.ok) return { ok: false, reason: readFailure(refs) };
  const { branches, remotes, tags, clipped: refsClipped } = refsFrom(parseRefRecords(refs.stdout), {
    remoteNames: remoteCfg.ok ? parseRemoteNames(remoteCfg.stdout) : [],
    maxRefs,
    asked: maxRefs + REF_SLACK,
  });
  // A branch with no commit yet is not a ref, but it is where HEAD is.
  const head = repo.head;
  if (head?.unborn && head.branch && !branches.some((b) => b.name === head.branch)) {
    branches.unshift({ name: head.branch, sha: null, current: true, upstream: null, ahead: 0, behind: 0, gone: false, worktree: cwd });
  }
  const clipped = [];
  const unread = [];
  if (refsClipped) clipped.push("refs");
  for (const [name, r] of [["stashes", stashes], ["worktrees", worktrees], ["submodules", submodules]]) {
    if (!r.ok) unread.push(name);
    else if (r.clipped) clipped.push(name);
  }
  return {
    ok: true,
    branches,
    remotes,
    tags,
    stashes: stashes.ok ? stashes.list : [],
    worktrees: worktrees.ok ? worktrees.list : [],
    submodules: submodules.ok ? submodules.list : [],
    clipped,
    unread,
  };
}

// ── one read per worktree and stale count ────────────────────────────────

const MAX_CACHED = 64;
const cache = new Map(); // topLevel -> { stale, at, value } | { stale, pending }
let clock = () => Date.now();

/**
 * readRefs, shared: an answer holds while the worktree's stale counter is the
 * one it was read at and for MAX_AGE_MS at most (git-state.mjs), and askers
 * while a read runs share it. A failed read is never kept.
 */
export async function refsOf(repo) {
  const key = repo.topLevel;
  const stale = repo.stale ?? 0;
  const hit = cache.get(key);
  if (hit && hit.stale === stale) {
    if (hit.pending) return hit.pending;
    if (clock() - hit.at < MAX_AGE_MS) return hit.value;
  }
  const pending = readRefs(repo).catch(() => ({ ok: false, reason: "error" }));
  cache.set(key, { stale, pending });
  const value = await pending;
  if (cache.get(key)?.pending === pending) {
    if (value.ok) cache.set(key, { stale, at: clock(), value });
    else cache.delete(key);
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  }
  return value;
}

/** Forget every answer, and replace the clock — for the tests. */
export function clearRefsCache(nowFn = null) {
  cache.clear();
  clock = typeof nowFn === "function" ? nowFn : () => Date.now();
}
