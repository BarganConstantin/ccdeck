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
//                             (see filterNames in git-repo.mjs).
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
// nothing here talks to a remote.
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
 *  never empty. Checked because each one becomes part of a `-c` argument. */
const DRIVER = /^[^\n\r=]+$/;

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
  for (const name of filters) {
    if (typeof name !== "string" || !DRIVER.test(name)) continue;
    neutral.push(
      "-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`,
      "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`,
    );
  }
  return [...GLOBAL, ...neutral, sub, ...(PER_SUBCOMMAND[sub] ?? []), ...args];
}

/**
 * Run one read in `cwd`. Never throws. Answers
 *   { ok, stdout, stderr, code, timedOut, tooLarge, missing, noFolder }
 * where `missing` is git not being installed, `noFolder` is the folder having
 * gone, and `tooLarge` is the output passing `maxBytes` — the child is stopped
 * there rather than read to the end.
 */
export async function git(sub, args, { cwd, timeout = GIT_TIMEOUT_MS, maxBytes = GIT_MAX_BYTES, filters = [] } = {}) {
  const argv = gitArgv(sub, args, { filters });
  const r = await run(GIT_BIN, argv, { cwd, timeout, maxBuffer: maxBytes, env: gitEnv() });
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
 * or "error".
 */
export function classifyFailure(r) {
  if (r.missing) return "no-git";
  if (r.noFolder) return "gone";
  if (r.timedOut) return "timeout";
  if (r.tooLarge) return "too-large";
  const said = r.stderr ?? "";
  if (/dubious ownership|unsafe repository/i.test(said)) return "unsafe";
  if (/not a git repository/i.test(said)) return "not-a-repo";
  if (/must be run in a work tree|this operation must be run in a work ?tree/i.test(said)) return "bare";
  return "error";
}
