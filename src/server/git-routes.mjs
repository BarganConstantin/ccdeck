// GET /api/git/{repo,log,status,diff,commit,edits,refs} — the git view's reads, each for
// one session's repository.
//
// A request names a SESSION, never a folder: the folder is the one the deck
// heard that session run in (git-sessions.mjs), so these routes cannot be
// pointed at an arbitrary place on disk. A file path in a request is only ever
// a key into what git itself just reported for that repository — a status
// entry or one of a commit's files — and a path git did not report is a 404.
// Every route is in GUARDED_READS (request-gates.mjs): a diff is the user's own
// work.
//
// Shapes, all JSON:
//   400 { error }                 a parameter missing or malformed
//   409 { error }                 the git view is switched off in Settings
//   404 { error }                 an unknown session, path or commit
//   200 { ok, state, repo, … }    `state` is "repo" or why there is none —
//                                 "not-a-repo", "gone", "no-git", "bare",
//                                 "unsafe", "timeout", "error" — with
//                                 `repo: null`; `ok: false` with `reason` is a
//                                 read that failed inside a repository.
//
// The log's commits each carry `agent` — who made it, and how the deck knows
// (git-attribution.mjs) — and after the window, with `outsideWindow: true`,
// come HEAD's own line when HEAD is older than the window (git-reads.mjs),
// then the session's own agent commits older than it. The repository carries
// `defaultBranch`, the branch its remote calls its default.
//
// The repo answer for a session (not narrowed to one subagent) also lists the
// session's subagents that work in another folder — another worktree, another
// repository, or no repository — as `subagents`, so the view can say where
// they are and how much is changed there.
import { basename } from "node:path";
import { send } from "./http-io.mjs";
import { attributeHistory } from "./git-attribution.mjs";
import { agentLabel, sessionEdits } from "./git-edits.mjs";
import { isShaLike } from "./git-reads.mjs";
import { sessionFolder, sessionSubagents } from "./git-sessions.mjs";
import { gitEnabled } from "./git-watch.mjs";
import { commitOf, commitFileDiffOf, countedStatusOf, fileDiffOf, logOf, repoOf, statusOf } from "./git-state.mjs";
import { refsOf } from "./git-refs.mjs";

const AREAS = new Set(["staged", "unstaged", "untracked", "conflict"]);
const MAX_PARAM = 4096;

const param = (url, name) => {
  const v = url.searchParams.get(name);
  return typeof v === "string" && v !== "" && v.length <= MAX_PARAM ? v : null;
};

/**
 * The repository a request's session runs in, or the answer already sent.
 * `{ repo, folder }` with `repo.state === "repo"`, or null after replying.
 */
async function sessionRepo(url, res) {
  // Switched off in Settings: the deck reads no repository at all.
  if (!gitEnabled()) { send(res, 409, { error: "git is switched off in Settings" }); return null; }
  const sid = param(url, "session");
  if (!sid) { send(res, 400, { error: "session required" }); return null; }
  const folder = sessionFolder(sid, param(url, "agent"));
  if (!folder) { send(res, 404, { error: "unknown session" }); return null; }
  const repo = await repoOf(folder.cwd);
  if (repo.state !== "repo") { send(res, 200, { ok: true, state: repo.state, repo: null }); return null; }
  return { repo, folder };
}

/** The most subagents one repo answer lists. */
export const MAX_SUBAGENTS_ELSEWHERE = 32;

/**
 * The session's subagents whose folder is not the session's own worktree, in
 * the order the deck heard them:
 *   [{ agentId, label, folder, folderName, state, topLevel, sameRepo, changed }]
 * `state` is the folder's ("repo", or why it has none, as the routes say it),
 * `topLevel` its worktree or null, `sameRepo` whether that worktree shares the
 * session's repository, `changed` how many files are changed there (each path
 * once, from the cached status) or null when that is not known. A subagent in
 * the session's own worktree — its folder or a folder inside it — is not
 * listed.
 */
async function subagentsElsewhere(sid, root, repo) {
  const away = sessionSubagents(sid).filter(([, cwd]) => cwd !== root);
  const rows = await Promise.all(away.slice(0, MAX_SUBAGENTS_ELSEWHERE * 2).map(async ([agentId, cwd]) => {
    // Both reads are the cached ones every route shares, so a view asking
    // again — and several subagents in one folder — cost nothing more.
    const r = await repoOf(cwd);
    if (r.state === "repo" && r.topLevel === repo.topLevel) return null;
    let changed = null;
    if (r.state === "repo") {
      const status = await statusOf(r);
      if (status?.ok) changed = new Set(status.entries.map((e) => e.path)).size;
    }
    return {
      agentId,
      label: agentLabel(sid, agentId),
      folder: r.state === "repo" ? r.folder : cwd,
      folderName: r.state === "repo" ? r.folderName : basename(cwd),
      state: r.state,
      topLevel: r.state === "repo" ? r.topLevel : null,
      sameRepo: r.state === "repo" && r.commonDir === repo.commonDir,
      changed,
    };
  }));
  return rows.filter(Boolean).slice(0, MAX_SUBAGENTS_ELSEWHERE);
}

/** `?session[&agent]` — the repository, and for a session (not one subagent)
 *  its subagents working in another folder. */
export async function handleGitRepo(req, res, url) {
  const found = await sessionRepo(url, res);
  if (!found) return;
  const sid = param(url, "session");
  const subagents = param(url, "agent") ? [] : await subagentsElsewhere(sid, sessionFolder(sid)?.cwd ?? null, found.repo);
  send(res, 200, { ok: true, state: "repo", repo: found.repo, subagents });
}

/** `?session[&agent]` — the history, each commit with the agent that made it
 *  (git-attribution.mjs), and after it HEAD's own line when HEAD is older than
 *  the window, then the session's own agent commits older than the window,
 *  all flagged `outsideWindow`. `agent` narrows the session's to one
 *  subagent's. */
export async function handleGitLog(req, res, url) {
  const found = await sessionRepo(url, res);
  if (!found) return;
  const log = await logOf(found.repo);
  if (!log.ok) return send(res, 200, { ok: false, state: "repo", repo: found.repo, reason: log.reason });
  const commits = await attributeHistory(found.repo, log.commits, { sessionId: param(url, "session"), agentId: found.folder.agent });
  send(res, 200, { ok: true, state: "repo", repo: found.repo, commits });
}

/** `?session[&agent]` — the working tree's entries, each with the line counts
 *  its diff would show (`added`, `removed`, `binary`) when they are known. */
export async function handleGitStatus(req, res, url) {
  const found = await sessionRepo(url, res);
  if (!found) return;
  const status = await countedStatusOf(found.repo);
  send(res, 200, status.ok
    ? { ok: true, state: "repo", repo: found.repo, entries: status.entries, counts: status.counts }
    : { ok: false, state: "repo", repo: found.repo, reason: status.reason });
}

/** `?session&path&area` — one file's diff, for a path the status just named. */
export async function handleGitDiff(req, res, url) {
  const path = param(url, "path");
  const area = param(url, "area") ?? "unstaged";
  if (!param(url, "session")) return send(res, 400, { error: "session required" });
  if (!path) return send(res, 400, { error: "path required" });
  if (!AREAS.has(area)) return send(res, 400, { error: "area must be staged, unstaged, untracked or conflict" });
  const found = await sessionRepo(url, res);
  if (!found) return;
  const status = await statusOf(found.repo);
  if (!status.ok) return send(res, 200, { ok: false, state: "repo", repo: found.repo, reason: status.reason });
  const entry = status.entries.find((e) => e.path === path && e.area === area);
  if (!entry) return send(res, 404, { error: "no such change in this repository" });
  const diff = await fileDiffOf(found.repo, entry);
  send(res, 200, diff.ok
    ? { ok: true, state: "repo", repo: found.repo, file: entry, diff }
    : { ok: false, state: "repo", repo: found.repo, file: entry, reason: diff.reason });
}

/** `?session&sha[&path]` — a commit's files, or one file's diff within it.
 *  The `commit` carries who committed it and when (`committer`) and its
 *  message after the subject (`body`, `clipped` past 64 KB).
 *  A diff a partial clone holds no content for answers `reason:
 *  "not-downloaded"`: the deck never fetches. */
export async function handleGitCommit(req, res, url) {
  const sha = param(url, "sha");
  const path = param(url, "path");
  if (!param(url, "session")) return send(res, 400, { error: "session required" });
  if (!sha || !isShaLike(sha)) return send(res, 400, { error: "sha must be a commit id" });
  const found = await sessionRepo(url, res);
  if (!found) return;
  const c = await commitOf(found.repo, sha);
  if (!c.ok) {
    if (c.reason === "unknown") return send(res, 404, { error: "no such commit in this repository" });
    return send(res, 200, { ok: false, state: "repo", repo: found.repo, reason: c.reason });
  }
  // `notDownloaded`: a partial clone without this commit's file contents —
  // its files are listed without line counts, and their diffs are not there.
  if (!path) return send(res, 200, { ok: true, state: "repo", repo: found.repo, commit: c.commit, files: c.files, ...(c.notDownloaded ? { notDownloaded: true } : {}) });
  const file = c.files.find((f) => f.path === path);
  if (!file) return send(res, 404, { error: "no such file in this commit" });
  const diff = await commitFileDiffOf(found.repo, c.commit, file);
  send(res, 200, diff.ok
    ? { ok: true, state: "repo", repo: found.repo, commit: c.commit, file, diff }
    : { ok: false, state: "repo", repo: found.repo, commit: c.commit, file, reason: diff.reason });
}

/** `?session[&agent]` — the files the session's agents edited through their
 *  edit tools, as paths in its repository (git-edits.mjs):
 *  `edits: [{ path, agentId, label, at }]`, newest first, one row per agent
 *  per file. The whole session by default; `agent` narrows to one subagent. */
export async function handleGitEdits(req, res, url) {
  const found = await sessionRepo(url, res);
  if (!found) return;
  const edits = await sessionEdits(found.repo, param(url, "session"), found.folder.agent);
  send(res, 200, { ok: true, state: "repo", repo: found.repo, edits });
}

/** `?session[&agent]` — the repository's branches, remote-tracking branches,
 *  tags, stashes, worktrees and submodules, for the sidebar (git-refs.mjs).
 *  `current` on a branch and a worktree is the session's own worktree's. */
export async function handleGitRefs(req, res, url) {
  const found = await sessionRepo(url, res);
  if (!found) return;
  const refs = await refsOf(found.repo);
  if (!refs.ok) return send(res, 200, { ok: false, state: "repo", repo: found.repo, reason: refs.reason });
  const { ok, ...lists } = refs;
  send(res, 200, { ok: true, state: "repo", repo: found.repo, ...lists });
}
