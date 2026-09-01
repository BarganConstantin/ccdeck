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

/** How many archived episodes are kept. Roughly two years at the measured rate
 *  of one card every eight days, and small enough that the file stays a thing a
 *  person could open and read. Trimmed oldest-first. */
const KEEP = 500;

export const storeDir = (home = claudeConfigDir()) => join(home, "agent-dag", "browser-watch");
export const storePath = (home = claudeConfigDir()) => join(storeDir(home), "state.json");

/** The plain-text log, which is the one file here a person opens themselves.
 *  state.json is the deck's own record and is JSON because the deck reads it
 *  back; this is the same events in the shape `tail -f` wants. */
export const logPath = (home = claudeConfigDir()) => join(storeDir(home), "watch.log");

/**
 * Append one line per episode, oldest first.
 *
 * Append-only and never rewritten: a log a program edits is not a log. It is
 * also the only part of this feature that outlives the process by design — the
 * panel shows what this deck has seen, and this file is what somebody reads
 * three days later without opening the panel at all.
 */
export async function appendLog(episodes, home = claudeConfigDir(), deps = {}) {
  if (!episodes.length) return;
  const mk = deps.mkdir ?? mkdir;
  const add = deps.appendFile ?? appendFile;
  const line = e => {
    const at = new Date(e.startMs).toISOString().replace("T", " ").slice(0, 19);
    const span = e.endMs - e.startMs >= 60_000
      ? ` over ${Math.round((e.endMs - e.startMs) / 60_000)}m`
      : "";
    return `${at}  ${e.host}  ${e.count} page${e.count === 1 ? "" : "s"}${span}`;
  };
  await mk(storeDir(home), { recursive: true });
  await add(logPath(home), episodes.map(line).join("\n") + "\n", "utf8");
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

export async function readStore(home = claudeConfigDir(), deps = {}) {
  const read = deps.readFile ?? readFile;
  let parsed = null;
  try { parsed = JSON.parse(await read(storePath(home), "utf8")); } catch { /* absent or corrupt */ }
  const settings = normalise(parsed?.settings);
  const episodes = Array.isArray(parsed?.episodes)
    ? parsed.episodes.map(archivable).filter(e => Number.isFinite(e.startMs))
    : [];
  return { settings, episodes };
}

/**
 * Write the store, atomically.
 *
 * Through a temp file and a rename because the alternative is a truncated JSON
 * document as the only record of what was seen while the browser was being
 * driven — the one file whose loss this feature cannot absorb. installer.mjs
 * makes the same argument about settings.json, for the same reason.
 */
export async function writeStore(state, home = claudeConfigDir(), deps = {}) {
  const mk = deps.mkdir ?? mkdir;
  const write = deps.writeFile ?? writeFile;
  const mv = deps.rename ?? rename;
  await mk(storeDir(home), { recursive: true });
  const body = JSON.stringify({
    v: 1,
    settings: normalise(state.settings),
    episodes: (state.episodes ?? []).map(archivable),
  }, null, 2) + "\n";
  const tmp = `${storePath(home)}.${process.pid}.tmp`;
  await write(tmp, body, "utf8");
  await mv(tmp, storePath(home));
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
