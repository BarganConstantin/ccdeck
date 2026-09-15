// What Browser Watch remembers between runs: whether it is on, how it is tuned,
// and the episodes it has already seen.
//
// THE ARCHIVE IS THE POINT, AND IT IS NOT A CACHE. Everything the panel shows
// is read live out of Chrome's own history, which is complete and needs no help
// from us — with one exception that is the whole reason this file exists.
// Whoever can drive your browser can also clear its history, and they have the
// same buttons you do. A watch that only ever reads live is a watch that any
// intruder can erase behind themselves.
//
// So while the watch is ON, every episode it sees is copied here, and the panel
// shows the union of what Chrome still remembers and what the deck already
// wrote down. What happened while the watch was OFF is at the mercy of the
// browser, and the panel says so rather than implying an unbroken record.
//
// A separate directory rather than a file beside the deck records in
// `~/.claude/agent-dag`: readLiveDecks() reads every `.json` in that directory
// and would have to keep skipping this one forever. A subdirectory is not a
// name it can collide with.
//
// AND THE READ IS THE OTHER HALF OF THAT SENTENCE, which took #1003 to notice.
// An archive whose whole premise is that the browser's own copy can be erased
// has to survive its own file being damaged, and what this module did when it
// met one was read it as an empty archive — same answer as "no file yet" — and
// then let the next ten-second poll write that emptiness over it. A file that
// cannot be parsed is now moved aside and said out loud; only a genuinely
// ABSENT file starts clean. See loadStore.
import { appendFile, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
// The rename, with the Windows retry ladder installer.mjs wrote for exactly
// this call. See the note over `writeNow` (#786). `stripBom` comes from the same
// module for the reason its export block gives: a rule spelled twice is a rule
// that drifts, and "a BOM is not damage" has to mean the same thing here as it
// does on settings.json, or a state.json somebody opened in Notepad gets
// quarantined for a mark the settings reader has ignored since it was written.
import { renameWithRetry, stripBom } from "./installer.mjs";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
import { PRODUCT } from "./brand.mjs";

/** Reactions the panel can arm. `close-tab` is macOS-only and the server is the
 *  one that says so — a client cannot be trusted to know what the OS can do,
 *  and a mode that silently does nothing is worse than one that is not offered. */
export const REACTIONS = ["notify", "close-tab", "quit-browser"];

export const DEFAULTS = {
  v: 1,
  // ON unless somebody switches it off (since 3.22.7; off before). A saved
  // `false` still wins — normalise() takes any real boolean — so an upgrade
  // starts watching only on a deck that never saved this field.
  enabled: true,
  reaction: "notify",
  quietMinutes: 15,
  gapMinutes: 15,
};

/**
 * The store's schema version.
 *
 * Bumped when the rule that PRODUCES episodes changes, not when their shape
 * does — see readStore. Version 1 kept rows from a thirty-day sweep of the
 * browser's history; version 2 keeps only what the deck saw while watching.
 */
const STORE_VERSION = 2;

/** How many archived episodes are kept. Roughly two years at the measured rate
 *  of one card every eight days, and small enough that the file stays a thing a
 *  person could open and read. Trimmed oldest-first. */
const KEEP = 500;

/** Exported so the boot-time temp sweep can be handed this directory by name
 *  rather than by a second spelling of the path. `sweepTempFiles` does not
 *  recurse — deck-home.mjs:229 walks the directories it is given and nothing
 *  under them — so the archive's own `.tmp` files, about 2.5 MB each with a
 *  full 500-episode store, were outside every sweep the deck has ever run. */
export const storeDir = (home = claudeConfigDir()) => join(home, "agent-dag", "browser-watch");
export const storePath = (home = claudeConfigDir()) => join(storeDir(home), "state.json");

/** Where the bytes of a state.json nothing could parse are put.
 *
 *  `Date.now()` rather than an ISO timestamp because a colon is not a legal
 *  filename character on Windows, and a quarantine that cannot be created on
 *  the platform it is protecting is not a quarantine. Beside the file it came
 *  from, so nobody has to be told where to look — and it does not end in `.tmp`,
 *  so the sweep that now reaches this directory will not carry it off. */
export const quarantinePath = (home = claudeConfigDir(), at = Date.now()) =>
  `${storePath(home)}.corrupt-${at}`;

/** The plain-text log, which is the one file here a person opens themselves.
 *  state.json is the deck's own record and is JSON because the deck reads it
 *  back; this is the same events in the shape `tail -f` wants. */
export const logPath = (home = claudeConfigDir()) => join(storeDir(home), "watch.log");

/** The one generation kept behind it. `.1` rather than a datestamp because this
 *  is `tail -f`'s file and `logrotate`'s convention is the one a person reading
 *  it already knows — and because a name that changes is a name nothing can
 *  overwrite, which is how a rotation that bounds nothing gets written. */
export const rolledLogPath = (home = claudeConfigDir()) => `${logPath(home)}.1`;

/**
 * How large watch.log may grow before it is rolled over (#989).
 *
 * EVERY OTHER STORE IN THIS MODULE HAS A CAP. `KEEP` holds the archive to 500
 * episodes, `DISMISS_KEEP` holds dismissals to 2000, and the panel's feed is
 * held to 200 lines — while this file, the one that writes out EVERY ADDRESS in
 * full, grew for the life of the install and nothing ever trimmed it. With the
 * watch on by default, a machine where something drives a browser in a loop
 * builds a plaintext list of every address it touched, without end.
 *
 * TWO MEBIBYTES. An episode of twenty addresses with query strings is about
 * 2 KB of this file, so the cap is on the order of a thousand episodes: twice
 * the archive beside it, which `KEEP` sizes at about two years of the measured
 * rate. It is only reached where something drives a browser far more often than
 * that, and that machine must not fill its disk reporting it.
 *
 * ONE GENERATION, `watch.log.1`, so the most this costs on disk is a number a
 * reader can state: twice the cap, plus one append that was larger on its own.
 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * What the log holds on disk right now, both generations, in bytes — for the
 * panel, which names the file and now its size. Never throws: 0 is the answer
 * for a log never written, and a coverage field is not where a stat error goes.
 */
export async function logSize(home = claudeConfigDir(), deps = {}) {
  const st = deps.stat ?? stat;
  let total = 0;
  for (const file of [logPath(home), rolledLogPath(home)]) {
    try { total += (await st(file)).size; } catch { /* not there, or not readable */ }
  }
  return total;
}

/**
 * Append one episode, and EVERY ADDRESS IN IT, oldest first.
 *
 * THE URLs ARE THE POINT OF THE FILE. A summary line — host, count, duration —
 * says something happened and leaves the reader unable to act on it: the
 * question three days later is not "did a program touch gitlab" but "WHICH
 * pages", because a jobs list and a settings page mean different things. So
 * every address is written in full, unshortened and unescaped, exactly as
 * Chrome recorded it.
 *
 * Query strings and fragments included. They are frequently the whole content
 * of the visit — `?scope=all`, `#servicii` — and a log that dropped them would
 * be tidier and useless for the one job it has.
 *
 * Indented under their episode so the shape survives `grep`: a summary line
 * starts at column zero, a URL line does not, which is what lets
 * `grep -v '^ '` give the summary alone and `grep '^  '` give the addresses.
 *
 * Append-only and never rewritten: a log a program edits is not a log. It is
 * the only part of this feature that outlives the process by design — the panel
 * shows what this deck has seen, this file is what somebody reads three days
 * later without opening the panel at all.
 *
 * ROLLED OVER, NOT EDITED, at LOG_MAX_BYTES (#989), which keeps that rule: the
 * whole file moves to `watch.log.1` and the next append starts a new one. No
 * line this function wrote is ever changed. Trimming the oldest lines out in
 * place was the other way to bound it, and it is the edit the rule forbids.
 */
export async function appendLog(episodes, home = claudeConfigDir(), deps = {}) {
  if (!episodes.length) return;
  const mk = deps.mkdir ?? mkdir;
  const add = deps.appendFile ?? appendFile;
  // Local time, not UTC. The reader's question is "what was happening at four
  // yesterday afternoon", and their afternoon is not UTC's — the ISO stamp this
  // replaced was off by the offset for everyone outside London.
  const stamp = ms => {
    const d = new Date(ms);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
         + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const block = e => {
    const span = e.endMs - e.startMs >= 60_000
      ? ` over ${Math.round((e.endMs - e.startMs) / 60_000)}m`
      : "";
    const where = e.browser ? ` [${e.browser}]` : "";
    const head = `${stamp(e.startMs)}  ${e.host}  ${e.count} page${e.count === 1 ? "" : "s"}${span}${where}`;
    const rows = (e.urls ?? []).map(u => `    ${stamp(u.timeMs).slice(11)}  ${u.url}`);
    return [head, ...rows].join("\n");
  };
  await mk(storeDir(home), { recursive: true });
  const text = episodes.map(block).join("\n") + "\n";
  await rollIfFull(home, Buffer.byteLength(text, "utf8"), deps);
  await add(logPath(home), text, "utf8");
}

/**
 * Move the log aside when this append would carry it past the cap.
 *
 * MEASURED BEFORE THE WRITE, so the cap is a ceiling rather than a line the file
 * sits above until the next append. The one overshoot left is a single append
 * larger than the whole cap, written whole on purpose: an episode split across
 * two files would leave addresses under no summary line, and that line and its
 * indented addresses are what `grep -v '^ '` and `grep '^  '` separate.
 *
 * A ROTATION THAT FAILS MUST NOT COST THE APPEND. This is the record of what a
 * program did in somebody's browser. A full disk, a Windows handle still open on
 * `watch.log.1`, a permission on the directory: each is a reason to write a
 * larger file than intended, and none is a reason to write nothing. The next
 * append tries again.
 *
 * `renameWithRetry` for the reason #786 gives over `writeNow`: on Windows a
 * rename loses to anything still holding a handle, and this is a file people
 * open to read.
 */
async function rollIfFull(home, adding, deps) {
  const st = deps.stat ?? stat;
  const mv = deps.rename ?? renameWithRetry;
  try {
    const { size } = await st(logPath(home));
    if (size === 0 || size + adding <= LOG_MAX_BYTES) return;
    await mv(logPath(home), rolledLogPath(home));
  } catch {
    // No log yet (the ordinary first call), or the filesystem refused. Either
    // way the append is the thing that matters and it is not this function's to
    // cancel.
  }
}

/**
 * Settings as they will be used, whatever the file said.
 *
 * Every field is checked rather than spread, because this file is on disk and
 * on disk is where a hand edit, a half-written save and an older version all
 * arrive from. A `quietMinutes` of `"15"` or of `0` would otherwise reach
 * classify() and widen the gate to everything, which is the failure that turns
 * the panel into noise — the same reason the route refuses to coerce its query
 * string.
 */
export function normalise(raw) {
  const it = raw && typeof raw === "object" ? raw : {};
  const num = (v, fallback, lo, hi) =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
  return {
    v: 1,
    enabled: typeof it.enabled === "boolean" ? it.enabled : DEFAULTS.enabled,
    reaction: REACTIONS.includes(it.reaction) ? it.reaction : DEFAULTS.reaction,
    quietMinutes: num(it.quietMinutes, DEFAULTS.quietMinutes, 1, 24 * 60),
    gapMinutes: num(it.gapMinutes, DEFAULTS.gapMinutes, 1, 24 * 60),
  };
}

/** An episode reduced to what an archive needs: enough to redraw the card and
 *  enough to recognise it again. `urls` is kept whole — it is the evidence, and
 *  an archive that dropped it would preserve the accusation without it. */
function archivable(e) {
  return {
    host: String(e.host ?? ""),
    // Which browser it happened in. Kept because a reaction has to tell ONE
    // application to close a tab, and because a log line that names the host
    // but not the browser leaves a two-browser machine guessing. Dropping it
    // here was the one place the tag was lost between finding and acting.
    browser: typeof e.browser === "string" ? e.browser : null,
    startMs: Number(e.startMs),
    endMs: Number(e.endMs),
    count: Number(e.count),
    urls: Array.isArray(e.urls)
      ? e.urls.map(u => ({ url: String(u.url ?? ""), timeMs: Number(u.timeMs) }))
      : [],
    // When the deck wrote it down, which is the only claim the archive can make
    // that Chrome's history cannot: the episode existed at this moment, whatever
    // the browser says later.
    archivedMs: Number(e.archivedMs ?? Date.now()),
  };
}

/** Two episodes are the same one when they start at the same moment on the same
 *  host. Not the count or the end, both of which grow while a program is still
 *  working — keyed on those, one run would archive itself a dozen times. */
// Separated by an escaped NUL rather than a space: a host cannot contain one,
// so no two different episodes can collide on the joined string. Written as an
// ESCAPE and never as the raw byte — source-nul-bytes.test.ts exists because a
// raw NUL makes grep skip the whole file without ever saying so.
const keyOf = e => `${e.host}\u0000${e.startMs}`;

/** The same key, from the two fields a caller has. Exported because the route
 *  that dismisses an episode is handed a host and a start, not an episode. */
export const episodeKey = (host, startMs) => `${host}\u0000${startMs}`;

/** How many dismissals are remembered. A dismissal is a few dozen bytes and
 *  the archive it filters is capped at 500, so this is generous — but it is
 *  capped all the same, because a set that only grows is a file that only
 *  grows. Trimmed oldest-first, and the cost of forgetting the oldest is that
 *  an episode from two years ago could reappear if it were still live, which
 *  it cannot be. */
const DISMISS_KEEP = 2000;

/** The refusal `updateStore` throws rather than merge onto a base it knows is
 *  not what is on disk. Shaped like installer.mjs's SETTINGS_UNREADABLE and
 *  deck-prefs' PREFS_UNREADABLE, which is this same policy on the other two
 *  files the deck rewrites in place: a file we cannot reproduce is never
 *  treated as an empty one. */
function unreadableStore(path, why) {
  const err = new Error(
    `${path} could not be read (${why}). Refusing to overwrite it — the episodes ` +
    `in there are this deck's own record of what a program did in the browser, and ` +
    `nothing can re-derive them. Fix the file or move it aside, then restart ${PRODUCT}.`,
  );
  err.code = "WATCH_STORE_UNREADABLE";
  err.storePath = path;
  err.why = why;
  return err;
}

/**
 * Complaints already made, so a poll does not repeat one six times a minute.
 *
 * THE DIVERGENCE FROM deck-prefs, and the reason for it. prefs.json is read at
 * boot and when somebody presses something; this file is read by the panel's
 * ten-second poll and by the badge's background one, for as long as the deck is
 * up. A quarantine that succeeded says its piece once by construction — the
 * damaged file is gone from that name afterwards — but the two failures that
 * CANNOT clear themselves, an unreadable file and a quarantine the filesystem
 * refused, would otherwise put the same line on stderr every ten seconds
 * forever, which is how a warning becomes something people filter out.
 *
 * Keyed on the path and the reason, not on a bare flag: two different things
 * going wrong with two different files are two things somebody needs told.
 */
const _said = new Set();
function sayOnce(warn, key, line) {
  if (_said.has(key)) return;
  _said.add(key);
  warn(line);
}

/**
 * Read the store, and say WHICH of four things happened — because three of them
 * hand back the same empty archive and only one of them means it.
 *
 * WHY THE SOURCE IS PART OF THE ANSWER (#1003). The old read caught every
 * failure the same way — one bare `catch` marked "absent or corrupt" — which is
 * a defensible answer to a question about VALUES and a catastrophic one as the
 * merge base of a write, because `updateStore` asked it that question on every
 * single write. Measured end to end against a state.json truncated to half its
 * length, the way a machine that died between the write and the rename leaves
 * one: the archive read as empty, and the next poll wrote an archive holding
 * only what Chrome itself still remembered — which is precisely the copy this
 * feature exists because an intruder can erase. The dismissals went with it and
 * the settings went back to defaults in the same write, and nothing anywhere
 * said a word.
 *
 *   "file"       parsed. This is the deck's own record.
 *   "missing"    ENOENT, and only ENOENT. Nothing has been written yet;
 *                an empty archive, silently, which is what a first run is.
 *   "corrupt"    bytes that are not JSON. Moved aside to `quarantined` BEFORE
 *                this returns, so nothing can write over them.
 *   "unreadable" the read itself failed for some reason other than absence — a
 *                permission, a directory in the way. The file is still there
 *                and still unread, which is exactly when a write must not land.
 */
export async function loadStore(home = claudeConfigDir(), deps = {}) {
  const read = deps.readFile ?? readFile;
  const warn = deps.warn ?? console.error;
  const path = storePath(home);
  const empty = () => ({ settings: normalise(null), episodes: [], dismissed: [], migrated: false });

  let raw;
  try {
    raw = await read(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { store: empty(), source: "missing", quarantined: "" };
    sayOnce(warn, `${path} read`,
      `${PRODUCT}: could not read ${path}: ${err?.message ?? err}. Leaving it alone — ` +
      `the episode archive will not be written until it can be read.`);
    return { store: empty(), source: "unreadable", quarantined: "" };
  }

  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (err) {
    const why = err?.message ?? String(err);
    const mv = deps.rename ?? renameWithRetry;
    const to = quarantinePath(home);
    try {
      await mv(path, to);
    } catch (moveErr) {
      // ENOENT means somebody else moved it between the read and the rename —
      // a second deck on the same home, or this deck's own poll racing its own
      // write queue. The bytes are safe, just not under a name this read chose,
      // and what is at `path` now is nothing.
      if (moveErr?.code === "ENOENT") return { store: empty(), source: "missing", quarantined: "" };
      // Anything else and the damaged file is STILL THERE, unread and
      // unprotected. Saying so is the whole point: `updateStore` refuses on it.
      sayOnce(warn, `${path} quarantine`,
        `${PRODUCT}: ${path} could not be read as JSON (${why}), and could not be moved ` +
        `aside either: ${moveErr?.message ?? moveErr}. The episode archive will not be ` +
        `written until it is fixed or moved.`);
      return { store: empty(), source: "corrupt", quarantined: "" };
    }
    warn(
      `${PRODUCT}: ${path} could not be read as JSON (${why}). It has been kept as ${to} ` +
      `and Browser Watch is starting a fresh archive — the episodes this deck recorded ` +
      `are in that file, so do not delete it if you want them back.`,
    );
    return { store: empty(), source: "corrupt", quarantined: to };
  }
  return { store: shapeStore(parsed), source: "file", quarantined: "" };
}

/** What is on disk, or an empty archive — the VALUES alone, for the callers
 *  that want nothing else. `loadStore` is the same read with the answer to "and
 *  was that really the deck's own file?" still attached; anything about to
 *  write must ask that question, and does. */
export async function readStore(home = claudeConfigDir(), deps = {}) {
  return (await loadStore(home, deps)).store;
}

/** The parsed document as the rest of the deck reads it. Unchanged from what
 *  `readStore` always did; it is a function of its own now only because the
 *  read above has three other answers to give. */
function shapeStore(parsed) {
  const settings = normalise(parsed?.settings);

  // A VERSION BUMP DROPS THE EPISODES AND KEEPS THE SETTINGS, because the two
  // are not the same kind of thing. Settings are what the user chose and stay
  // chosen; episodes are FINDINGS, and a finding produced by a rule the deck no
  // longer applies is not a finding it can stand behind.
  //
  // Version 1 archived whatever a thirty-day sweep of the browser's history
  // turned up, so its rows are the user's own past browsing — read before the
  // watch existed, under a rule that has since been removed. Keeping them would
  // put "nothing from before this deck started" on screen directly above four
  // episodes from a fortnight earlier, which is the panel calling itself a liar.
  //
  // Dropping rather than migrating: there is no way to re-derive which of those
  // rows the current rule WOULD have found, because the evidence for that
  // question is exactly the history the deck no longer reads.
  //
  // `migrated` tells the caller to write the file back. Hiding the rows is not
  // enough: the promise is that nothing from before the watch is KEPT, and rows
  // left on disk are kept whatever the panel chooses to draw. readStore does not
  // write them away itself — a read with a side effect is a trap for the next
  // caller — so it says so and the snapshot does it.
  if (parsed && parsed.v !== STORE_VERSION) return { settings, episodes: [], dismissed: [], migrated: true };

  // FILTERED BEFORE `archivable`, NOT AFTER. archivable opens with
  // `String(e.host ?? "")`, which is a property access — so a `null` element
  // threw before the `.filter` below could refuse it, and the throw escaped
  // readStore (the try up there wraps only JSON.parse) through
  // browserWatchSnapshot and fetchBrowserWatch into guard(): a 500 on
  // GET /api/browser-watch, and on the settings and dismiss POSTs through
  // updateStore. The panel stayed dead until the file was edited by hand.
  //
  // `{"v":2,"episodes":[null]}` is all it took. A string element was already
  // handled correctly — it is specifically a non-object that reached the
  // property access — and normalise a few lines up is defensive for exactly
  // this reason: "a hand edit, a half-written save and an older version all
  // arrive from" here.
  const episodes = Array.isArray(parsed?.episodes)
    ? parsed.episodes
        .filter(e => e && typeof e === "object")
        .map(archivable)
        .filter(e => Number.isFinite(e.startMs))
    : [];
  // WHAT THE READER HAS ALREADY LOOKED AT. It has to be its own list rather
  // than a deletion from `episodes`, because the panel reads the browser's
  // history live as well as its own archive — delete the row and the very next
  // poll finds the same visits and puts it back, which is worse than having no
  // delete at all.
  const dismissed = Array.isArray(parsed?.dismissed)
    ? parsed.dismissed.filter(k => typeof k === "string" && k.includes("\u0000")).slice(-DISMISS_KEEP)
    : [];
  return { settings, episodes, dismissed, migrated: false };
}

/**
 * Write the store, atomically.
 *
 * Through a temp file and a rename because the alternative is a truncated JSON
 * document as the only record of what was seen while the browser was being
 * driven — the one file whose loss this feature cannot absorb. installer.mjs
 * makes the same argument about settings.json, for the same reason.
 */
/**
 * One writer at a time, in this process.
 *
 * Three call sites write this file — the poll's snapshot, the settings route
 * and the dismiss route — and none of them knew about the others. The queue is
 * the same shape `log-writer.mjs` uses for its appends: a promise chain that
 * survives a rejection, so one failed write cannot wedge every later one.
 */
let _chain = Promise.resolve();
let _writeSeq = 0;
function serialized(job) {
  const started = _chain.then(job, job);
  _chain = started.then(() => {}, () => {});
  return started;
}

/**
 * Write the whole store, atomically.
 *
 * IT WRITES WHAT IT IS HANDED. There is no merge with what is on disk, on
 * purpose — a writer that read first would have to decide what wins, and two
 * decks racing on that is worse than one deck writing a whole state. The cost
 * is that every caller must pass every field, and the cost was paid once: the
 * settings route omitted `dismissed` and so erased every episode the reader had
 * marked reviewed, from a change that had nothing to do with them. There is a
 * test that greps this file's callers for the field.
 */
export async function writeStore(state, home = claudeConfigDir(), deps = {}) {
  return serialized(() => writeNow(state, home, deps));
}

/**
 * The temp file, on disk and FLUSHED, before anything renames it.
 *
 * A rename orders the DIRECTORY ENTRY; it does not order the bytes. A machine
 * that loses power just after one can come up with the new entry pointing at
 * blocks that were never written — the classic file of zero bytes, and the
 * ordinary outcome of a crash for a writer that does not sync. installer.mjs's
 * writeFileAtomic has fsync'd for exactly this reason since it was written, and
 * this is the file where the argument is strongest: a truncated state.json is a
 * lost archive, and the archive exists because the browser's own copy can be
 * erased by whoever is driving it.
 *
 * Signature-compatible with `writeFile` on purpose. `deps.writeFile` is the seam
 * the suite drives a fake filesystem through, and a staging step that changed
 * its shape would be a second thing for every caller of that seam to know.
 */
async function writeAndSync(path, body, encoding) {
  const fh = await open(path, "w");
  try {
    await fh.writeFile(body, encoding);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** The write itself, already inside the queue. */
async function writeNow(state, home, deps) {
  const mk = deps.mkdir ?? mkdir;
  const write = deps.writeFile ?? writeAndSync;
  const drop = deps.unlink ?? unlink;
  // `renameWithRetry`, not `rename` (#786). Same Windows rule as deck-prefs,
  // and the stakes are higher here: none of the three writers catches the
  // throw, so a refused rename 500s `GET /api/browser-watch` and the panel goes
  // blank, while the episode archive — the file that exists BECAUSE an intruder
  // can clear the browser's own history — is not written at all.
  const mv = deps.rename ?? renameWithRetry;
  await mk(storeDir(home), { recursive: true });
  const body = JSON.stringify({
    v: STORE_VERSION,
    settings: normalise(state.settings),
    episodes: (state.episodes ?? []).map(archivable),
    dismissed: [...new Set(state.dismissed ?? [])].slice(-DISMISS_KEEP),
  }, null, 2) + "\n";
  // A NAME NO SECOND WRITE CAN BE USING. The pid distinguishes decks and not
  // the calls inside one, and there are three writers in this process — the
  // poll's snapshot, the settings route and the dismiss route — with nothing
  // between them. Measured with a full 500-episode archive (~2.5 MB, past the
  // 512 KiB write chunk): eight concurrent runs left state.json unparseable
  // in six of them and failed one call with ENOENT, renaming a temp file the
  // other writer had already renamed away. readStore swallowed a corrupt file
  // then, so the next poll reported an empty archive and no dismissals at all —
  // total loss of the one file this feature exists to keep. That second half is
  // no longer true of any cause, which is #1003 and `loadStore` above; this
  // counter is what stops this particular cause from arising at all.
  const tmp = `${storePath(home)}.${process.pid}.${++_writeSeq}.tmp`;
  let landed = false;
  try {
    await write(tmp, body, "utf8");
    await mv(tmp, storePath(home));
    landed = true;
  } finally {
    // A REFUSED WRITE MUST NOT LEAVE ITS STAGING FILE. Each of these is about
    // 2.5 MB with a full archive, and nothing ever unlinked one: a rename the
    // Windows ladder could not outlast, a full disk, a permission — every one
    // of them left a copy of the whole archive lying beside it. That is only
    // half the litter, because a deck KILLED between the two never reaches this
    // line at all; the other half is the boot sweep, which now gets handed this
    // directory (see `storeDir`, and bin/deck.js's sweepTempFiles call).
    if (!landed) await drop(tmp).catch(() => {});
  }
}

/**
 * Read, change, write — with nothing else writing in between.
 *
 * `writeStore` writes what it is handed and merges nothing, which is right for
 * a whole-state write and wrong for a caller that owns one field. The snapshot
 * takes about 400ms — a 21 MB History copy plus the sqlite read — and used to
 * write back the `dismissed` and `settings` it had read at the start, so a
 * dismissal made while it ran was reverted by the next poll ten seconds later.
 * The settings route and the dismiss route had the same shape against each
 * other.
 *
 * So a caller that owns one field passes a function instead: it runs inside the
 * same queue the write does, against the state on disk at that moment, and no
 * other writer can slip between the read and the write.
 *
 * AND IT REFUSES RATHER THAN MUTATE A BASE THAT IS NOT WHAT IS ON DISK (#1003).
 * `current` exists to PRESERVE what the caller does not own; handed an empty
 * archive because `loadStore` could not read the file, it preserves nothing and
 * this becomes the call that destroys the episodes. So the two failures that
 * read as empty are separated: a file already moved aside is safe to start
 * clean over, and one still sitting there unread is not. installer.mjs's
 * readSettingsForWrite is the same policy on settings.json and deck-prefs'
 * writePrefs is the same policy on prefs.json.
 */
export async function updateStore(mutate, home = claudeConfigDir(), deps = {}) {
  return serialized(async () => {
    const { store: current, source, quarantined } = await loadStore(home, deps);
    if (source === "unreadable") throw unreadableStore(storePath(home), "the read failed");
    if (source === "corrupt" && !quarantined) {
      throw unreadableStore(storePath(home), "it is not JSON and could not be moved aside");
    }
    const next = (await mutate(current)) ?? current;
    await writeNow(next, home, deps);
    return next;
  });
}

/**
 * The archive with `seen` folded into it, newest first and capped.
 *
 * An episode already archived is REPLACED rather than skipped, because a run
 * that is still going gains pages: the card the deck wrote at 17:05 said one
 * page, and by 17:44 the truth is thirteen. Skipping would freeze the first
 * reading; appending would show the same run twice.
 */
export function mergeEpisodes(archive, seen, now = Date.now()) {
  const byKey = new Map();
  for (const e of archive) byKey.set(keyOf(e), archivable(e));
  for (const e of seen) {
    const key = keyOf(e);
    const had = byKey.get(key);
    byKey.set(key, archivable({ ...e, archivedMs: had?.archivedMs ?? now }));
  }
  return [...byKey.values()].sort((a, b) => b.startMs - a.startMs).slice(0, KEEP);
}

/**
 * Episodes the reader has not dismissed.
 *
 * Applied to the LIVE read as well as to the archive, which is the whole point:
 * an episode is rebuilt from the browser's own history on every poll, so a
 * dismissal that only removed the archived copy would be undone within ten
 * seconds by the next read of the same visits.
 *
 * Keyed on host and START, never on the end or the count: a run that is still
 * going gains pages, and a key that moved with them would let a dismissed
 * episode return the moment its program opened one more tab.
 */
export function undismissed(episodes, dismissed) {
  if (!Array.isArray(dismissed) || dismissed.length === 0) return episodes;
  const gone = new Set(dismissed);
  return episodes.filter(e => !gone.has(keyOf(e)));
}
