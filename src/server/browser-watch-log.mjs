// watch.log: the one Browser Watch file a person opens themselves.
//
// state.json (browser-watch-store.mjs) is the deck's own record, and JSON
// because the deck reads it back. This is the same episodes in the shape
// `tail -f` and `grep` want — one summary line per episode and every address
// under it — written the way a log is written: appended to, never edited, and
// rolled over whole at a cap (#989). It lives in the store's directory, which
// is why `storeDir` comes from the store rather than from a second spelling of
// the path.
//
// The snapshot appends to it once an episode is archived, and the panel names
// it and its size. Neither asks anything else of this module.
import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
// The rename, with the Windows retry ladder atomic-write.mjs keeps for it — see
// `rollIfFull` below, and #786.
import { renameWithRetry } from "./atomic-write.mjs";
import { storeDir } from "./browser-watch-store.mjs";

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
 * EVERY OTHER STORE IN BROWSER WATCH HAS A CAP. `KEEP` holds the archive to 500
 * episodes and `DISMISS_KEEP` holds dismissals to 2000, both in
 * browser-watch-store.mjs, and the panel's feed is held to 200 lines — while
 * this file, the one that writes out EVERY ADDRESS in full, grew for the life
 * of the install and nothing ever trimmed it. With the watch on by default, a
 * machine where something drives a browser in a loop builds a plaintext list of
 * every address it touched, without end.
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
  await mk(storeDir(home), { recursive: true });
  const text = episodes.map(logBlock).join("\n") + "\n";
  await rollIfFull(home, Buffer.byteLength(text, "utf8"), deps);
  await add(logPath(home), text, "utf8");
}

/**
 * A moment as the log writes it, to the second: `2026-09-28 16:05:09`.
 *
 * Local time, not UTC. The reader's question is "what was happening at four
 * yesterday afternoon", and their afternoon is not UTC's — the ISO stamp this
 * replaced was off by the offset for everyone outside London.
 */
function localStamp(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * One episode as the log writes it, without the newline that ends it.
 *
 * The summary line at column zero — when it started, the host, how many pages,
 * how long it ran once that is a minute or more, and which browser — and then
 * every address under it, indented, each with its time of day. `appendLog`
 * above says why the addresses are written whole and why the indent is the
 * shape `grep` needs.
 *
 * Exported for its test, which can pin the exact text a person reads without
 * going through a file.
 */
export function logBlock(e) {
  const span = e.endMs - e.startMs >= 60_000
    ? ` over ${Math.round((e.endMs - e.startMs) / 60_000)}m`
    : "";
  const where = e.browser ? ` [${e.browser}]` : "";
  const head = `${localStamp(e.startMs)}  ${e.host}  ${e.count} page${e.count === 1 ? "" : "s"}${span}${where}`;
  const rows = (e.urls ?? []).map(u => `    ${localStamp(u.timeMs).slice(11)}  ${u.url}`);
  return [head, ...rows].join("\n");
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
 * `renameWithRetry` for the reason #786 gives over the store's `writeNow`: on
 * Windows a rename loses to anything still holding a handle, and this is a file
 * people open to read.
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
