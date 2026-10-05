// GET /api/git/{repo,log,status,diff,commit} — the git view's reads, each for
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
// (git-attribution.mjs) — and the session's own agent commits older than the
// window follow it with `outsideWindow: true`.
import { send } from "./http-io.mjs";
import { attributeHistory } from "./git-attribution.mjs";
import { isShaLike } from "./git-reads.mjs";
import { sessionFolder } from "./git-sessions.mjs";
import { gitEnabled } from "./git-watch.mjs";
import { commitOf, commitFileDiffOf, fileDiffOf, logOf, repoOf, statusOf } from "./git-state.mjs";

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

export async function handleGitRepo(req, res, url) {
  const found = await sessionRepo(url, res);
  if (!found) return;
  send(res, 200, { ok: true, state: "repo", repo: found.repo });
}

/** `?session[&agent]` — the history, each commit with the agent that made it
 *  (git-attribution.mjs), and after it the session's own agent commits older
 *  than the window, flagged `outsideWindow`. `agent` narrows those to one
 *  subagent's. */
export async function handleGitLog(req, res, url) {
  const found = await sessionRepo(url, res);
  if (!found) return;
  const log = await logOf(found.repo);
  if (!log.ok) return send(res, 200, { ok: false, state: "repo", repo: found.repo, reason: log.reason });
  const commits = await attributeHistory(found.repo, log.commits, { sessionId: param(url, "session"), agentId: found.folder.agent });
  send(res, 200, { ok: true, state: "repo", repo: found.repo, commits });
}

export async function handleGitStatus(req, res, url) {
  const found = await sessionRepo(url, res);
  if (!found) return;
  const status = await statusOf(found.repo);
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

/** `?session&sha[&path]` — a commit's files, or one file's diff within it. */
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
  if (!path) return send(res, 200, { ok: true, state: "repo", repo: found.repo, commit: c.commit, files: c.files });
  const file = c.files.find((f) => f.path === path);
  if (!file) return send(res, 404, { error: "no such file in this commit" });
  const diff = await commitFileDiffOf(found.repo, c.commit, file);
  send(res, 200, diff.ok
    ? { ok: true, state: "repo", repo: found.repo, commit: c.commit, file, diff }
    : { ok: false, state: "repo", repo: found.repo, commit: c.commit, file, reason: diff.reason });
}
