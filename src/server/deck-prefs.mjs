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
import { deckDataDir } from "./deck-home.mjs";

/** Set to "1" to keep the deck off the desktop whatever the stored preference
 *  says. Same sheet of switches as AGENTS_DECK_NO_DOWNLOAD and
 *  AGENTS_DECK_NO_INSTALL, and unchanged in meaning by this file. */
export const OFF_ENV = "AGENTS_DECK_NO_NOTIFY";

/* WHERE THIS FILE LIVES, AND WHY IT MOVED. It sat in ~/.claude/agent-dag — the
   directory Claude Code owns — which meant a person clearing Claude Code's
   configuration cleared this deck's private key, and every machine that had
   pinned it had to be told to trust this one again. deck-home.mjs owns the new
   answer and the reasons; what matters here is that the parameter is still a
   DIRECTORY, so every caller that passes one is unchanged. */
const prefsDir = (home = deckDataDir()) => home;
export const prefsPath = (home = deckDataDir()) => join(prefsDir(home), "prefs.json");

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
  // Whether the deck may update itself: restart into code already on disk once
  // it is idle, and — while nobody is looking — install a newer release and
  // restart into that (auto-update.mjs). ON, because this is the banner's
  // `auto when idle`, which defaulted on as a localStorage key; it moved here so
  // the server can read it with no page open.
  autoUpdate: true,
  // LAN sync, off until somebody turns it on. `passphrase` is the only secret
  // this file has ever held, which is why the write below now names a mode.
  lan: Object.freeze({
    enabled: false, name: "", secret: "", shared: [], manual: [], trusted: [], port: 0,
    // WHO PAIRS WITH WHOM, WITHOUT ANYBODY PRESSING ANYTHING. Both on, so two
    // decks on one network find each other and pair themselves — which is what
    // a person with three of their own machines wants and had to do by hand
    // six times.
    //
    // Read this next to the two switches that gate it. `enabled` above is off,
    // so nothing here happens until somebody deliberately puts this deck on the
    // network; `shared` is empty, so a deck that pairs is offered nothing until
    // somebody ticks a login. These say what happens AFTER both of those, and
    // the dialog that turns the feature on prints them.
    autoAsk: true,
    autoAccept: true,
    // What somebody HERE calls another deck, keyed by its fingerprint. The name
    // a deck gives itself is its owner's to choose; this is the other half.
    aliases: Object.freeze({}),
  }),
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

/** The longest name somebody here may give another deck. The same order as a
 *  deck's own name, and short enough to stay one line in the panel's column. */
export const ALIAS_MAX = 48;

/** A name somebody typed for another deck, cleaned — or "" for one with
 *  nothing left in it, which is how an alias is taken away. Control characters
 *  go the way cleanName sends them: this string reaches a terminal as well as a
 *  page. */
export function cleanAlias(raw) {
  if (typeof raw !== "string") return "";
  const flat = raw.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  return [...flat].slice(0, ALIAS_MAX).join("").trim();
}

/** A fingerprint an alias may be kept under. Real ones are `abc-def-012-345`;
 *  what matters here is only that a typed address's placeholder — which has a
 *  colon in it and names no deck — can never be one, and that nothing exotic
 *  becomes a key in an object this file writes back to disk. */
export function isAliasKey(fp) {
  return typeof fp === "string" && /^[A-Za-z0-9-]{1,64}$/.test(fp);
}

/** The alias map, coerced. A page writes it; a hand-edited file can hold
 *  anything. Capped, because nothing legitimate is anywhere near it. */
function aliasesFrom(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [fp, name] of Object.entries(raw).slice(0, 256)) {
    const clean = cleanAlias(name);
    if (isAliasKey(fp) && clean) out[fp] = clean;
  }
  return out;
}

/** One LAN section, coerced. Unknown keys dropped like everything else here,
 *  and the two lists forced to arrays of strings — they arrive from a page and
 *  are then compared against account keys and dialled as addresses. */
function normaliseLan(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : false,
    name: typeof src.name === "string" ? src.name : "",
    // THIS DECK'S PRIVATE KEY, and the only secret this file has ever held —
    // which is why the write below names a mode rather than taking the umask's.
    // It is an X25519 private key in base64 pkcs8; anything else is replaced on
    // the next start rather than refused, because a corrupt key is not a thing
    // anybody can act on and refusing to start would take the feature away.
    secret: typeof src.secret === "string" ? src.secret : "",
    shared: strings(src.shared),
    manual: strings(src.manual),
    // THE DECKS SOMEBODY PRESSED ACCEPT ON. The public key is the load-bearing
    // half: a fingerprint is a hash of it, so an entry without one cannot be
    // checked against whatever answers at an address later, and an entry that
    // cannot be checked is worse than no entry at all.
    trusted: (Array.isArray(src.trusted) ? src.trusted : [])
      .filter(t => t && typeof t.fp === "string" && typeof t.pub === "string")
      .map(t => ({
        fp: t.fp, pub: t.pub, name: typeof t.name === "string" ? t.name : "",
        // When somebody here said yes. Absent on every pin made before this was
        // kept, and absent is drawn as "before" rather than guessed.
        ...(Number.isFinite(t.at) && t.at > 0 ? { at: t.at } : {}),
      })),
    aliases: aliasesFrom(src.aliases),
    // The port this deck listened on last time, so an address somebody typed on
    // the other machine still works after a restart. It asked the OS for a new
    // one every start, which is invisible while broadcast works and is exactly
    // what does not work in the case the address field exists for.
    //
    // A PREFERENCE, never a requirement: a port already taken falls through to
    // an OS-chosen one and this is rewritten. 0 means "none yet".
    port: Number.isInteger(src.port) && src.port > 0 && src.port < 65_536 ? src.port : 0,
    // ASK FIRST. A deck heard on the broadcast is sent a pairing request without
    // anybody pressing `ask` — the outbound half, which gives nothing away: the
    // machine on the other end still answers it, by hand or by the switch below.
    autoAsk: typeof src.autoAsk === "boolean" ? src.autoAsk : true,
    // AND SAY YES. Every deck that finishes a handshake and is not already
    // trusted is pinned without anybody being asked — the accept button pressed
    // in advance, and it hands whoever asks a copy of every login this deck
    // shares. Absent means the default above; only a real boolean overrides it,
    // because a truthy string from a hand-edited file is not an answer.
    autoAccept: typeof src.autoAccept === "boolean" ? src.autoAccept : true,
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
    autoUpdate: typeof src.autoUpdate === "boolean" ? src.autoUpdate : DEFAULTS.autoUpdate,
    lan: normaliseLan(src.lan),
  };
}

/** What is on disk, or the defaults. A corrupt or absent file is not an error
 *  the user can act on mid-session, so it reads as "nothing chosen yet". */
export async function readPrefs(home = deckDataDir(), deps = {}) {
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
export async function writePrefs(patch, home = deckDataDir(), deps = {}) {
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
    await mk(prefsDir(home), { recursive: true, mode: 0o700 });
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
 * THE PRIVATE KEY NEVER LEAVES THIS PROCESS. `GET /api/prefs` is readable by
 * anything that can reach the loopback port — which is the whole point of the
 * deck's own threat model, and is why the share envelope is not served there
 * either. A page has no use for the key: what it needs is this deck's
 * fingerprint, which is a hash of the PUBLIC half and comes from `/api/lan`.
 *
 * The pinned public keys of trusted decks go the same way, for a smaller
 * reason: they are not secret, and they are forty characters of base64 that no
 * page draws. What a page shows is a name and a fingerprint.
 */
export function publicPrefs(prefs) {
  const p = normalise(prefs);
  const { secret, trusted, ...lan } = p.lan;
  return {
    ...p,
    lan: { ...lan, trusted: trusted.map(t => ({ fp: t.fp, name: t.name })) },
  };
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
