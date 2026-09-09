// The deck's own small settings, and the first of them: whether it may reach
// the desktop.
//
// WHY THIS FILE EXISTS. Everything the deck could be told before this was told
// through an environment variable read once at boot — AGENTS_DECK_NO_NOTIFY,
// AGENTS_DECK_NO_INSTALL, AGENTS_DECK_NO_DOWNLOAD. That is the right shape for
// "never do this on this machine", set by whoever launches the deck, and the
// wrong shape for a switch a person wants to flip because the notifications are
// annoying them right now: it means quitting the deck and re-running it with a
// variable in front, which is a lot to ask of somebody whose complaint is that
// the deck is being noisy.
//
// So there is one preference file, and the notification switch lives in it. The
// env var is NOT retired and is not a default either — it is an override that
// wins, because a machine told at launch to stay off the desktop must stay off
// it whatever a page later posts. See `notificationsOn`.
//
// WHY NOT IN THE BROWSER. The desktop notifier runs in the SERVER, on the case
// where no page exists at all — so a preference kept in localStorage could not
// reach the code it governs at the moment that code runs. It also has to be one
// answer per machine rather than one per browser profile: two browsers open on
// the same deck are one deck, and a switch that meant something different in
// each would be a switch nobody could reason about.
//
// The write is the atomic one browser-watch-store.mjs argues for at length —
// temp file, rename — because the alternative is a truncated JSON document as
// the only record of what the user chose, and a corrupt file here silently
// turns the notifications back on.
import { mkdir, readFile, writeFile } from "node:fs/promises";
// The rename, with the Windows retry ladder installer.mjs wrote for exactly
// this call. See the note over the write below (#786).
import { renameWithRetry } from "./installer.mjs";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";

/** Set to "1" to keep the deck off the desktop whatever the stored preference
 *  says. Same sheet of switches as AGENTS_DECK_NO_DOWNLOAD and
 *  AGENTS_DECK_NO_INSTALL, and unchanged in meaning by this file. */
export const OFF_ENV = "AGENTS_DECK_NO_NOTIFY";

const prefsDir = (home = claudeConfigDir()) => join(home, "agent-dag");
export const prefsPath = (home = claudeConfigDir()) => join(prefsDir(home), "prefs.json");

/**
 * Every preference the deck keeps, with the answer it gives when there is no
 * file — which is the answer for every existing install, so it has to be the
 * behaviour those installs already have.
 *
 * `notifications` defaults ON because that is what 3.7.0 shipped and what the
 * release notes describe; a switch that quietly turned an existing feature off
 * on upgrade would be a worse surprise than the noise it is meant to stop.
 */
export const DEFAULTS = Object.freeze({
  notifications: true,
  // LAN sync, off until somebody turns it on. `passphrase` is the only secret
  // this file has ever held, which is why the write below now names a mode.
  lan: Object.freeze({ enabled: false, name: "", passphrase: "", shared: [], manual: [] }),
});

/** The mode prefs.json is created with.
 *
 *  It held nothing but booleans until LAN sync, and a booleans file at the
 *  umask default is unremarkable. A group passphrase is not: on a shared
 *  machine the default mode hands it to every other account on the box, and
 *  from it they can decrypt any credential that crosses the network.
 *
 *  Passed to `writeFile` rather than applied with a follow-up chmod, and the
 *  difference is the whole point — claude-swap's transfer.py makes the same
 *  argument at length: a write-then-chmod leaves the file readable for the
 *  window between the two, which is exactly when a secret is in it. */
export const PREFS_MODE = 0o600;

/** One LAN section, coerced. Unknown keys dropped like everything else here,
 *  and the two lists forced to arrays of strings — they arrive from a page and
 *  are then compared against account keys and dialled as addresses. */
function normaliseLan(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : false,
    name: typeof src.name === "string" ? src.name : "",
    passphrase: typeof src.passphrase === "string" ? src.passphrase : "",
    shared: strings(src.shared),
    manual: strings(src.manual),
  };
}

/** Coerce whatever is on disk into a whole, known-shaped prefs object.
 *
 *  Unknown keys are DROPPED rather than carried: this file is written by the
 *  deck and read by the deck, and a key from a newer build that this one does
 *  not understand cannot be honoured — keeping it would only mean writing back
 *  a setting nothing here can see, which reads as support and is not. */
export function normalise(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    notifications: typeof src.notifications === "boolean" ? src.notifications : DEFAULTS.notifications,
    lan: normaliseLan(src.lan),
  };
}

/** What is on disk, or the defaults. A corrupt or absent file is not an error
 *  the user can act on mid-session, so it reads as "nothing chosen yet". */
export async function readPrefs(home = claudeConfigDir(), deps = {}) {
  const read = deps.readFile ?? readFile;
  try { return normalise(JSON.parse(await read(prefsPath(home), "utf8"))); }
  catch { return { ...DEFAULTS }; }
}

let _chain = Promise.resolve();

/**
 * Change some of the preferences, keeping the rest.
 *
 * A PATCH rather than a whole-state write, which is the opposite of the choice
 * browser-watch-store.mjs makes — and deliberately. That store holds a growing
 * archive where a merge would have to decide what wins between two decks; this
 * holds a handful of independent booleans, where "the field I did not mention
 * keeps its value" is the only sane reading and an omitted field erasing a
 * setting would be a bug with no upside.
 *
 * Serialized for the same reason the other store is: two pages toggling two
 * different switches in the same second must not lose one of them.
 */
export async function writePrefs(patch, home = claudeConfigDir(), deps = {}) {
  const job = async () => {
    const mk = deps.mkdir ?? mkdir;
    const write = deps.writeFile ?? writeFile;
    // `renameWithRetry`, not `rename` (#786). MoveFileExW refuses while any
    // handle without FILE_SHARE_DELETE is open on either side, and Defender and
    // the search indexer open a file the instant it is written — so on Windows
    // a bare rename fails on a perfectly healthy machine, `POST /api/prefs`
    // 500s through `guard`, and the notifications switch silently does not
    // stick. POSIX rename(2) has no such rule, which is why this shipped green.
    const mv = deps.rename ?? renameWithRetry;
    const prev = await readPrefs(home, deps);
    // The LAN section merges rather than replaces, so a page toggling the
    // switch does not have to send the passphrase back to keep it — and so
    // nothing has to send a secret it was never given.
    const merged = { ...prev, ...patch, lan: { ...prev.lan, ...(patch?.lan ?? {}) } };
    const next = normalise(merged);
    await mk(prefsDir(home), { recursive: true });
    const tmp = `${prefsPath(home)}.${process.pid}.tmp`;
    await write(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: PREFS_MODE });
    await mv(tmp, prefsPath(home));
    return next;
  };
  const started = _chain.then(job, job);
  _chain = started.then(() => {}, () => {});
  return started;
}

/**
 * May the deck raise a desktop notification right now?
 *
 * The env var wins. A machine launched with AGENTS_DECK_NO_NOTIFY=1 has been
 * told by whoever started it to stay off the desktop, and a page posting to
 * /api/prefs must not be able to overrule that — the person at the keyboard and
 * the person who wrote the launch script are not always the same person, and
 * only one of them is making a claim about the machine.
 */
/**
 * The preferences as a PAGE may see them.
 *
 * The passphrase never leaves this process. `GET /api/prefs` is readable by
 * anything that can reach the loopback port — which is the whole point of the
 * deck's own threat model, and is why the share envelope is not served there
 * either — so what goes out is whether one is set, not what it is.
 *
 * A boolean rather than a mask: `••••••••` in a field invites a page to send it
 * back, and then the dots are the passphrase.
 */
export function publicPrefs(prefs) {
  const p = normalise(prefs);
  const { passphrase, ...lan } = p.lan;
  return { ...p, lan: { ...lan, hasPassphrase: passphrase !== "" } };
}

export function notificationsOn(prefs, env = process.env) {
  if (env[OFF_ENV] === "1") return false;
  return normalise(prefs).notifications;
}

/**
 * Did the MACHINE veto this, as opposed to the person?
 *
 * Reported separately because the two are different sentences and the UI has to
 * say the right one. Deriving it from `notificationsOn` being false was the
 * first spelling, and the browser caught it immediately: switching the setting
 * off made the menu read "off — set at launch" on a deck launched with no
 * variable at all, telling the user their own press had been overruled by
 * something that had not happened.
 */
export function notificationsVetoed(env = process.env) {
  return env[OFF_ENV] === "1";
}
