// Where the deck keeps its OWN things, as opposed to where Claude Code keeps
// its things.
//
// For a year those were one directory. `~/.claude/agent-dag/` held the hook
// Claude Code reads, the deck's private key, its pairings, its port registry
// and a hundred megabytes of event log — and the only reason was that the deck
// already knew that path, because it has to read `~/.claude` to do its job at
// all.
//
// THREE THINGS THAT COST, and none of them is tidiness:
//
//   A person who deletes ~/.claude to fix Claude Code deletes this deck's
//   identity. The key is what every paired machine has pinned, so it is not a
//   setting that comes back — every colleague has to accept this deck again.
//
//   CLAUDE_CONFIG_DIR is Claude Code's knob for keeping a second profile, and
//   pointing it somewhere gave the deck a brand new identity and no pairings,
//   silently. That is a footgun with a fifty-machine blast radius and no error
//   message anywhere.
//
//   The event log is a hundred megabytes of the deck's data inside another
//   application's configuration directory. Nothing about a rotating log is
//   configuration.
//
// So the deck's own state moves to where this platform keeps application data,
// and the two things that CANNOT move stay where they are: `hook.js`, because
// Claude Code reads it from there, and the per-pid port registry, because a
// deck of any version has to be able to list the others — see
// registeredDeckPorts, which reads that directory by name.
//
// The layout is env-paths', which is what Node command-line tools converge on,
// and its rule is the one worth repeating: XDG is a Linux specification, so it
// applies on Linux and nowhere else. macOS has Application Support and Logs;
// Windows has LocalAppData. A tool that puts ~/.config on a Mac is a tool that
// read half the page.
//
// NOTHING IS DELETED BY THE MOVE. Every file is COPIED to its new home and the
// original left where it was, so a deck downgraded to the version before this
// one finds exactly what it had. See migrateDeckFiles.
import { homedir } from "node:os";
import { join, resolve, posix as posixPath, win32 as winPath } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
// The Windows ladder, not `rename` (#786). MoveFileExW refuses while any other
// process holds the destination open — a scanner, the indexer, a backup agent —
// and the file this one renames into place is a private key. Losing that rename
// to a virus scanner would be a deck with no identity, which is the one outcome
// this whole module is written to prevent.
import { renameWithRetry } from "./installer.mjs";

/** The name this deck files itself under. No `-nodejs` suffix, which env-paths
 *  adds to keep a script from colliding with a native app of the same name —
 *  there is no other ccdeck on any of these platforms. */
const APP = "ccdeck";

/** Point the deck's whole home somewhere else in one variable. The escape
 *  hatch for a portable install, a test, or anybody who simply wants it
 *  elsewhere; it wins over every rule below. */
export const HOME_ENV = "CCDECK_HOME";

/** Where the deck kept everything before this, and where two of its files still
 *  live. Also the place a migration reads from. */
export function legacyDeckDir(env = process.env, home = homedir(), platform = process.platform) {
  const { join } = platform === "win32" ? winPath : posixPath;
  return join(claudeConfigDir(env, home), "agent-dag");
}

/**
 * The deck's own durable state: its key, its pairings, the accounts it offers.
 *
 * CLAUDE_CONFIG_DIR IS HONOURED RATHER THAN OVERRIDDEN, and that is deliberate.
 * Somebody who set it has asked for a separate Claude profile and has been
 * getting a separate deck along with it for a year — separate identity,
 * separate pairings, separate share list. Moving those people to one
 * machine-wide deck would collapse two profiles into one on upgrade, which is
 * exactly the kind of silent change this file exists to stop. They keep what
 * they have; everybody else moves.
 */
export function deckDataDir(platform = process.platform, env = process.env, home = homedir()) {
  // THE TARGET PLATFORM'S SEPARATOR, NOT THE HOST'S — the same reason
  // claudeCliCandidates does it, which is that the only way a Windows answer
  // stays right is if it can be checked from a Mac. `node:path` joins with
  // whatever the machine running the code uses, so a bare `join` here answers
  // `\home\u\Library\...` on Windows for a question about macOS.
  const { join } = platform === "win32" ? winPath : posixPath;
  const forced = env[HOME_ENV]?.trim();
  if (forced) return resolve(forced);
  if (env.CLAUDE_CONFIG_DIR?.trim()) return legacyDeckDir(env, home, platform);
  if (platform === "darwin") return join(home, "Library", "Application Support", APP);
  if (platform === "win32") return join(localAppData(env, home, platform), APP, "Data");
  return join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), APP);
}

/**
 * Where a log belongs, which is not where a preference belongs.
 *
 * On Linux that is the state directory rather than the data one: XDG separates
 * "data the user would miss" from "state the program can rebuild", and an event
 * log that rotates at 50 MB is the second. macOS and Windows have a named place
 * for logs and this uses it.
 */
export function deckLogDir(platform = process.platform, env = process.env, home = homedir()) {
  const { join } = platform === "win32" ? winPath : posixPath;
  const forced = env[HOME_ENV]?.trim();
  if (forced) return resolve(forced);
  if (env.CLAUDE_CONFIG_DIR?.trim()) return legacyDeckDir(env, home, platform);
  if (platform === "darwin") return join(home, "Library", "Logs", APP);
  if (platform === "win32") return join(localAppData(env, home, platform), APP, "Log");
  return join(env.XDG_STATE_HOME?.trim() || join(home, ".local", "state"), APP);
}

/** %LOCALAPPDATA%, or the path it points at on every Windows since Vista. The
 *  fallback is not decoration: a service account or a stripped environment can
 *  reach this code with the variable unset, and a deck that throws there is a
 *  deck that will not start. */
function localAppData(env = process.env, home = homedir(), platform = process.platform) {
  const { join } = platform === "win32" ? winPath : posixPath;
  return env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
}

/**
 * WHAT MOVES, and the two things that do not.
 *
 * `hook.js` stays: Claude Code reads it out of ~/.claude/agent-dag and would
 * find nothing if it moved. The per-pid `NNNNN.json` files stay: a deck lists
 * that directory to find the other decks on this machine, and a deck of the
 * previous version reads it by name — move them and two versions running side
 * by side stop seeing each other.
 *
 * `mode` is the file's, not the directory's, and 0600 on the preferences is
 * load-bearing: it is the one file with a private key in it.
 */
export const MOVED = Object.freeze([
  Object.freeze({ name: "prefs.json", where: "data", mode: 0o600 }),
  Object.freeze({ name: "events.jsonl", where: "log", mode: 0o644 }),
  Object.freeze({ name: "events.jsonl.1", where: "log", mode: 0o644 }),
]);

/**
 * Bring a deck's files to their new home, once, and never at the cost of one.
 *
 * FOUR RULES, and each one is a way this could have lost somebody's key:
 *
 *   A destination that already exists is never touched. That is what makes
 *   this safe to run at every boot, and it is also what stops a stale copy in
 *   the old directory from overwriting live state later.
 *
 *   The copy lands on a temp file in the destination directory and is renamed
 *   into place. A copy interrupted half-way is a truncated prefs.json, and a
 *   truncated prefs.json is a deck with no key — which is the whole thing this
 *   is trying not to do.
 *
 *   The original is LEFT WHERE IT IS. Somebody who downgrades finds what they
 *   had. It costs four kilobytes and a hundred megabytes of log that was
 *   already there, and it buys a move nobody can be hurt by.
 *
 *   A failure is reported and swallowed. A read-only home, a full disk, a
 *   permission the installer never had — none of those is a reason for the
 *   deck not to start, and the caller falls back to reading the old path.
 *
 * Returns what it did, so the caller can say so once rather than every boot.
 */
export async function migrateDeckFiles({
  from,
  data,
  log,
  fs,
  /** Separate from `fs` because it is not `fs.rename`: see the import above. */
  rename = renameWithRetry,
  onError,
} = {}) {
  const moved = [];
  const failed = [];
  for (const file of MOVED) {
    const dir = file.where === "log" ? log : data;
    const src = join(from, file.name);
    const dst = join(dir, file.name);
    if (src === dst) continue;
    try {
      // Both questions asked before anything is written: there is something to
      // move, and there is nothing already there.
      if (!(await exists(fs, src))) continue;
      if (await exists(fs, dst)) continue;
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${dst}.${process.pid}.migrating`;
      await fs.copyFile(src, tmp);
      await fs.chmod(tmp, file.mode).catch(() => {});
      await rename(tmp, dst);
      moved.push(file.name);
    } catch (err) {
      failed.push(file.name);
      onError?.(file.name, err);
    }
  }
  return { moved, failed };
}

async function exists(fs, path) {
  try { await fs.stat(path); return true; } catch { return false; }
}

/** An hour. A temp file younger than this may belong to a write happening in
 *  another deck right now, and deleting one of those turns an atomic write into
 *  a lost one. Nothing legitimate is an hour old: the rename that retires a
 *  temp file happens within milliseconds of its creation. */
export const TEMP_STALE_MS = 60 * 60 * 1000;

/**
 * The litter an atomic write leaves when the process is killed between the
 * write and the rename.
 *
 * Ninety-seven of them were found in one directory, the oldest six days old:
 * two waves, one from decks that crashed and one from decks killed by hand
 * mid-write. Nothing has ever swept them, because the code that makes them is
 * the code that is not running any more when they are made.
 *
 * So the sweep belongs at START, where a process that is alive can clean up
 * after the ones that are not — and it is deliberately blind to WHICH deck made
 * a file, because it cannot know: it goes by age instead, which is a fact about
 * the file rather than a guess about a pid.
 */
export async function sweepTempFiles({ dirs, fs, now = Date.now(), onError } = {}) {
  let removed = 0;
  for (const dir of dirs ?? []) {
    let names;
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".tmp") && !name.endsWith(".migrating")) continue;
      const path = join(dir, name);
      try {
        const st = await fs.stat(path);
        if (now - st.mtimeMs < TEMP_STALE_MS) continue;
        await fs.unlink(path);
        removed++;
      } catch (err) {
        onError?.(path, err);
      }
    }
  }
  return removed;
}
