// Giving the deck's own folders back to the person running it, from the panel
// (#1711).
//
// #1335 taught the deck to say, precisely, that its settings folder belongs to
// another user — which is what a `sudo ccdeck` leaves on a Mac, where sudo keeps
// HOME. It could not do more: the folder is root's, and only root can give it
// back. So the way out was a `sudo chown -R` line in a log the person reporting
// it did not know how to find, and until they ran it every settings write was
// refused, the share tick included.
//
// On macOS the deck can ask for that root itself, through the operating
// system's own password dialog. That makes this the one place ccdeck acts with
// administrator rights, and everything below is about keeping it that narrow:
//
//   THE PATHS ARE THE DECK'S OWN. Computed here, from the same functions that
//   decide where the deck keeps its things. Nothing the request carries reaches
//   the command; the route takes no body at all.
//
//   EVERY TARGET IS CHECKED BEFORE THE DIALOG. A real directory, not a symlink,
//   named like one of the deck's, strictly inside the user's home both as
//   written and after realpath, and owned by somebody else. A folder that is
//   already the user's is left out, so the dialog never appears for nothing.
//
//   THE PATHS ARE DATA, NOT SOURCE. They reach AppleScript as argv, after `--`
//   (see notify in browser-react.mjs for what a leading dash did without it),
//   and reach the shell through `quoted form of`. The script text is a
//   constant, and osascript is named by its full path.
//
//   THE FOLDER ROOT CHANGES IS THE FOLDER THAT WAS CHECKED. The checks run
//   before the dialog and root acts after it, minutes later if the person is
//   slow, and the parent folder is the user's: anything running as the user
//   could put a folder of its own in place of the checked one, holding a hard
//   link to a file root owns, and `chown -R` would hand that file over. So the
//   root step does not trust the path. It enters the folder, compares the
//   device and inode of where it landed with the ones surveyed here, refuses
//   a tree holding any file with a second hard link, and only then changes
//   `.`, which a rename of the path can no longer move.
//
//   `chown -n -x -R -P`: numeric ids with no name lookup, no mount point
//   crossed, and no symlink inside the tree followed.
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
// POSIX, not the host's: every path here is a Mac's, and the suite checks
// them on Windows too, where the host's `normalize` would turn every slash
// into a backslash and find nothing inside any home (see deckDataDir).
import { posix } from "node:path";
import { PRODUCT } from "./brand.mjs";
import { deckDataDir, deckLogDir, legacyDeckDir } from "./deck-home.mjs";
import { run } from "./exec.mjs";
import { prefsDir } from "./prefs-path.mjs";

/** The folder names the deck files itself under. A CCDECK_HOME named anything
 *  else is somebody's own choice of place, and the log's command is still there
 *  for it; the deck does not take root to change the owner of it. */
const DECK_FOLDER_NAMES = new Set(["ccdeck", "agent-dag"]);

/** How long the password dialog may stay open. It waits on a person, so the
 *  exec default of twenty seconds would close it under them. */
export const GIVE_BACK_TIMEOUT_MS = 180_000;

/** What the dialog says it is for, above macOS's own "wants to make changes". */
export const GIVE_BACK_PROMPT =
  `${PRODUCT} needs your password to make its settings folder yours again. It was left owned by another user, most likely by a run with sudo.`;

/** osascript, by its full path: this is the one call that asks for the
 *  administrator's password, and a PATH lookup is a way to put a different
 *  dialog in front of it. */
export const OSASCRIPT = "/usr/bin/osascript";

/** The whole of what runs as root. Item 1 is `uid:gid`, item 2 the prompt, and
 *  after them a folder and its `device:inode` for each folder; every one is
 *  quoted by AppleScript, never by hand. A folder that is not the one surveyed,
 *  or that holds a file with a second hard link, stops the whole command with
 *  status 3 before anything in it changes owner. */
export const GIVE_BACK_SCRIPT = [
  "on run argv",
  "set owner to quoted form of (item 1 of argv)",
  'set cmd to "true"',
  "repeat with i from 3 to (count of argv) by 2",
  "set target to quoted form of (item i of argv)",
  "set wanted to quoted form of (item (i + 1) of argv)",
  'set cmd to cmd & " && { cd -P -- " & target & " && [ \\"$(/usr/bin/stat -f %d:%i .)\\" = " & wanted & " ] && [ -z \\"$(/usr/bin/find -x -P . ! -type d -links +1 -print)\\" ] || exit 3; } && /usr/sbin/chown -n -x -R -P -- " & owner & " ."',
  "end repeat",
  "do shell script cmd with prompt (item 2 of argv) with administrator privileges",
  "end run",
].join("\n");

/** osascript's "User canceled." — the person closed the dialog. */
const CANCELLED = /\(-128\)/;
/** The root step's own refusal: the folder was not the one surveyed, or held a
 *  hard link. osascript reports the shell's status in brackets. */
const GUARD_TRIPPED = /\(3\)\s*$/m;

/**
 * Which of the deck's folders belong to somebody else, and whether each one is
 * safe to hand back.
 *
 * The settings folder is the one the refusal was about, so it comes first and
 * its verdict decides the answer. The log folder and the legacy folder are
 * where the same sudo run wrote too — the event log, the hook, the port
 * registry — and are given back in the same dialog when they need it, or
 * skipped when they do not exist or already belong to the user.
 */
export function deckFolders(platform = process.platform, env = process.env, home = homedir()) {
  return [prefsDir(deckDataDir(platform, env, home)), deckLogDir(platform, env, home), legacyDeckDir(env, home, platform)]
    .filter((path, i, all) => all.indexOf(path) === i);
}

async function survey(path, { uid, home, fs }) {
  let st;
  try {
    // BigInt, because the inode is handed to the root step to compare with
    // stat(1)'s, and a number past 2^53 would compare unequal to itself.
    st = await fs.lstat(path, { bigint: true });
  } catch (err) {
    return { path, state: err?.code === "ENOENT" ? "missing" : "unsafe" };
  }
  if (Number(st.uid) === uid) return { path, state: "yours" };
  if (!st.isDirectory() || st.isSymbolicLink()) return { path, state: "unsafe" };
  if (!DECK_FOLDER_NAMES.has(basename(path))) return { path, state: "unsafe" };
  if (!strictlyInside(path, home)) return { path, state: "unsafe" };
  const real = await fs.realpath(path).catch(() => "");
  const realHome = await fs.realpath(home).catch(() => "");
  if (!real || !realHome || !strictlyInside(real, realHome)) return { path, state: "unsafe" };
  return { path, state: "foreign", id: `${st.dev}:${st.ino}` };
}

const { basename, isAbsolute, normalize, sep } = posix;

function strictlyInside(path, home) {
  if (!isAbsolute(path) || !isAbsolute(home) || normalize(path) !== path) return false;
  const root = home.endsWith(sep) ? home : home + sep;
  return path.startsWith(root) && path.length > root.length;
}

let _inFlight = false;

/**
 * Ask macOS for the password, and give the deck's folders back to this user.
 *
 * Answers `{ ok: true, changed }` — `changed: false` when nothing needed it,
 * which is also what a folder somebody already fixed by hand looks like — or
 * `{ ok: false, reason }` from a closed set, because the route hands it to a
 * page and a path names the user:
 *
 *   unsupported    not macOS, or no uid to compare, or running as root already
 *   busy           a dialog from an earlier press is still open
 *   not_eligible   the settings folder failed one of the checks above
 *   cancelled      the person closed the dialog
 *   timed_out      nobody answered it
 *   refused        macOS or chown said no; the log has what it said
 *   still_foreign  chown answered and the folder is still not theirs
 */
export async function giveBackDeckFolders(deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return { ok: false, reason: "unsupported" };
  const uid = deps.getuid ? deps.getuid() : process.getuid?.();
  const gid = deps.getgid ? deps.getgid() : process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) return { ok: false, reason: "unsupported" };
  if (_inFlight) return { ok: false, reason: "busy" };
  _inFlight = true;
  try {
    return await giveBack({ ...deps, platform, uid, gid });
  } finally {
    _inFlight = false;
  }
}

async function giveBack({ platform, uid, gid, env = process.env, home = homedir(), fs = { lstat, realpath }, exec = run, warn = console.error }) {
  const folders = await Promise.all(deckFolders(platform, env, home).map(path => survey(path, { uid, home, fs })));
  const [settings] = folders;
  if (settings.state === "unsafe") {
    warn(`${PRODUCT}: ${settings.path} is not a folder this deck will change the owner of from the panel — it has to be a real folder named like the deck's, inside your home. Give it back by hand: sudo chown -R "$(id -un)" "${settings.path}"`);
    return { ok: false, reason: "not_eligible" };
  }
  const foreign = folders.filter(f => f.state === "foreign");
  if (!foreign.length) return { ok: true, changed: false };

  const r = await exec(OSASCRIPT, [
    "-e", GIVE_BACK_SCRIPT, "--", `${uid}:${gid}`, GIVE_BACK_PROMPT, ...foreign.flatMap(f => [f.path, f.id]),
  ], { timeout: GIVE_BACK_TIMEOUT_MS });
  const said = (r?.stderr || r?.code || "osascript failed").toString().trim();
  if (!r?.ok && !r?.timedOut && CANCELLED.test(r?.stderr ?? "")) return { ok: false, reason: "cancelled" };

  // WHO OWNS THEM NOW, WHATEVER osascript ANSWERED. One command gives every
  // folder back, so a failure on the log folder fails the exit after the
  // settings folder was already changed, and a password typed just before the
  // deadline can land after it. Answering that as a refusal would leave the
  // deck on defaults with its writes now succeeding.
  const owners = await Promise.all(foreign.map(f => fs.lstat(f.path).then(st => Number(st.uid), () => undefined)));
  const left = foreign.filter((_, i) => owners[i] !== uid).map(f => f.path);
  const settingsGiven = settings.state === "foreign" && !left.includes(settings.path);
  if (!left.length || settingsGiven) {
    if (left.length) warn(`${PRODUCT}: the settings folder is yours again, but ${left.join(", ")} still belongs to another user: ${said}`);
    return { ok: true, changed: true };
  }
  if (r?.timedOut) return { ok: false, reason: "timed_out" };
  if (!r?.ok) {
    warn(GUARD_TRIPPED.test(r?.stderr ?? "")
      ? `${PRODUCT}: did not give ${left.join(", ")} back: the folder changed between the check and the password, or holds a file with a second hard link. Nothing in it changed owner.`
      : `${PRODUCT}: could not give ${left.join(", ")} back: ${said}`);
    return { ok: false, reason: "refused" };
  }
  warn(`${PRODUCT}: chown answered, but ${left.join(", ")} still belongs to another user.`);
  return { ok: false, reason: "still_foreign" };
}
