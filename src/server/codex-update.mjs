// Did Codex just update itself? Asked by the terminal pane when a Codex it
// watched exits with status 0, so the pane can tell Codex's own "Update now"
// from /exit.
//
// Codex checks for a new version as it starts and offers to install it. Its
// "Update now" runs npm, Homebrew or bun, prints "Update ran successfully!
// Please restart Codex." and exits 0, exactly as /exit does. What differs is
// on disk: the codex the deck starts was replaced a moment ago. An npm package
// keeps the fixed 1985 times npm gives every file it extracts, so the time to
// read is the change time (ctime), which the system sets whenever a file is
// written or replaced, and which npm, Homebrew and bun all leave fresh on the
// file the command's link points to.
//
// A DURATION FROM THE PAGE, THE TIME FROM THIS CLOCK. The page says how long
// the pane was live, never when: a phone on the LAN keeps its own clock. The
// file counts as replaced while the pane was live when its ctime is no older
// than that, and never older than CODEX_UPDATE_WINDOW_MS, so a Codex updated
// in another terminal before the pane opened, or an hour into a long session,
// is not this pane's update.
//
// A YES OR A NO, NEVER A PATH. The answer is one boolean; where codex lives is
// never sent or logged. Anything that cannot be read is a no, and a no keeps
// the pane exactly as it ended.
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix as posixPath } from "node:path";
import { pathLookup } from "./exec-spec.mjs";

/** The oldest a replaced codex can be and still be this pane's update: an
 *  npm, Homebrew or bun install takes seconds to a minute, and the choice is
 *  made on Codex's first screen. */
export const CODEX_UPDATE_WINDOW_MS = 120_000;

/** The longest a pane's life is taken to be, so what the page sends stays a
 *  duration: a day. */
export const LIVE_FOR_MAX_MS = 24 * 60 * 60_000;

/**
 * Where the codex the deck starts is, or null: PATH, then the places its npm
 * and Homebrew installs land. A deck started from a shortcut has a PATH that
 * never sourced the shell rc that put Codex on it. The JS terminal backend
 * starts its Codex from here too (terminal-sessions.mjs resolveAgentBin).
 */
export function codexBin({ env = process.env, platform = process.platform, home = homedir(), exists = existsSync } = {}) {
  const pathEnv = env.PATH ?? env.Path ?? "";
  for (const bin of ["codex", posixPath.join(home, ".local", "bin", "codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    let at = null;
    if (!/[\\/]/.test(bin)) at = pathLookup(bin, platform, { pathEnv, exists });
    else {
      try { at = exists(bin) ? bin : null; } catch { at = null; }
    }
    if (at) return at;
  }
  return null;
}

/** `liveForMs` as the page sent it, when it is a duration: a finite number of
 *  milliseconds, not negative, held to LIVE_FOR_MAX_MS. Null otherwise. */
export function liveForOf(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, LIVE_FOR_MAX_MS);
}

/**
 * Whether a file whose ctime is `ctimeMs` was replaced while the pane was
 * live: at or after the later of the moment the pane went live (`now` less
 * `liveForMs`) and the start of CODEX_UPDATE_WINDOW_MS. Pure, for the suite.
 */
export function replacedWhileLive(ctimeMs, liveForMs, now) {
  const live = liveForOf(liveForMs);
  if (live === null || typeof ctimeMs !== "number" || !Number.isFinite(ctimeMs)) return false;
  return ctimeMs >= Math.max(now - live, now - CODEX_UPDATE_WINDOW_MS);
}

/**
 * Whether the codex the deck would start now was replaced in the last
 * `liveForMs`: found as the deck finds it (codexBin), followed through its
 * links to the file itself, and that file's ctime read. Never throws: no
 * codex, a link that leads nowhere or a stat refused is a no.
 */
export async function codexReplaced(liveForMs, {
  env = process.env, platform = process.platform, home = homedir(), now = Date.now,
  findBin = codexBin, realpathFn = realpath, statFn = stat,
} = {}) {
  try {
    const bin = findBin({ env, platform, home });
    if (!bin) return false;
    const st = await statFn(await realpathFn(bin));
    return replacedWhileLive(st?.ctimeMs, liveForMs, now());
  } catch {
    return false;
  }
}
