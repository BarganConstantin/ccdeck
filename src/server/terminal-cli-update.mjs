// The deck updating the terminal's ccdeck on its own.
//
// terminal-cli.mjs finds the ccdeck a terminal on this machine starts and says
// when it is older than the deck. Saying it was not enough: the desktop app, an
// npx run and a global npm install each update only their own copy, and the
// one a terminal types stayed at the version it was installed at — a 3.42
// `ccdeck` beside a 3.49 deck, answering `ccdeck tui` with "unknown option". A
// copy that old cannot learn to update itself, but the deck can replace it, with
// the `npm i -g` its own Update now runs (npm-upgrade.mjs), aimed at the global
// prefix that copy lives in.
//
// Only where the command a person would type does the same thing: a global npm
// install of `ccdeck`, in a prefix this user can write, that is not the deck's
// own copy (its own update path has that one), under the switch the deck's own
// unattended update obeys (`autoUpdate`), and never with
// AGENTS_DECK_NO_INSTALL=1. Everything else — a root-owned prefix, pnpm, yarn or
// bun, a retired name, a checkout — keeps the command in About and runs nothing.
//
// Nothing of the deck's restarts, so this does not wait for an idle moment the
// way auto-update.mjs does: lifecycle.mjs asks once a minute, after the boot
// grace.
import { readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AWAY_RECHECK_MS, AWAY_RETRY_MS } from "./auto-update.mjs";
import { hostPackage, installedName, PUBLISHED_NAME, upgradeCommand, upgradeName } from "./install-layout.mjs";
import { runInstall, upgradeBlock, upgradeSpec } from "./npm-upgrade.mjs";
import { isOlder } from "./self-update.mjs";
import { terminalCli } from "./terminal-cli.mjs";

/**
 * Why the deck leaves the terminal's copy to the person, or null when it may
 * update it — before the filesystem is asked (upgradeBlock). Pure, so the
 * policy reads as one expression, as upgradeBlockedReason does for the deck's
 * own copy.
 */
export function terminalUpdateBlockedReason({ optedOut, enabled, prefix, name, own }) {
  if (optedOut) return "opted_out";
  if (!enabled) return "off";
  // pnpm, yarn, bun or a link made by hand: `npm i -g` would put a second copy
  // somewhere else and leave this one where it is.
  if (!prefix) return "not_npm";
  // A retired name is fixed by a removal as well as an install
  // (upgradeCommand), and that is the person's to run.
  if (name !== PUBLISHED_NAME) return "retired_name";
  if (own) return "own_copy";
  return null;
}

/**
 * Whether to start an install for `key` — one copy against one deck version —
 * given the last one this process started. Pure.
 *
 * A finished install is not repeated for the same key: when npm's latest is
 * still older than the deck (a desktop build ahead of the registry), installing
 * it again every half hour would change nothing. A failed one is tried again
 * after AWAY_RETRY_MS, as the deck's own unattended update is.
 */
export function terminalUpdateDue({ key, last, now, retryMs = AWAY_RETRY_MS }) {
  if (last?.key !== key) return true;
  if (last.state !== "failed") return false;
  // A clock that moved backwards counts as time elapsed, as in awayUpdateStep.
  return !(now >= last.at && now - last.at < retryMs);
}

// Every deck on a machine sees the same terminal copy — the app's beside one
// started from a checkout, say — and two `npm i -g` into one prefix at once can
// leave it half written. The first takes this file in the global node_modules
// the copy sits in (npm passes over dot-files there), and the others leave that
// tick alone. One left by a deck that died is taken over once it is older than
// an install can last: npm-upgrade.mjs's five minutes, and one more.
const LOCK = ".ccdeck-terminal-update.lock";
const LOCK_STALE_MS = 6 * 60_000;

/**
 * Take the install lock in `dir`. Returns the call that gives it back, or null
 * while another deck holds it. A directory the lock cannot be written to is no
 * refusal: whether npm may write there is upgradeBlock's question, answered
 * already.
 */
export function takeInstallLock(dir, now = Date.now()) {
  const file = join(dir, LOCK);
  const release = () => { try { unlinkSync(file); } catch { /* gone already */ } };
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(file, String(now), { flag: "wx" });
      return release;
    } catch (e) {
      if (e?.code !== "EEXIST") return () => {};
      let at = NaN;
      try { at = Number(readFileSync(file, "utf8")); } catch { /* released meanwhile: try again */ }
      if (Number.isFinite(at) && now >= at && now - at < LOCK_STALE_MS) return null;
      release();
    }
  }
  return null;
}

// The install this process last started for the terminal's copy:
// { key, state: "running" | "done" | "failed", error, at }.
let _last = null;
// The filesystem half of the refusal, kept per copy for AWAY_RECHECK_MS: on
// Windows upgradeBlock proves a directory writable by creating a file in it,
// and /api/version asks on every poll.
let _onDisk = null;

/** Forget both, for tests. */
export function resetTerminalCliUpdate() {
  _last = null;
  _onDisk = null;
}

function real(dir) {
  try { return realpathSync(dir); } catch { return dir; }
}

/** Whether `root` is the copy this deck runs out of. */
function ownCopy(root, pkgRoot) {
  if (!pkgRoot) return false;
  const own = hostPackage(pkgRoot, installedName(pkgRoot))?.root ?? pkgRoot;
  return real(root) === real(own);
}

function blockedOnDisk(root, now, block) {
  if (_onDisk?.root === root && now >= _onDisk.at && now - _onDisk.at < AWAY_RECHECK_MS) return _onDisk.reason;
  const reason = block(root, { ownCopy: false });
  _onDisk = { root, reason, at: now };
  return reason;
}

/** The terminal's copy when it is older than `running`, its key, and why the
 *  deck would leave it alone (null when it would not). */
function look({ running, pkgRoot, enabled, now, block = upgradeBlock, ...opts }) {
  const cli = terminalCli(opts);
  if (!cli || !isOlder(cli.version, running)) return null;
  const reason = terminalUpdateBlockedReason({
    optedOut: process.env.AGENTS_DECK_NO_INSTALL === "1",
    enabled,
    prefix: cli.prefix,
    name: upgradeName(cli.root),
    own: ownCopy(cli.root, pkgRoot),
  }) ?? blockedOnDisk(cli.root, now, block);
  return { cli, key: `${cli.root}>${running}`, reason };
}

/**
 * What /api/version says about the terminal's ccdeck: its version, the line
 * that updates it for that install's shape (upgradeCommand), and what the deck
 * is doing about it — `auto` is "pending" (it will, within the boot grace and a
 * minute), "running", "failed" with npm's own `error`, or null when the copy is
 * left to the person. Null unless it is older than `running`: the deck's own
 * copy, an up-to-date one and a newer one need nothing said.
 */
export function terminalCliState({ running, pkgRoot, enabled, now = Date.now(), ...opts } = {}) {
  const seen = look({ running, pkgRoot, enabled, now, ...opts });
  if (!seen) return null;
  const out = { version: seen.cli.version, command: upgradeCommand(seen.cli.root), auto: null, error: null };
  if (_last?.key === seen.key) {
    if (_last.state === "running") out.auto = "running";
    else if (_last.state === "failed") Object.assign(out, { auto: "failed", error: _last.error });
    // Done and still older: npm had nothing newer, and the command is all
    // that is left to say.
    return out;
  }
  if (!seen.reason) out.auto = "pending";
  return out;
}

/**
 * Start `npm i -g --prefix <its prefix> ccdeck@latest` for the terminal's copy
 * when it is due and no other deck is installing it. True when an install
 * started. `install` and `lock` are runInstall and takeInstallLock, parameters
 * so a test can see the spec without npm or a prefix on disk.
 */
export function updateTerminalCli({
  running, pkgRoot, enabled, now = Date.now(), install = runInstall, lock = takeInstallLock, ...opts
} = {}) {
  if (_last?.state === "running") return false;
  const seen = look({ running, pkgRoot, enabled, now, ...opts });
  if (!seen || seen.reason || !terminalUpdateDue({ key: seen.key, last: _last, now })) return false;
  const release = lock(dirname(seen.cli.root), now);
  if (!release) return false;
  const { key } = seen;
  _last = { key, state: "running", error: null, at: now };
  const spec = upgradeSpec(PUBLISHED_NAME, opts.platform, undefined, seen.cli.prefix);
  return install(spec, (state, error) => {
    _last = { key, state, error: error ?? null, at: Date.now() };
    release();
  });
}
