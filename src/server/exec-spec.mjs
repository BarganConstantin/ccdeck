// Which file to run for a command name, and what to hand spawn for it — on
// Linux, macOS and Windows alike.
//
// Everything exec.mjs's header argues for is decided here: the spellings a bare
// name is tried under (candidates), which of them are batch files that must go
// through cmd.exe (isBatch, viaCmd), how one argument is quoted for a shell that
// will parse it (shellQuoteArg), and the absolute path a `.cmd` shim is
// launched under so it finds its own payload (shimPath, pathLookup,
// candidateSpec). Nothing here spawns anything. The platform is a parameter
// throughout, so the Windows answers can be checked from a machine that is not
// Windows.
//
// The one piece of state is the memo of which spelling worked, per command
// name: `candidates` reads it, and `rememberSpelling` is its one write, which
// exec.mjs's runners call once a spelling has proved itself.
//
// exec.mjs re-exports every public name here, so its callers are unchanged.
import { existsSync } from "node:fs";

// Extensions Windows will execute, most specific first. `.com` is omitted —
// nothing ships one, and every extra candidate costs a failed spawn.
const WIN_EXTS = [".exe", ".cmd", ".bat", ""];

// Which spelling worked, per command name. A failed spawn is cheap but not
// free, and these run on a poll.
const resolved = new Map();

/**
 * Remember that `raw` is the spelling of `cmd` that worked, so `candidates`
 * offers it alone from now on.
 *
 * The memo's one write, named. Five places confirm a spelling — a clean `run`,
 * a direct spawn and a clean exit in `runInteractive`, the same two in
 * `runDetached` — and each has its own rule for WHEN a spelling counts as
 * confirmed; see the notes at each. What they record is always the candidate
 * and never a resolved path, for the reason given in `run`.
 */
export function rememberSpelling(cmd, raw) {
  resolved.set(cmd, raw);
}

/**
 * The spellings to try for `cmd`, best first.
 *
 * Exported with the platform as a parameter for the reason everything else in
 * this file is: the Windows answer decides which candidate becomes a batch one,
 * and a batch candidate is the only kind #457 touches — so a test that wants to
 * follow a caller's bare name all the way to the command line cmd.exe receives
 * has to be able to ask for the Windows list from a machine that is not Windows.
 */
export function candidates(cmd, platform = process.platform) {
  if (platform !== "win32") return [cmd];
  // An explicit extension is respected as given.
  if (/\.[a-z]+$/i.test(cmd)) return [cmd];
  const known = resolved.get(cmd);
  return known ? [known] : WIN_EXTS.map(ext => cmd + ext);
}

/** Exported for tests: the platform is a parameter so both can be checked. */
export const isBatch = (file, platform = process.platform) =>
  platform === "win32" && /\.(cmd|bat)$/i.test(file);

/**
 * Rewrite a batch-file invocation as a cmd.exe one.
 *
 * Mirrors what Node does internally for `shell: true` on Windows — comspec,
 * /d /s /c, the whole command line as a single quoted argument, and
 * windowsVerbatimArguments so Node does not quote it a second time. Each
 * argument is quoted by shellQuoteArg below, which has to satisfy cmd.exe AND
 * the argv parser of whatever it launches — see the note there, and #624 for
 * the half of that rule this file was missing until a real cmd.exe was asked.
 */
export function viaCmd(file, args) {
  const line = [file, ...args].map(a => shellQuoteArg(a, "win32")).join(" ");
  return {
    file: process.env.comspec || process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    opts: { windowsVerbatimArguments: true },
  };
}

/**
 * Quote ONE argument into a command line a shell will parse.
 *
 * Everything else in this module exists to avoid needing this: an argument
 * vector is handed to spawn untouched and nothing in it is ever read as syntax.
 * Two callers cannot take that route, and they are the reason this is exported.
 * A Claude Code hook is registered as `{type:"command", command:"<string>"}` —
 * the host CLI runs that string THROUGH A SHELL on every tool call, and the
 * format has no argv form to emit instead. So the string has to be built here,
 * correctly, once.
 *
 * The inputs are not user input in the web sense, but they are not constants
 * either: the hook path is built from $CLAUDE_CONFIG_DIR and homedir(), and the
 * node path from process.execPath. Wrapping those in double quotes — what this
 * used to do — is not escaping on POSIX at all: `$(…)`, a backtick and `\` are
 * all still live inside them, so a config dir named `/tmp/a$(id)b` became shell
 * code written into the user's settings.json and executed on every hook fire.
 * A bare `$` in a path is the same bug wearing a duller hat — `$HOME` expands to
 * nothing, the hook path silently becomes wrong, and hooks stop firing with no
 * error anywhere.
 *
 * POSIX gets single quotes, inside which NOTHING is special, with the one
 * escape that form has: close the quote, emit a backslash-quote, reopen.
 *
 * Windows gets the rule below — the same one viaCmd applies above, so this file
 * has one Windows quoting rule rather than two. It has to satisfy TWO parsers,
 * and that is the whole of its difficulty, because they disagree about the
 * backslash:
 *
 *   cmd.exe reads the line only far enough to find where the command ends. It
 *   has no escape for a quote at all — a `"` toggles "inside quotes", and `&`,
 *   `|`, `<`, `>`, `^`, `(` and `)` are syntax only while outside — and it does
 *   not treat `\` as anything. Then it hands the rest of the line on AS TEXT.
 *
 *   The program on the other end splits that text into argv itself, and for
 *   node that is the UCRT parser, which DOES read `\` as an escape in front of
 *   a quote: 2n backslashes before a `"` are n backslashes and a quote that
 *   toggles, 2n+1 are n backslashes and a literal `"`.
 *
 * So an embedded `"` is written `""` rather than `\"` — two toggles is no net
 * change to cmd.exe's idea of where it is, while the child's parser turns the
 * pair back into one quote — and every run of backslashes that ends up in front
 * of a quote, INCLUDING THE CLOSING ONE THIS ADDS, is doubled so the child does
 * not read it as an escape.
 *
 * That last clause is #624 and it was missing. `"` + arg + `"` alone turns a
 * path ending in a separator — `C:\Program Files\nodejs\` — into
 * `"C:\Program Files\nodejs\"`, whose final `\"` is an escaped quote to the
 * child: the quoted region never closes, and the argument swallows every
 * argument after it on the line. `--provider claude` in the hook command is
 * exactly what it swallowed. A backslash immediately before an embedded quote
 * was the quieter half of the same defect — it was eaten as the escape.
 *
 * The one residual left, unchanged: cmd.exe expands `%VAR%` inside quotes too,
 * and a command line has no escape for it. That is narrower than it sounds,
 * since `%foo%` with no variable `foo` is left alone, and it is a limit of the
 * platform rather than of this function. `!VAR!` is the same limit on a machine
 * with delayed expansion turned on, which is not the default for `cmd /c`.
 *
 * no-shell-hook-commands.test.ts runs the output of this through a real cmd.exe
 * on the Windows leg of the matrix and compares what the child RECEIVED against
 * what was intended. Four literals said this function agreed with itself for
 * three releases; they could not say whether it agreed with Windows.
 */
export function shellQuoteArg(arg, platform = process.platform) {
  const s = String(arg ?? "");
  if (platform !== "win32") return `'${s.split("'").join("'\\''")}'`;
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === "\\") { slashes++; continue; }
    if (ch === '"') { out += "\\".repeat(slashes * 2) + '""'; slashes = 0; continue; }
    out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  // A run that reaches the end of the argument is in front of the closing quote,
  // which is a quote like any other.
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/**
 * The absolute path of a Windows command shim, or null when nothing answers to
 * that name.
 *
 * Why a bare name is not good enough, which is the whole of #456. npm's `.cmd`
 * shims locate every file they need relative to THEMSELVES:
 *
 *     SET "NPM_PREFIX_JS=%~dp0\node_modules\npm\bin\npm-prefix.js"
 *     SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js"
 *
 * `%~dp0` is the drive and path of `%0`, and `%0` is the command token cmd.exe
 * was given. Handed `cmd.exe /d /s /c ""npm.cmd" "install" …`, that token
 * carries no directory of its own, so `%~dp0` came out as the deck's WORKING
 * DIRECTORY instead of the shim's. Reported from Windows 10 with the deck
 * started from `C:\Users\vceban`:
 *
 *     Error: Cannot find module 'C:\Users\vceban\node_modules\npm\bin\npm-prefix.js'
 *     Error: Cannot find module 'C:\Users\vceban\node_modules\npm\bin\npx-cli.js'
 *
 * — two stacks, one defect, and `C:\Users\vceban` is the cwd rather than
 * anything to do with npm: `where npx` on that machine printed
 * `C:\Program Files\nodejs\npx.cmd` and `npx ccdeck` ran perfectly from a
 * prompt. It is ours, introduced when #362 replaced `shell: true` with viaCmd:
 * the quoting was the fix and the bare name was the cost, and it broke the
 * managed install and the npx fallback in the same stroke, which is why every
 * diagnosis of one half kept half-fitting.
 *
 * Node's own directory is tried before PATH because node and npm ship together
 * and that is where the shims are — the same preference npxCliCandidates in
 * npx.mjs states for npm's CLI scripts, so the repo has one rule rather than
 * two. PATH is then walked in its own order, which is what cmd.exe would have
 * done, minus the current directory it searches first: a deck that resolves its
 * npm out of whatever folder it happens to be sitting in is the bug above
 * wearing a hat.
 *
 * The path arithmetic is spelled out rather than done through `node:path` for
 * the reason npxCliCandidates gives: `path` is the platform running the SUITE,
 * so a Windows layout checked from macOS would come back with forward slashes.
 * `execPath`, `pathEnv` and `exists` are injected for the same reason — the
 * Windows answer has to be checkable from an OS that cannot run it.
 *
 * The walk itself now lives in `pathLookup` below, because #433 needed the same
 * one for a tool that is not a shim; this is that walk with the two answers a
 * shim needs — Windows, and node's own directory first.
 */
export const shimPath = (name, deps) =>
  pathLookup(name, "win32", { besideNode: true, ...deps });

/**
 * Where `name` actually lives on PATH, as an absolute path, or null when
 * nothing on PATH answers to it.
 *
 * This is the general form of shimPath above, and it exists because #433 asked
 * for a third way to reach ccusage: the copy a user installed themselves. The
 * deck's own error text has told people to "put ccusage on PATH yourself" since
 * before there was anything that looked, so the choice was to either look or
 * stop saying it — see getRunner in ccusage.mjs for which way that went.
 *
 * Writing it as ONE walk rather than a second one is the point. A PATH search
 * on Windows is not a PATH search plus a note: `ccusage` there is `ccusage.cmd`
 * or `ccusage.exe` and never the bare name, because PATHEXT is a shell's job
 * and spawn is not a shell — which is the whole reason `candidates` exists, so
 * that is what supplies the spellings here. And a `.cmd` found this way is
 * returned as a FULL PATH, which is what keeps #456 fixed: launched by its bare
 * name through cmd.exe, a shim computes `%~dp0` from the deck's working
 * directory and goes hunting for its payload there.
 *
 * `besideNode` is the one thing a shim wants and a tool does not. npm ships
 * beside node, so looking there first is right for `npm.cmd`; for anything else
 * it would quietly overrule the order the user put their own PATH in, which is
 * the one statement of preference they actually made.
 *
 * The check is existence, not executability. That is what `run`'s candidate
 * loop effectively asks too — it spawns and moves on if the spawn fails — and
 * an executable bit is not a thing Windows has. The residue is a directory on
 * PATH that happens to be named after the tool; it would be resolved here and
 * fail on spawn, with the failure naming the path, which is a better place to
 * find out than a silent miss.
 */
export function pathLookup(name, platform = process.platform, {
  execPath = process.execPath,
  pathEnv = process.env.PATH ?? process.env.Path ?? "",
  exists = existsSync,
  besideNode = false,
} = {}) {
  // A name that already carries a directory needs no lookup, and re-rooting it
  // would be a way to run something else entirely.
  if (typeof name !== "string" || !name || /[\\/]/.test(name)) return null;
  const win = platform === "win32";
  const sep = win ? "\\" : "/";
  const dirs = [];
  if (besideNode) {
    const beside = String(execPath ?? "").split(/[\\/]/).slice(0, -1).join(sep);
    if (beside) dirs.push(beside);
  }
  // `;` on Windows, `:` everywhere else. Splitting on the wrong one is not a
  // near miss: a POSIX PATH read with `;` is one enormous directory that
  // exists nowhere, so every lookup would answer null and the feature would
  // look like it had never been written.
  for (const raw of String(pathEnv ?? "").split(win ? ";" : ":")) {
    // A PATH entry may be quoted, and may end in a separator; neither is part
    // of the directory, and both would produce a path nothing exists at.
    const dir = raw.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "");
    if (dir) dirs.push(dir);
  }
  // On POSIX this is `[name]`, so the inner loop runs once and the cost is one
  // stat per directory, exactly as before.
  const spellings = candidates(name, platform);
  for (const dir of dirs) {
    for (const spelling of spellings) {
      const full = `${dir}${sep}${spelling}`;
      try {
        if (exists(full)) return full;
      } catch {
        // An entry that cannot even be stat'ed — a disconnected network drive
        // is the usual one — is a miss, not a reason to stop looking.
      }
    }
  }
  return null;
}

/**
 * What to hand `spawn`/`execFile` for `file` and `args` on this platform, with
 * the argument vector intact and no shell.
 *
 * The alternative every caller reaches for first — `shell: true`, because a
 * .cmd cannot be spawned any other way — is the one thing that must not be
 * used: Node joins the array into a command line with a single space and no
 * per-argument quoting, so `--workspace C:\Users\John Smith\proj` arrives as
 * two arguments and an `&` in a path ends the command early. Batch files go
 * through cmd.exe with each argument quoted; everything else is spawned as
 * given. The platform is a parameter so both branches can be tested.
 *
 * The one thing quoting cannot cover: cmd.exe expands `%VAR%` inside quotes
 * too, and a command line has no escape for it. Every other metacharacter —
 * `&`, `|`, `>`, `^`, `(` — is inert once quoted.
 */
export const spawnSpec = (file, args, platform = process.platform) =>
  isBatch(file, platform) ? viaCmd(file, args) : { file, args, opts: {} };

/**
 * The same thing for ONE CANDIDATE SPELLING out of the list above — which on
 * Windows means deciding the NAME the shim is launched under before deciding
 * how, because those are not the same question.
 *
 * `spawnSpec` answers "how". This answers what #457 put in front of it. A batch
 * candidate runs THROUGH cmd.exe (see viaCmd), and a `.cmd` shim locates its own
 * payload relative to `%~dp0` — the drive and path of the command token cmd.exe
 * was handed. A bare `claude.cmd` carries no directory at all, so `%~dp0` came
 * out as the deck's WORKING DIRECTORY and the shim went hunting for its
 * JavaScript under whatever folder the deck happened to be started from. #456
 * proved exactly that for ccusage's `npm.cmd` and `npx.cmd`; it left the three
 * helpers below alone, and they carry the shims the panels depend on — the
 * `claude.cmd` behind the quota poll and the sign-in, and whatever `.cmd` a
 * Python installer left for cswap. Same defect, same machine, wider blast
 * radius.
 *
 * `?? raw` is the whole safety story and is not optional: when shimPath can see
 * no layout it answers null, and the candidate stays the bare name today's code
 * already uses, so nothing that works now can start failing. It is the same
 * `?? name` ccusage.mjs and npx.mjs spell, so the repo has one rule rather than
 * three. shimPath also refuses any name that already carries a directory, which
 * is what keeps a caller's own absolute candidate — quotaClaudeBin's
 * `%APPDATA%\npm\claude.cmd`, cswapCandidates' `~/.local/bin/cswap.exe` — from
 * being re-rooted somewhere else entirely.
 *
 * `launch` comes back beside the spec because looksMissing has to be told the
 * spelling cmd.exe was ACTUALLY GIVEN rather than the one the loop started
 * from; its own header explains what breaks otherwise, and that coupling is the
 * reason #456 stopped short of doing this.
 *
 * On POSIX `isBatch` is false, so no lookup happens, no filesystem is touched,
 * `launch` is `raw`, and the spec is the object spawnSpec always returned —
 * byte-identical, which is the point.
 */
export function candidateSpec(raw, args, platform = process.platform, deps) {
  const launch = isBatch(raw, platform) ? (shimPath(raw, deps) ?? raw) : raw;
  return { ...spawnSpec(launch, args, platform), launch };
}
