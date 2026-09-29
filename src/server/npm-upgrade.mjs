// The in-app upgrade: whether this copy may install over itself, and the
// `npm i -g` that does it.
//
// This lived in src/server/self-update.mjs: the policy (upgradeSpec,
// upgradeBlockedReason, upgradeMode and the filesystem half, upgradeBlock) and
// the install itself (startUpgrade, the state it reports, and the line of npm's
// log the banner shows). It is the only part of the self-update code that
// writes to the user's machine, and it moved here whole. self-update.mjs asks it why an
// upgrade is refused and how the last one went for the version report, and
// re-exports every name, so index.mjs still reaches startUpgrade there. The
// code is unchanged.
import { inApp } from "./app-host.mjs";
import { accessSync, constants as FS, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { killTree, shimPath, spawnSpec } from "./exec.mjs";
import { npmCliLaunch } from "./npx.mjs";
import {
  frozenNameInstall, hostPackage, installedName, isGitCheckout, isNpxInstall,
  PUBLISHED_NAME, successorRoot, upgradeCommand, upgradeName,
} from "./install-layout.mjs";

// ── installing ───────────────────────────────────────────────────────────────

const INSTALL_TIMEOUT_MS = 300_000; // a cold global install on a slow line

/**
 * What `spawn` gets for `npm install -g <target>@latest`.
 *
 * This was the last caller still spelling it the way #362 and #456 were written
 * to remove: `spawn("npm.cmd", args, { shell: true })`, with a comment claiming
 * it was "the same pair the ccusage installer uses". ccusage stopped using that
 * pair when #456 fixed it, and this one was never revisited — it does not go
 * through `run`/`runInteractive`/`runDetached`, so #457's sweep of their callers
 * could not see it and exec-shim-callers.test.ts never listed it.
 *
 * Both halves of the old spelling were wrong on Windows and only one of them
 * bites today.
 *
 * The one that bites: a `.cmd` shim locates its payload relative to `%~dp0`,
 * the drive and path of the command token cmd.exe was handed, and a BARE
 * `npm.cmd` carries no directory — so `%~dp0` came out as the deck's working
 * directory and npm's shim went looking for `node_modules\npm\bin\npm-cli.js`
 * underneath it. A user with a global install, deck started from
 * `C:\Users\vceban`, clicks Update now and npm dies with `Cannot find module
 * 'C:\Users\vceban\node_modules\npm\bin\npm-cli.js'` — on a machine whose npm
 * is perfectly healthy, and where typing the same command at the same prompt
 * works. shimPath is the answer, and `?? "npm.cmd"` keeps a layout it cannot see
 * exactly as well off as it was.
 *
 * The one that does not, yet: `shell: true` makes Node join file and args with
 * single spaces and no quoting. These arguments contain no spaces, so it has
 * never mattered here — but it is the #362 defect sitting one argument away, and
 * spawnSpec removes it by quoting every token into the cmd.exe line.
 *
 * POSIX is untouched: `npm` there is a real executable, isBatch is false, and
 * the vector goes to spawn exactly as it always has.
 *
 * Exported for tests: the platform is a parameter so the Windows command line
 * can be checked from any OS, and `deps` stands in for the Windows filesystem
 * the shim lookup asks about. The same shape ccusage.mjs's installSpec has.
 */
export function upgradeSpec(target, platform = process.platform, deps) {
  const args = ["install", "-g", `${target}@latest`, "--no-audit", "--no-fund", "--loglevel", "error"];
  // POSIX: the npm-cli.js beside this node, and the bare name only when there
  // is none, because a deck started at login has no PATH that finds npm on a
  // Homebrew or nvm install (#1777). See npmCliLaunch.
  if (platform !== "win32") {
    return { ...(npmCliLaunch(args, { platform, ...deps }) ?? spawnSpec("npm", args, platform)), plain: args };
  }
  const file = shimPath("npm.cmd", deps) ?? "npm.cmd";
  return { ...spawnSpec(file, args, platform), plain: args };
}

/**
 * Why an in-app upgrade would be wrong here, or null when it is fine.
 *
 * Pure so the policy can be read and tested on its own — it is the part that
 * decides whether we are allowed to write to the user's machine.
 */
export function upgradeBlockedReason({ git, npx, writable, optedOut, frozen }) {
  if (optedOut) return "opted_out";
  // The maintainer's own tree. Its version leads npm's, and installing over it
  // would replace a working copy with a published tarball.
  if (git) return "git_checkout";
  // npx runs from a content-addressed cache directory that is never upgraded in
  // place — `npx agents-deck@latest` fetches a DIFFERENT directory, which this
  // process could not switch to even after restarting.
  if (npx) return "npx";
  // A flat install of a retired name: the one shape where `npm i -g <us>@latest`
  // runs cleanly, reports success, and leaves no deck behind — the registry
  // serves a 5 KB pointer for those names now, and npm's reify removes bin/,
  // src/ and hook/ to make room for it. Every other refusal here is "this
  // install cannot be written over"; this one is "what the write would fetch is
  // not a deck", so it is asked before writability rather than after: on a
  // prefix nobody can write, the remedy is still a different command, and
  // naming the wrong one is what #975 is about.
  if (frozen) return "retired_name";
  // Almost always a root-owned global prefix. Failing inside npm with EACCES
  // tells the user less than declining up front does.
  if (!writable) return "not_writable";
  return null;
}

/**
 * How this copy can update itself, if it can at all.
 *
 *   "install" — `npm i -g` here and restart into the new files.
 *   "npx"     — nothing to install: the supervisor re-runs `npx -y <spec>`,
 *               which fetches a NEW cache directory and hands the port to it.
 *   null      — a checkout, an unwritable prefix, or an explicit opt-out; the
 *               user gets the command and does it themselves.
 *
 * Pure, so the policy is one readable expression rather than three conditions
 * spread across the server and the UI.
 */
export function upgradeMode(blockedReason) {
  if (blockedReason === null || blockedReason === undefined) return "install";
  return blockedReason === "npx" ? "npx" : null;
}

/**
 * Can this user write into `p`?
 *
 * ON WINDOWS THE QUESTION HAS TO BE ASKED BY WRITING (#795). libuv's
 * `fs__access` short-circuits to success for anything carrying
 * FILE_ATTRIBUTE_DIRECTORY — "Directories cannot be read-only on Windows" — and
 * never consults the ACL; Node documents this. Both arguments this is called
 * with are always directories, so `writable` was unconditionally true there,
 * `upgradeBlockedReason` could never answer `not_writable`, and the banner
 * offered "Update & restart" on the common nvm-windows layout where the global
 * prefix is C:\Program Files\nodejs and a non-elevated shell cannot write it.
 * npm then died with EPERM and the user got a truncated npm log tail in a
 * 46-character box — where a POSIX user in the same position gets "the install
 * directory is not writable by this user" and the command to paste. The comment
 * on upgradeBlockedReason states the intent the platform defeated: "Failing
 * inside npm with EACCES tells the user less than declining up front does."
 *
 * The probe is `createTemp`'s "wx" pattern, synchronously: a name nothing else
 * can be using, created exclusively and removed at once. POSIX keeps
 * `accessSync`, where it is correct and cheaper.
 */
function dirWritable(p) {
  if (process.platform !== "win32") {
    try { accessSync(p, FS.W_OK); return true; } catch { return false; }
  }
  // `wx` fails if the name exists, so a collision reads as "not writable"
  // rather than clobbering somebody's file — hence pid and a random suffix.
  const probe = join(p, `.ccdeck-w-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(probe, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(probe); } catch { /* never created, or already gone */ }
  }
}

/** The same question, answered against the real filesystem and environment. */
export function upgradeBlock(pkgRoot) {
  // Whatever `npm i -g` would rewrite is what has to be writable, and under the
  // stub layout that is not this directory: `npm i -g ccdeck` replaces
  // <prefix>/lib/node_modules/ccdeck, and the copy running out of its nested
  // node_modules goes with it. In practice both pairs answer the same, since
  // one npm install created them with one owner — but the question is about the
  // tree the command touches, and that tree is the host's.
  //
  // Asked with this build's own name rather than with the default, for the same
  // reason upgradeName is: the host is recognised by the dependency it declares
  // on us, and "us" is whatever the manifest here says — `agents-deck` under the
  // stub npm publishes today, but nothing in this rule should assume that.
  //
  // successorRoot covers the case after such an upgrade has run: pkgRoot is
  // gone, so hostPackage cannot recognise a host that no longer declares us,
  // and asking accessSync about a deleted directory answers ENOENT — which this
  // function reported as `not_writable`, telling the user their npm prefix was
  // read-only when it was not.
  const target = hostPackage(pkgRoot, installedName(pkgRoot))?.root
    ?? successorRoot(pkgRoot)
    ?? pkgRoot;
  return upgradeBlockedReason({
    git: isGitCheckout(pkgRoot),
    npx: isNpxInstall(pkgRoot),
    // npm -g rewrites the package directory and its parent (the global
    // node_modules), so both have to be ours to write.
    writable: dirWritable(target) && dirWritable(resolve(target, "..")),
    // Inside the desktop app the app updates itself; an `npm i -g` here would
    // install a copy it never runs (app-host.mjs).
    optedOut: process.env.AGENTS_DECK_NO_INSTALL === "1" || inApp(),
    // Whether the package that write would fetch is still a deck. Kept out of
    // the pure rule above, like every other input here, so the policy stays one
    // readable expression and this file owns the filesystem half of it.
    frozen: frozenNameInstall(pkgRoot) !== null,
  });
}

// One install at a time, per process. State is deliberately coarse: the UI only
// needs to know whether to show a spinner, a version, or an error.
let _upgrade = { state: "idle", command: null, error: null, at: 0 };

/** Where this process's install stands: its state, the command it runs, and why
 *  it failed when it did, stamped with the moment it got there. Every change to
 *  the state goes through here, so no path can report one without its time. */
function setUpgrade(state, command, error = null) {
  _upgrade = { state, command, error, at: Date.now() };
}

export function upgradeStatus() {
  return { ..._upgrade };
}

/**
 * Start `npm i -g <name>@latest` in the background.
 *
 * Returns immediately with the accepted command, or a refusal. Never installs
 * anything except this deck — under one of its own three published names, and
 * never at a version the caller chose. The argument vector is fixed here, not
 * assembled from request input: the only thing that varies is which alias, and
 * that is read off the install on disk and confined to ALIAS_PACKAGES.
 */
export function startUpgrade({ pkgRoot, name = PUBLISHED_NAME }) {
  if (_upgrade.state === "running") return { ok: true, already: true, command: _upgrade.command };
  const blocked = upgradeBlock(pkgRoot);
  if (blocked) return { ok: false, reason: blocked, command: upgradeCommand(pkgRoot, name) };

  // The package this install can actually be replaced by — the stub for a
  // `npm i -g ccdeck`, the published name everywhere else. Installing `name`
  // there wrote a tree this process never reads, so the version on disk never
  // moved and the same update was offered forever.
  const target = upgradeName(pkgRoot, name);
  const spec = upgradeSpec(target);
  // The LOGICAL vector, not the cmd.exe line: this string is shown to the user
  // and is the one they can paste. `cmd /d /s /c "…"` is an implementation
  // detail of how this platform reaches npm, and pasting it would be advice
  // about the deck rather than about their install.
  const command = `npm ${spec.plain.join(" ")}`;
  setUpgrade("running", command);

  let child;
  try {
    child = spawn(spec.file, spec.args, { ...spec.opts, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    setUpgrade("failed", command, err?.message ?? String(err));
    return { ok: false, reason: "spawn_failed", command };
  }

  // Only the tail is kept: npm's failures put the useful line near the end, and
  // a full buffer of an install log is not something the browser should hold.
  let err = "";
  const keepTail = (s) => { err = (err + s).slice(-4000); };
  child.stdout.on("data", d => keepTail(String(d)));
  child.stderr.on("data", d => keepTail(String(d)));

  // The deadline states the outcome itself, and only then kills.
  //
  // npm is a .cmd shim on Windows and is therefore spawned through cmd.exe, so
  // `child` is cmd.exe and npm itself is a grandchild — a plain kill would
  // report the install as timed out while it carried on writing to
  // node_modules. killTree is what reaches it (taskkill /T there, the same
  // plain signal everywhere else).
  //
  // Leaving the verdict to 'close' was the other half of the same bug. 'close'
  // waits for the stdio pipes, which the grandchild inherited, so on Windows it
  // could arrive minutes after the deadline — or never, if the tree kill could
  // not run at all — and until it did, /api/version kept reporting
  // `state: "running"` with the UI spinning on "installing…" and the guard at
  // the top of this function refusing every retry. When it finally arrived it
  // carried the killed wrapper's status, so a five-minute timeout was announced
  // to the user as "npm exited null".
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    setUpgrade("failed", command, `timed out after ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} minutes`);
    killTree(child);
  }, INSTALL_TIMEOUT_MS);
  timer.unref?.();

  child.on("error", (e) => {
    clearTimeout(timer);
    // A kill can make the child emit one of these; whatever it says, the reason
    // this install failed is the deadline that has already been reported.
    if (timedOut) return;
    setUpgrade("failed", command, e?.message ?? String(e));
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code === 0) {
      // A clean exit is a real install even if it lands after the deadline —
      // npm finishing in the same breath as the timer is the one case where the
      // files on disk disagree with the verdict above, and the files win.
      //
      // Deliberately does not restart anything. The new files on disk make
      // installedVersion() disagree with the running one, and the ordinary
      // drift path takes it from there — including its wait for an idle moment.
      setUpgrade("done", command);
    } else if (!timedOut && _upgrade?.state !== "failed") {
      // Not over a failure the 'error' handler already explained. A missing npm
      // emits 'error' with ENOENT and THEN 'close' with a null code, and this
      // branch used to replace "spawn npm ENOENT" with "npm exited -2" — the
      // one message that says what is wrong, overwritten by the one that does
      // not.
      setUpgrade("failed", command, lastMeaningfulLine(err) || `npm exited ${code}`);
    }
  });

  return { ok: true, command };
}

// The furniture around a Node crash, none of which is the reason anything
// failed. npm's own log needs none of this — it is `npm ERR!` lines and a rule —
// but the two get mixed the moment the thing npm's shim tried to load is
// missing, which is what #535's bare `npm.cmd` produced on every attempt.
const CRASH_NOISE = [
  /^\s*at\s/,                                  // stack frames
  /^\s*\^+\s*$/,                                // the caret under the throw
  /^node:internal\//,                           // the frame node leads with
  /^\s*throw\s/,
  /^Node\.js v/,                                // the last line, and the one that was quoted
  /^\s*[{}]\s*$/,                               // the error object's braces
  /^\s*(code|errno|syscall|path|requireStack|stack):/,
  /^Require stack:/,
  /^-+$/,
  /^A complete log/,
];

/** npm's real complaint, for the banner: the last line that is not furniture.
 *
 *  Last rather than first, and that is the whole reason this is not npx.mjs's
 *  summariser under another name. The two read different documents. npm's log
 *  opens with its codes — `code EACCES`, `syscall mkdir` — and ends with the
 *  sentence a person can act on, so the last line wins. An npx failure is a Node
 *  crash dump, which opens with the sentence and ends with a stack, a brace and
 *  a version banner, so the first signal line wins there. Sharing one function
 *  would mean picking one of those and being wrong about the other half the
 *  time; sharing the NOISE list would be the copy this comment exists instead
 *  of.
 *
 *  What was wrong was not the rule but its list. `lastMeaningfulLine` dropped
 *  `npm ERR!` prefixes, rules and "A complete log", and nothing else — so when
 *  #535's spawn failed with a MODULE_NOT_FOUND dump, the last surviving line was
 *  `Node.js v22.11.0`, and that string was the entire explanation the UI gave
 *  for a failed upgrade. */
export function lastMeaningfulLine(text) {
  const lines = String(text ?? "").split(/\r?\n/)
    .map(l => l.replace(/^npm (ERR!|WARN)\s*/, "").trim())
    .filter(l => l && !CRASH_NOISE.some(re => re.test(l)));
  if (!lines.length) return "";
  // A line that names an error outranks a later line that does not, because
  // what survives the filter after one is usually its context rather than its
  // successor: `Require stack:` is furniture, but the paths listed under it are
  // not shaped like furniture and would otherwise be the last thing standing.
  // Still the LAST such line, not the first — npm's own log builds up to its
  // sentence, and picking the first would answer `code EACCES` where the next
  // line says which directory and why.
  const named = lines.filter(l => /(^|\s)[A-Za-z]*Error:/.test(l));
  const pick = named.length ? named[named.length - 1] : lines[lines.length - 1];
  return pick.slice(0, 300);
}
