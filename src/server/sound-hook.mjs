// Toggle for the "play a sound when the turn finishes" Stop hook.
//
// Hand-written versions of this hook are almost always one OS-specific
// command — `afplay …` on macOS, a PowerShell one-liner on Windows — ending in
// `|| true`. Each is a silent no-op on every other machine, so a settings.json
// synced across devices ends up with several of them stacked, none of which
// work everywhere. This installs a single entry pointing at notify.mjs, which
// picks its own player at run time.
//
// Only ever touches its own entry, tagged `__agent-dag-sound`. Hooks the user
// wrote themselves are left exactly as found — including the platform-specific
// ones this replaces, which are reported rather than deleted.
//
// Claude Code only, and deliberately: everything here is one entry in Claude
// Code's settings.json, which Claude Code alone reads and executes. There is no
// Codex equivalent — the deck installs no Codex hooks and tails the rollout
// files instead — so a Codex turn ends in silence and no amount of writing to
// this file changes that. The browser is where that is said rather than
// guessed: the topbar button is drawn only where Claude Code is, and its
// tooltip names the limit and the mechanism behind it. If this module ever does
// learn a second provider, src/web/provider-copy.ts's finishSoundTitle is the
// sentence that has to move with it, and finish-sound-scope.test.ts fails until
// it does (#394).
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "./claude-dir.mjs";
import { readSettingsForWrite, writeFileAtomic, installScript } from "./installer.mjs";
import { shellQuoteArg } from "./exec.mjs";

const PKG_ROOT      = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAUDE_DIR    = claudeConfigDir();
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const INSTALL_DIR   = join(CLAUDE_DIR, "agent-dag");

// `.mjs`, and the extension is the whole feature on the machines it matters on.
//
// This script is ESM — `import { spawn } from "node:child_process"` on its first
// executable line — and in the package that is settled by package.json's
// `"type": "module"` two directories up. Installed, it lands in <claude config
// dir>/agent-dag/, where there is normally no package.json between it and the
// filesystem root, so the extension alone decides the format and a `.js` with
// nothing above it is CommonJS. Node's module-syntax detection rescued that, but
// only where detection is on by default: v20.19.0 and v22.7.0 and later. The
// package's own `engines` says `>=18`, and on 18.x, 19.x, 20.0–20.18.x, 21.x and
// 22.0–22.6.x the Stop hook was a `SyntaxError: Cannot use import statement
// outside a module` printed at the end of every turn instead of a sound.
//
// `.mjs` is ESM on every Node that has ever had ESM, with nothing above it
// consulted and no detection involved. A package.json beside the script would
// have been the other spelling of the fix and is the wrong one here: hook.js
// lives in this same directory, is deliberately CommonJS because that is what
// this directory's layout means, and a `{"type":"module"}` next to it would
// break the event forwarder to fix the sound.
const NOTIFY_NAME     = "notify.mjs";
const PACKAGED_NOTIFY = join(PKG_ROOT, "hook", NOTIFY_NAME);
const NOTIFY_PATH     = join(INSTALL_DIR, NOTIFY_NAME);
// What the same script was called before it declared its own format. Swept once
// the entry that named it has been rewritten — see sweepLegacySoundScript.
const LEGACY_NOTIFY_PATH = join(INSTALL_DIR, "notify.js");

const MARK = "__agent-dag-sound";
const EVENT = "Stop";
// Where a user's own sound hooks are kept while the toggle is off, so turning
// the feature off actually produces silence and nothing is destroyed.
const PARKED_PATH = join(homedir(), ".agents-deck", "parked-sound-hooks.json");

// Commands that look like a hand-rolled sound hook. Used only to tell the user
// what is already there — never to modify or remove it.
const SOUND_HINTS = [/\bafplay\b/i, /Media\.SoundPlayer/i, /\bpaplay\b/i, /\baplay\b/i, /canberra-gtk-play/i];

/**
 * The Stop hook's `command` string, escaped for the shell that will run it.
 *
 * Same shape and same reasoning as installer.mjs's hookCommand — see the note
 * there — kept separate because this entry takes no `--provider` and is written
 * to a different key. Exported, with the node path and the platform injectable,
 * for the reason hookCommand gives: the two quoting rules are different, and a
 * test that cannot name a platform can only ever assert its own.
 */
export function soundHookCommand(notifyPath, node = process.execPath,
                                 platform = process.platform) {
  return `${shellQuoteArg(node, platform)} ${shellQuoteArg(notifyPath, platform)}`;
}

/**
 * Read settings.json, refusing to guess at a file that will not parse.
 *
 * Shared with the hook installer, because the danger is the same: this module
 * rewrites the whole file, so treating a damaged one as `{}` replaces every
 * permission, env var and hook the user has with nothing but the sound entry.
 * Only a missing file is an empty one — a stray comma, a BOM, a half-written
 * save from another process all throw SETTINGS_UNREADABLE instead.
 */
async function readSettings() {
  const { settings } = await readSettingsForWrite(SETTINGS_PATH);
  return settings;
}

const isUnreadable = (err) => err?.code === "SETTINGS_UNREADABLE";

/** What every entry point here answers with when it will not touch the file. */
function refusal(err) {
  return {
    ok: false,
    reason: "settings_unreadable",
    settingsPath: SETTINGS_PATH,
    message: err?.message ?? String(err),
  };
}

const isParkFailure = (err) => err?.code === "PARKED_UNREADABLE" || err?.code === "PARKED_UNWRITABLE";

/** The same refusal, for the file the parked hooks live in rather than settings.json. */
function parkRefusal(err) {
  return {
    ok: false,
    reason: err?.code === "PARKED_UNREADABLE" ? "parked_unreadable" : "parked_unwritable",
    parkedPath: PARKED_PATH,
    message: err?.message ?? String(err),
  };
}

/**
 * Write settings.json back atomically — this file holds every hook the user
 * has, and a torn write costs them all of them.
 */
async function writeSettings(settings) {
  await writeFileAtomic(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

const isOurs = (g) => g?.[MARK] === true;

/** Hand-written sound hooks on the Stop event, and whether they run here. */
function foreignSoundHooks(settings) {
  const group = settings?.hooks?.[EVENT];
  if (!Array.isArray(group)) return [];
  const found = [];
  for (const entry of group) {
    if (isOurs(entry)) continue;
    for (const h of entry.hooks ?? []) {
      const cmd = typeof h?.command === "string" ? h.command : "";
      if (!SOUND_HINTS.some(re => re.test(cmd))) continue;
      // A PowerShell hook on a Mac (or afplay on Windows) still runs — it just
      // fails, usually swallowed by a trailing `|| true`. Worth naming.
      const platform = /Media\.SoundPlayer|powershell/i.test(cmd) ? "win32"
                     : /\bafplay\b/i.test(cmd)                    ? "darwin"
                     : "linux";
      found.push({ command: cmd.slice(0, 120), platform, worksHere: platform === process.platform });
    }
  }
  return found;
}

function parkedError(code, why) {
  const err = new Error(
    code === "PARKED_UNREADABLE"
      ? `${PARKED_PATH} could not be read as JSON (${why}). It holds sound hooks you wrote yourself, ` +
        `so it is not being treated as empty — fix the file or move it aside, then try again.`
      : `${PARKED_PATH} could not be written (${why}). It is where your own sound hooks are kept while ` +
        `the toggle is on, so nothing was taken out of settings.json — they would have been in neither file.`,
  );
  err.code = code;
  err.parkedPath = PARKED_PATH;
  return err;
}

/**
 * Read the parked hooks, refusing to guess at a file that will not parse.
 *
 * Same bargain as readSettingsForWrite, for the same reason: this is the only
 * copy of hooks the user wrote by hand, and every caller either overwrites the
 * file or reports how much is in it. A truncated file — a kill mid-write, a full
 * disk — used to read as "nothing was ever parked", and the next toggle wrote
 * its own list over the remains. Only ENOENT is genuinely empty; the array is
 * not optional, because a JSON object here means the file is not ours to touch.
 */
async function readParked() {
  let raw;
  try {
    raw = await readFile(PARKED_PATH, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw parkedError("PARKED_UNREADABLE", err?.message ?? String(err));
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw parkedError("PARKED_UNREADABLE", err?.message ?? String(err));
  }
  if (!Array.isArray(parsed)) throw parkedError("PARKED_UNREADABLE", "top level is not a JSON array");
  return parsed;
}

/**
 * Write the parked hooks, and never quietly fail to.
 *
 * This used to swallow every error, which made the park a suggestion: a
 * root-owned ~/.agents-deck, a full disk or a Windows lock on the file left the
 * write undone while setSoundHook went on to strip the same hooks out of
 * settings.json and report success. Atomic for the other half of it — a torn
 * parked file is a parked file that reads as empty.
 */
async function writeParked(entries) {
  try {
    if (!existsSync(dirname(PARKED_PATH))) await mkdir(dirname(PARKED_PATH), { recursive: true });
    await writeFileAtomic(PARKED_PATH, JSON.stringify(entries, null, 2) + "\n");
  } catch (err) {
    throw parkedError("PARKED_UNWRITABLE", err?.message ?? String(err));
  }
}

/**
 * True when this Stop entry plays a sound, on any platform.
 *
 * Deliberately not limited to the current one. settings.json is commonly
 * synced between machines — this user's own file carries Windows paths
 * alongside macOS ones — so parking only the hook that fires here leaves the
 * other in place, and the switch looks broken again on the other machine.
 */
function isSoundHook(entry) {
  if (isOurs(entry)) return false;
  return (entry.hooks ?? []).some(h =>
    SOUND_HINTS.some(re => re.test(typeof h?.command === "string" ? h.command : "")));
}

export async function soundHookStatus() {
  let settings;
  try {
    settings = await readSettings();
  } catch (err) {
    if (!isUnreadable(err)) throw err;
    // Reporting a healthy "off" here would be a lie the user acts on: the
    // toggle cannot do anything until they repair the file, so say which file
    // and why rather than offering a switch that will refuse.
    return {
      ...refusal(err),
      enabled: false,
      platform: process.platform,
      foreign: [],
      // A parked file that will not read is a second refusal, and settings.json
      // is the one being reported. Count what can be counted.
      parked: await readParked().then(p => p.length, () => 0),
    };
  }
  const group = settings?.hooks?.[EVENT];
  const enabled = Array.isArray(group) && group.some(isOurs);
  let parked;
  try {
    parked = await readParked();
  } catch (err) {
    if (!isParkFailure(err)) throw err;
    // "parked: 0" on a file we cannot read is the lie that sends the user to
    // click the toggle, which is the thing that would overwrite it.
    return { ...parkRefusal(err), enabled, platform: process.platform, foreign: foreignSoundHooks(settings), parked: 0 };
  }
  return {
    ok: true,
    enabled,
    platform: process.platform,
    foreign: foreignSoundHooks(settings),
    parked: parked.length,
  };
}

/**
 * Put back the hooks the toggle set aside.
 *
 * Nothing is deleted, only moved, so a user who preferred their own command
 * can have it back exactly as it was.
 */
export async function restoreParkedSoundHooks() {
  let parked;
  try {
    parked = await readParked();
  } catch (err) {
    if (!isParkFailure(err)) throw err;
    // The file is left exactly as it is. Answering "restored: 0" would be the
    // last word on hooks that are still in there, badly written but present.
    return parkRefusal(err);
  }
  if (parked.length === 0) return { ok: true, restored: 0 };
  let settings;
  try {
    settings = await readSettings();
  } catch (err) {
    if (!isUnreadable(err)) throw err;
    // The parked file is left as it is, so the restore works once the user has
    // fixed settings.json. Nothing is lost by waiting.
    return refusal(err);
  }
  settings.hooks ??= {};
  const group = Array.isArray(settings.hooks[EVENT]) ? settings.hooks[EVENT] : [];
  settings.hooks[EVENT] = [...parked, ...group];
  await writeSettings(settings);
  // Emptying the park comes last and its failure is reported, not swallowed:
  // the hooks are safely back in settings.json now, but a park left behind is
  // one the next restore hands over a second time, duplicating them.
  try {
    await writeParked([]);
  } catch (err) {
    if (!isParkFailure(err)) throw err;
    return { ...parkRefusal(err), restored: parked.length };
  }
  return { ok: true, restored: parked.length };
}

/**
 * Take the toggle off the machine entirely, for `agents-deck --uninstall`.
 *
 * uninstallHooks only knows the `__agent-dag` mark the event forwarders carry;
 * this entry is marked `__agent-dag-sound` and its command points at notify.mjs,
 * so it used to survive an uninstall and keep playing a sound on every turn. The
 * user's own hooks were the worse half: parked here when the toggle went on,
 * they stayed in a file under ~/.agents-deck that nothing left on the machine
 * knew how to open. Removing the entry without putting those back would be the
 * same loss with a tidier settings.json, so the two go together.
 */
export async function uninstallSoundHook() {
  let settings;
  try {
    settings = await readSettings();
  } catch (err) {
    if (!isUnreadable(err)) throw err;
    // Same bargain as everywhere else here: a file we cannot parse is left
    // untouched, and the parked hooks stay parked until it is repaired.
    return refusal(err);
  }
  const group = settings?.hooks?.[EVENT];
  let removed = 0;
  if (Array.isArray(group)) {
    const others = group.filter(g => !isOurs(g));
    removed = group.length - others.length;
    if (removed > 0) {
      if (others.length) settings.hooks[EVENT] = others;
      else delete settings.hooks[EVENT];   // don't leave an empty array behind
      await writeSettings(settings);
    }
  }
  const restore = await restoreParkedSoundHooks();
  if (restore.ok === false) return restore;
  return { ok: true, removed, restored: restore.restored ?? 0 };
}

/**
 * Our Stop entry, built fresh from this machine's node and this machine's paths.
 *
 * One function rather than an object literal in each writer, because the entry
 * has to be IDENTICAL wherever it comes from: reassertSoundHook decides whether
 * to rewrite by comparing what is in settings.json against what this returns, so
 * a second copy of the shape that drifted by a field would make every boot look
 * like a change and rewrite the user's settings.json forever.
 */
function soundHookEntry() {
  return {
    [MARK]: true,
    hooks: [{
      type: "command",
      // Absolute node path, matching how the event hooks are installed: the
      // shell a hook runs in does not necessarily have the user's PATH. And
      // properly escaped for that shell, for the reason installer.mjs's
      // hookCommand spells out — NOTIFY_PATH is built from $CLAUDE_CONFIG_DIR,
      // double quotes do not suppress `$(…)` or a backtick on POSIX, and this
      // string is executed at the end of every turn.
      command: soundHookCommand(NOTIFY_PATH),
      timeout: 5,
    }],
  };
}

/**
 * Bring the installed sound hook back up to the packaged one, in a settings
 * object the caller is about to write.
 *
 * The forwarder gets this for free: installHooks re-asserts hook.js on every
 * boot, so a machine that upgrades the deck upgrades the script Claude Code
 * actually executes. notify.js had exactly one installer — setSoundHook(true) —
 * so the copy on disk was whatever shipped in the release the user last TOGGLED
 * THE SOUND ON WITH, and every later release stopped at the package directory.
 * That is not a theoretical drift: #548 replaced a `printf "\a"` player that
 * spawned a BEL into `stdio: "ignore"` — silent by construction — and could not
 * reach a single machine that already had the toggle on, which is precisely the
 * set of machines it was written for.
 *
 * The presence of our entry in settings.json is the whole of the permission
 * check, and it is deliberately the only one. A user who turned the sound OFF
 * has no entry, so nothing here writes a script into their config dir on a boot
 * they asked nothing of; a user who has it ON has already consented to this file
 * existing, and keeping it current is the deck's job rather than theirs.
 *
 * The entry is rebuilt rather than inspected, which is the other half of the
 * report. settings.json is commonly synced between machines and the command
 * bakes in `process.execPath` and this machine's $CLAUDE_CONFIG_DIR — so a file
 * carried over from a laptop names that laptop's node binary inside that
 * laptop's home directory, soundHookStatus reports `enabled: true`, and the turn
 * ends in an ENOENT nobody sees. Rewriting it from soundHookEntry() re-derives
 * both against the machine the deck is running on.
 *
 * Mutates `settings` and returns what it did; the caller owns the write, so a
 * boot that would otherwise change nothing still changes nothing.
 */
export async function reassertSoundHook(settings) {
  const group = settings?.hooks?.[EVENT];
  if (!Array.isArray(group) || !group.some(isOurs)) return { present: false, script: false, entry: false };

  if (!existsSync(INSTALL_DIR)) await mkdir(INSTALL_DIR, { recursive: true });
  // Same reason the event forwarder is installed this way: the Stop hook fires
  // this file from sessions that are already running, so replacing it must not
  // leave one of them executing a half-copied program. installScript renames a
  // finished copy over the name, and skips the write entirely when the bytes
  // already match — which is every boot after the first.
  const script = await installScript(PACKAGED_NOTIFY, NOTIFY_PATH);

  const rebuilt = soundHookEntry();
  const wanted = JSON.stringify(rebuilt);
  const next = [];
  let entry = false;
  let kept = false;
  for (const g of group) {
    if (!isOurs(g)) { next.push(g); continue; }
    // More than one of ours is a settings.json that has been merged by hand or
    // by a sync tool. One sound per turn, so the extras are dropped rather than
    // rewritten alongside the first.
    if (kept) { entry = true; continue; }
    kept = true;
    if (JSON.stringify(g) !== wanted) entry = true;
    next.push(rebuilt);
  }
  settings.hooks[EVENT] = next;
  return { present: true, script, entry };
}

/**
 * Delete the `notify.js` an older deck installed, now that nothing names it.
 *
 * Called AFTER settings.json has been written, and that ordering is the point:
 * until the new entry is on disk the old command is still what a live Claude
 * Code session will run at the end of its next turn, and deleting the file it
 * names would turn a stale sound into a "Cannot find module" in the user's
 * session. Best-effort on the way out — a Windows lock or a read-only config dir
 * leaves one stale file behind, which is litter, not a failure worth reporting
 * over a hook that is now installed correctly.
 */
export async function sweepLegacySoundScript() {
  if (LEGACY_NOTIFY_PATH === NOTIFY_PATH) return false;
  try {
    if (!existsSync(LEGACY_NOTIFY_PATH)) return false;
    await rm(LEGACY_NOTIFY_PATH, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function setSoundHook(enabled) {
  // Read before anything else. A file we cannot parse stops the toggle here,
  // with nothing parked, nothing copied and settings.json untouched.
  let settings;
  try {
    settings = await readSettings();
  } catch (err) {
    if (!isUnreadable(err)) throw err;
    return refusal(err);
  }
  settings.hooks ??= {};
  const group = Array.isArray(settings.hooks[EVENT]) ? settings.hooks[EVENT] : [];

  // Set aside any of the user's own hooks that play a sound on this machine.
  // Without this the toggle is a lie in both directions: off still plays their
  // afplay/PowerShell hook, and on plays twice. They are moved, not deleted —
  // restoreParkedSoundHooks puts them back untouched.
  //
  // Which only holds if the move lands first. The filter below drops exactly
  // these entries from the object written to settings.json, so a park that
  // failed and said nothing left the user's own Stop hook in neither file, with
  // ok:true on the way out. Nothing here is written until the park is on disk.
  const parking = group.filter(isSoundHook);
  if (parking.length > 0) {
    try {
      await writeParked([...(await readParked()), ...parking]);
    } catch (err) {
      if (!isParkFailure(err)) throw err;
      return parkRefusal(err);
    }
  }
  const others = group.filter(g => !isOurs(g) && !isSoundHook(g));

  if (enabled) {
    if (!existsSync(INSTALL_DIR)) await mkdir(INSTALL_DIR, { recursive: true });
    // Same reason the event forwarder is installed this way: the Stop hook fires
    // notify.mjs from sessions that are already running, and toggling the sound
    // on must not leave one of them executing a half-copied file.
    await installScript(PACKAGED_NOTIFY, NOTIFY_PATH);
    others.push(soundHookEntry());
    settings.hooks[EVENT] = others;
  } else if (others.length) {
    settings.hooks[EVENT] = others;
  } else {
    delete settings.hooks[EVENT];   // don't leave an empty array behind
  }

  await writeSettings(settings);
  // Last, and after the write, for the reason sweepLegacySoundScript gives: the
  // file an older deck installed is only safe to delete once nothing in
  // settings.json still points at it.
  if (enabled) await sweepLegacySoundScript();
  return { ok: true, enabled };
}

// All four paths are exported so a test can prove it is pointed at a sandbox
// before it writes anything — the real ones are the user's own settings. The two
// script paths are also the only honest way for a test to ask where the sound
// hook ACTUALLY lands: rebuilding `<config dir>/agent-dag/notify.mjs` in the test
// would keep passing on the day this module started installing somewhere else.
export { SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH, LEGACY_NOTIFY_PATH };
