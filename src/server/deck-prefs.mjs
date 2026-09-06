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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
export const DEFAULTS = Object.freeze({ notifications: true });

/** Coerce whatever is on disk into a whole, known-shaped prefs object.
 *
 *  Unknown keys are DROPPED rather than carried: this file is written by the
 *  deck and read by the deck, and a key from a newer build that this one does
 *  not understand cannot be honoured — keeping it would only mean writing back
 *  a setting nothing here can see, which reads as support and is not. */
export function normalise(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return { notifications: typeof src.notifications === "boolean" ? src.notifications : DEFAULTS.notifications };
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
    const mv = deps.rename ?? rename;
    const next = normalise({ ...(await readPrefs(home, deps)), ...patch });
    await mk(prefsDir(home), { recursive: true });
    const tmp = `${prefsPath(home)}.${process.pid}.tmp`;
    await write(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
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
