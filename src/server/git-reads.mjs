// The four reads the git view is built from — the history, the working tree's
// status, one file's diff, and one commit — each a parse of git's own
// machine-readable output, run through git-run.mjs.
//
// Nothing here decides WHICH repository: the caller hands in a top level it
// resolved from a session's folder (git-repo.mjs), and for the diffs an entry
// git itself reported. A path never comes from a request on its own.
import { access, lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { classifyFailure, git } from "./git-run.mjs";

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
/** The most a read of LOG_FORMAT may print. A commit message has no limit of
 *  its own (a generated changelog, a squash listing thousands of commits),
 *  and one past the usual cap would fail the whole history. */
const LOG_BYTES = 64 << 20;
/** The most the read of every ref may print: a pull-request refspec on a busy
 *  project, or a tag per build, can pass a hundred thousand refs. */
const ALL_REFS_BYTES = 64 << 20;

/** The reasons a read inside a repository answers with; anything else that
 *  went wrong is "error". "not-downloaded" is a partial clone that does not
 *  hold the objects the read needs (the deck never fetches them), "unsafe" a
 *  filter driver that could not be emptied (git-run.mjs). */
const READ_FAILURES = new Set(["timeout", "too-large", "not-downloaded", "unsafe"]);
export function readFailure(r) {
  const kind = classifyFailure(r);
  return READ_FAILURES.has(kind) ? kind : "error";
}

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

/** One record of LOG_FORMAT, or null. `hasBody`: the message says more than
 *  its subject line (trailers count, as they do in any client). */
export function parseLogRecord(record) {
  const parts = record.replace(/^\n+/, "").split(US);
  if (parts.length < 7) return null;
  const [sha, parents, name, email, date, subject, ...rest] = parts;
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null;
  const body = rest.join(US);
  return {
    sha,
    parents: parents ? parents.split(" ").filter(Boolean) : [],
    author: { name, email },
    date,
    subject,
    trailers: parseTrailers(body),
    hasBody: /\S/.test(body),
  };
}

const REF_LINE = "--format=%(objectname)%00%(*objectname)%00%(refname)%00%(symref)%00%(upstream)";

/** Every branch, remote-tracking branch and tag, by the commit it names; a
 *  branch whose configured upstream is a remote-tracking branch has it in its
 *  commit's `upstream`, by name (`{ develop: "origin/develop" }`). When there
 *  are too many to read, HEAD's branch and its upstream alone (headRefLines). */
async function refsByCommit(topLevel, head, maxBytes = ALL_REFS_BYTES) {
  const r = await git("for-each-ref", [REF_LINE, "refs/heads", "refs/remotes", "refs/tags"], { cwd: topLevel, maxBytes });
  const map = new Map();
  const stdout = r.ok ? r.stdout : await headRefLines(topLevel, head);
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [obj, peeled, ref, symref, upstream] = line.split("\0");
    // origin/HEAD and its kind point at another ref, which is listed itself.
    if (symref) continue;
    const at = peeled || obj;
    const slot = map.get(at) ?? { local: [], remote: [], tags: [], head: false };
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice(11);
      slot.local.push(name);
      if (upstream?.startsWith("refs/remotes/")) (slot.upstream ??= {})[name] = upstream.slice(13);
    } else if (ref.startsWith("refs/remotes/")) slot.remote.push(ref.slice(13));
    else if (ref.startsWith("refs/tags/")) slot.tags.push(ref.slice(10));
    map.set(at, slot);
  }
  return map;
}

/** refsByCommit's lines for HEAD's branch and the remote-tracking branch it
 *  follows: what the history needs most when every ref cannot be read, so
 *  HEAD is still shown on its branch and what it has not pushed is still
 *  flagged. Both names are git's own (symbolic-ref, %(upstream)), so each is
 *  a ref name and never an option. Empty for a detached HEAD. */
async function headRefLines(topLevel, head) {
  if (!head?.branch || head.detached) return "";
  const one = (ref) => git("for-each-ref", ["--count=1", REF_LINE, ref], { cwd: topLevel, maxBytes: 64 << 10 });
  const own = await one(`refs/heads/${head.branch}`);
  if (!own.ok) return "";
  const upstream = own.stdout.split("\0")[4]?.trim() ?? "";
  if (!upstream.startsWith("refs/remotes/")) return own.stdout;
  const up = await one(upstream);
  return own.stdout + (up.ok ? up.stdout : "");
}

/** How many commits of HEAD's own line the history lists after the window
 *  when HEAD is older than it. */
export const HEAD_LINE_MAX = 20;

/** The branch names a branch is measured against, besides the remote's own
 *  default: the history's three tones (web/git-graph-layout.ts keeps the same
 *  list, and a test holds the two together). */
export const TRUNK_NAMES = ["develop", "development", "dev", "main", "master", "trunk"];

/** How long `--topo-order` may take on a repository with no commit-graph
 *  before the history is read the streaming way instead (readLog). */
export const TOPO_BUDGET_MS = 2_000;
/** The repositories (by common git directory) whose history took longer than
 *  that, so it is not tried again while the deck runs. */
const slowTopo = new Set();
const MAX_SLOW_TOPO = 256;

/**
 * The last LOG_LIMIT commits across every branch, remote-tracking branch, tag
 * and HEAD, in topological order — parents are what the graph's lanes are
 * drawn from, so a child always comes before its parents. Stashes and notes
 * are refs too and are left out: neither is history anybody committed to.
 *
 * WHY TWO WAYS. `--topo-order` is cheap with a commit-graph file, whose
 * generation numbers let git stop walking early, and on any repository of
 * modest size; on a large one with no commit-graph (a fresh clone has none
 * until gc writes it) git walks the whole history first — seven to ten seconds
 * on a million commits, past the read's timeout. Its default order streams
 * and stops at the limit. So `--topo-order` is used with a commit-graph, and
 * without one for as long as it answers within TOPO_BUDGET_MS; a repository
 * that takes longer is read in the default order from then on, the window put
 * in graph order here the way git's own topological sort does it
 * (graphOrder). That window is the newest commits by date rather than the
 * first of git's topological walk; both are the recent history, and every
 * commit still comes before its parents. `commonDir` is where to look for the
 * commit-graph, and what the slow repository is remembered by.
 *
 * HEAD OLDER THAN THE WINDOW. In a busy repository a branch a day or two old
 * is already past the newest LOG_LIMIT commits, and the history would list
 * none of what the view is about. Then HEAD and up to HEAD_LINE_MAX commits of
 * its first-parent line follow the window, flagged `outsideWindow`, up to the
 * first one already listed. The commits between them and the window are not
 * listed, so the page cannot tell which of them the branch HEAD is measured
 * against already has; each carries `base`, git's answer to that (headLine).
 *
 * Each commit says whether its message has a body (`hasBody`), and the ones
 * HEAD has not pushed to its upstream yet carry `unpushed: true`
 * (withUnpushed).
 *
 * `{ ok: true, commits }`, or `{ ok: false, reason }` for a read that failed.
 */
export async function readLog(topLevel, head, { limit = LOG_LIMIT, commonDir = null, topoBudgetMs = TOPO_BUDGET_MS, defaultBranch = null, refsBytes = ALL_REFS_BYTES } = {}) {
  const refs = await refsByCommit(topLevel, head, refsBytes);
  const starts = ["--branches", "--remotes", "--tags"];
  if (head?.sha) starts.push("HEAD");
  if (!head?.sha && refs.size === 0) return { ok: true, commits: [] };
  const read = (topo, timeout) =>
    git("log", ["-z", ...(topo ? ["--topo-order"] : []), `--max-count=${limit}`, `--format=${LOG_FORMAT}`, ...starts, "--"], { cwd: topLevel, maxBytes: LOG_BYTES, ...(timeout ? { timeout } : {}) });
  const key = commonDir || topLevel;
  const graph = await hasCommitGraph(commonDir);
  const finish = async (commits) => withUnpushed(topLevel, await withHeadLine(topLevel, commits, refs, head, defaultBranch), refs, head, limit);
  if (graph || !slowTopo.has(key)) {
    const r = await read(true, graph ? null : topoBudgetMs);
    if (r.ok) return { ok: true, commits: await finish(withRefs(r.stdout, refs, head)) };
    if (graph || !r.timedOut) return { ok: false, reason: readFailure(r) };
    slowTopo.add(key);
    while (slowTopo.size > MAX_SLOW_TOPO) slowTopo.delete(slowTopo.values().next().value);
  }
  const r = await read(false, null);
  if (!r.ok) return { ok: false, reason: readFailure(r) };
  return { ok: true, commits: await finish(graphOrder(withRefs(r.stdout, refs, head))) };
}

/**
 * The remote-tracking branch HEAD's branch is configured to follow, by name
 * (`origin/develop`), when there is one and it still exists; null for a
 * detached or unborn HEAD, a branch with no upstream, an upstream that is
 * another local branch, or one that is gone.
 */
function headUpstream(refs, head) {
  if (!head?.sha || head.detached || !head.branch) return null;
  let upstream = null;
  const remotes = new Set();
  for (const slot of refs.values()) {
    if (slot.local.includes(head.branch)) upstream = slot.upstream?.[head.branch] ?? null;
    for (const r of slot.remote) remotes.add(r);
  }
  return upstream && remotes.has(upstream) ? upstream : null;
}

/**
 * The listed commits HEAD has and its upstream does not — what has not been
 * pushed — each flagged `unpushed: true`: `git rev-list <upstream>..HEAD`, as
 * many as the history holds. With no upstream to measure by nothing is
 * flagged, rather than a guess; a read that fails flags nothing either. The
 * upstream is a full ref name git itself reported (`refs/remotes/…`), so it
 * can never be read as an option, and a ref name cannot hold `..`.
 */
async function withUnpushed(topLevel, commits, refs, head, limit) {
  const upstream = headUpstream(refs, head);
  if (!upstream || !commits.length) return commits;
  const r = await git("rev-list", [`--max-count=${limit}`, `refs/remotes/${upstream}..HEAD`, "--"], { cwd: topLevel });
  if (!r.ok) return commits;
  const ahead = new Set(r.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  if (!ahead.size) return commits;
  return commits.map((c) => (ahead.has(c.sha) ? { ...c, unpushed: true } : c));
}

/** The window, and after it HEAD's own line when HEAD is not in it (readLog).
 *  A read of that line that fails leaves the window as it is. */
async function withHeadLine(topLevel, commits, refs, head, defaultBranch) {
  if (!head?.sha || !isShaLike(head.sha) || commits.some((c) => c.sha === head.sha)) return commits;
  const r = await git("log", ["-z", "--first-parent", `--max-count=${HEAD_LINE_MAX}`, `--format=${LOG_FORMAT}`, head.sha, "--"], { cwd: topLevel, maxBytes: LOG_BYTES });
  if (!r.ok) return commits;
  const listed = new Set(commits.map((c) => c.sha));
  const line = [];
  for (const c of withRefs(r.stdout, refs, head)) {
    if (listed.has(c.sha)) break;
    line.push({ ...c, outsideWindow: true });
  }
  const bases = baseRefs(refs, head, defaultBranch);
  if (!line.length || !bases.length) return [...commits, ...line];
  // HEAD's own commits: on its line and on none of the branches it is
  // measured against. The rest of the line is what they already have.
  const own = await git("rev-list", ["--first-parent", `--max-count=${HEAD_LINE_MAX}`, head.sha, "--not", ...bases, "--"], { cwd: topLevel });
  if (!own.ok) return [...commits, ...line];
  const mine = new Set(own.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  return [...commits, ...line.map((c) => ({ ...c, base: !mine.has(c.sha) }))];
}

/**
 * The refs HEAD's branch is measured against, as the history's tones measure
 * it: a trunk (the remote's default branch, or one of TRUNK_NAMES) against its
 * own remote-tracking branches, so its own commits are the ones not pushed;
 * any other branch, or a detached HEAD, against every trunk there is, local
 * and remote-tracking.
 */
function baseRefs(refs, head, defaultBranch) {
  const names = new Set([...(defaultBranch ? [defaultBranch] : []), ...TRUNK_NAMES]);
  const branch = head && !head.detached ? head.branch : null;
  const out = new Set();
  for (const slot of refs.values()) {
    for (const r of slot.remote) {
      const name = r.slice(r.indexOf("/") + 1);
      if (branch && names.has(branch) ? name === branch : names.has(name)) out.add(`refs/remotes/${r}`);
    }
    if (branch && names.has(branch)) continue;
    for (const l of slot.local) if (names.has(l) && l !== branch) out.add(`refs/heads/${l}`);
  }
  return [...out];
}

/** Whether the repository whose common git directory is `commonDir` has a
 *  commit-graph — a single file or a chain of them. False when not known. */
export async function hasCommitGraph(commonDir) {
  if (typeof commonDir !== "string" || !commonDir) return false;
  for (const rel of [["objects", "info", "commit-graph"], ["objects", "info", "commit-graphs", "commit-graph-chain"]]) {
    try { await access(join(commonDir, ...rel)); return true; } catch { /* not this one */ }
  }
  return false;
}

/**
 * `commits` — in the order git's walk gave them, newest first — put in graph
 * order, the way `git log --topo-order` sorts what it walked: the tips first,
 * in walk order, then each commit once every one of its children here is
 * shown, following one line of history as far as it goes before taking up
 * another, so lines are not interleaved. Parents outside `commits` are
 * ignored. A pure function of its input.
 */
export function graphOrder(commits) {
  const bySha = new Map();
  const waiting = new Map(); // sha -> children here not shown yet
  for (const c of commits) { bySha.set(c.sha, c); waiting.set(c.sha, 0); }
  for (const c of commits) for (const p of c.parents) if (waiting.has(p)) waiting.set(p, waiting.get(p) + 1);
  // A stack: the first tip on top, and a commit's last parent pushed last, so
  // it is shown next — git's own LIFO for this sort.
  const stack = commits.filter((c) => waiting.get(c.sha) === 0).reverse();
  const out = [];
  while (stack.length) {
    const c = stack.pop();
    out.push(c);
    for (const p of c.parents) {
      if (!waiting.has(p)) continue;
      const left = waiting.get(p) - 1;
      waiting.set(p, left);
      if (left === 0) stack.push(bySha.get(p));
    }
  }
  // A cycle cannot happen in git; should the input ever hold one, nothing is lost.
  if (out.length < commits.length) for (const c of commits) if (!out.includes(c)) out.push(c);
  return out;
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
      ...(slot?.upstream ? { upstream: slot.upstream } : {}),
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
 * what an amend or a rebase left behind, kept only by the reflog. Each says
 * whether HEAD has it, and how it stands against HEAD's base and upstream
 * (withReach), since the commits joining it to the window are not listed.
 *
 * `{ ok: true, commits }`, or `{ ok: false, reason }` for a read that failed.
 */
export async function readCommitsBySha(topLevel, shas, head, { defaultBranch = null } = {}) {
  const list = [...new Set((Array.isArray(shas) ? shas : []).filter((s) => typeof s === "string" && STORED_SHA.test(s)))];
  if (!list.length) return { ok: true, commits: [] };
  const ends = ["--branches", "--remotes", "--tags", ...(head?.sha ? ["HEAD"] : [])];
  // What no ref reaches: the named commits that left the history, with their
  // own ancestors that left with them.
  const lost = await git("rev-list", ["--ignore-missing", ...list, "--not", ...ends, "--"], { cwd: topLevel });
  if (!lost.ok) return { ok: false, reason: readFailure(lost) };
  const gone = new Set(lost.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  const refs = await refsByCommit(topLevel, head);
  const r = await git("log", ["-z", "--no-walk", "--ignore-missing", `--format=${LOG_FORMAT}`, ...list, "--"], { cwd: topLevel, maxBytes: LOG_BYTES });
  if (!r.ok) return { ok: false, reason: readFailure(r) };
  const kept = withRefs(r.stdout, refs, head).filter((c) => !gone.has(c.sha));
  return { ok: true, commits: await withReach(topLevel, kept, refs, head, defaultBranch) };
}

const shaSet = (stdout) => new Set(stdout.split("\n").map((l) => l.trim()).filter(Boolean));

/**
 * Commits read on their own, each flagged `onHead: true` when HEAD has it,
 * and those then `base` (whether the branches HEAD is measured against have
 * it too, as withHeadLine says it) and `unpushed: true` (HEAD's upstream does
 * not have it, as withUnpushed says it). A read that fails flags nothing.
 */
async function withReach(topLevel, commits, refs, head, defaultBranch) {
  if (!commits.length || !head?.sha || !isShaLike(head.sha)) return commits;
  const away = await git("rev-list", [...commits.map((c) => c.sha), "--not", head.sha, "--"], { cwd: topLevel });
  if (!away.ok) return commits;
  const off = shaSet(away.stdout);
  const on = commits.map((c) => c.sha).filter((sha) => !off.has(sha));
  if (!on.length) return commits;
  const bases = baseRefs(refs, head, defaultBranch);
  const upstream = headUpstream(refs, head);
  const [own, ahead] = await Promise.all([
    bases.length ? git("rev-list", [...on, "--not", ...bases, "--"], { cwd: topLevel }) : null,
    upstream ? git("rev-list", [...on, "--not", `refs/remotes/${upstream}`, "--"], { cwd: topLevel }) : null,
  ]);
  const mine = own?.ok ? shaSet(own.stdout) : null;
  const unpushed = ahead?.ok ? shaSet(ahead.stdout) : null;
  const onHead = new Set(on);
  return commits.map((c) => (onHead.has(c.sha)
    ? { ...c, onHead: true, ...(mine ? { base: !mine.has(c.sha) } : {}), ...(unpushed?.has(c.sha) ? { unpushed: true } : {}) }
    : c));
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
  if (!r.ok) return { ok: false, reason: readFailure(r) };
  const entries = parseStatus(r.stdout);
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflict: 0 };
  for (const e of entries) counts[e.area] += 1;
  return { ok: true, entries, counts };
}

// ─── line counts for the working tree's entries ───────────────────────────

/** The most untracked files read to count their lines, per status read; the
 *  rest are left without counts rather than read. */
export const UNTRACKED_COUNT_MAX_FILES = 200;
/** And the most bytes read for that in all. */
export const UNTRACKED_COUNT_MAX_BYTES = 8 << 20;
/** How many untracked files are read at once. */
const UNTRACKED_COUNT_PARALLEL = 8;

/**
 * `diff --numstat -z` as a list: [{ path, from?, added, removed, binary }].
 * A record is `added\tremoved\tpath`, or for a rename `added\tremoved\t`
 * followed by the two paths as records of their own; a binary file counts as
 * `-\t-`.
 */
export function parseNumstat(out) {
  const t = String(out ?? "").split("\0");
  const rows = [];
  for (let i = 0; i < t.length; i++) {
    const rec = t[i];
    if (!rec) continue;
    const a = rec.indexOf("\t");
    const b = a < 0 ? -1 : rec.indexOf("\t", a + 1);
    if (b < 0) continue;
    const added = rec.slice(0, a);
    const removed = rec.slice(a + 1, b);
    let path = rec.slice(b + 1);
    let from;
    if (path === "") {
      from = t[i + 1];
      path = t[i + 2];
      i += 2;
      if (!from || !path) continue;
    }
    const binary = added === "-" && removed === "-";
    rows.push({
      path,
      ...(from !== undefined ? { from } : {}),
      added: binary ? 0 : Number(added) || 0,
      removed: binary ? 0 : Number(removed) || 0,
      binary,
    });
  }
  return rows;
}

/** One side's numstat, keyed by the path an entry carries (and the `from` of a
 *  rename, so a rename is matched only to the entry that names both ends), or
 *  null when git could not answer. */
async function numstatSide(topLevel, cached, filters) {
  const r = await git("diff", [...(cached ? ["--cached"] : []), "--numstat", "-z", "--find-renames"], { cwd: topLevel, filters });
  if (!r.ok) return null;
  const map = new Map();
  for (const row of parseNumstat(r.stdout)) {
    const key = `${row.from ?? ""}\0${row.path}`;
    const held = map.get(key);
    // One path twice (a change of type shown as a delete and an add) is what
    // its diff shows: both halves.
    if (held) map.set(key, { added: held.added + row.added, removed: held.removed + row.removed, binary: held.binary || row.binary });
    else map.set(key, { added: row.added, removed: row.removed, binary: row.binary });
  }
  return map;
}

/** What countEntries sets on an entry: the three fields a commit's files carry. */
const countFields = (c) => (c.binary ? { added: 0, removed: 0, binary: true } : { added: c.added, removed: c.removed, binary: false });

/**
 * An untracked file's lines, counted the way its diff (untrackedDiff) shows
 * them, or null when it is not counted: a folder, a file past DIFF_CAP or past
 * the read budget, one that is gone, or one whose path leaves the repository.
 * A link is the one line its diff shows, and is never followed.
 */
async function untrackedCounts(topLevel, realTop, entry, budget) {
  if (entry.directory || entry.submodule) return null;
  const full = await insideRepo(topLevel, entry.path);
  if (!full) return null;
  let st;
  try { st = await lstat(full); } catch { return null; }
  if (st.isSymbolicLink()) return { added: 1, removed: 0, binary: false };
  if (!st.isFile() || st.size > DIFF_CAP) return null;
  if (budget.files <= 0 || budget.bytes < st.size) return null;
  budget.files -= 1;
  budget.bytes -= st.size;
  const real = await realpath(full).catch(() => null);
  if (!realTop || !real || !real.startsWith(realTop.endsWith(sep) ? realTop : realTop + sep)) return null;
  const buf = await readFile(full).catch(() => null);
  if (!buf || buf.length > DIFF_CAP) return null;
  // git's own test: a NUL in the first 8000 bytes.
  if (buf.subarray(0, 8000).includes(0)) return { added: 0, removed: 0, binary: true };
  let lines = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) lines++;
  if (buf.length && buf[buf.length - 1] !== 10) lines++;
  return { added: lines, removed: 0, binary: false };
}

/**
 * `entries` (readStatus's, for this repository) with the line counts their
 * diffs would show — `added`, `removed` and `binary`, as a commit's files
 * carry them. Staged entries are counted from `diff --cached --numstat`,
 * unstaged ones from `diff --numstat`, untracked files by reading them (no
 * more than UNTRACKED_COUNT_MAX_FILES and UNTRACKED_COUNT_MAX_BYTES of them,
 * each no larger than DIFF_CAP). An entry left without the three fields is
 * one whose counts are not known: a conflict, a submodule, an untracked
 * folder, a file past a cap, or a side git could not answer for. The entries
 * given are not changed; new ones are answered.
 */
export async function countEntries(topLevel, entries, { filters = [] } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const wants = (area) => list.some((e) => e.area === area && !e.submodule);
  const [staged, unstaged, realTop] = await Promise.all([
    wants("staged") ? numstatSide(topLevel, true, filters) : null,
    wants("unstaged") ? numstatSide(topLevel, false, filters) : null,
    wants("untracked") ? realpath(topLevel).catch(() => null) : null,
  ]);
  const out = list.map((e) => ({ ...e }));
  const budget = { files: UNTRACKED_COUNT_MAX_FILES, bytes: UNTRACKED_COUNT_MAX_BYTES };
  const untracked = [];
  for (const e of out) {
    if (e.submodule || e.area === "conflict") continue;
    if (e.area === "untracked") { untracked.push(e); continue; }
    const side = e.area === "staged" ? staged : unstaged;
    const c = side?.get(`${e.from ?? ""}\0${e.path}`);
    if (c) Object.assign(e, countFields(c));
  }
  for (let i = 0; i < untracked.length; i += UNTRACKED_COUNT_PARALLEL) {
    const batch = untracked.slice(i, i + UNTRACKED_COUNT_PARALLEL);
    const counted = await Promise.all(batch.map((e) => untrackedCounts(topLevel, realTop, e, budget)));
    batch.forEach((e, k) => { if (counted[k]) Object.assign(e, countFields(counted[k])); });
  }
  return out;
}

// ─── diffs ────────────────────────────────────────────────────────────────

/** A unified diff's added and removed line counts. The patch is one file's,
 *  so its `---`/`+++` header lines all come before the first hunk; after it, a
 *  line that starts with `--` or `++` is a changed line like any other. */
function countLines(patch) {
  let added = 0, removed = 0, inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** What a diff read answers, from git's output. */
function diffAnswer(r, sizes) {
  if (r.tooLarge) return { ok: true, tooLarge: true, limit: DIFF_CAP, ...sizes };
  if (!r.ok) return { ok: false, reason: readFailure(r) };
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
 * index, a conflicted one against HEAD, an untracked file as an added one. `entry` must be one readStatus
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
  // A conflicted file against HEAD: git's own diff of an unmerged path is a
  // combined diff of both sides (or only "Unmerged path"), where this one is
  // an ordinary patch whose conflict markers are added lines.
  const against = entry.area === "conflict" && hasHead ? ["HEAD"] : [];
  const r = await git("diff", [...DIFF_ARGS, ...against, "--", ...paths], { cwd: topLevel, maxBytes: DIFF_CAP, filters });
  return diffAnswer(r, r.tooLarge ? {
    oldSize: await blobSize(topLevel, `${against.length ? "HEAD" : ""}:${entry.from ?? entry.path}`),
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

/** The most of a commit message's body one commit read answers with, in
 *  bytes; past it the body is cut and the commit says `clipped: true`. */
export const BODY_MAX = 64 << 10;

// LOG_FORMAT's fields with the committer's name, email and date (strict ISO)
// after the author's. The body is last for the same reason.
const COMMIT_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%s", "%b"].join("%x1f");

/**
 * One record of COMMIT_FORMAT: the record readLog builds (parseLogRecord's
 * shape, trailers included) plus who committed it and when, and the message
 * after its subject — trailing blank lines dropped, at most BODY_MAX bytes,
 * `clipped: true` when it was cut. Null for a record that is not one.
 */
export function parseCommitRecord(record) {
  const parts = String(record ?? "").replace(/^\n+/, "").split(US);
  if (parts.length < 10) return null;
  const [sha, parents, name, email, date, cName, cEmail, cDate, subject, ...rest] = parts;
  const raw = rest.join(US);
  const commit = parseLogRecord([sha, parents, name, email, date, subject, raw].join(US));
  if (!commit) return null;
  let body = raw.replace(/\s+$/, "");
  let clipped = false;
  if (Buffer.byteLength(body) > BODY_MAX) {
    // Cut on a character, never inside one: a sequence the cut split decodes
    // to U+FFFD at the end, which is dropped.
    body = Buffer.from(body).subarray(0, BODY_MAX).toString("utf8").replace(/�+$/, "");
    clipped = true;
  }
  return { ...commit, committer: { name: cName, email: cEmail, date: cDate }, body, ...(clipped ? { clipped } : {}) };
}

/**
 * One commit: its record (as readLog builds one, without refs, plus its
 * `committer` and its message `body`, parseCommitRecord) and its files
 * against its first parent — a merge is shown as what it brought into the
 * branch, a root commit as everything added. `sha` must already look like one
 * (isShaLike); a commit the repository does not have answers `{ ok: false,
 * reason: "unknown" }`.
 *
 * A partial clone holds a commit's trees but not every file's content, and the
 * line counts and rename detection need the content. There the files are
 * listed without counts (each `added` and `removed` 0) — renames as renames
 * while git can tell them by the trees alone, else as a delete and an add —
 * and the answer says `notDownloaded: true`.
 *
 * A commit whose file list runs past the read's cap (a vendored import of
 * tens of thousands of files) is still answered whole, with no files and
 * `filesTooLarge: true`: its message, author and SHA are not lost with them.
 */
export async function readCommit(topLevel, sha) {
  if (!isShaLike(sha)) return { ok: false, reason: "unknown" };
  const full = await resolveCommit(topLevel, sha);
  if (!full) return { ok: false, reason: "unknown" };
  const head = await git("log", ["-z", "--max-count=1", `--format=${COMMIT_FORMAT}`, full, "--"], { cwd: topLevel });
  if (!head.ok) return { ok: false, reason: readFailure(head) };
  const commit = parseCommitRecord(head.stdout.split("\0")[0] ?? "");
  if (!commit) return { ok: false, reason: "error" };
  const range = commit.parents.length ? [commit.parents[0], full] : ["--root", full];
  const tree = (how) => git("diff-tree", ["-r", "-z", ...how, "--no-commit-id", ...range], { cwd: topLevel });
  let r = await tree(["--find-renames", "--raw", "--numstat"]);
  // A treeless clone's older trees were never downloaded, and a git that
  // will not fetch them says only that it could not read one.
  if (!r.ok && readFailure(r) === "error" && /unable to read tree|missing tree/i.test(r.stderr) && await isPartialClone(topLevel)) {
    return { ok: false, reason: "not-downloaded" };
  }
  if (!r.ok && readFailure(r) === "not-downloaded") {
    for (const how of [["--find-renames", "--raw"], ["--no-renames", "--raw"]]) {
      const bare = await tree(how);
      if (bare.ok) return { ok: true, commit, files: parseCommitFiles(bare.stdout), notDownloaded: true };
      if (readFailure(bare) !== "not-downloaded") { r = bare; break; }
    }
  }
  if (!r.ok && r.tooLarge) return { ok: true, commit, files: [], filesTooLarge: true };
  if (!r.ok) return { ok: false, reason: readFailure(r) };
  return { ok: true, commit, files: parseCommitFiles(r.stdout) };
}

/** Whether the repository is a partial clone: one with a remote it would
 *  fetch a missing object from. Tells an object never downloaded from one a
 *  repository lost. */
async function isPartialClone(topLevel) {
  const r = await git("config", ["-z", "--get-regexp", "^(extensions\\.partialclone|remote\\..+\\.promisor)$"], { cwd: topLevel, maxBytes: 64 << 10 });
  if (!r.ok) return false;
  return r.stdout.split("\0").some((entry) => {
    const [key, value = ""] = entry.split("\n");
    return key !== "" && !/^(false|no|off|0)$/i.test(value.trim());
  });
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
