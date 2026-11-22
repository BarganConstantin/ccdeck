// The PATH the user's own terminal has, for a deck that was started without it.
//
// A deck started by the desktop app, a LaunchAgent, a systemd user unit or a
// login item inherits a PATH that never read the shell's startup files. Claude
// Code installed through nvm, mise, volta, fnm, asdf, pnpm or bun is put on
// PATH only there, so on such a machine the user's own terminal runs `claude`
// while the deck's Accounts › Add › Sign in says Claude Code is not installed —
// with that user's sessions live on the board beside the dialog. The candidate
// list in claude-dir.mjs cannot know those places: each tool picks its own, per
// version, per user.
//
// WHY THE WHOLE PATH AND NOT JUST A `claude`. An npm-installed `claude` is a
// `#!/usr/bin/env node` script. Its absolute path alone still fails, exit 127,
// because `env` looks `node` up on the deck's PATH, which is exactly the PATH
// that does not have it. The shell's PATH carries both folders at once.
//
// HOW. One run of the user's own login shell, interactive so that ~/.bashrc and
// ~/.zshrc are read too (nvm and its kind set themselves up there, and only an
// interactive shell reads them), printing PATH between two markers. The rc
// files may print anything around it; the last marked block is the answer.
// Its folders are appended AFTER the deck's own, never before, so every
// program the deck finds today is still the one it runs.
//
// WHEN. Only when the deck cannot find `claude` by itself: the boot fires it
// without waiting (bin/deck.js), and the sign-in waits for it before it gives
// up (cswap-admin.mjs's claudeBin). Once per process, whoever asks first. A
// machine whose `claude` is found today spawns nothing new at all.
//
// POSIX only. Windows programs read PATH from the registry, which every
// process already inherits, and there is no login shell to ask. The shell runs
// as an argument vector with a constant command, in a process group of its
// own, under a deadline; what it prints is never logged, and nothing here
// names a folder it found. AGENTS_DECK_NO_LOGIN_SHELL=1 turns it off.
import { spawn as nodeSpawn } from "node:child_process";
import { posix as posixPath } from "node:path";
import { killTree, watchChild } from "./exec-children.mjs";

const BEGIN = "__CCDECK_PATH_BEGIN__";
const END = "__CCDECK_PATH_END__";

/** How long the shell may take to start and print, its rc files included. */
const LOGIN_SHELL_TIMEOUT_MS = 5_000;

/** How much of what it prints is kept: the end of it, where the markers are.
 *  An rc file can print a banner of any length before them; PATH is a line. */
const STDOUT_MAX = 64 * 1024;

/** The shells whose `-l -i -c` means login, interactive, run this command, and
 *  in which `echo` and `printenv` read the same. csh and tcsh take `-l` only
 *  alone, and nu and pwsh speak another language; they get null and the deck
 *  carries on as it did. */
const SHELLS = new Set(["bash", "zsh", "fish", "ksh", "mksh", "dash", "sh"]);

/**
 * The argument vector that prints the login shell's PATH between the markers,
 * or null for a `shell` this cannot ask: not an absolute path, or not one of
 * the shells above.
 */
export function loginShellArgv(shell) {
  if (typeof shell !== "string") return null;
  const file = shell.trim();
  if (!posixPath.isAbsolute(file) || !SHELLS.has(posixPath.basename(file))) return null;
  return [file, "-l", "-i", "-c", `echo ${BEGIN}; printenv PATH; echo ${END}`];
}

/**
 * The text of the LAST complete marked block in `text`, untrimmed, or null.
 *
 * Complete means the way the command prints it: BEGIN ending its line, END
 * starting one. Text that merely names both markers — the command itself,
 * echoed back by an rc file — is not a block, so it can neither be taken for
 * the answer nor end the read early. Whatever precedes BEGIN on its line is
 * allowed: an rc file can leave a title escape there without a newline.
 */
function lastBlock(text) {
  let found = null;
  let from = 0;
  for (;;) {
    const at = text.indexOf(BEGIN, from);
    if (at === -1) return found;
    let eol = at + BEGIN.length;
    if (text[eol] === "\r") eol += 1;
    if (text[eol] !== "\n") { from = at + BEGIN.length; continue; }
    const end = text.indexOf(`\n${END}`, eol);
    if (end === -1) return found;
    // Empty when END follows BEGIN's own newline: printenv printed nothing.
    found = text.slice(eol + 1, end);
    from = end + 1 + END.length;
  }
}

/**
 * The PATH the shell printed: the text of the LAST marked block, trimmed, or
 * null when there is none or it is empty. rc files may print anything around
 * it, and a second block can only come after the first.
 */
export function parseShellPath(stdout) {
  const path = lastBlock(String(stdout ?? ""))?.trim();
  return path ? path : null;
}

/** A folder as it is compared, not as it is written: without trailing `/`. */
const sameFolder = (dir) => (dir.length > 1 ? dir.replace(/\/+$/, "") : dir);

/**
 * The deck's PATH with the shell's missing folders appended: `{ path, added }`.
 *
 * The deck's own value is kept exactly as it is, first; after it, each of the
 * shell's entries that is absolute, on one line, and not already there, once.
 * An empty or relative entry means "the current directory" to a PATH search,
 * which is no place to look for a program. `added` is how many were appended;
 * zero hands back the deck's PATH unchanged.
 */
export function mergePath(deckPath, shellPath) {
  const own = String(deckPath ?? "");
  const present = new Set(own.split(":").filter(Boolean).map(sameFolder));
  const extra = [];
  for (const entry of String(shellPath ?? "").split(":")) {
    if (!entry.startsWith("/") || /[\r\n\0]/.test(entry)) continue;
    const key = sameFolder(entry);
    if (present.has(key)) continue;
    present.add(key);
    extra.push(entry);
  }
  if (extra.length === 0) return { path: own, added: 0 };
  return { path: own ? `${own}:${extra.join(":")}` : extra.join(":"), added: extra.length };
}

/**
 * Ask the user's login shell for its PATH. Resolves the PATH, or null: on
 * Windows, without a SHELL this can ask, when AGENTS_DECK_NO_LOGIN_SHELL is 1,
 * when it could not start, and when it did not print the markers in time.
 * Never rejects.
 *
 * DETACHED, which on POSIX is a session and a process group of its own, for two
 * reasons. The deadline kills the group, so whatever an rc file started dies
 * with the shell. And an interactive shell takes the terminal's foreground for
 * itself when it has one: in the deck's own session it could take the terminal
 * the deck is running in. stdin is /dev/null, so an rc file that asks a question
 * reads an end of file instead of waiting, and TERM=dumb keeps prompt themes
 * from drawing. SIGKILL, because an interactive bash ignores SIGTERM.
 *
 * The answer counts even after a non-zero exit: an rc file whose last command
 * failed is still an rc file that set PATH.
 *
 * SETTLED ON THE MARKERS, NOT ONLY ON 'close'. 'close' waits for every holder
 * of the stdout pipe, and an rc file that starts something in the background
 * (`some-tool &`, a lazy loader) hands that process the pipe: the shell exits,
 * the pipe stays open, and the read would sit out the whole deadline with the
 * answer already in hand. So the first complete block ends it, and the group
 * is killed, since nothing else is wanted from it. 'close' and the deadline
 * still end the reads that never print one.
 */
export function readLoginShellPath({
  env = process.env,
  platform = process.platform,
  spawn = nodeSpawn,
  timeoutMs = LOGIN_SHELL_TIMEOUT_MS,
} = {}) {
  if (platform === "win32" || env?.AGENTS_DECK_NO_LOGIN_SHELL === "1") return Promise.resolve(null);
  const argv = loginShellArgv(env?.SHELL);
  if (!argv) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = "";
    let timer = null;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = watchChild(spawn(argv[0], argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...env, TERM: "dumb" },
        detached: true,
        windowsHide: true,
        shell: false,
      }), { processGroup: true });
    } catch {
      settle(null);
      return;
    }
    if (!child) { settle(null); return; }
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => {
      if (settled) return;
      out = (out + chunk).slice(-STDOUT_MAX);
      if (lastBlock(out) === null) return;
      killTree(child, "SIGKILL");
      settle(parseShellPath(out));
    });
    // Read and dropped, so a chatty rc file can never fill the pipe and stall.
    child.stderr?.resume?.();
    child.once?.("error", () => settle(null));
    child.once?.("close", () => settle(parseShellPath(out)));
    timer = setTimeout(() => {
      if (settled) return;
      killTree(child, "SIGKILL");
      settle(null);
    }, timeoutMs);
  });
}

let adoption = null;

/**
 * Adopt the login shell's PATH into `env` (the deck's own process.env), once per
 * process: the second call gets the first call's promise, whatever it is
 * passed. When the shell's PATH has folders the deck's lacks, `env.PATH`
 * becomes the merged value, which every child started afterwards inherits —
 * the sign-in, the quota read, the terminal engine. Resolves `{ added }`, the
 * number of folders appended. Never rejects.
 */
export function adoptLoginShellPath({
  env = process.env,
  platform = process.platform,
  read = readLoginShellPath,
} = {}) {
  adoption ??= (async () => {
    try {
      const shellPath = await read({ env, platform });
      if (!shellPath) return { added: 0 };
      const { path, added } = mergePath(env.PATH ?? "", shellPath);
      if (added > 0) env.PATH = path;
      return { added };
    } catch {
      return { added: 0 };
    }
  })();
  return adoption;
}

/** Forget the adoption, so a test can run it again. */
export function resetLoginShellPathAdoption() {
  adoption = null;
}

/**
 * Resolve a program; when the answer is not runnable, adopt the login shell's
 * PATH and resolve once more. A program found the first time costs nothing
 * new: no shell is started. `adopt` failing is the same as it adding nothing.
 */
export async function resolveWithLoginShell({ resolve, runnable, adopt = () => adoptLoginShellPath() }) {
  const first = resolve();
  if (runnable(first)) return first;
  try { await adopt(); } catch { /* the second answer is the first one */ }
  return resolve();
}

/**
 * The boot's half: start the adoption, WITHOUT waiting for it, when nothing
 * names a `claude` and the deck cannot find one by itself. Returns whether it
 * started. Never throws, never delays the boot; the quota read and the terminal
 * engine that start after it see the merged PATH once it lands, and a sign-in
 * that comes before then waits for the same promise.
 */
export function adoptLoginShellPathAtBoot({
  env = process.env,
  platform = process.platform,
  findsClaude,
  adopt = adoptLoginShellPath,
} = {}) {
  try {
    if (platform === "win32") return false;
    if (String(env.AGENTS_DECK_CLAUDE ?? "").trim()) return false;
    if (findsClaude()) return false;
    Promise.resolve(adopt({ env, platform })).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
