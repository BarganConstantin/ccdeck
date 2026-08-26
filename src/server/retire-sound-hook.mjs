// Takes the deck's old finish-sound hook back off a machine that already has it.
//
// Until #704 the deck played its "turn finished" sound by writing a `Stop` entry
// into the user's settings.json whose command ran `notify.mjs` out of the deck's
// own install directory. The deck plays that sound itself now, from the `Stop`
// and `Notification` envelopes it already receives, and the script is gone from
// the package — so an entry naming it is a hook pointing at a file that does not
// exist, and Claude Code runs it at the end of every turn. On a machine that was
// working yesterday. That is what this module exists to prevent, and it is the
// whole of what is left here: there is no installer, no toggle, no status
// reporter and no re-assert. Only the removal, and the promise the removal owes.
//
// THE PROMISE. Turning the sound on used to PARK any sound hook the user had
// written themselves — an `afplay` line, a PowerShell one — in
// ~/.agents-deck/parked-sound-hooks.json, so that "off" produced actual silence
// and "on" did not play twice. Those hooks are the user's, the deck is the only
// thing that knows where they went, and this is the last code that will ever be
// in a position to hand them back. So retirement is not "delete our entry": it
// is "delete our entry and put theirs back where they wrote it".
//
// WHAT COUNTS AS OURS. Two rules, and they cover different machines.
//
//   The `__agent-dag-sound` mark is what this deck wrote, and it survives a
//   settings.json synced from another computer — where every path in the command
//   belongs to that computer and matches nothing here.
//
//   An entry whose command names one of our installed scripts is ours too, mark
//   or no mark. <claude config dir>/agent-dag/ is a directory this deck creates
//   and fills; nobody hand-writes a Stop hook that runs `node
//   ~/.claude/agent-dag/notify.mjs`. The author's own machine is the case: two
//   Stop entries naming the installed notify.js with the mark missing from both,
//   which the mark rule alone would have left behind — playing a sound with no
//   switch anywhere that could stop it, or crashing once the script was swept.
//
// Everything else in the file is the user's and is not touched. `afplay …` stays
// exactly where they put it, and this module has no idea what it does.
//
// EXACTLY ONCE, without a stamp. Retirement is triggered by the state it
// removes: our entry in settings.json, a parked file, or one of our scripts on
// disk. When it has run there is none of that left, so the next boot asks three
// `existsSync` questions, gets three noes, and writes nothing — the same answer
// every boot after it, forever. A "retirement done" marker file would have been
// the other spelling and is the wrong one: a marker can say done about a machine
// whose settings.json was later restored from a backup carrying the old entry,
// and then the broken hook lives there permanently. State that describes itself
// cannot drift from itself.
//
// A DECK THAT CANNOT WRITE. Nothing here is done speculatively and nothing is
// recorded as done that was not. A settings.json that will not parse stops
// retirement with the file byte for byte as it was found (see
// readSettingsForWrite: this rewrites the whole file, so treating a damaged one
// as `{}` would replace every permission, env var and hook in it with nothing).
// An unwritable one throws out of the write and the boot reports it. A parked
// file that will not read leaves the park alone and still removes our entry,
// because those are two independent repairs and only one of them is urgent.
// In every one of those cases the trigger state is still on disk, so the next
// boot tries again. There is nothing to reset.
//
// TWO DECKS BOOTING AT ONCE. Both read the same settings, both compute the same
// result, and both write it through writeFileAtomic — a rename, so the file is
// one whole payload whichever lands second. The park is the part that could
// have gone wrong: deck B reading the park before A deleted it and settings
// after A wrote it would put the user's hooks back a second time, on top of the
// copy A had just restored. So a parked entry is spliced back only when an
// identical one is not already in the group. Restoring is idempotent, and the
// race stops being one.
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { claudeConfigDir } from "./claude-dir.mjs";
import { readSettingsForWrite, writeFileAtomic } from "./installer.mjs";

const CLAUDE_DIR    = claudeConfigDir();
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const INSTALL_DIR   = join(CLAUDE_DIR, "agent-dag");

// Both names the sound script ever had. `.js` is the pre-#577 spelling, which
// was CommonJS-by-default in a directory with no package.json above it and so a
// `SyntaxError: Cannot use import statement` at the end of every turn on the
// older half of this package's `engines` range; `.mjs` is what replaced it.
// Retirement has to know both, because a machine that never upgraded past #577
// is exactly the kind of machine this runs on.
const NOTIFY_PATH        = join(INSTALL_DIR, "notify.mjs");
const LEGACY_NOTIFY_PATH = join(INSTALL_DIR, "notify.js");
const OUR_SCRIPTS = [NOTIFY_PATH, LEGACY_NOTIFY_PATH];

const MARK  = "__agent-dag-sound";
const EVENT = "Stop";
// Where the user's own sound hooks were put while the toggle was on. Nothing
// writes this any more; retirement reads it once and deletes it.
const PARKED_PATH = join(homedir(), ".agents-deck", "parked-sound-hooks.json");

const commandsOf = (entry) =>
  (entry?.hooks ?? []).map(h => (typeof h?.command === "string" ? h.command : ""));

/** An entry this deck put there: by its mark, or by the script it runs. */
function isOurs(entry) {
  if (entry?.[MARK] === true) return true;
  return commandsOf(entry).some(cmd => OUR_SCRIPTS.some(p => cmd.includes(p)));
}

/** Anywhere in the file — not just `Stop` — that still runs one of our scripts.
 *  The sweep below asks this before deleting them: a stale sound is survivable
 *  and a hook pointing at nothing is not. */
function anythingStillNamesOurScripts(settings) {
  const groups = settings?.hooks;
  if (!groups || typeof groups !== "object") return false;
  for (const group of Object.values(groups)) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (commandsOf(entry).some(cmd => OUR_SCRIPTS.some(p => cmd.includes(p)))) return true;
    }
  }
  return false;
}

function parkedError(why) {
  const err = new Error(
    `${PARKED_PATH} could not be read as JSON (${why}). It holds sound hooks you wrote yourself, so it ` +
    `is not being treated as empty and it has not been deleted — repair it or move it aside, and the ` +
    `deck will hand them back on its next start.`,
  );
  err.code = "PARKED_UNREADABLE";
  err.parkedPath = PARKED_PATH;
  return err;
}

/**
 * The hooks the toggle set aside, or a refusal.
 *
 * Only ENOENT is genuinely empty. A truncated file — a kill mid-write, a full
 * disk — used to read as "nothing was ever parked", and this is the only copy of
 * hooks a user wrote by hand: answering "restored: 0" about a file with their
 * work in it, and then deleting it, is the one unrecoverable thing in this
 * module. A JSON object rather than an array is a file that is not ours.
 */
async function readParked() {
  let raw;
  try {
    raw = await readFile(PARKED_PATH, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw parkedError(err?.message ?? String(err));
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw parkedError(err?.message ?? String(err));
  }
  if (!Array.isArray(parsed)) throw parkedError("top level is not a JSON array");
  return parsed;
}

/** Is there anything of the retired mechanism left on this machine? Three
 *  `existsSync` calls and a scan of a settings object the caller already read —
 *  which is the whole cost of retirement on every boot after the first. */
function anythingToRetire(settings) {
  const group = settings?.hooks?.[EVENT];
  if (Array.isArray(group) && group.some(isOurs)) return true;
  if (existsSync(PARKED_PATH)) return true;
  return OUR_SCRIPTS.some(existsSync);
}

/** Nothing here, and nothing for the caller to do afterwards. */
const NOTHING = Object.freeze({ pending: false, changed: false, removed: 0, restored: 0, parkError: null });

/**
 * Retire the sound hook inside a settings object the caller is about to write.
 *
 * Mutates `settings` and returns what it did; the caller owns the write, so a
 * boot that would otherwise change nothing still changes nothing. Call
 * `completeSoundHookRetirement` with the result AFTER settings.json is on disk —
 * that ordering is the point of the split. Until the new file has landed, the
 * old command is still what a live Claude Code session will run at the end of
 * its next turn, and deleting the script it names turns a stale sound into a
 * "Cannot find module" in the user's session.
 *
 * Never throws over the parked file. A corrupt ~/.agents-deck must not stop the
 * deck from booting, and it must not stop the urgent half either: our entry
 * points at a script that is about to be deleted, and taking it out is worth
 * doing whether or not the user's own hooks can be handed back in the same pass.
 */
export async function retireSoundHookIn(settings) {
  if (!anythingToRetire(settings)) return NOTHING;

  let parked = [];
  let parkError = null;
  try {
    parked = await readParked();
  } catch (err) {
    if (err?.code !== "PARKED_UNREADABLE") throw err;
    parkError = { reason: "parked_unreadable", parkedPath: PARKED_PATH, message: err.message };
  }

  const group = Array.isArray(settings?.hooks?.[EVENT]) ? settings.hooks[EVENT] : [];
  const theirs = group.filter(g => !isOurs(g));
  const removed = group.length - theirs.length;

  // Identical entries are not restored twice — see the note on two decks at the
  // top. `theirs` is what will be in the file, so a hook already back from an
  // earlier attempt (or from the other deck, a millisecond ago) is recognised.
  //
  // And an entry that is OURS is never restored, wherever it was found. The park
  // is not supposed to contain one — the old toggle set aside hooks that looked
  // hand-written and skipped its own — but "supposed to" is doing all the work
  // in that sentence: the file is years old on some machines, it is synced
  // between them, and the unmarked entries naming our installed script are
  // exactly the shape a hand-written-hook filter would have swept up. Restoring
  // one would put back the hook this whole module exists to remove, pointing at
  // a script this release deletes, on the boot that was supposed to repair it.
  const seen = new Set(theirs.map(g => JSON.stringify(g)));
  const putBack = [];
  for (const entry of parked) {
    if (isOurs(entry)) continue;
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    putBack.push(entry);
  }

  const next = [...putBack, ...theirs];
  let changed = false;
  if (removed > 0 || putBack.length > 0) {
    changed = true;
    settings.hooks ??= {};
    if (next.length) settings.hooks[EVENT] = next;
    else delete settings.hooks[EVENT];        // don't leave an empty array behind
  }

  return {
    pending: true,
    changed,
    removed,
    restored: putBack.length,
    // Only when the whole park was accounted for. A read that refused leaves the
    // file for repair, and the next boot tries again.
    clearPark: parkError === null && existsSync(PARKED_PATH),
    parkError,
  };
}

/**
 * The half of retirement that must happen after settings.json is on disk.
 *
 * Deleting the parked file is safe here and only here: its contents are in the
 * file Claude Code reads. If the delete fails — a read-only ~/.agents-deck, a
 * Windows lock — the next boot reads the same park and restores nothing, because
 * the hooks it names are already in the group. That is the whole reason the
 * restore de-duplicates.
 *
 * The scripts go last, and only when nothing in settings.json still names them.
 * Retirement removes every entry that does, so the guard is normally already
 * satisfied; it exists for the file that puts one under some other event, where
 * leaving a stale sound is right and leaving a missing module is not.
 */
export async function completeSoundHookRetirement(plan, settings) {
  if (!plan?.pending) return { parkCleared: false, scripts: [] };
  let parkCleared = false;
  if (plan.clearPark) {
    parkCleared = await rm(PARKED_PATH, { force: true }).then(() => true, () => false);
  }
  const scripts = [];
  if (!anythingStillNamesOurScripts(settings)) {
    for (const path of OUR_SCRIPTS) {
      if (!existsSync(path)) continue;
      if (await rm(path, { force: true }).then(() => true, () => false)) scripts.push(path);
    }
  }
  return { parkCleared, scripts };
}

/**
 * Retirement for a caller that holds no settings object: `agents-deck
 * --uninstall`, which is taking the deck off the machine rather than upgrading
 * it, and where there is no hook install to ride along with.
 *
 * Same three steps in the same order — read, mutate, write, then clean up — so
 * there is one description of what retirement is rather than two that can drift.
 */
export async function retireSoundHook() {
  let settings;
  try {
    ({ settings } = await readSettingsForWrite(SETTINGS_PATH));
  } catch (err) {
    if (err?.code !== "SETTINGS_UNREADABLE") throw err;
    // A file we cannot parse is a file whose contents we cannot reproduce, and
    // this rewrites the whole of it. Left exactly as found, parked hooks still
    // parked, and the user told which file and why.
    return {
      ok: false,
      reason: "settings_unreadable",
      settingsPath: SETTINGS_PATH,
      why: err.why ?? err.message,
      message: err?.message ?? String(err),
      removed: 0,
      restored: 0,
    };
  }

  const plan = await retireSoundHookIn(settings);
  if (plan.changed) await writeFileAtomic(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  await completeSoundHookRetirement(plan, settings);

  if (plan.parkError) return { ok: false, ...plan.parkError, removed: plan.removed, restored: plan.restored };
  return { ok: true, removed: plan.removed, restored: plan.restored };
}

// Exported so a test can prove it is pointed at a sandbox before it writes
// anything — the real ones are the user's own settings and the user's own hooks.
// The script paths are also the only honest way to ask where the retired script
// ACTUALLY lived: rebuilding `<config dir>/agent-dag/notify.mjs` inside a test
// would keep passing on the day this module started looking somewhere else.
export { SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH, LEGACY_NOTIFY_PATH };
