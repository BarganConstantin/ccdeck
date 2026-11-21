// GET /api/session/transcript?session=<id>&provider=<claude|codex>
//   [&since=<version>] or [&before=<cursor>[&after=<cursor>]].
// Chat reads one transcript already tracked by the Claude output watch or
// the Codex rollout watcher. Requests without provider use Claude.
//
// THE ID IS A KEY AND NOTHING ELSE. It is checked against a short alphabet
// before anything is looked up, and then only asks the watch's map for a path;
// no path is built from it and none is taken from the request. Anything the
// route will not read gets the same answer, so the route never tells which
// files exist. What is refused: an id the deck does not know; a stored path
// that no longer passes the transcript gate; a file that is itself a symlink;
// a path that reaches its file through a symlinked folder, or through a `..`
// after one (the file's real path must stay under the real path of a
// transcript root); a folder, a pipe or any file that is not a regular file; a
// file swapped for another between the stat and the open.
//
// WHAT IS NOT: a hard link. A second name for the same file is the same file
// to the system, and nothing here can tell it from the original. Making one
// needs write access to the projects folder, which is the same user who holds
// the deck's token (transcript-gate.mjs), so this route does not claim to
// refuse it.
//
// THE SAME GATES AS THE OTHER ROUTES THAT SHOW SESSION CONTENT: the path is in
// GUARDED_READS (request-gates.mjs), so the router's Host and same-origin or
// token check has run; and on top of it a request that did not come from this
// computer is refused here, as Settings › Claude Code's are, so a paired deck
// never reads a conversation through this server.
//
// BOUNDED. The last READ_WINDOW bytes are read, never more, however large the
// file. Cut at the front, the partial first line is dropped and the answer says
// `complete: false`. A line longer than the window gives no turn; the read is
// never grown to fit it.
//
// LIVE WITHOUT A WATCHER. Each answer carries `version`, a token for the file
// as it stands (which file, how long, when written), opaque to the page. A page
// that sends it back as `since` is told `unchanged: true` after one lstat when
// the file has not moved: nothing is opened, read or parsed, so asking often
// costs one stat.
//
// PAGED BACK ON REQUEST. When a window did not reach the file's start it
// carries `older`, a cursor for the byte its first kept line starts at.
// `before=<cursor>` answers the window that ends there, with an `older` of its
// own until the start; `after=<cursor>` with it stops that window at a line the
// page already holds, which is how a page keeping older turns fills the stretch
// the live window slid past. Pages never split a line, and the turn cap falls
// on whole lines. A cursor is held to the file as it is now: an offset inside
// it, at the start of a line, of the same file (device and inode). Anything
// else is a 400 with a short reason, never a path.
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, relative, sep } from "node:path";
import { lstat as fsLstat, open as fsOpen, realpath as fsRealpath } from "node:fs/promises";
import { send } from "./http-io.mjs";
import { claudeTranscriptRoots, isClaudeTranscriptPath } from "./transcript-gate.mjs";
import { outputWatch } from "./session-tracking.mjs";
import { codexTranscriptWindow, MAX_TURNS, transcriptWindow } from "./transcript-turns.mjs";
import { rolloutNameId } from "./codex-dir.mjs";
import { codexProfileSessionDirs } from "./codex-profiles.mjs";
import { codexTranscriptPath } from "./codex-watch.mjs";

export const SESSION_TRANSCRIPT_ROUTE = "/api/session/transcript";

/** The most bytes read from the end of a transcript. */
export const READ_WINDOW = 512 * 1024;

/** How far past an older window's end is read for the answers to its last
 *  calls: a call at its end is answered in the line after, which is the next
 *  window's. Only lines that bring no turn of their own are taken. */
export const LOOKAHEAD = 64 * 1024;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TOKEN = "[A-Za-z0-9_-]{22}";
const VERSION = new RegExp(`^${TOKEN}$`);
const CURSOR = new RegExp(`^([1-9][0-9]{0,15})\\.(${TOKEN})$`);
const KEYS = new Set(["session", "provider", "continuation", "since", "before", "after"]);

const loopback = req => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

const digest = text => createHash("sha256").update(text).digest("base64url").slice(0, 22);
/** Which file this is: the same until it is replaced. Hashed, so the page never sees an inode. */
const fileTag = stat => digest(`file:${stat.dev}:${stat.ino}`);
/** The file as it stands: moves whenever it grows or is written again. */
const versionOf = stat => digest(`version:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`);
const cursorText = (at, tag) => `${at}.${tag}`;

/** A cursor's offset and file tag, or null for one of the wrong shape. */
function cursorOf(text) {
  const found = CURSOR.exec(text ?? "");
  if (!found) return null;
  const at = Number(found[1]);
  return Number.isSafeInteger(at) ? { at, tag: found[2] } : null;
}

const BAD_SESSION = { reason: "bad_session" };

/** The request's parts, or `{ reason }` for one refused before anything is looked up. */
function transcriptQuery(params) {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !KEYS.has(key))) return BAD_SESSION;
  const session = params.get("session");
  const provider = params.get("provider") ?? "claude";
  if (!SESSION_ID.test(session ?? "") || (provider !== "claude" && provider !== "codex")) return BAD_SESSION;
  const continuation = params.has("continuation");
  if (continuation && (params.get("continuation") !== "1" || provider !== "claude" || !UUID.test(session))) return BAD_SESSION;
  const since = params.get("since");
  if (since !== null && (continuation || !VERSION.test(since))) return { reason: "bad_since" };
  if (!params.has("before") && !params.has("after")) return { session, provider, continuation, since, end: null, floor: null };
  // An older window: `before` where it ends, `after` (optional) a line it stops at, both of one file.
  const end = cursorOf(params.get("before"));
  const floor = params.has("after") ? cursorOf(params.get("after")) : null;
  if (!end || continuation || since !== null || (params.has("after") && (!floor || floor.tag !== end.tag || floor.at >= end.at))) {
    return { reason: "bad_cursor" };
  }
  return { session, provider, continuation, since, end, floor };
}

function isCodexTranscriptPath(path, roots, session) {
  if (rolloutNameId(basename(path)) !== session) return false;
  return roots.some(root => /^\d{4}\/\d{2}\/\d{2}\/[^/]+$/.test(relative(root, path).split(sep).join("/")));
}

const unknown = res => send(res, 404, { ok: false, reason: "unknown_session" });

/** The bytes [from, to) of an open file; fewer when it shrank under the read. */
async function readRange(handle, from, to) {
  const want = Math.max(0, to - from);
  const buf = Buffer.alloc(want);
  let got = 0;
  while (got < want) {
    const { bytesRead } = await handle.read(buf, got, want - got, from + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/** Whether byte `at` starts a line: the file's start, or just after a newline. */
async function startsLine(handle, at) {
  if (at === 0) return true;
  const byte = await readRange(handle, at - 1, at);
  return byte.length === 1 && byte[0] === 0x0a;
}

/**
 * The lines of `buf`, read from byte `from`, with the byte each starts at. With
 * `cut`, the partial first line is dropped. The last entry is what follows the
 * last newline: "" or a line still being written. Split on the newline byte, so
 * an offset is exact whatever the text holds.
 */
function splitLines(buf, from, cut) {
  const lines = [];
  const at = [];
  let start = 0;
  if (cut) {
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return { lines, at };
    start = nl + 1;
  }
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    lines.push(buf.toString("utf8", start, nl < 0 ? buf.length : nl));
    at.push(from + start);
    if (nl < 0) return { lines, at };
    start = nl + 1;
  }
}

const STALE = { stale: true };

/**
 * One window of the file at `path`, or null for a file this route will not read.
 * `lstat` first (a symlink is refused), then opened read-only and non-blocking, and the
 * handle's own `fstat` must be the same regular file `lstat` saw, so a swap in between
 * is refused too. `{ unchanged }` when the file still has the version the page holds;
 * `{ stale }` for a cursor that does not fit the file as it is now.
 */
async function readWindow(path, io, want) {
  const before = await io.lstat(path, { bigint: true });
  if (!before.isFile()) return null;
  // The page holds this file as it stands: one stat answers it. Nothing new is
  // said, so this runs ahead of the real-path check the read itself needs.
  if (want.since && versionOf(before) === want.since) return { unchanged: true };
  // Where the file really is, after every link on the way, must still be in a
  // transcript root (themselves resolved: ~/.claude is often a link).
  const real = await io.realpath(path);
  const roots = [];
  for (const root of io.roots) {
    try { roots.push(await io.realpath(root)); } catch { /* a root that does not exist holds nothing */ }
  }
  if (!io.allowed(real, roots)) return null;
  const handle = await io.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) return null;
    const size = Number(after.size);
    const tag = fileTag(after);
    // The live window ends at the file's end; an older one where its cursor
    // says, and stops at its `after` line or at the start.
    let end = size;
    let floor = 0;
    if (want.end) {
      if (want.end.tag !== tag || want.end.at > size || !(await startsLine(handle, want.end.at))) return STALE;
      if (want.floor && !(await startsLine(handle, want.floor.at))) return STALE;
      end = want.end.at;
      floor = want.floor?.at ?? 0;
    }
    const from = Math.max(floor, end - READ_WINDOW);
    const cut = from > floor;
    const { lines, at } = splitLines(await readRange(handle, from, end), from, cut);
    // Whole lines after an older window, for the answers to its last calls.
    const ahead = want.end && end < size
      ? splitLines(await readRange(handle, end, Math.min(size, end + LOOKAHEAD)), end, false).lines.slice(0, -1)
      : [];
    return { lines, at, ahead, cut, floor, end, tag, version: versionOf(after) };
  } finally {
    await handle.close();
  }
}

/**
 * The turns of the last whole lines that fit under the turn cap, and the index of
 * the first line kept. Each line's own turns are counted to find where the cap
 * falls, so a line is never split between two pages. `ahead` are lines after the
 * window that bring no turn of their own (a tool's answer, a command's output):
 * read with it, so a call at its end has its answer.
 */
export function pageOf(lines, windowOf, ahead = []) {
  const whole = windowOf(ahead.length ? [...lines, ...ahead] : lines);
  if (!whole.cut) return { turns: whole.turns, start: 0, cut: false };
  let count = 0;
  let start = lines.length;
  while (start > 0) {
    const own = windowOf([lines[start - 1]]).turns.length;
    // The newest line with a turn is kept even when it alone is over the cap.
    if (count > 0 && count + own > MAX_TURNS) break;
    count += own;
    start -= 1;
  }
  const kept = windowOf([...lines.slice(start), ...ahead]);
  return { turns: kept.turns, start, cut: start > 0 || kept.cut };
}

/** Nothing in an older window still runs: a call with no answer in it was answered later. */
function settled(turn) {
  if (!turn.running) return turn;
  const { running: _, ...rest } = turn;
  return rest;
}

/** Claude writes this event in the original transcript when /background changes its UUID. */
function continuedSession(lines, source) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let event;
    try { event = JSON.parse(lines[i]); } catch { continue; }
    if (event?.type !== "continued-in" || event.sessionId !== source) continue;
    const next = event.continuedInSessionId;
    return typeof next === "string" && UUID.test(next) && next.toLowerCase() !== source.toLowerCase() ? next : null;
  }
  return null;
}

export async function handleSessionTranscript(req, res, io = {}) {
  if (!loopback(req)) return send(res, 403, { ok: false, error: "A conversation can be read on this computer only." });
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "Use GET." });
  const query = transcriptQuery(new URL(req.url, "http://localhost").searchParams);
  if (query.reason) return send(res, 400, { ok: false, reason: query.reason });
  const { session, provider, continuation } = query;
  const codex = provider === "codex";
  const pathOf = io.pathOf ?? (codex ? codexTranscriptPath : sid => outputWatch.pathOf(sid));
  const allowed = codex ? (path, roots) => isCodexTranscriptPath(path, roots, session) : isClaudeTranscriptPath;
  const realpath = io.realpath ?? fsRealpath;
  let read;
  let next = null;
  try {
    const path = pathOf(session);
    if (typeof path !== "string") return unknown(res);
    const roots = await (io.roots ?? (codex ? codexProfileSessionDirs : claudeTranscriptRoots))();
    if (!(io.isTranscriptPath ?? allowed)(path, roots)) return unknown(res);
    read = await readWindow(path, {
      lstat: io.lstat ?? fsLstat, open: io.open ?? fsOpen,
      realpath, roots, allowed,
    }, query);
    if (continuation && read?.lines && basename(path) === `${session}.jsonl`) {
      const candidate = continuedSession(read.lines, session);
      const destination = candidate && pathOf(candidate);
      // An idle background worker may be attachable before writing a transcript.
      // The pane verifies the backend's live target and the session's project.
      if (candidate && typeof destination !== "string") next = candidate;
      if (typeof destination === "string" && basename(destination) === `${candidate}.jsonl` && allowed(destination, roots)) {
        const dest = await realpath(destination);
        const src = await realpath(path);
        // Same resolved project within the same profile. No scan of other sessions.
        if (dirname(dest) === dirname(src) && basename(dest) === `${candidate}.jsonl`) next = candidate;
      }
    }
  } catch { return unknown(res); }
  if (!read) return unknown(res);
  if (read.unchanged) return send(res, 200, { ok: true, unchanged: true });
  if (read.stale) return send(res, 400, { ok: false, reason: "stale_cursor" });
  if (continuation) return send(res, 200, { ok: true, sessionId: next });
  const windowOf = codex ? codexTranscriptWindow : transcriptWindow;
  const ahead = [];
  for (const line of read.ahead) {
    if (windowOf([line]).turns.length) break;
    ahead.push(line);
  }
  const page = pageOf(read.lines, windowOf, ahead);
  // Where the kept lines start: a cursor for what comes before them, when that
  // is past the window's floor. One that would not move back is not given, so a
  // line longer than the window ends the paging rather than repeating it.
  const startAt = page.start < read.at.length ? read.at[page.start] : read.end;
  const older = startAt > read.floor && startAt < read.end ? cursorText(startAt, read.tag) : null;
  const turns = query.end ? page.turns.map(settled) : page.turns;
  // Not complete when the byte window began after its floor, or when the turn
  // cap dropped lines from the front.
  return send(res, 200, { ok: true, complete: !read.cut && !page.cut, turns, version: read.version, ...(older ? { older } : {}) });
}
