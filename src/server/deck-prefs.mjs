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
// temp file, fsync, rename — because the alternative is a truncated JSON
// document as the only record of what the user chose.
//
// And the READ is the other half of that sentence, which took #1002 to notice.
// An atomic write makes a truncated prefs.json rare; it does not make it
// impossible — a full disk, a power cut, an editor saving garbage — and what
// the deck did when it met one was read it as "nothing chosen yet" and then
// write defaults over it, destroying the LAN key every paired machine had
// pinned. A file that cannot be parsed is now moved aside and said out loud;
// only a genuinely ABSENT file starts clean. See loadPrefs.
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
// The rename, with the Windows retry ladder installer.mjs wrote for exactly
// this call. See the note over the write below (#786). `stripBom` and
// `createTemp` come from the same module for the reason its export block gives:
// a rule spelled twice is a rule that drifts, and both of these are rules
// settings.json and auth.json already follow on files with the same stakes.
import { createTemp, renameWithRetry, stripBom } from "./installer.mjs";
import { join } from "node:path";
import { deckDataDir } from "./deck-home.mjs";
import { PRODUCT } from "./brand.mjs";

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
 * file. A saved choice always wins over these — normalise() takes any real
 * boolean — so changing one here reaches only decks that never saved that
 * field, and nobody's saved setting is flipped by an upgrade.
 *
 * `notifications` defaults OFF since 3.22.7. The deck's own sounds are how it
 * gets attention by default; a desktop notification is something a person
 * turns on. It defaulted on from 3.7.0 until then, and a deck that saved that
 * `true` keeps it.
 */
export const DEFAULTS = Object.freeze({
  notifications: false,
  // Whether the deck may update itself: restart into code already on disk once
  // it is idle, and — while nobody is looking — install a newer release and
  // restart into that (auto-update.mjs). ON, because this is the banner's
  // `auto when idle`, which defaulted on as a localStorage key; it moved here so
  // the server can read it with no page open.
  autoUpdate: true,
  // LAN sync, ON unless somebody turns it off (since 3.22.7; off before).
  // `passphrase` is the only secret this file has ever held, which is why the
  // write below names a mode. AGENTS_DECK_NO_LAN=1 keeps a deck off the network
  // whatever this file says — see lanEnabled.
  lan: Object.freeze({
    enabled: true, name: "", secret: "", shared: [], manual: [], trusted: [], port: 0,
    // WHO PAIRS WITH WHOM, WITHOUT ANYBODY PRESSING ANYTHING. Asking is on, so
    // two decks on one network find each other and send each other a request —
    // which is what a person with three of their own machines wants and had to
    // do by hand six times.
    //
    // SAYING YES IS ON TOO, WHICH REVERSES WHAT 3.22.7 DECIDED. It shipped off
    // then, on the argument that every ccdeck in an office would otherwise pair
    // with every other one in silence. What that argument left out is what the
    // off state costs the person this feature is for: three of their own
    // machines find each other, each raises a request, and nothing happens
    // until somebody walks to each machine and presses accept — the manual
    // steps `autoAsk` exists to remove, moved one press along. The owner asked
    // for it on, 2026-09-16.
    //
    // WHAT MAKES IT SURVIVABLE IS THE GATE THAT NEVER CHANGED: `shared` is
    // empty, so a deck that pairs is offered NOTHING until somebody ticks a
    // login here. Pairing is a name in a list; a login is the thing worth
    // having, and it still takes a deliberate tick on this machine. A deck on a
    // network it does not own turns this off in the dialog, in one press.
    autoAsk: true,
    autoAccept: true,
    // WHICH ACCOUNT THIS DECK IS ON, told to the decks it is paired with — and
    // only ever one it shares, so an unticked account is never named. On, so two
    // of one person's machines show each other where they are working; off, and
    // paired decks read "current account hidden" instead.
    shareActive: true,
    // FINDING THIS PERSON'S OTHER MACHINES OVER TAILSCALE, off until they turn
    // it on: it is a new path off this machine, and the owner chooses it. Its
    // two permissions ship on, like the local pair above, and they are narrower
    // than those by construction — they only ever answer for a machine signed
    // in to the same Tailscale account as this one (see tailscale.mjs), never
    // for a colleague's node or one shared in from another tailnet.
    tailscale: false,
    tailscaleAsk: true,
    tailscaleAccept: true,
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
 *  Named on the CREATE rather than applied with a follow-up chmod, and the
 *  difference is the whole point — claude-swap's transfer.py makes the same
 *  argument at length: a create-then-chmod leaves the file readable for the
 *  window between the two, which is exactly when a secret is in it. The chmod
 *  that does follow the create is not that: it only pins a file the umask may
 *  have made narrower, and cannot widen one past what the create allowed. */
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
    enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULTS.lan.enabled,
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
    // AND SAY YES, once somebody has turned this on. Every deck that finishes a
    // handshake and is not already trusted is then pinned without anybody being
    // asked — the accept button pressed in advance, and it hands whoever asks a
    // copy of every login this deck shares. Absent means the default above,
    // which is off since the feature itself started on; only a real boolean
    // overrides it, because a truthy string from a hand-edited file is not an
    // answer.
    autoAccept: typeof src.autoAccept === "boolean" ? src.autoAccept : DEFAULTS.lan.autoAccept,
    // Whether paired decks are told which shared account this one is on. Absent
    // is on — the default above — and only a real boolean turns it off.
    shareActive: typeof src.shareActive === "boolean" ? src.shareActive : DEFAULTS.lan.shareActive,
    // The Tailscale switch and its two permissions. Only a real boolean
    // overrides a default, as above.
    tailscale: typeof src.tailscale === "boolean" ? src.tailscale : DEFAULTS.lan.tailscale,
    tailscaleAsk: typeof src.tailscaleAsk === "boolean" ? src.tailscaleAsk : DEFAULTS.lan.tailscaleAsk,
    tailscaleAccept: typeof src.tailscaleAccept === "boolean" ? src.tailscaleAccept : DEFAULTS.lan.tailscaleAccept,
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

/** Where the bytes of a prefs.json nothing could parse are put.
 *
 *  `Date.now()` rather than an ISO timestamp because a colon is not a legal
 *  filename character on Windows, and a quarantine that cannot be created on
 *  the platform it is protecting is not a quarantine. */
export const quarantinePath = (home = deckDataDir(), at = Date.now()) =>
  `${prefsPath(home)}.corrupt-${at}`;

/** The refusal `writePrefs` throws rather than merge onto a base it knows is
 *  not the user's. Shaped like installer.mjs's SETTINGS_UNREADABLE, which is
 *  the same policy on the other file this deck rewrites: a file we cannot
 *  reproduce is never treated as an empty one. */
function unreadablePrefs(path, why) {
  const err = new Error(
    `${path} could not be read (${why}). Refusing to overwrite it — this deck's ` +
    `LAN key and its pairings are in there and cannot be re-derived. Fix the ` +
    `file or move it aside, then restart ${PRODUCT}.`,
  );
  err.code = "PREFS_UNREADABLE";
  err.prefsPath = path;
  err.why = why;
  return err;
}

/**
 * Read prefs.json, and say WHICH of four things happened — because three of
 * them hand back the same object and only one of them means it.
 *
 * WHY THE SOURCE IS PART OF THE ANSWER. The old read collapsed "no file yet"
 * and "a file nothing could parse" into one silent `{ ...DEFAULTS }`, which is
 * a defensible answer to a question about VALUES and a catastrophic one as the
 * merge base of a write. A power cut or an OOM kill between the write and the
 * rename leaves a truncated prefs.json; the next boot read it as "nothing
 * chosen yet", found an empty `lan.secret`, generated a new identity and wrote
 * it — over the file that still had the old key, the pairings, the shared
 * accounts and the dialled addresses legibly in it. Every peer that had pinned
 * this deck had to accept it again, and nothing anywhere said why.
 *
 *   "file"       parsed. These are the user's own settings.
 *   "missing"    ENOENT, and only ENOENT. Nothing has been chosen yet;
 *                defaults, silently, which is what a first start is.
 *   "corrupt"    bytes that are not JSON. Moved aside to `quarantined` BEFORE
 *                this returns, so nothing can merge over them.
 *   "unreadable" the read itself failed for some reason other than absence — a
 *                permission, a directory in the way. The file is still there
 *                and still unread, which is exactly when a write must not land.
 *
 * A BYTE-ORDER MARK IS NOT DAMAGE. Notepad and `Set-Content` write one, and
 * `JSON.parse` throws on it — so stripping it here is what keeps a perfectly
 * good hand-edited file out of quarantine. Same call installer.mjs makes on
 * settings.json for the same reason.
 */
export async function loadPrefs(home = deckDataDir(), deps = {}) {
  const read = deps.readFile ?? readFile;
  const warn = deps.warn ?? console.error;
  const path = prefsPath(home);
  const defaults = () => ({ ...DEFAULTS });

  let raw;
  try {
    raw = await read(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { prefs: defaults(), source: "missing", quarantined: "" };
    warn(`${PRODUCT}: could not read ${path}: ${err?.message ?? err}. Leaving it alone — settings will not be saved until it can be read.`);
    return { prefs: defaults(), source: "unreadable", quarantined: "" };
  }

  try {
    return { prefs: normalise(JSON.parse(stripBom(raw))), source: "file", quarantined: "" };
  } catch (err) {
    const why = err?.message ?? String(err);
    const mv = deps.rename ?? renameWithRetry;
    const to = quarantinePath(home);
    try {
      await mv(path, to);
    } catch (moveErr) {
      // ENOENT means somebody else moved it between the read and the rename —
      // a second deck booting on the same machine. The bytes are safe, just not
      // under a name this read chose, and what is at `path` now is nothing.
      if (moveErr?.code === "ENOENT") return { prefs: defaults(), source: "missing", quarantined: "" };
      // Anything else and the damaged file is STILL THERE, unread and
      // unprotected. Saying so is the whole point: `writePrefs` refuses on it.
      warn(`${PRODUCT}: ${path} could not be read as JSON (${why}), and could not be moved aside either: ${moveErr?.message ?? moveErr}. Settings will not be saved until it is fixed or moved.`);
      return { prefs: defaults(), source: "corrupt", quarantined: "" };
    }
    warn(`${PRODUCT}: ${path} could not be read as JSON (${why}). It has been kept as ${to} and this deck is starting with fresh settings — its LAN key and its pairings are in that file, so do not delete it if you want them back.`);
    return { prefs: defaults(), source: "corrupt", quarantined: to };
  }
}

/** What is on disk, or the defaults — the VALUES alone, for the callers that
 *  want nothing else. `loadPrefs` is the same read with the answer to "and was
 *  that really the user's file?" still attached; anything about to write must
 *  ask that question, and does. */
export async function readPrefs(home = deckDataDir(), deps = {}) {
  return (await loadPrefs(home, deps)).prefs;
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
 *
 * AND IT REFUSES RATHER THAN MERGE ONTO A BASE THAT IS NOT THE USER'S. The
 * merge above exists to PRESERVE what the caller did not send; handed the
 * defaults because `loadPrefs` could not read the file, it preserves nothing
 * and the write becomes the thing that destroys the key. So the two failures
 * that read as defaults are separated: a file that was moved aside is safe to
 * start clean over, and one still sitting there unread is not. See
 * installer.mjs's readSettingsForWrite, which is this policy on settings.json.
 */
export async function writePrefs(patch, home = deckDataDir(), deps = {}) {
  return queued(() => save(() => patch, home, deps));
}

/**
 * Change some of the preferences from what the write is about to READ.
 *
 * The twin of `updateStore` in browser-watch-store.mjs, made for the same
 * reason and shaped the same way: `mutate(prev)` runs INSIDE the queued job,
 * after that job's own `loadPrefs` and after the two guards that decide whether
 * this file may be written at all, so the patch is a function of the file
 * rather than of a copy somebody took earlier — and a caller that computes one
 * never sees the defaults `loadPrefs` returns for a file it refused to write
 * over.
 *
 * WHICH CALLERS NEED IT, AND WHY A PATCH IS NOT ENOUGH ON ITS OWN. `writePrefs`
 * already merges field by field, so two writes naming two different fields
 * cannot lose each other. What it cannot do is merge two writes of the SAME
 * field, and three callers compute one whole field — `lan.manual` twice and
 * `lan.aliases` once — out of `index.mjs`'s module-level `_prefs`, which is
 * refreshed only when a previous write resolves. Two of them in one turn both
 * read before either job runs, and the second patch is a whole array or a whole
 * map without the first's entry in it: both answer 200, both panels redraw, one
 * change is never written.
 *
 * Measured against this file in a temp directory, with those exact call shapes,
 * starting from `manual: ["10.0.0.1:5000"]`:
 *
 *     memory manual  = ["10.0.0.1:5000","10.0.0.3:5002"]   # the onDial entry is gone
 *     disk   manual  = ["10.0.0.1:5000","10.0.0.3:5002"]
 *
 * The alias route carried a comment claiming the opposite — "the whole map is
 * rebuilt from the one on disk rather than sent by the page, so two tabs
 * renaming two decks cannot undo each other" — which is the sentence this makes
 * true.
 *
 * `mutate` returns a PATCH, not a whole state, so the merge doctrine above is
 * unchanged: a field nobody mentions keeps its value. It may return nothing,
 * which means "no change" and still rewrites the file with what it read.
 */
export async function updatePrefs(mutate, home = deckDataDir(), deps = {}) {
  return queued(() => save(mutate, home, deps));
}

/** One read-modify-write, behind every other one. Both entry points go through
 *  here so there is a single queue and a single merge. */
function queued(job) {
  const started = _chain.then(job, job);
  _chain = started.then(() => {}, () => {});
  return started;
}

async function save(mutate, home, deps) {
  const mk = deps.mkdir ?? mkdir;
  const temp = deps.createTemp ?? createTemp;
  const setMode = deps.chmod ?? chmod;
  const drop = deps.unlink ?? unlink;
  // `renameWithRetry`, not `rename` (#786). MoveFileExW refuses while any
  // handle without FILE_SHARE_DELETE is open on either side, and Defender and
  // the search indexer open a file the instant it is written — so on Windows
  // a bare rename fails on a perfectly healthy machine, `POST /api/prefs`
  // 500s through `guard`, and the notifications switch silently does not
  // stick. POSIX rename(2) has no such rule, which is why this shipped green.
  const mv = deps.rename ?? renameWithRetry;
  const target = prefsPath(home);
  const { prefs: prev, source, quarantined } = await loadPrefs(home, deps);
  if (source === "unreadable") throw unreadablePrefs(target, "the read failed");
  if (source === "corrupt" && !quarantined) {
    throw unreadablePrefs(target, "it is not JSON and could not be moved aside");
  }
  // INSIDE THE JOB, after the read above and after the two guards that
  // decide whether this file may be written at all — see `updatePrefs`.
  // `writePrefs` hands over a constant here, which is what makes the two
  // one function.
  const patch = await mutate(prev);
  // The LAN section merges rather than replaces, so a page toggling the
  // switch does not have to send the passphrase back to keep it — and so
  // nothing has to send a secret it was never given.
  const merged = { ...prev, ...patch, lan: { ...prev.lan, ...(patch?.lan ?? {}) } };
  const next = normalise(merged);
  await mk(prefsDir(home), { recursive: true, mode: 0o700 });
  // `createTemp`, not a name built out of the pid alone.
  //
  // The splice browser-watch-store.mjs met is NOT the hazard here: `_chain`
  // above serializes every write in this process, and two decks on one home
  // have two pids. The hazard is the LEFTOVER. A deck killed between the
  // create and the rename strands a temp file with this deck's private key
  // in it under a name derived from its pid, the old code never unlinked one
  // on failure either — and `writeFile`'s `mode` applies only when the call
  // CREATES the file, so a later deck the OS hands that pid back adopted the
  // stranded file whole, keeping whatever permissions it had, and wrote the
  // key into it. O_EXCL is what turns a taken name into an error the caller
  // handles instead, and it is also what makes PREFS_MODE binding from the
  // first byte rather than a hope about what was there before. codex-auth.mjs
  // argues all of this at length over the one other secret this deck stages
  // through a temp file.
  const { tmp, handle } = await temp(target, { mode: PREFS_MODE });
  let landed = false;
  try {
    try {
      await handle.writeFile(JSON.stringify(next, null, 2) + "\n", "utf8");
      // The fsync is the half of "atomic" a rename alone does not buy. A
      // rename orders the directory entry; it does not order the BYTES, so a
      // machine that loses power just after it can come up with the entry
      // pointing at a file that was never flushed — which is the truncated
      // prefs.json this whole read path now exists to survive.
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The umask only ever clears bits off the creation mode, so the key is
    // never wider than 0600 — but it can land narrower, and a prefs.json at
    // 0400 is one this writer cannot replace next time. On Windows chmod's
    // only effect is the read-only bit, and a read-only target is one no
    // rename can replace. Pin it either way.
    await setMode(tmp, PREFS_MODE);
    await mv(tmp, target);
    landed = true;
  } finally {
    // A temp left behind holds this deck's private key in cleartext.
    if (!landed) await drop(tmp).catch(() => {});
  }
  return next;
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
 * Should the LAN engine run? The file's answer, unless the machine said no.
 *
 * AGENTS_DECK_NO_LAN=1 wins for the reason AGENTS_DECK_NO_NOTIFY does above:
 * whoever launched the deck is making a claim about the machine, and a page
 * posting to /api/prefs is not entitled to overrule it. It earns its keep twice
 * over now that the feature is on by default — it is also how this repo's own
 * suite keeps the decks it boots off the network it is being run on.
 */
export function lanEnabled(prefs, env = process.env) {
  if (env.AGENTS_DECK_NO_LAN === "1") return false;
  return normalise(prefs).lan.enabled;
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
