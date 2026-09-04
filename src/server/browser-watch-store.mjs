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
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";

/** Reactions the panel can arm. `close-tab` is macOS-only and the server is the
 *  one that says so — a client cannot be trusted to know what the OS can do,
 *  and a mode that silently does nothing is worse than one that is not offered. */
export const REACTIONS = ["notify", "close-tab", "quit-browser"];

export const DEFAULTS = {
  v: 1,
  enabled: false,
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

const storeDir = (home = claudeConfigDir()) => join(home, "agent-dag", "browser-watch");
export const storePath = (home = claudeConfigDir()) => join(storeDir(home), "state.json");

/** The plain-text log, which is the one file here a person opens themselves.
 *  state.json is the deck's own record and is JSON because the deck reads it
 *  back; this is the same events in the shape `tail -f` wants. */
export const logPath = (home = claudeConfigDir()) => join(storeDir(home), "watch.log");

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
  await add(logPath(home), episodes.map(block).join("\n") + "\n", "utf8");
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
    enabled: it.enabled === true,
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

export async function readStore(home = claudeConfigDir(), deps = {}) {
  const read = deps.readFile ?? readFile;
  let parsed = null;
  try { parsed = JSON.parse(await read(storePath(home), "utf8")); } catch { /* absent or corrupt */ }
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

  const episodes = Array.isArray(parsed?.episodes)
    ? parsed.episodes.map(archivable).filter(e => Number.isFinite(e.startMs))
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

/** The write itself, already inside the queue. */
async function writeNow(state, home, deps) {
  const mk = deps.mkdir ?? mkdir;
  const write = deps.writeFile ?? writeFile;
  const mv = deps.rename ?? rename;
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
  // 512 KiB writeFile chunk): eight concurrent runs left state.json unparseable
  // in six of them and failed one call with ENOENT, renaming a temp file the
  // other writer had already renamed away. readStore swallows a corrupt file,
  // so the next poll reported an empty archive and no dismissals at all — total
  // loss of the one file this feature exists to keep.
  const tmp = `${storePath(home)}.${process.pid}.${++_writeSeq}.tmp`;
  await write(tmp, body, "utf8");
  await mv(tmp, storePath(home));
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
 */
export async function updateStore(mutate, home = claudeConfigDir(), deps = {}) {
  return serialized(async () => {
    const current = await readStore(home, deps);
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
