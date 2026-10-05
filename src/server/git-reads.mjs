// The four reads the git view is built from — the history, the working tree's
// status, one file's diff, and one commit — each a parse of git's own
// machine-readable output, run through git-run.mjs.
//
// Nothing here decides WHICH repository: the caller hands in a top level it
// resolved from a session's folder (git-repo.mjs), and for the diffs an entry
// git itself reported. A path never comes from a request on its own.
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { git } from "./git-run.mjs";

/** How many commits the history holds. */
export const LOG_LIMIT = 100;
/** The largest single diff answered with its content; past it, "too large". */
export const DIFF_CAP = 1 << 20;
/** The trailers kept off each commit message, compared without case. */
const TRAILER_KEYS = new Set(["co-authored-by", "claude-session"]);

const US = "\x1f";
// SHA, parents, author name, author email, author date (strict ISO), subject,
// body. The body is last so a unit separator inside one cannot shift a field.
const LOG_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%s", "%b"].join("%x1f");

/** Whether a string can only be a commit id: hex, 4 to 64 characters. Checked
 *  before it reaches git, so a request cannot pass an option or a revision
 *  expression in its place. */
export const isShaLike = (s) => typeof s === "string" && /^[0-9a-f]{4,64}$/i.test(s);

// ─── log ──────────────────────────────────────────────────────────────────

/**
 * The trailers worth keeping from a commit body: the last paragraph's
 * `Key: value` lines whose key is one of TRAILER_KEYS, continuation lines
 * folded in. Parsed here rather than by `%(trailers)` so no git version or
 * trailer configuration changes the answer.
 */
export function parseTrailers(body) {
  const paragraphs = String(body ?? "").replace(/\s+$/, "").split(/\n[ \t]*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const out = [];
  let current = null;
  for (const line of last.split("\n")) {
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (m) {
      current = TRAILER_KEYS.has(m[1].toLowerCase()) ? { key: m[1], value: m[2].trim() } : null;
      if (current) out.push(current);
    } else if (current && /^[ \t]+\S/.test(line)) {
      current.value = `${current.value} ${line.trim()}`;
    } else {
      current = null;
    }
  }
  return out;
}

/** One record of LOG_FORMAT, or null. */
export function parseLogRecord(record) {
  const parts = record.replace(/^\n+/, "").split(US);
  if (parts.length < 7) return null;
  const [sha, parents, name, email, date, subject, ...rest] = parts;
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null;
  return {
    sha,
    parents: parents ? parents.split(" ").filter(Boolean) : [],
    author: { name, email },
    date,
    subject,
    trailers: parseTrailers(rest.join(US)),
  };
}

/** Every branch, remote-tracking branch and tag, by the commit it names. */
async function refsByCommit(topLevel) {
  const r = await git("for-each-ref", ["--format=%(objectname)%00%(*objectname)%00%(refname)%00%(symref)", "refs/heads", "refs/remotes", "refs/tags"], { cwd: topLevel });
  const map = new Map();
  if (!r.ok) return map;
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [obj, peeled, ref, symref] = line.split("\0");
    // origin/HEAD and its kind point at another ref, which is listed itself.
    if (symref) continue;
    const at = peeled || obj;
    const slot = map.get(at) ?? { local: [], remote: [], tags: [], head: false };
    if (ref.startsWith("refs/heads/")) slot.local.push(ref.slice(11));
    else if (ref.startsWith("refs/remotes/")) slot.remote.push(ref.slice(13));
    else if (ref.startsWith("refs/tags/")) slot.tags.push(ref.slice(10));
    map.set(at, slot);
  }
  return map;
}

/**
 * The last LOG_LIMIT commits across every branch, remote-tracking branch, tag
 * and HEAD, in topological order — parents are what the graph's lanes are
 * drawn from, so a child always comes before its parents. Stashes and notes
 * are refs too and are left out: neither is history anybody committed to.
 *
 * `{ ok: true, commits }`, or `{ ok: false, reason }` for a read that failed.
 */
export async function readLog(topLevel, head, { limit = LOG_LIMIT } = {}) {
  const refs = await refsByCommit(topLevel);
  const starts = ["--branches", "--remotes", "--tags"];
  if (head?.sha) starts.push("HEAD");
  if (!head?.sha && refs.size === 0) return { ok: true, commits: [] };
  const args = ["-z", "--topo-order", `--max-count=${limit}`, `--format=${LOG_FORMAT}`, ...starts, "--"];
  const r = await git("log", args, { cwd: topLevel });
  if (!r.ok) return { ok: false, reason: r.timedOut ? "timeout" : r.tooLarge ? "too-large" : "error" };
  return { ok: true, commits: withRefs(r.stdout, refs, head) };
}

/** Every record of a `log -z --format=LOG_FORMAT` answer, with the refs that
 *  name it and whether HEAD is on it. */
function withRefs(stdout, refs, head) {
  const commits = [];
  for (const record of stdout.split("\0")) {
    const c = parseLogRecord(record);
    if (!c) continue;
    const slot = refs.get(c.sha);
    c.refs = {
      local: slot?.local ?? [],
      remote: slot?.remote ?? [],
      tags: slot?.tags ?? [],
      head: c.sha === head?.sha,
    };
    commits.push(c);
  }
  return commits;
}

/** A SHA as the commit store holds it: git's shortest default abbreviation
 *  or longer, hex only — so it can never be read as an option or a range. */
const STORED_SHA = /^[0-9a-f]{7,64}$/;

/**
 * Named commits that are still part of the history, wherever they are in it —
 * the ones LOG_LIMIT leaves out that the view still shows. Each is read on its
 * own (`--no-walk`, so no parent is followed), newest first, with refs as
 * readLog attaches them. A SHA the repository does not hold is skipped, and so
 * is a commit no branch, remote-tracking branch, tag or HEAD reaches any more —
 * what an amend or a rebase left behind, kept only by the reflog.
 *
 * `{ ok: true, commits }`, or `{ ok: false, reason }` for a read that failed.
 */
export async function readCommitsBySha(topLevel, shas, head) {
  const list = [...new Set((Array.isArray(shas) ? shas : []).filter((s) => typeof s === "string" && STORED_SHA.test(s)))];
  if (!list.length) return { ok: true, commits: [] };
  const ends = ["--branches", "--remotes", "--tags", ...(head?.sha ? ["HEAD"] : [])];
  // What no ref reaches: the named commits that left the history, with their
  // own ancestors that left with them.
  const lost = await git("rev-list", ["--ignore-missing", ...list, "--not", ...ends, "--"], { cwd: topLevel });
  if (!lost.ok) return { ok: false, reason: lost.timedOut ? "timeout" : lost.tooLarge ? "too-large" : "error" };
  const gone = new Set(lost.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  const refs = await refsByCommit(topLevel);
  const r = await git("log", ["-z", "--no-walk", "--ignore-missing", `--format=${LOG_FORMAT}`, ...list, "--"], { cwd: topLevel });
  if (!r.ok) return { ok: false, reason: r.timedOut ? "timeout" : r.tooLarge ? "too-large" : "error" };
  return { ok: true, commits: withRefs(r.stdout, refs, head).filter((c) => !gone.has(c.sha)) };
}

/**
 * When the file at `path` was last committed to on HEAD's history, if that was
 * after `sinceMs` — the end of that commit's second, in ms — or null when no
 * commit since then touched it (or git could not say). `--since` keeps the walk
 * to recent history, however old the file. `path` must be one git reported.
 */
export async function readLastCommitTime(topLevel, path, sinceMs) {
  if (typeof path !== "string" || path === "") return null;
  const args = ["-1", "--format=%ct"];
  if (typeof sinceMs === "number" && Number.isFinite(sinceMs)) args.push(`--since=@${Math.max(0, Math.floor(sinceMs / 1000) - 1)}`);
  const r = await git("log", [...args, "--", path], { cwd: topLevel, maxBytes: 4096 });
  const seconds = r.ok ? Number(r.stdout.trim()) : NaN;
  // A commit inside the same second as an edit is taken as after it: a mark
  // missed by a second is better than a false alarm.
  return Number.isFinite(seconds) && seconds > 0 ? (seconds + 1) * 1000 - 1 : null;
}

// ─── status ───────────────────────────────────────────────────────────────

const CHANGE = { M: "modified", T: "typechange", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict" };

/**
 * `git status --porcelain=v2 -z` as a list of entries:
 *   { path, area: "staged" | "unstaged" | "untracked" | "conflict", change,
 *     from?, submodule?, directory? }
 * A file both staged and changed again in the working tree is two entries, one
 * per area. `from` is the path a rename or copy started at, on the side that
 * renamed. An untracked folder git did not list file by file is one entry with
 * `directory: true`.
 */
export function parseStatus(out) {
  const tokens = String(out ?? "").split("\0");
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.startsWith("#")) continue;
    const kind = t[0];
    if (kind === "?") {
      const path = t.slice(2);
      const directory = path.endsWith("/");
      entries.push({ path: directory ? path.slice(0, -1) : path, area: "untracked", change: "untracked", ...(directory ? { directory: true } : {}) });
      continue;
    }
    if (kind === "!") continue;
    const fields = t.split(" ");
    if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      entries.push({ path: fields.slice(10).join(" "), area: "conflict", change: "conflict", ...(fields[2] !== "N..." ? { submodule: true } : {}) });
      continue;
    }
    if (kind !== "1" && kind !== "2") continue;
    const xy = fields[1] ?? "..";
    const submodule = (fields[2] ?? "N...") !== "N...";
    // 1 XY sub mH mI mW hH hI path / 2 XY sub mH mI mW hH hI Xscore path\0from
    const path = fields.slice(kind === "1" ? 8 : 9).join(" ");
    const from = kind === "2" ? tokens[++i] : undefined;
    const sides = [["staged", xy[0]], ["unstaged", xy[1]]];
    for (const [area, code] of sides) {
      if (!code || code === ".") continue;
      const entry = { path, area, change: CHANGE[code] ?? "modified" };
      if (from && (code === "R" || code === "C")) entry.from = from;
      if (submodule) entry.submodule = true;
      entries.push(entry);
    }
  }
  return entries;
}

/** The working tree as git reports it: `{ ok: true, entries, counts }`. */
export async function readStatus(topLevel, { filters = [] } = {}) {
  const r = await git("status", ["--porcelain=v2", "-z", "--find-renames"], { cwd: topLevel, filters });
  if (!r.ok) return { ok: false, reason: r.timedOut ? "timeout" : r.tooLarge ? "too-large" : "error" };
  const entries = parseStatus(r.stdout);
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflict: 0 };
  for (const e of entries) counts[e.area] += 1;
  return { ok: true, entries, counts };
}

// ─── diffs ────────────────────────────────────────────────────────────────

/** A unified diff's added and removed line counts. */
function countLines(patch) {
  let added = 0, removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** What a diff read answers, from git's output. */
function diffAnswer(r, sizes) {
  if (r.tooLarge) return { ok: true, tooLarge: true, limit: DIFF_CAP, ...sizes };
  if (!r.ok) return { ok: false, reason: r.timedOut ? "timeout" : "error" };
  const patch = r.stdout;
  if (/^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch)) {
    return { ok: true, binary: true, ...sizes };
  }
  return { ok: true, binary: false, patch, ...countLines(patch) };
}

/** A blob's size in bytes, or null. `spec` is `rev:path` or `:path`. */
async function blobSize(topLevel, spec) {
  const r = await git("cat-file", ["-s", spec], { cwd: topLevel, maxBytes: 64 });
  const n = r.ok ? Number(r.stdout.trim()) : NaN;
  return Number.isFinite(n) ? n : null;
}

const DIFF_ARGS = ["--find-renames", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * The diff of one status entry — staged against HEAD, unstaged against the
 * index, an untracked file as an added one. `entry` must be one readStatus
 * returned for this repository; that is the only way a path reaches here.
 *
 * `{ ok: true, binary: false, patch, added, removed }`, `{ ok: true, binary:
 * true }`, `{ ok: true, tooLarge: true, limit, oldSize, newSize }`, `{ ok:
 * true, directory: true }`, or `{ ok: false, reason }`.
 */
export async function readFileDiff(topLevel, entry, { filters = [], hasHead = true } = {}) {
  if (entry.area === "untracked") return untrackedDiff(topLevel, entry);
  const paths = entry.from ? [entry.from, entry.path] : [entry.path];
  if (entry.area === "staged") {
    const r = await git("diff", ["--cached", ...DIFF_ARGS, "--", ...paths], { cwd: topLevel, maxBytes: DIFF_CAP, filters });
    return diffAnswer(r, r.tooLarge ? {
      oldSize: hasHead ? await blobSize(topLevel, `HEAD:${entry.from ?? entry.path}`) : null,
      newSize: await blobSize(topLevel, `:${entry.path}`),
    } : {});
  }
  const r = await git("diff", [...DIFF_ARGS, "--", ...paths], { cwd: topLevel, maxBytes: DIFF_CAP, filters });
  return diffAnswer(r, r.tooLarge ? {
    oldSize: await blobSize(topLevel, `:${entry.from ?? entry.path}`),
    newSize: await fileSize(topLevel, entry.path),
  } : {});
}

/** The real path of `rel` under `topLevel`, or null when it would leave it. */
async function insideRepo(topLevel, rel) {
  if (typeof rel !== "string" || rel === "" || isAbsolute(rel)) return null;
  const full = join(topLevel, rel);
  const back = relative(topLevel, full);
  if (back === "" || back.startsWith("..") || isAbsolute(back)) return null;
  return full;
}

async function fileSize(topLevel, rel) {
  const full = await insideRepo(topLevel, rel);
  if (!full) return null;
  try { return (await lstat(full)).size; } catch { return null; }
}

/** An untracked file shown as git shows an added one, read here: git has no
 *  object for it to diff. Never follows a link out of the repository. */
async function untrackedDiff(topLevel, entry) {
  if (entry.directory) return { ok: true, directory: true };
  const full = await insideRepo(topLevel, entry.path);
  if (!full) return { ok: false, reason: "outside" };
  let st;
  try { st = await lstat(full); } catch { return { ok: false, reason: "gone" }; }
  const header = (mode) => `diff --git a/${entry.path} b/${entry.path}\nnew file mode ${mode}\n`;
  if (st.isSymbolicLink()) {
    const target = await readlink(full).catch(() => "");
    return { ok: true, binary: false, patch: `${header("120000")}--- /dev/null\n+++ b/${entry.path}\n@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`, added: 1, removed: 0 };
  }
  if (!st.isFile()) return { ok: true, directory: true };
  // The folder holding it must still be inside the repository once every link
  // on the way is resolved; a folder swapped for a link since status ran would
  // otherwise be followed.
  const [realTop, realFile] = await Promise.all([realpath(topLevel).catch(() => null), realpath(full).catch(() => null)]);
  if (!realTop || !realFile || !(realFile === realTop || realFile.startsWith(realTop.endsWith(sep) ? realTop : realTop + sep))) {
    return { ok: false, reason: "outside" };
  }
  if (st.size > DIFF_CAP) return { ok: true, tooLarge: true, limit: DIFF_CAP, oldSize: null, newSize: st.size };
  const buf = await readFile(full).catch(() => null);
  if (!buf) return { ok: false, reason: "gone" };
  const mode = process.platform !== "win32" && (st.mode & 0o111) ? "100755" : "100644";
  // git's own test: a NUL in the first 8000 bytes.
  if (buf.subarray(0, 8000).includes(0)) return { ok: true, binary: true, oldSize: null, newSize: st.size };
  const text = buf.toString("utf8");
  if (text === "") return { ok: true, binary: false, patch: header(mode), added: 0, removed: 0 };
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  const body = lines.map((l) => `+${l}`).join("\n") + "\n" + (endsWithNewline ? "" : "\\ No newline at end of file\n");
  const range = lines.length === 1 ? "1" : `1,${lines.length}`;
  return { ok: true, binary: false, patch: `${header(mode)}--- /dev/null\n+++ b/${entry.path}\n@@ -0,0 +${range} @@\n${body}`, added: lines.length, removed: 0 };
}

// ─── one commit ───────────────────────────────────────────────────────────

/**
 * `diff-tree -z --raw --numstat` as a file list: every raw record first, then
 * the numstat records for the same files in the same order.
 * [{ path, from?, change, added, removed, binary, submodule? }]
 */
export function parseCommitFiles(out) {
  const t = String(out ?? "").split("\0");
  const files = [];
  let i = 0;
  while (i < t.length && t[i].startsWith(":")) {
    const meta = t[i].slice(1).split(" ");
    const status = meta[4] ?? "M";
    const code = status[0];
    const submodule = meta[0] === "160000" || meta[1] === "160000";
    if (code === "R" || code === "C") {
      files.push({ path: t[i + 2], from: t[i + 1], change: CHANGE[code], ...(submodule ? { submodule } : {}) });
      i += 3;
    } else {
      files.push({ path: t[i + 1], change: CHANGE[code] ?? "modified", ...(submodule ? { submodule } : {}) });
      i += 2;
    }
  }
  let n = 0;
  while (i < t.length && n < files.length) {
    if (!t[i]) { i++; continue; }
    const [a, d, inline] = t[i].split("\t");
    // A rename's numstat has an empty path field followed by the two paths.
    i += inline === "" ? 3 : 1;
    const f = files[n++];
    f.binary = a === "-" && d === "-";
    f.added = f.binary ? 0 : Number(a) || 0;
    f.removed = f.binary ? 0 : Number(d) || 0;
  }
  for (; n < files.length; n++) Object.assign(files[n], { binary: false, added: 0, removed: 0 });
  return files;
}

/**
 * One commit: its record (as readLog builds one, without refs) and its files
 * against its first parent — a merge is shown as what it brought into the
 * branch, a root commit as everything added. `sha` must already look like one
 * (isShaLike); a commit the repository does not have answers `{ ok: false,
 * reason: "unknown" }`.
 */
export async function readCommit(topLevel, sha) {
  if (!isShaLike(sha)) return { ok: false, reason: "unknown" };
  const full = await resolveCommit(topLevel, sha);
  if (!full) return { ok: false, reason: "unknown" };
  const head = await git("log", ["-z", "--max-count=1", `--format=${LOG_FORMAT}`, full, "--"], { cwd: topLevel });
  if (!head.ok) return { ok: false, reason: head.timedOut ? "timeout" : "error" };
  const commit = parseLogRecord(head.stdout.split("\0")[0] ?? "");
  if (!commit) return { ok: false, reason: "error" };
  const range = commit.parents.length ? [commit.parents[0], full] : ["--root", full];
  const r = await git("diff-tree", ["-r", "-z", "--find-renames", "--raw", "--numstat", "--no-commit-id", ...range], { cwd: topLevel });
  if (!r.ok) return { ok: false, reason: r.timedOut ? "timeout" : r.tooLarge ? "too-large" : "error" };
  return { ok: true, commit, files: parseCommitFiles(r.stdout) };
}

/** The full id of a commit, or null. */
async function resolveCommit(topLevel, sha) {
  if (!isShaLike(sha)) return null;
  const r = await git("rev-parse", ["-q", "--verify", `${sha}^{commit}`], { cwd: topLevel });
  const full = r.ok ? r.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(full) ? full : null;
}

/**
 * One file's diff within a commit, against its first parent. `file` must be
 * one readCommit returned for this commit.
 */
export async function readCommitFileDiff(topLevel, commit, file) {
  const paths = file.from ? [file.from, file.path] : [file.path];
  const parent = commit.parents[0];
  const range = parent ? [parent, commit.sha] : ["--root", commit.sha];
  const r = await git("diff-tree", ["-r", "-p", ...DIFF_ARGS, ...range, "--", ...paths], { cwd: topLevel, maxBytes: DIFF_CAP });
  return diffAnswer(r, r.tooLarge ? {
    oldSize: parent ? await blobSize(topLevel, `${parent}:${file.from ?? file.path}`) : null,
    newSize: await blobSize(topLevel, `${commit.sha}:${file.path}`),
  } : {});
}
