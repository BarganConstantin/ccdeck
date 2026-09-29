// Which ccusage runs, and running it once.
//
// Three paths answer, in an order getRunner explains below: a copy the user
// named or has on PATH, the deck's own managed install (ccusage-install.mjs),
// and `npx -y ccusage@latest` when neither is there. None of them is handed
// to a shell. What to ask ccusage and what to make of its answer are
// ccusage.mjs's; this module only turns an argument vector into a child and
// its stdout, and retries the one failure a rebuilt install can fix.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { killTree, pathLookup, spawnSpec } from "./exec.mjs";
import { note, stamp, tagged } from "./ccusage-failure.mjs";
import {
  discardDamagedInstall, installsDisabled, lastInstallError, maybeBackgroundUpdate, resolveEntry,
  startInstall, touchMarker, winShim,
} from "./ccusage-install.mjs";

const TIMEOUT_MS = 90_000;

// npx is the same kind of shim as npm, and the fallback run needs the same
// treatment for a second, sharper reason: its argument vector carries a
// user-supplied `--since`. `shell: true` handed `[file, ...args].join(" ")` to
// /bin/sh -c, so `GET /api/ccusage?since=1;id;` ran `id` — and because that
// route is a GET, any page open in the user's browser could aim it at the
// loopback port with no CORS, no preflight and no need to read the answer.
// spawnSpec quotes each argument into the cmd.exe line on Windows and spawns
// the vector untouched everywhere else, so nothing in it is ever parsed as
// syntax. Naming the file `npx.cmd` on Windows is what makes that work: only a
// .cmd/.bat file routes through cmd.exe, and a bare `npx` there is not a file
// spawn can launch at all (PATHEXT is a shell's job), so asking for the
// extensionless name would trade a shell injection for an ENOENT. What it must
// NOT be is the bare `npx.cmd` this said until #456 — see winShim.
function npxSpec(args, platform = process.platform, deps) {
  return spawnSpec(platform === "win32" ? winShim("npx.cmd", deps) : "npx", args, platform);
}

/**
 * What `spawn` gets for the portable `npx -y ccusage@latest <args>` fallback.
 * Exported for tests: the platform is a parameter so the Windows command line
 * can be checked from any OS, and `deps` stands in for the Windows filesystem
 * the shim lookup asks about.
 */
export const fallbackSpec = (args = [], platform = process.platform, deps) =>
  npxSpec(["-y", "ccusage@latest", ...args], platform, deps);

// ── the user's own copy ─────────────────────────────────────────────────────

/**
 * A ccusage the USER put somewhere, either by naming it outright or by having
 * it on PATH — or null when there is no such thing.
 *
 * This is #433, and the case for it is not that a PATH search is nice to have.
 * The deck has been telling people "put ccusage on PATH yourself" in
 * admin-failure.ts for as long as that sentence has existed, and nothing
 * anywhere ever looked: a user who did exactly what they were told, and could
 * prove it with `ccusage --version` in their own shell, got the identical
 * failure on the next click. Two ways out of that, and the other one is to
 * delete the promise. It is kept because there is a configuration that needs it
 * and has no other:
 *
 *   - `AGENTS_DECK_NO_INSTALL=1` is documented as "never install or update
 *     claude-swap / ccusage". Someone who sets it AND installs ccusage
 *     themselves has done the only thing that flag can sensibly mean, and until
 *     now the deck answered "ccusage is not installed" while it was installed
 *     and on their PATH. There was NO combination of settings that made a
 *     self-managed ccusage work.
 *   - The #432 machine — npm and npx both unusable on disk — cannot create the
 *     managed install and cannot run the npx fallback. A copy the user already
 *     has is the only route left, and it was the one route the deck refused to
 *     look down.
 *
 * The override wins over PATH the way AGENTS_DECK_CSWAP does over cswap's own
 * search, and is never remembered, because somebody debugging a bad resolution
 * needs a change to it to take effect on the next click rather than the next
 * restart. Nothing here is cached for the same reason, and it is affordable:
 * a lookup is a handful of stats, once per uncached fetch, against a process
 * spawn that follows it.
 *
 * `platform` and `deps` are parameters, and this is exported, for the reason
 * every other Windows answer in this module is: the PATHEXT walk and the
 * `.cmd` spelling have to be checkable from a machine that cannot run Windows.
 */
export function userCcusage(platform = process.platform, deps, env = process.env) {
  const named = env.AGENTS_DECK_CCUSAGE;
  if (named) {
    // A path the user typed is used as typed — pathLookup would refuse it
    // anyway, since re-rooting a name that carries a directory is a way to run
    // something other than what was asked for. Whether it EXISTS is the
    // caller's question, because "the path you gave me is not there" is a
    // different sentence from "you have no ccusage".
    return { file: String(named), named: true };
  }
  const found = pathLookup("ccusage", platform, deps);
  return found ? { file: found, named: false } : null;
}

/** Does the file an explicit override names actually exist? Split out so the
 *  existence check is injectable alongside the lookup above. */
export const overrideIsThere = (file, { exists = existsSync } = {}) => {
  try {
    return exists(file);
  } catch {
    return false;
  }
};

// Ensure a runnable ccusage. Returns { kind:"node", entry } for the managed
// install, { kind:"path", file } for a copy the user provided, or { kind:"npx" }
// as the portable fallback.
//
// The order is the whole design decision, so it is stated rather than implied.
//
// An explicit AGENTS_DECK_CCUSAGE is first and is never fallen through: a user
// who pointed the deck at a file and got silently ignored has been given a
// setting that does nothing, which is worse than not having one. If it does not
// resolve, the failure names THAT — "npx is not on this deck's PATH" would be
// both true and completely beside the point.
//
// The managed install then comes BEFORE the PATH copy, which is the opposite of
// what #433 proposed, and deliberately. Preferring PATH would silently change
// which ccusage runs on every machine that already has both — a deck that works
// today would start running a copy it has never run, and an old global ccusage
// without `daily --json` would turn a working panel into a broken one for no
// reason the user asked for. The PATH copy is an ESCAPE ROUTE, and it wants to
// be reached exactly when the managed install is not there; someone who wants
// their own copy to win over the deck's says so with AGENTS_DECK_CCUSAGE, which
// is unambiguous in a way a precedence rule never is.
//
// PATH comes before INSTALLING, though. Downloading a second copy of a tool
// that is already on the machine is not something to do to somebody, and it is
// what makes the order identical with and without AGENTS_DECK_NO_INSTALL=1 —
// that flag now removes a step rather than changing the sequence.
async function getRunner() {
  const mine = userCcusage();
  if (mine?.named) {
    if (!overrideIsThere(mine.file)) {
      throw tagged("bad_override",
        `AGENTS_DECK_CCUSAGE points at ${mine.file}, and there is no such file`);
    }
    return { kind: "path", file: mine.file, named: true };
  }
  let resolved = resolveEntry();
  if (resolved) {
    maybeBackgroundUpdate(resolved.version);
    return { kind: "node", entry: resolved.entry };
  }
  if (mine) return { kind: "path", file: mine.file, named: false };
  // Nothing installed, nothing of the user's to run, and installs are
  // forbidden. The npx fallback is not an escape hatch — `npx -y ccusage@latest`
  // downloads and runs the same package — so there is no runner to hand back.
  // Fail with the reason, which the usage-history modal shows, instead of
  // quietly installing.
  if (installsDisabled()) {
    throw tagged("no_install", "ccusage is not installed, and installs are off (AGENTS_DECK_NO_INSTALL=1)");
  }
  // Cold: install once (deduped across concurrent callers).
  await startInstall("latest");
  resolved = resolveEntry();
  if (resolved) { touchMarker(); return { kind: "node", entry: resolved.entry }; }
  // npm unavailable / offline → fall back to npx, carrying WHY the managed
  // install is not here. Without that the modal can only describe the fallback,
  // and the fallback is the second thing that failed.
  return { kind: "npx", installError: lastInstallError() };
}

// ── invocation ──────────────────────────────────────────────────────────────

/**
 * What `spawn` gets for a ccusage the user provided.
 *
 * `file` is always an absolute path by the time it reaches here — pathLookup
 * resolves the directory and an override is a path the user typed — and that is
 * load-bearing rather than tidy. On Windows the thing on PATH is `ccusage.cmd`,
 * a batch file, so spawnSpec routes it through cmd.exe; a batch file launched
 * by BARE name computes `%~dp0` from the deck's working directory and goes
 * looking for its payload there, which is #456 exactly. Resolving first and
 * quoting second is the same order the npm and npx shims go through.
 *
 * Exported for tests: the platform is a parameter so the Windows command line
 * can be checked from any OS.
 */
export const userSpec = (file, args = [], platform = process.platform) =>
  spawnSpec(file, args, platform);

/**
 * The platform binary ccusage's own cli.js would run, resolved the way cli.js
 * resolves it (`@ccusage/ccusage-<platform>-<arch>/bin/ccusage[.exe]`, from
 * the package's own directory), or null when there is none.
 *
 * WINDOWS ONLY, and for one reason: cli.js starts that binary WITHOUT hiding
 * its console. The deck runs with no console of its own (detached, or inside
 * the desktop app), so the binary is given a new one — and with Windows
 * Terminal as the default terminal that is a window flashing up on every
 * usage read, measured on a Windows 10 box as a CASCADIA_HOSTING_WINDOW_CLASS
 * hosting ccusage. Running the binary directly, with windowsHide, is what
 * cli.js does minus the window. Elsewhere nothing flashes, and the wrapper
 * stays in the path it has always been in.
 *
 * Exported for tests; `resolve` is injectable.
 */
export function nativeCcusage(entry, platform = process.platform, arch = process.arch, resolve = null) {
  if (platform !== "win32" || typeof entry !== "string" || !entry) return null;
  const pkg = arch === "arm64" ? "@ccusage/ccusage-win32-arm64" : arch === "x64" ? "@ccusage/ccusage-win32-x64" : null;
  if (!pkg) return null;
  try {
    const req = resolve ?? createRequire(entry).resolve;
    return req(`${pkg}/bin/ccusage.exe`);
  } catch {
    return null;
  }
}

// One attempt with one runner. No branch gets a shell. The managed install is
// `node <entry> …`, which never needed one; the user's own copy and the npx
// fallback are routed through spawnSpec instead — see npxSpec and userSpec, and
// note that `args` here ends in whatever /api/ccusage was asked for.
function runOnce(runner, args) {
  const native = runner.kind === "node" ? nativeCcusage(runner.entry) : null;
  const { file, args: full, opts } = native
    ? { file: native, args, opts: {} }
    : runner.kind === "node"
    ? { file: process.execPath, args: [runner.entry, ...args], opts: {} }
    : runner.kind === "path"
      ? userSpec(runner.file, args)
      : fallbackSpec(args);
  return new Promise((resolve, reject) => {
    const child = spawn(file, full, { windowsHide: true, ...opts });
    let out = "", err = "";
    const timer = setTimeout(() => {
      // The npx fallback goes through cmd.exe on Windows, so `child` is the
      // wrapper there and npx is a grandchild that a plain kill would leave
      // downloading.
      killTree(child);
      reject(tagged("timeout", "ccusage timed out"));
    }, TIMEOUT_MS);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `ccusage exited ${code}`));
    });
  });
}

// Run ccusage with the given args, resolve raw stdout AND the runner that
// produced it. One retry, and only for the one failure that is otherwise
// permanent — see discardDamagedInstall. The second getRunner() is what rebuilds
// the install, or falls through to npx when npm cannot.
//
// The runner comes back with the output because the caller has to say which
// path answered: `extractJson` in ccusage.mjs can fail on a run that started
// perfectly well, and "ccusage ran but printed no usage data" reads
// differently depending on which ccusage that was.
export async function runCcusage(args) {
  const runner = await getRunner();
  try {
    return { out: await runOnce(runner, args), runner };
  } catch (err) {
    if (!discardDamagedInstall(runner, err)) throw stamp(err, runner);
    note("managed install was unusable, rebuilding it", err);
    const rebuilt = await getRunner();
    try {
      return { out: await runOnce(rebuilt, args), runner: rebuilt };
    } catch (again) {
      throw stamp(again, rebuilt);
    }
  }
}
