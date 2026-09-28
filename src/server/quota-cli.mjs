// Source 3 of quota.mjs's chain: `claude --print /usage`, and the `claude` it
// runs.
//
// The most expensive of the three sources — a whole Claude Code process per
// attempt — and the only self-service one on a Mac, where the token is in the
// Keychain and there is no credentials file to read. What lives here is the
// part that is about the CLI itself: which binary to run, one run of it, and
// the one line said when that run fails. How many attempts, how far apart, and
// what to publish when none of them prints a window stay in quota.mjs, beside
// the floors and the cache those answers are decided against.
import { claudeCliCandidates } from "./claude-dir.mjs";
import { pathLookup, run } from "./exec.mjs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { PRODUCT } from "./brand.mjs";
import { stripAnsi } from "./term.mjs";
import { parseUsageText } from "./quota-shape.mjs";

// Where the `claude` CLI can be. The list moved to claude-dir.mjs, which is the
// module that owns every "where does Claude Code live" answer the deck has —
// the config dir was already there, and the boot-time presence check that reads
// this same list had no business importing a quota poller to get at it.

/** Which `claude` to run for `--print /usage`: the first candidate that exists.
 *
 *  This used to hand back a whole shell command line — `"<bin>" --print /usage
 *  < /dev/null` — for `exec()` to parse. Double quotes are not escaping on
 *  POSIX: `$(…)`, backticks and `\` all still work inside them, and every
 *  ingredient of that line came from the environment (`%APPDATA%`, `homedir()`),
 *  so a home directory named `/home/a$(id)b` was shell code the quota poll ran
 *  every minute. A bare `$` was the duller half of the same bug — it expanded
 *  to nothing and the probe looked for a binary at a path that did not exist.
 *
 *  There is nothing left to escape once there is no shell: exec.mjs's `run`
 *  spawns the argument vector as given, resolves the Windows `.cmd`/`.exe`
 *  spelling itself, and closes the child's stdin — which is what `< /dev/null`
 *  was for, since `claude --print` waits three seconds on a stdin pipe nobody
 *  is writing to.
 *
 *  Exported, with everything it touches injectable, so the Windows branch is
 *  testable from the platforms this repo is actually developed on.
 *
 *  WHY THE BARE NAME HAS TO EARN ITS PLACE (#553). This used to be a `.find`
 *  over `!c.includes(sep) || exists(c)`, which reads as "a bare name always
 *  answers, a full path only when it is there". On Windows that is harmless —
 *  the bare name is LAST in the list — but on POSIX it is FIRST, so the `||`
 *  short-circuited on candidate one and `exists` was never called even once:
 *  `~/.local/bin/claude`, `/usr/local/bin/claude` and `/opt/homebrew/bin/claude`
 *  were in a list nothing ever read. The user this broke is the one
 *  claude-dir.mjs names out loud: Claude Code installed by the official
 *  installer, so the binary is at `~/.local/bin/claude`, and the deck launched
 *  from something whose PATH never sourced a shell rc — a LaunchAgent, a
 *  systemd user unit, pm2, a desktop shortcut. `hasClaudeInstalled()` stats the
 *  absolute paths and says yes, so hooks install and the Claude surface turns
 *  on; every `claude --print /usage` spawn is then a bare-name ENOENT logged as
 *  `quota: claude CLI failed`. On macOS there is no `.credentials.json` to fall
 *  back to (the token is in the Keychain, #360), so the quota panel simply stays
 *  dark on a machine that plainly has Claude Code. The identical install on
 *  Windows worked, because there the ordering already said what this now says.
 *
 *  WHICH WINS. The candidate list's own order decides, unchanged on both
 *  platforms — PATH first on POSIX, the two known install directories first on
 *  Windows — because the ordering question here is the one getRunner in
 *  ccusage.mjs already answered: preferring a different copy would silently
 *  change which binary runs on every machine that has two, and a deck that
 *  works today must not start running a `claude` it has never run. A user with
 *  a current claude on PATH via nvm/mise/volta and a stale one left in
 *  `~/.local/bin` keeps getting the one their own shell gives them. All that
 *  changes is that a bare name is now only ANSWERED WITH when PATH actually
 *  holds it, which is the same rule claudeCliOnDisk in claude-dir.mjs has
 *  always applied to this very list — the two readers of one list can no longer
 *  disagree about whether the deck can run what it says is installed.
 *
 *  WHAT IT COSTS. One PATH walk, stopping at the first hit, and only for the
 *  bare candidate; the absolute paths are stat'ed only once PATH has come up
 *  empty. That is the trade ccusage.mjs already priced for the same shape of
 *  question — "a handful of stats, once per uncached fetch, against a process
 *  spawn that follows it" — and here the spawn that follows is a whole Claude
 *  Code process measured at ~3s, behind the SELF_POLL_MS floor.
 *
 *  `pathLookup` is used as a yes/no gate rather than for the path it found, on
 *  purpose: answering with the bare name keeps spawn's own resolution (and, on
 *  Windows, exec.mjs's PATHEXT candidate walk) in charge of the PATH case
 *  exactly as before, so a PATH entry that merely LOOKS like a hit — a
 *  directory named `claude` — cannot become the answer.
 */
export function quotaClaudeBin(platform = process.platform, env = process.env,
                               home = homedir(), exists = existsSync) {
  const sep = platform === "win32" ? "\\" : "/";
  // process.env is case-insensitive on Windows; an injected plain object in a
  // test is not, and %Path% is how the variable is actually spelled there.
  const pathEnv = env.PATH ?? env.Path ?? env.path ?? "";
  for (const c of claudeCliCandidates(platform, env, home)) {
    // A full path is worth a single stat; a bare name means "ask PATH", which
    // is pathLookup's walk — PATHEXT included, since `claude` on Windows is
    // spelled `claude.exe` or `claude.cmd` and never the bare word.
    if (c.includes(sep)) { if (exists(c)) return c; }
    else if (pathLookup(c, platform, { pathEnv, exists })) return c;
  }
  // Nothing on PATH and nothing at any known install directory. The bare name
  // is still the right last resort — POSIX `execvp` and cmd.exe's own search
  // both deserve their turn at a layout no list here knows — and the ENOENT it
  // produces is what `quota: claude CLI failed` reports.
  return "claude";
}

// Run `claude --print /usage` once. Returns { cliOk, parsed }.
//   cliOk  — the CLI ran and we recognized its output (preamble present)
//   parsed — quota percentages object, or null if the "Current session/week"
//            lines were absent (CLI cold-start, or genuinely <1% usage)
/**
 * The failure this last said out loud, so a standing one is said once.
 *
 * #742. A Windows user with no Claude Code installed sent a screenshot of three
 * identical lines — `ccdeck quota: claude CLI failed: claude exited ENOENT` —
 * interleaved with the deck's pulse line, and they keep coming for as long as
 * the deck runs. Every poll ran the loop below three times, and every attempt
 * printed. A CLI that is not installed is not news three times a minute; it is
 * a condition, and a condition is worth exactly one line.
 *
 * Cleared on the first run that works, so a `claude` installed while the deck
 * is up can still report its next genuine failure.
 */
let _saidFailure = null;

/** Exported for its test, and for the same reason resetCswapBin is: a module
 *  that remembers something across calls needs a way to be asked twice.
 *
 *  Deliberately NOT folded into invalidateQuotaCache, which production calls
 *  after an account switch — forgetting the notice there would put the same
 *  sentence back on the terminal every time somebody changed accounts. */
export function forgetQuotaFailureNotice() { _saidFailure = null; }

export async function runUsageOnce(bin) {
  const r = await run(bin, ["--print", "/usage"], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    // Marks this Claude Code run as the deck's own. `claude --print /usage`
    // is a full invocation, so it fires the hooks we installed, and every
    // quota poll was drawing itself onto the canvas as a fresh session with
    // no prompt and no tools. Hooks inherit the environment, so hook.js
    // sees this and stays quiet.
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb", AGENTS_DECK_INTERNAL: "1" },
  });
  // `run` never rejects, so there is one path rather than two — and the output
  // is kept either way, which matters because the CLI writes the quota lines to
  // stdout and can still exit non-zero afterwards.
  const combined = r.stdout + "\n" + r.stderr;
  // `run` normalises a binary that is not there to this, on every platform —
  // see exec.mjs. It is the difference between "Claude Code answered badly",
  // which is worth retrying and worth saying, and "there is no Claude Code on
  // this machine", which is neither.
  const missing = r.code === "ENOENT";
  if (!r.ok) {
    const msg = stripAnsi(r.stderr).trim() || `claude exited ${r.code}`;
    if (msg !== _saidFailure) {
      _saidFailure = msg;
      console.error(`${PRODUCT} quota: claude CLI failed:`, msg);
    }
  } else {
    _saidFailure = null;
  }
  const cliOk = /subscription/i.test(combined) || /claude code usage/i.test(combined);
  // WHETHER THE RUN ITSELF SUCCEEDED, which `cliOk` does not answer. `cliOk` is
  // a test of the OUTPUT — it means "we recognised what came back" — and a CLI
  // that printed its banner and then failed satisfies it. That is the right
  // rule for the parse above (see the note there: the quota lines can be on
  // stdout and the exit non-zero), and the wrong one for the no-numbers
  // fallback in _doFetch, which was publishing 0% for a run that errored.
  return { cliOk, ran: r.ok, missing, parsed: parseUsageText(combined) };
}
