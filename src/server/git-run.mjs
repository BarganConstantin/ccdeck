// The one way the deck runs git, and the reason it is a module of its own: a
// repository can make git run programs of its choosing, and an ordinary
// `git status` can take a lock an agent's `git commit` then trips over.
//
// Every read the deck makes of a repository comes through `git()` below, which
// fixes the whole argument vector before anything is spawned and adds, to
// every call, the switches that keep git from writing anything or from
// starting anything the repository's configuration names:
//
//   --no-optional-locks       status otherwise refreshes the index and takes
//   GIT_OPTIONAL_LOCKS=0      `index.lock` to write it back, and an agent's
//                             commit landing in that moment fails with
//                             "index.lock exists". Both spellings, because
//                             either alone is ignored by some git.
//   diff.autoRefreshIndex     and `git diff` does the same thing on its own,
//     =false                  locks or no locks: a file whose timestamp moved
//                             but whose content did not makes it take the lock
//                             and write the index back on its way out.
//   core.fsmonitor=false      the hook git runs before every status to ask
//                             what changed is a program the repo's config
//                             names. core.useBuiltinFSMonitor is the older
//                             Git for Windows spelling of the same switch.
//   --no-ext-diff             diff.external and diff.<driver>.command are
//   --no-textconv             programs too, and so is diff.<driver>.textconv;
//                             added to every subcommand that can show a diff.
//   filter.<driver>.*=""      a clean filter runs on a working-tree file
//                             whenever status or diff compares its content
//                             (git-lfs's writes into .git/lfs while it does).
//                             There is no switch that turns filters off, so
//                             the caller passes the driver names the
//                             repository's config defines and each is emptied
//                             (see filterNames in git-repo.mjs) — through the
//                             child's GIT_CONFIG_COUNT/KEY/VALUE, which takes
//                             a name holding `=` as it is, and through `-c`
//                             as well for a git older than 2.31, which reads
//                             no GIT_CONFIG_COUNT. `-c` splits at the first
//                             `=`, so on such a git a name holding one cannot
//                             be emptied, and the read is refused instead.
//   GIT_NO_LAZY_FETCH=1       a partial clone (`--filter=blob:none`, the
//   protocol.allow=never      treeless `--filter=tree:0`) fetches a missing
//                             object from its promisor remote the moment a
//                             read needs it: a network call that runs the
//                             credential helper, the ssh command or the
//                             remote's configured upload-pack, and writes a
//                             pack into .git. The variable stops it on git
//                             2.44 and later; the protocol switch refuses
//                             every transport on any git before a connection
//                             or a helper is started. The read then fails, and
//                             says "not-downloaded" (classifyFailure).
//   --ignore-submodules=dirty status and diff otherwise start a second git
//                             inside every submodule, under that submodule's
//                             own configuration.
//   --no-show-signature       log.showSignature makes log run gpg.program.
//   no GIT_* from the deck    GIT_DIR, GIT_INDEX_FILE, GIT_EXTERNAL_DIFF and
//                             the rest, inherited from whoever launched the
//                             deck, would point a read somewhere else or run
//                             something; the child gets none of them.
//   --literal-pathspecs       a path git itself reported is passed back as a
//                             path, never as `:(glob)` pathspec magic.
//
// Hooks are not disabled because nothing here can fire one: no read runs a
// hook, and the commands that do (commit, merge, checkout, push) are never
// spawned. Neither are credential helpers, the ssh command or the askpass —
// nothing here talks to a remote, and the lazy fetch above, the one way a
// read could, is switched off.
//
// The binary is `git.exe` on Windows, spelled with its extension so exec-spec
// offers that one candidate and never a `git.cmd` routed through cmd.exe, and
// importing exec.mjs is also what turns off Windows's search of the working
// directory: without NoDefaultCurrentDirectoryInExePath a `git.exe` planted at
// the top of a cloned repository would be the one started.
import { run } from "./exec.mjs";

export const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";

/** How long one read may take before it is abandoned, by default. */
export const GIT_TIMEOUT_MS = 10_000;
/** The most output one read may produce before it is abandoned, by default. */
export const GIT_MAX_BYTES = 8 << 20;

// Switches that go in front of the subcommand on every call.
const GLOBAL = [
  "--no-optional-locks",
  "--no-pager",
  "--literal-pathspecs",
  "-c", "core.fsmonitor=false",
  "-c", "core.useBuiltinFSMonitor=false",
  "-c", "color.ui=false",
  "-c", "log.showSignature=false",
  "-c", "core.quotePath=false",
  "-c", "i18n.logOutputEncoding=UTF-8",
  "-c", "status.submoduleSummary=false",
  "-c", "diff.ignoreSubmodules=dirty",
  "-c", "diff.autoRefreshIndex=false",
  "-c", "protocol.allow=never",
];

const DIFFS = ["--no-ext-diff", "--no-textconv", "--no-color"];
// Switches that go straight after the subcommand, for the ones that take them.
const PER_SUBCOMMAND = {
  diff: [...DIFFS, "--ignore-submodules=dirty", "--submodule=short"],
  "diff-tree": DIFFS,
  log: [...DIFFS, "--no-show-signature"],
  show: [...DIFFS, "--no-show-signature"],
  status: ["--ignore-submodules=dirty"],
};

/** The subcommands this module will start. Anything else is refused before a
 *  process exists, so a later caller cannot reach a command that writes. */
const READS = new Set([
  "rev-parse", "symbolic-ref", "for-each-ref", "config", "status", "diff",
  "diff-tree", "log", "show", "cat-file", "rev-list",
]);

/** A driver name as git's config keys spell it: anything but a newline, and
 *  never empty. Checked because each one becomes part of a config key. */
const DRIVER = /^[^\n\r\0]+$/;
/** One `-c` can carry it too: git splits a `-c` at its first `=`. */
const DASH_C_DRIVER = /^[^\n\r\0=]+$/;
/** The first git that reads GIT_CONFIG_COUNT. */
const CONFIG_ENV_SINCE = [2, 31];

const driverNames = (filters) => [...new Set((Array.isArray(filters) ? filters : []).filter((n) => typeof n === "string" && DRIVER.test(n)))];

/** The child's environment: the deck's own, minus every GIT_* variable, plus
 *  the few that pin a read down. Case-insensitive on Windows, where
 *  `Git_Dir` and `GIT_DIR` are one variable. */
export function gitEnv(base = process.env, platform = process.platform) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if ((platform === "win32" ? k.toUpperCase() : k).startsWith("GIT_")) continue;
    env[k] = v;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  // A partial clone's missing objects stay missing (see the header).
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GIT_LITERAL_PATHSPECS = "1";
  // English messages, which is what classifyFailure reads.
  env.LC_ALL = "C";
  env.LANGUAGE = "";
  return env;
}

/**
 * The argument vector `git()` hands to execFile, exported so the tests can pin
 * it without spawning. `filters` are the clean/smudge driver names to empty.
 */
export function gitArgv(sub, args = [], { filters = [] } = {}) {
  if (!READS.has(sub)) throw new Error(`git ${sub} is not a read`);
  const neutral = [];
  for (const name of driverNames(filters)) {
    if (!DASH_C_DRIVER.test(name)) continue;
    neutral.push(
      "-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`,
      "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`,
    );
  }
  return [...GLOBAL, ...neutral, sub, ...(PER_SUBCOMMAND[sub] ?? []), ...args];
}

/**
 * The same emptying as gitArgv's `-c`s, as the child's GIT_CONFIG_COUNT,
 * GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n> — the only spelling that keeps a
 * driver name holding `=` whole. Exported so the tests can pin it.
 */
export function filterConfigEnv(filters = []) {
  const env = {};
  let n = 0;
  for (const name of driverNames(filters)) {
    for (const [field, value] of [["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"]]) {
      env[`GIT_CONFIG_KEY_${n}`] = `filter.${name}.${field}`;
      env[`GIT_CONFIG_VALUE_${n}`] = value;
      n++;
    }
  }
  if (n) env.GIT_CONFIG_COUNT = String(n);
  return env;
}

/** Whether every filter driver named can be emptied by a git of `version`
 *  ([major, minor], or null when unknown): a name holding `=` needs a git that
 *  reads GIT_CONFIG_COUNT. */
export function filtersCanBeEmptied(filters, version) {
  const names = driverNames(filters);
  if (names.every((n) => DASH_C_DRIVER.test(n))) return true;
  if (!Array.isArray(version)) return false;
  const [major, minor] = version;
  return major > CONFIG_ENV_SINCE[0] || (major === CONFIG_ENV_SINCE[0] && minor >= CONFIG_ENV_SINCE[1]);
}

/** `git version`'s answer as [major, minor], or null. */
export function parseGitVersion(text) {
  const m = /git version (\d+)\.(\d+)/.exec(String(text ?? ""));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

let versionAsked = null;
/** The installed git's version, asked once — and only when a read needs it. */
function installedVersion() {
  versionAsked ??= run(GIT_BIN, ["version"], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4096, env: gitEnv() })
    .then((r) => (r.ok ? parseGitVersion(r.stdout) : null), () => null);
  return versionAsked;
}

/** How many git processes the deck runs at once. A view opening on a busy
 *  repository asks for several reads together, and every session's branch is
 *  read off the same pool; the rest wait their turn rather than all starting. */
export const MAX_RUNNING = 4;
let running = 0;
const waiting = [];
const slot = () => (running < MAX_RUNNING ? (running++, Promise.resolve()) : new Promise((go) => waiting.push(go)));
function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

/**
 * Run one read in `cwd`. Never throws. Answers
 *   { ok, stdout, stderr, code, timedOut, tooLarge, missing, noFolder, refused? }
 * where `missing` is git not being installed, `noFolder` is the folder having
 * gone, `tooLarge` is the output passing `maxBytes` — the child is stopped
 * there rather than read to the end — and `refused` is a read never started
 * because a filter driver it would run cannot be emptied on this git.
 */
export async function git(sub, args, { cwd, timeout = GIT_TIMEOUT_MS, maxBytes = GIT_MAX_BYTES, filters = [] } = {}) {
  const argv = gitArgv(sub, args, { filters });
  // A driver this git cannot empty would run on this read: refused instead.
  if (!filtersCanBeEmptied(filters, null) && !filtersCanBeEmptied(filters, await installedVersion())) {
    return { ok: false, stdout: "", stderr: "a filter driver name holds '=' and this git cannot empty it", code: null,
      timedOut: false, tooLarge: false, missing: false, noFolder: false, refused: true };
  }
  await slot();
  let r;
  try {
    r = await run(GIT_BIN, argv, { cwd, timeout, maxBuffer: maxBytes, env: { ...gitEnv(), ...filterConfigEnv(filters) } });
  } finally {
    release();
  }
  return {
    ok: r.ok,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.code,
    timedOut: Boolean(r.timedOut),
    tooLarge: r.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    missing: r.code === "ENOENT",
    noFolder: r.code === "ENOCWD",
  };
}

/**
 * What a failed read was, in the few words the routes answer with:
 * "no-git", "gone", "not-a-repo", "bare", "unsafe", "timeout", "too-large",
 * "not-downloaded" (a partial clone without the objects the read needs — the
 * deck never fetches them), or "error".
 */
export function classifyFailure(r) {
  if (r.missing) return "no-git";
  if (r.noFolder) return "gone";
  if (r.timedOut) return "timeout";
  if (r.tooLarge) return "too-large";
  if (r.refused) return "unsafe";
  const said = r.stderr ?? "";
  if (/lazy fetching disabled|from promisor remote|transport '[^']*' not allowed/i.test(said)) return "not-downloaded";
  if (/dubious ownership|unsafe repository/i.test(said)) return "unsafe";
  if (/not a git repository/i.test(said)) return "not-a-repo";
  if (/must be run in a work tree|this operation must be run in a work ?tree/i.test(said)) return "bare";
  return "error";
}
