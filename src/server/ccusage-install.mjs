// The managed ccusage install: where it lives, how npm is asked to build and
// update it, what is said when that fails, and the one repair a broken one
// gets. ccusage.mjs decides when to run ccusage and reads what it prints; this
// is only about there being a copy of the deck's own to run.
//
// Performance: we do NOT run `npx -y ccusage@latest` on every call — that hits
// the npm registry to resolve `@latest` (and re-downloads when the npx cache is
// cold), so each modal open waited seconds. Instead we keep our OWN managed
// install under ~/.agents-deck/ccusage and invoke it directly with
// `node <pkg>/src/cli.js` (no npx, no registry round-trip). A throttled
// once-per-day background check upgrades it when a newer ccusage ships, while
// the current call always serves from the already-installed copy. If the
// managed install is missing/broken we fall back to the old npx path so the
// feature still works on a fresh machine.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { killTree, shimPath, spawnSpec } from "./exec.mjs";
import { oneLine } from "./term.mjs";
import { note } from "./ccusage-failure.mjs";

const INSTALL_TIMEOUT_MS = 120_000; // first-run npm install can be slow
const UPDATE_CHECK_MS = 24 * 3600_000; // check npm for a newer ccusage once/day

const CACHE_DIR = path.join(os.homedir(), ".agents-deck", "ccusage");
const PKG_DIR = path.join(CACHE_DIR, "node_modules", "ccusage");
const MARKER = path.join(CACHE_DIR, ".last-update-check");

/**
 * The name to hand cmd.exe for one of npm's Windows shims: its full path when
 * one can be found, and the bare name only when none can.
 *
 * The full path is not a tidiness preference, it is the fix for #456. A shim
 * launched by bare name computes `%~dp0` — which is where it looks for
 * npm-prefix.js, npm-cli.js and npx-cli.js — from the deck's WORKING DIRECTORY
 * rather than from its own, so on a deck started from `C:\Users\vceban` both
 * shims died with `Cannot find module 'C:\Users\vceban\node_modules\npm\bin\…'`
 * on a machine whose npm was perfectly healthy. shimPath in exec.mjs carries
 * the whole account; what matters here is that BOTH the managed install and the
 * npx fallback are launched this way, so both failed, and diagnosing either
 * half alone could never have explained the other.
 *
 * Falling back to the bare name is deliberate: it is exactly what this did
 * before, so a layout shimPath cannot see is no worse off than it was, and on
 * such a machine cmd.exe's own PATH search still gets its turn.
 */
export const winShim = (name, deps) => shimPath(name, deps) ?? name;

// npm is a .cmd shim on Windows, which spawn can only launch through cmd.exe.
// `shell: true` is the tempting way to get there and the wrong one: Node then
// joins file and args with single spaces and no quoting, so on a profile like
// C:\Users\John Smith the `--prefix <CACHE_DIR>` below arrived as
// `--prefix C:\Users\John` plus a bogus package spec `Smith\.agents-deck\...`,
// npm exited non-zero, and the managed install never materialised. spawnSpec
// routes the .cmd through cmd.exe with every argument quoted, and hands back
// the argument vector untouched everywhere else.
//
// POSIX is untouched by any of this: `npm` there is a real executable on PATH,
// not a batch file, so isBatch is false, viaCmd never runs, and the vector goes
// to spawn exactly as it always has.
function npmSpec(args, platform = process.platform, deps) {
  return spawnSpec(platform === "win32" ? winShim("npm.cmd", deps) : "npm", args, platform);
}

/**
 * What `spawn` gets for `npm install ccusage@<spec>`.
 * Exported for tests: the platform is a parameter so the Windows command line
 * can be checked from any OS, and `deps` stands in for the Windows filesystem
 * the shim lookup asks about.
 */
export const installSpec = (spec = "latest", platform = process.platform, deps) =>
  npmSpec(["install", `ccusage@${spec}`, "--prefix", CACHE_DIR,
    "--no-save", "--no-audit", "--no-fund", "--loglevel", "error"], platform, deps);

let _installing = null;   // Promise guard so concurrent calls share one install
let _checkedThisRun = false; // only kick the daily check once per process boot

// The last `npm install` that failed, in one line of its own words.
//
// Module scope rather than a value thrown out of the install, because the two
// callers that matter never see that throw. primeCcusage runs the install at
// boot and only logs the rejection; a second modal open that arrives while an
// install is in flight awaits the SHARED promise, whose rejection has already
// been handled by the first. Both then land on the npx fallback with nothing to
// say about why they were there — which is precisely how three rounds of
// debugging went to the fallback's stderr while the install's own account
// stayed on a terminal row the deck had already painted over.
//
// One line, not the whole dump: this is written into a sentence in a 46ch box.
// The full text still goes to the terminal through note() below.
let _lastInstallError = null;
const INSTALL_ERROR_ROOM = 240;

/** The last failed install's line, or null once an install has worked — what
 *  getRunner hands the npx fallback to carry. */
export function lastInstallError() { return _lastInstallError; }

/**
 * Start the one shared install, remembering how it ended.
 *
 * Deduped through `_installing` the way it always was, so concurrent callers
 * cost one `npm install` between them, and the outcome survives the promise.
 *
 * This used to read `_installing = (async () => { installSync(spec); })()`, and
 * that wrapper was the whole of #476: an async function body runs synchronously
 * up to its first `await`, and there was none, so the IIFE turned a throw into
 * a rejection and bought no asynchrony at all. `installSync` was a `spawnSync`
 * of `npm install` with a two-minute deadline, and it ran on the caller's
 * stack — which at boot is bin/deck.js's, beside jobs that really are async.
 * primeCcusage answered `{ state: "installing" }`, a sentence that says the
 * wait was deferred, while the process could not accept an HTTP connection,
 * write an SSE frame, ingest a hook or repaint the pulse line until npm exited.
 * On a first run, with nothing cached, that is the one boot a new user judges
 * the tool by.
 *
 * `install` below is the fix, and there is now exactly one install mechanism in
 * this module rather than a synchronous one and a background one.
 */
export function startInstall(spec = "latest") {
  if (!_installing) {
    _installing = install(spec)
      .then(() => { _lastInstallError = null; })
      .catch(e => {
        _lastInstallError = oneLine(e?.message ?? e, INSTALL_ERROR_ROOM);
        note("install failed", e);
      })
      .finally(() => { _installing = null; });
  }
  return _installing;
}

// AGENTS_DECK_NO_INSTALL=1 is documented as "never install or update
// claude-swap / ccusage, and never ask npm about releases", so it has to hold
// on the lazy path too — opening the usage-history modal must not be a way to
// pull ccusage off the registry behind the user's back. Read per call rather
// than once at import, because the module is imported lazily and a test (or an
// embedder) may set it after load.
export function installsDisabled() {
  return process.env.AGENTS_DECK_NO_INSTALL === "1";
}

/**
 * Node saying it could not load a file it was pointed at.
 *
 * Both spellings are here because both happen: CommonJS throws
 * `MODULE_NOT_FOUND`, ESM throws `ERR_MODULE_NOT_FOUND` with the wording
 * "Cannot find package" for a bare specifier, and ccusage's entry point is ESM
 * while the npm/npx shims it may be launched through are not.
 *
 * Exported for tests. The one caller is the managed-install branch of
 * runCcusage, where the child is `node <our entry>` and nothing else — so a
 * module Node cannot resolve is by construction a file of OURS that is missing,
 * never the user's npm.
 */
export const cannotLoadModule = (text) =>
  /\b(?:ERR_)?MODULE_NOT_FOUND\b|cannot find (?:module|package)/i.test(String(text ?? ""));

// ── managed install ─────────────────────────────────────────────────────────

// Absolute path to ccusage's CLI entry inside our managed install, or null if
// not installed. Reads the package's `bin` field (currently "./src/cli.js").
//
// `bin` is a string out of a package.json downloaded from the registry, and it
// is joined onto PKG_DIR and then handed to `spawn(node, [entry])` — so a `bin`
// of "../../../evil.js" names a file outside the managed install and gets run.
// existsSync alone does not notice: it is asked whether the escaped path is
// there, and for an attacker who put something there the answer is yes.
//
// The narrowness is worth stating rather than leaving implied: a package that
// can choose its own `bin` can also ship an install script, so this is not the
// weak link in a hostile-package scenario. What it does close is the case where
// only the file is influenced — a tampered or half-written package.json in the
// cache dir, or a `bin` that walks out of the install by accident — and it
// costs one comparison.
//
// Exported for tests: the containment rule is the whole point of the function
// and there is no other way to reach it without an install on disk.
export function resolveEntry() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));
    let rel = pkg.bin;
    if (rel && typeof rel === "object") rel = rel.ccusage ?? Object.values(rel)[0];
    if (typeof rel !== "string") return null;
    const entry = path.resolve(PKG_DIR, rel);
    // path.resolve, not path.join, so an ABSOLUTE `bin` is measured as the
    // absolute path it is rather than being silently re-rooted under PKG_DIR
    // and passing on a technicality. The trailing separator is what stops a
    // sibling directory whose name merely starts with PKG_DIR's — and it also
    // rejects PKG_DIR itself, which is a directory and no kind of entry point.
    if (!entry.startsWith(path.resolve(PKG_DIR) + path.sep)) return null;
    return existsSync(entry) ? { entry, version: pkg.version } : null;
  } catch {
    return null;
  }
}

/**
 * Everything a failed install is known to have said, in the order the answer is
 * usually in.
 *
 * The old line read `(r.stderr || "").trim() || r.status`, which threw away the
 * two things most likely to be the whole story. `error` is where a failure to
 * LAUNCH lands — ENOENT for a comspec that is not there, EINVAL for a .cmd Node
 * refuses to spawn directly, and the expired deadline — and it comes with no
 * status at all, so what reached the terminal in every one of those cases was
 * the word "null". And npm has never confined itself to stderr: a shim that
 * dies before npm starts writes wherever Node chose, and `npm ERR!` blocks have
 * landed on stdout across majors.
 *
 * The four fields are spawnSync's, because that is where they were first read
 * off; `install` below now fills the same shape from the 'error' event, the
 * exit status and the two collected streams.
 */
function installFailureText(r) {
  const parts = [];
  if (r?.error?.message) parts.push(String(r.error.message));
  const stderr = String(r?.stderr ?? "").trim();
  const stdout = String(r?.stdout ?? "").trim();
  if (stderr) parts.push(stderr);
  if (stdout) parts.push(stdout);
  if (!parts.length) parts.push(r?.status === null || r?.status === undefined
    ? "npm exited without a status and said nothing"
    : `npm exited ${r.status} and said nothing`);
  return parts.join(" — ");
}

/**
 * Which level of the managed install `npm install --prefix` actually produced.
 *
 * This is the honest answer to the question nobody could answer from a
 * screenshot: an install that exits 0 and leaves a tree resolveEntry cannot use
 * is reported as SUCCESS by an exit code alone, and #432 found that exact shape
 * once already. Naming the first level that is not there turns "ccusage could
 * not report usage" into a sentence about this machine's disk — whether npm
 * wrote nothing, wrote a node_modules with no ccusage in it, or wrote a package
 * whose entry point this deck refuses.
 */
function installTreeReport() {
  const levels = [
    [CACHE_DIR, "the prefix directory"],
    [path.join(CACHE_DIR, "node_modules"), "node_modules under it"],
    [PKG_DIR, "node_modules/ccusage"],
    [path.join(PKG_DIR, "package.json"), "node_modules/ccusage/package.json"],
  ];
  for (const [where, name] of levels) {
    if (!existsSync(where)) return `${name} is not there`;
  }
  // Every level exists, so resolveEntry refused for one of its own reasons: an
  // unreadable or bin-less package.json, or a `bin` pointing outside the
  // package. All three are about the package rather than about npm.
  return "the package is there but its bin entry could not be read or does not point inside it";
}

/**
 * Run `npm install ccusage@<spec> --prefix CACHE_DIR`, off this stack.
 *
 * The ONE install in this module, awaited by startInstall and dropped on the
 * floor by the daily update path below. It was two — a `spawnSync` for the cold
 * path and a fire-and-forget `spawn` for the background one — and the sync half
 * is what #476 removes: nothing here needs an answer before the next tick, and
 * a two-minute `spawnSync` at boot is two minutes of a dead process.
 *
 * Everything the sync path was careful about is carried over unchanged, because
 * every one of those cares was bought with a bug report:
 *
 *   - the vector is `installSpec`'s, spread into spawn exactly as spawnSync got
 *     it, which is what keeps #456's absolute `npm.cmd` and #362's per-argument
 *     quoting on Windows. `opts` is spread LAST for the same reason it was
 *     before: it carries windowsVerbatimArguments, and nothing above it may win.
 *   - `windowsHide`, so no console window flashes up.
 *   - INSTALL_TIMEOUT_MS, as a deadline this module enforces itself rather than
 *     spawn's own `timeout` option. That option sends one signal to the process
 *     it started, and on Windows a `.cmd` runs THROUGH cmd.exe — so the signal
 *     would land on the wrapper and leave npm downloading, which is the same
 *     distinction exec.mjs's `run` states and the reason killTree exists. Same
 *     shape as runOnce in ccusage-runner.mjs, so ccusage's children have one
 *     deadline pattern rather than two.
 *
 * Diagnosis is unchanged too: `installFailureText` is handed the same four
 * fields spawnSync used to hand it — a failure to LAUNCH in `error`, the exit
 * status, and both output streams, because npm has never confined itself to
 * stderr.
 */
function install(spec = "latest") {
  return new Promise((resolve, reject) => {
    mkdirSync(CACHE_DIR, { recursive: true });
    const { file, args, opts } = installSpec(spec);
    const child = spawn(file, args, { windowsHide: true, ...opts });
    let out = "", err = "", settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    // A child that dies emits 'error' AND THEN 'close', and a deadline that
    // fires kills the child and so provokes both — hence `settled`. Whichever
    // arrives first is the account that travels.
    const failed = (r) => finish(reject, new Error(`npm install ccusage failed: ${installFailureText(r)}`));
    timer = setTimeout(() => {
      // The verdict is stated before the kill, the order exec.mjs's `run` uses:
      // the answer must not depend on the killed child cooperating.
      failed({
        error: { message: `npm install timed out after ${INSTALL_TIMEOUT_MS}ms` },
        stdout: out,
        stderr: err,
      });
      killTree(child);
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", d => { out += d; });
    child.stderr?.on("data", d => { err += d; });
    child.on("error", e => failed({ error: e, stdout: out, stderr: err }));
    child.on("close", status => {
      if (status !== 0) return failed({ status, stdout: out, stderr: err });
      // A zero exit is npm's opinion, not a fact about the disk, and the caller
      // treats "the install resolved" as "there is something to run". Checking
      // here is what stops a silent success: getRunner used to call
      // resolveEntry(), get null, and fall through to the npx fallback with
      // NOTHING recorded anywhere about why — so the modal explained the
      // fallback's stderr and the install's half of the story was never written
      // down at all.
      if (!resolveEntry()) {
        // The reason before the path (#1672). startInstall fits this to
        // INSTALL_ERROR_ROOM from the start, and with the path first a long home
        // directory used the room up, so the level that was missing, the one
        // thing this sentence is for, was what got cut.
        return finish(reject, new Error(
          `npm install ccusage exited 0 but left nothing runnable: ${installTreeReport()}, `
          + `under ${CACHE_DIR}`,
        ));
      }
      finish(resolve, undefined);
    });
  });
}

// The daily update path's install: the same one above, with nobody listening.
//
// It has no shared promise and no `_lastInstallError` on purpose. This runs
// behind a ccusage that already works, so a failed upgrade is not news the
// modal should lead with — the copy on disk still answers, and the check comes
// round again tomorrow.
function installInBackground(spec = "latest") {
  install(spec).catch(() => { /* best-effort */ });
}

// True at most once per UPDATE_CHECK_MS, gated by the marker file's mtime so the
// throttle survives restarts.
function updateCheckDue() {
  try {
    return Date.now() - statSync(MARKER).mtimeMs > UPDATE_CHECK_MS;
  } catch {
    return true; // no marker yet → due
  }
}
// (Re)write the marker so its mtime marks "now" as the last check time.
export function touchMarker() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(MARKER, String(Date.now()));
  } catch { /* ignore */ }
}

/** Whether the daily check is due: this process has not checked yet, and the
 *  marker says the day is up. maybeBackgroundUpdate asks it before going to
 *  npm, and primeCcusage asks the same question to report `updating`, so the
 *  two cannot disagree about what the boot row says is happening. */
export function backgroundUpdateDue() {
  return !_checkedThisRun && updateCheckDue();
}

// Non-blocking: compare installed version to npm `latest`; install if newer.
export function maybeBackgroundUpdate(installedVersion) {
  if (installsDisabled()) return; // no `npm view`, no upgrade install
  if (!backgroundUpdateDue()) return;
  _checkedThisRun = true;
  touchMarker();
  try {
    const { file, args, opts } = npmSpec(["view", "ccusage", "version"]);
    const child = spawn(file, args, { windowsHide: true, ...opts });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.on("error", () => {});
    child.on("close", () => {
      const latest = out.trim();
      if (latest && latest !== installedVersion) installInBackground(latest);
    });
  } catch { /* ignore */ }
}

// At most one repair per process, so a package that is simply unrunnable —
// reinstalled and still broken — cannot put this into a loop of npm installs.
let _repairedThisRun = false;

/**
 * Throw away a managed install that resolves but cannot run, so the next
 * attempt builds a new one.
 *
 * This is the only genuinely permanent failure in this module, and it is the
 * one a broken npm creates: `npm install` that dies partway leaves a
 * package.json and an entry file on disk, resolveEntry answers "installed", and
 * getRunner then hands back that entry FOREVER. Nothing re-checks it —
 * maybeBackgroundUpdate only reinstalls when the registry has a newer version,
 * so even a repaired npm never repaired the install. Every run failed
 * identically, the modal said "try again", and the only thing that actually
 * worked was deleting ~/.agents-deck/ccusage by hand, which nothing in the
 * product tells anyone to do.
 *
 * Only the managed branch qualifies: the npx fallback's failures are npm's own
 * and none of this deck's business to delete anything over.
 *
 * Not done under AGENTS_DECK_NO_INSTALL=1. That variable is a promise not to
 * fetch, and removing the only copy on a machine that cannot replace it would
 * turn a broken feature into an absent one.
 */
export function discardDamagedInstall(runner, err) {
  if (_repairedThisRun || runner.kind !== "node" || installsDisabled()) return false;
  if (!cannotLoadModule(err?.message)) return false;
  // THE FLAG IS SPENT ON A REPAIR THAT HAPPENED, not on one that was attempted
  // (#790). It used to be set here, before the try — and the rm below fails on
  // Windows for the reason its own maxRetries comment gives: the `node <entry>`
  // child that just exited still holds a handle, the unlink marks the file
  // delete-pending, and rmdir answers ENOTEMPTY past all ten retries. The catch
  // returned false with NOTHING removed, and every later modal open and every
  // 60s poll for the life of the deck then short-circuited on this same flag —
  // including seconds later, once the handle was gone and the rm would have
  // worked. The user's only way out was deleting ~/.agents-deck/ccusage by
  // hand, which nothing tells them.
  //
  // The budget exists to stop a loop of INSTALLS. Here it was being consumed by
  // a repair that never happened and never reached an install.
  try {
    // maxRetries because of what has just happened: the deck ran `node <entry>`
    // out of this very directory a moment ago, and on Windows a file any handle
    // still holds cannot be deleted — the unlink marks it delete-pending, the
    // name stays, and rmdir on the parent answers ENOTEMPTY. A child still
    // exiting is exactly that handle. Node retries EBUSY, EMFILE, ENFILE,
    // ENOTEMPTY and EPERM with a linear backoff when asked to; unasked, it
    // tries once and gives up, which turned a repairable install into the
    // permanent failure below.
    rmSync(PKG_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  } catch {
    // Windows holds a lock on a file inside a directory being removed more
    // readily than POSIX does, and a half-removed install is still a resolvable
    // one. Say the repair did not happen so the caller reports the real failure
    // rather than retrying into the same broken entry point.
    return false;
  }
  const gone = !resolveEntry();
  // Only now. The directory is really gone, so this deck has spent its one
  // repair and the budget is doing its job. A failed `rm` returned false above
  // without touching the flag, so the next poll — seconds later, once the
  // handle is released — is free to try again.
  if (gone) _repairedThisRun = true;
  return gone;
}
