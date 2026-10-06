// Spotting the commits an agent makes, from the shell calls that make them.
//
// A commit made with `git commit` prints one summary line per commit:
//
//   [main 1a2b3c4] subject                  an ordinary commit
//   [main (root-commit) 1a2b3c4] subject    the first commit of a repo
//   [detached HEAD 1a2b3c4] subject         no branch checked out
//   [feature/x/y 1a2b3c4] subject           a branch name may hold slashes
//
// cherry-pick and revert print the same line. So a candidate needs two things
// from one finished call: a command that runs `git … commit` (or cherry-pick
// / revert) — through `-C <dir>`, `-c k=v`, `cd x &&`, `env`, `sh -c` and the
// rest of what a real command line holds — and that summary line in what the
// call printed. The command alone is not enough (it may have failed, or had
// nothing to commit) and the line alone is not enough (a `cat` or a `git log`
// can print one), so both are required, and the candidate is still only a
// candidate: `confirm`, injected where it is recorded, checks it against the
// repo.
//
// WHAT THIS CANNOT SEE, AND SAYS SO. A commit that prints nothing produces
// nothing here: `git commit -q`, output redirected away (`> /dev/null`, a
// pipe into `tail -0`), a commit made by a script or a tool the agent ran
// (`make release`, a hook, an IDE), plumbing (`commit-tree` + `update-ref`).
// Those commits get no "seen" mark. The trailer reader
// (agent-git-trailers.mjs) is the weaker fallback for some of them; the rest
// stay unattributed, which the view says rather than guessing.
//
// Pure: no git runs, no file is read. Paths are resolved lexically.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

// ─── git's summary line ─────────────────────────────────────────────────────

// The head is lazy so the FIRST ` <sha>] ` on the line ends it: a subject may
// hold brackets. The SHA is lower-case hex, at least git's default abbreviation.
const SUMMARY = /^\[(.+?) ([0-9a-f]{7,64})\](?: (.*))?$/;
// `(root-commit)`, or what a localized git prints in its place.
const ROOT_MARK = /^(.*\S) \(([^()]+)\)$/;

/**
 * @typedef {object} CommitSummary
 * @property {string | null} branch  null on a detached HEAD
 * @property {boolean} detached
 * @property {boolean} rootCommit    the repo's first commit
 * @property {string} shortSha
 * @property {string} subject
 */

/**
 * Every commit summary line in a call's output, in order, each once.
 *
 * A branch name holds no spaces, so a head that does is a detached HEAD in
 * whatever language git speaks ("detached HEAD", "losgelöster HEAD", …).
 *
 * @param {unknown} text
 * @returns {CommitSummary[]}
 */
export function parseCommitSummaries(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  const seen = new Set();
  for (const raw of text.split("\n")) {
    const m = SUMMARY.exec(raw.replace(/\r$/, ""));
    if (!m) continue;
    let head = m[1];
    let rootCommit = false;
    const root = ROOT_MARK.exec(head);
    if (root) { head = root[1]; rootCommit = true; }
    const detached = /\s/.test(head);
    const subject = m[3] ?? "";
    const key = `${m[2]}\0${subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ branch: detached ? null : head, detached, rootCommit, shortSha: m[2], subject });
  }
  return out;
}

// ─── the command line ───────────────────────────────────────────────────────

/** Heredoc bodies out of a command, so a message written through one — Claude
 *  commits with `-m "$(cat <<'EOF' … EOF)"` — cannot unbalance the quotes. A
 *  `<<` whose terminator line never comes is left alone. */
function stripHeredocs(src) {
  const re = /<<(-?)[ \t]*(["']?)([A-Za-z_][\w.-]*)\2/g;
  let out = "";
  let from = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index < from) continue;
    const nl = src.indexOf("\n", re.lastIndex);
    if (nl < 0) break;
    let at = nl + 1;
    let end = -1;
    while (at <= src.length) {
      const next = src.indexOf("\n", at);
      const line = src.slice(at, next < 0 ? src.length : next).replace(/\r$/, "");
      if ((m[1] ? line.replace(/^\t+/, "") : line) === m[3]) { end = next < 0 ? src.length : next; break; }
      if (next < 0) break;
      at = next + 1;
    }
    if (end < 0) continue;
    out += src.slice(from, nl + 1);
    from = end;
    re.lastIndex = end;
  }
  return out + src.slice(from);
}

/** The end of a `$( … )` that opens just before `i`. */
function skipSubst(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j + 1; continue; }
    if (c === '"') { i = readDouble(src, i + 1)[1]; continue; }
    if (c === "`") { const j = src.indexOf("`", i + 1); i = j < 0 ? src.length : j + 1; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
    i++;
  }
  return src.length;
}

/** A double-quoted string from just after its opening quote: its text, the
 *  index after its closing quote, and whether there was one. Command
 *  substitutions are kept as written. */
function readDouble(src, i) {
  let v = "";
  while (i < src.length) {
    const c = src[i];
    if (c === '"') return [v, i + 1, true];
    if (c === "\\" && i + 1 < src.length) {
      const n = src[i + 1];
      if (n === "\n") { i += 2; continue; }
      v += '$`"\\'.includes(n) ? n : c + n;
      i += 2;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") { const j = skipSubst(src, i + 2); v += src.slice(i, j); i = j; continue; }
    if (c === "`") { const j = src.indexOf("`", i + 1); const e = j < 0 ? src.length : j + 1; v += src.slice(i, e); i = e; continue; }
    v += c;
    i++;
  }
  return [v, i, false];
}

/** Words and control operators, the way a POSIX shell splits a line — enough
 *  of it to find the commands, not to run them. Redirections and their targets
 *  are dropped. */
function tokenize(src) {
  const toks = [];
  let word = null;
  let dropNext = false;
  const flush = () => {
    if (word === null) return;
    if (dropNext) dropNext = false;
    else toks.push({ w: word });
    word = null;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r") { flush(); i++; continue; }
    if (c === "\n") { flush(); toks.push({ op: ";" }); i++; continue; }
    if (c === "#" && word === null) { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl; continue; }
    if (c === ";" || c === "&" || c === "|") {
      flush();
      let op = c;
      if (src[i + 1] === c || (c === "|" && src[i + 1] === "&")) { op += src[i + 1]; i++; }
      toks.push({ op });
      i++;
      continue;
    }
    if (c === "(" || c === ")") { flush(); toks.push({ op: c }); i++; continue; }
    if (c === "<" || c === ">") {
      // `2>&1`, `> file`, `<<<` … — the fd digits before it and the target
      // after it are not words of the command.
      if (word !== null && /^\d+$/.test(word)) word = null;
      flush();
      while (src[i] === "<" || src[i] === ">") i++;
      if (src[i] === "&") { i++; while (/[\d-]/.test(src[i] ?? "")) i++; continue; }
      if (src[i] === "(") { i = skipSubst(src, i + 1); continue; }
      dropNext = true;
      continue;
    }
    if (c === "\\") {
      if (src[i + 1] === "\n") { i += 2; continue; }
      word = (word ?? "") + (src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return null; // unbalanced: not a command line this can read
      word = (word ?? "") + src.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const [v, j, closed] = readDouble(src, i + 1);
      if (!closed) return null;
      word = (word ?? "") + v;
      i = j;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") { const j = skipSubst(src, i + 2); word = (word ?? "") + src.slice(i, j); i = j; continue; }
    if (c === "`") { const j = src.indexOf("`", i + 1); const e = j < 0 ? src.length : j + 1; word = (word ?? "") + src.slice(i, e); i = e; continue; }
    word = (word ?? "") + c;
    i++;
  }
  flush();
  return toks;
}

const WINDOWS_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const flavour = (...ps) => (ps.some(p => typeof p === "string" && WINDOWS_ABS.test(p)) ? win32 : posix);

/** `dir` resolved from `base`, or null when it cannot be known from the text:
 *  a variable, a command substitution, `cd -`, or no base to resolve against. */
function resolveDir(base, dir, home) {
  if (typeof dir !== "string" || dir === "" || /[$`]/.test(dir) || dir === "-") return null;
  if (dir === "~" || dir.startsWith("~/") || dir.startsWith("~\\")) {
    if (!home) return null;
    dir = flavour(home).join(home, dir.slice(2));
  }
  const p = flavour(dir, base);
  if (p.isAbsolute(dir) && (p === posix || WINDOWS_ABS.test(dir))) return p.normalize(dir);
  if (typeof base !== "string" || !p.isAbsolute(base)) return null;
  return p.resolve(base, dir);
}

const COMMIT_SUBCOMMANDS = new Set(["commit", "cherry-pick", "revert"]);
// git's global options that take the next word as their value.
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source", "--list-cmds", "--exec-path"]);
// commit's short options whose value is the rest of their cluster, or the next word.
const COMMIT_VALUE_SHORTS = "mFcCt";
const SHELLS = /^(?:ba|z|da|k)?sh$/;
const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time", "noglob", "nice"]);

const baseName = w => w.split(/[\\/]/).pop().toLowerCase();
const isGit = w => typeof w === "string" && /^git(?:\.exe)?$/.test(baseName(w));

/**
 * @typedef {object} CommitInvocation
 * @property {string | null} cwd     the folder git ran in, when the text says
 * @property {"commit" | "cherry-pick" | "revert"} subcommand
 * @property {boolean} amend
 * @property {boolean} quiet         `-q`: it will print no summary line
 * @property {boolean} noCommit      `--dry-run`, `cherry-pick -n`: makes none
 */

/**
 * The git invocations in one shell command that make a commit, in order.
 *
 * @param {unknown} command the command line
 * @param {string | null | undefined} cwd the folder it was started in
 * @param {{ home?: string, depth?: number }} [opts]
 * @returns {CommitInvocation[]}
 */
export function gitCommitInvocations(command, cwd, { home = homedir(), depth = 0 } = {}) {
  const out = [];
  walkCommands(command, cwd, { home, depth }, {
    git(ws, i, dir) {
      const sub = ws[i];
      if (!COMMIT_SUBCOMMANDS.has(sub)) return;
      let amend = false;
      let quiet = false;
      let noCommit = false;
      for (let j = i + 1; j < ws.length; j++) {
        const a = ws[j];
        if (a === "--") break;
        if (a === "--amend") amend = true;
        else if (a === "--quiet") quiet = true;
        else if (a === "--dry-run" || a === "--no-commit") noCommit = true;
        else if (/^--(?:message|file|reuse-message|reedit-message|template|fixup|squash|author|date|cleanup|trailer)$/.test(a)) j++;
        else if (/^-[A-Za-z]+$/.test(a)) {
          for (let n = 1; n < a.length; n++) {
            const ch = a[n];
            if (ch === "q") quiet = true;
            if (ch === "n" && sub !== "commit") noCommit = true;
            if (sub === "commit" && COMMIT_VALUE_SHORTS.includes(ch)) {
              if (n === a.length - 1) j++;
              break;
            }
            if (sub !== "commit" && ch === "m") { if (n === a.length - 1) j++; break; }
          }
        }
      }
      out.push({ cwd: dir, subcommand: sub, amend, quiet, noCommit });
    },
  });
  return out;
}

/**
 * Every folder one shell command names for git to work in or moves into, in
 * order, each once: the target of a `cd` (`pushd`, `Set-Location`), and the
 * folder each git invocation runs in after its `-C`, `--work-tree` and
 * `--git-dir` — whatever the subcommand. What a command can change beyond the
 * folder it was started in, as far as its text says.
 *
 * @param {unknown} command the command line
 * @param {string | null | undefined} cwd the folder it was started in
 * @param {{ home?: string }} [opts]
 * @returns {string[]}
 */
export function commandFolders(command, cwd, { home = homedir() } = {}) {
  const dirs = new Set();
  walkCommands(command, cwd, { home, depth: 0 }, {
    cd(dir) { if (dir) dirs.add(dir); },
    git(_ws, _i, dir, gitDir) {
      if (dir) dirs.add(dir);
      if (gitDir) dirs.add(gitDir);
    },
  });
  return [...dirs];
}

/**
 * Walk the simple commands of one shell command line, keeping track of the
 * folder each runs in, and hand each `cd` and each git invocation to `visit`:
 * `cd(folder | null)`, and `git(words, i, folder | null, gitDir | null)` with
 * `words[i]` the subcommand. `sh -c '…'` is walked into.
 */
function walkCommands(command, cwd, { home, depth }, visit) {
  if (typeof command !== "string" || !command.trim() || depth > 3) return;
  const toks = tokenize(stripHeredocs(command));
  if (!toks) return;
  const stack = [];
  let cur = typeof cwd === "string" && cwd ? cwd : null;
  let words = [];

  const simple = (ws) => {
    let k = 0;
    while (k < ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[k])) k++;
    while (k < ws.length) {
      if (WRAPPERS.has(ws[k])) { k++; continue; }
      if (ws[k] === "env") {
        k++;
        while (k < ws.length && (ws[k].startsWith("-") || /^[A-Za-z_]\w*=/.test(ws[k]))) {
          if (ws[k] === "-u" || ws[k] === "--unset") k++;
          k++;
        }
        continue;
      }
      break;
    }
    const w0 = ws[k];
    if (w0 === undefined) return;
    if (w0 === "cd" || w0 === "pushd" || w0 === "Set-Location") {
      const arg = ws.slice(k + 1).find(a => !a.startsWith("-") || a === "-");
      cur = arg === undefined ? (home || null) : resolveDir(cur, arg, home);
      visit.cd?.(cur);
      return;
    }
    if (SHELLS.test(baseName(w0))) {
      const flag = ws.findIndex((a, i) => i > k && /^-[a-z]*c$/.test(a));
      if (flag > 0 && flag + 1 < ws.length) walkCommands(ws[flag + 1], cur, { home, depth: depth + 1 }, visit);
      return;
    }
    if (!isGit(w0)) return;
    let dir = cur;
    let workTree = null;
    let gitDir = null;
    let i = k + 1;
    while (i < ws.length) {
      const a = ws[i];
      if (a === "-C") { dir = resolveDir(dir, ws[i + 1], home); i += 2; continue; }
      if (GIT_VALUE_OPTS.has(a)) {
        if (a === "--work-tree") workTree = ws[i + 1];
        if (a === "--git-dir") gitDir = ws[i + 1];
        i += 2;
        continue;
      }
      if (a.startsWith("--work-tree=")) { workTree = a.slice("--work-tree=".length); i++; continue; }
      if (a.startsWith("--git-dir=")) { gitDir = a.slice("--git-dir=".length); i++; continue; }
      if (a.startsWith("-")) { i++; continue; }
      break;
    }
    if (workTree !== null) dir = resolveDir(dir, workTree, home);
    visit.git?.(ws, i, dir, gitDir !== null ? resolveDir(cur, gitDir, home) : null);
  };

  for (const t of toks) {
    if (t.w !== undefined) { words.push(t.w); continue; }
    if (words.length) simple(words);
    words = [];
    if (t.op === "(") stack.push(cur);
    else if (t.op === ")" && stack.length) cur = stack.pop();
  }
  if (words.length) simple(words);
}

// ─── candidates ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} CommitCandidate
 * @property {string} sessionId
 * @property {string | null} agentId
 * @property {"claude" | "codex"} kind
 * @property {string | null} cwd     the folder it was made in, when one is
 *   certain; null when several were possible (see `cwds`)
 * @property {string[]} cwds         every folder it may have been made in,
 *   the likeliest first
 * @property {string | null} branch  null on a detached HEAD
 * @property {boolean} detached
 * @property {boolean} rootCommit
 * @property {string} shortSha
 * @property {string} subject
 * @property {number} at             when the call's outcome was received (ms)
 * @property {boolean} amend
 * @property {"commit" | "cherry-pick" | "revert"} subcommand
 * @property {string | null} toolUseId
 * @property {string | null} model
 */

/**
 * The commits one finished call reports making.
 *
 * Summary lines are paired with the commit invocations in order when their
 * counts agree (`git -C a commit && git -C b commit`); when they do not — one
 * of them had nothing to commit — a candidate names every folder it may have
 * come from and claims none, and the recorder's `confirm` decides.
 *
 * A call that failed is read too: `git commit && npm test` with failing tests
 * still made the commit, and its summary line says so.
 *
 * @param {import("./agent-git-calls.mjs").FinishedCall | null | undefined} call
 * @returns {CommitCandidate[]}
 */
export function commitCandidates(call, opts) {
  if (!call || typeof call !== "object" || !Array.isArray(call.commands) || !call.commands.length) return [];
  if (typeof call.output !== "string" || !call.output) return [];
  const invs = call.commands
    .flatMap(c => gitCommitInvocations(c && c.command, c && c.cwd, opts))
    .filter(i => !i.noCommit);
  if (!invs.length) return [];
  const sums = parseCommitSummaries(call.output);
  if (!sums.length) return [];
  const all = [...new Set(invs.map(i => i.cwd).filter(Boolean))];
  const paired = sums.length === invs.length;
  return sums.map((s, idx) => {
    const inv = paired ? invs[idx] : null;
    const cwd = inv ? inv.cwd : all.length === 1 ? all[0] : null;
    return {
      sessionId: call.sessionId,
      agentId: call.agentId ?? null,
      kind: call.kind === "codex" ? "codex" : "claude",
      cwd,
      cwds: cwd ? [cwd, ...all.filter(c => c !== cwd)] : all,
      branch: s.branch,
      detached: s.detached,
      rootCommit: s.rootCommit,
      shortSha: s.shortSha,
      subject: s.subject,
      at: call.at,
      amend: inv ? inv.amend : invs.length === 1 && invs[0].amend,
      subcommand: inv ? inv.subcommand : invs[0].subcommand,
      toolUseId: call.toolUseId ?? null,
      model: call.model ?? null,
    };
  });
}
