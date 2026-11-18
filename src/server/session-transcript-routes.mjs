// GET /api/session/transcript?session=<id>&provider=<claude|codex>.
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
import { constants } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { lstat as fsLstat, open as fsOpen, realpath as fsRealpath } from "node:fs/promises";
import { send } from "./http-io.mjs";
import { claudeTranscriptRoots, isClaudeTranscriptPath } from "./transcript-gate.mjs";
import { outputWatch } from "./session-tracking.mjs";
import { codexTranscriptWindow, transcriptWindow } from "./transcript-turns.mjs";
import { rolloutNameId } from "./codex-dir.mjs";
import { codexProfileSessionDirs } from "./codex-profiles.mjs";
import { codexTranscriptPath } from "./codex-watch.mjs";

export const SESSION_TRANSCRIPT_ROUTE = "/api/session/transcript";

/** The most bytes read from the end of a transcript. */
export const READ_WINDOW = 512 * 1024;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const loopback = req => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

function transcriptQuery(params) {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => key !== "session" && key !== "provider" && key !== "continuation")) return null;
  const session = params.get("session");
  const provider = params.get("provider") ?? "claude";
  if (!SESSION_ID.test(session ?? "") || (provider !== "claude" && provider !== "codex")) return null;
  const continuation = params.has("continuation");
  if (continuation && (params.get("continuation") !== "1" || provider !== "claude" || !UUID.test(session))) return null;
  return { session, provider, continuation };
}

function isCodexTranscriptPath(path, roots, session) {
  if (rolloutNameId(basename(path)) !== session) return false;
  return roots.some(root => /^\d{4}\/\d{2}\/\d{2}\/[^/]+$/.test(relative(root, path).split(sep).join("/")));
}

const unknown = res => send(res, 404, { ok: false, reason: "unknown_session" });

/**
 * The tail of the file at `path` as lines, or null for a file this route will not read.
 * `lstat` first (a symlink is refused), then opened read-only and non-blocking, and the
 * handle's own `fstat` must be the same regular file `lstat` saw, so a swap in between
 * is refused too.
 */
async function readTail(path, io) {
  const before = await io.lstat(path, { bigint: true });
  if (!before.isFile()) return null;
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
    const from = Math.max(0, size - READ_WINDOW);
    const want = size - from;
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await handle.read(buf, got, want - got, from + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    let text = buf.toString("utf8", 0, got);
    const complete = from === 0;
    if (!complete) {
      const nl = text.indexOf("\n");
      text = nl < 0 ? "" : text.slice(nl + 1);
    }
    return { complete, lines: text.split("\n") };
  } finally {
    await handle.close();
  }
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
  if (!query) return send(res, 400, { ok: false, reason: "bad_session" });
  const { session, provider, continuation } = query;
  const codex = provider === "codex";
  const pathOf = io.pathOf ?? (codex ? codexTranscriptPath : sid => outputWatch.pathOf(sid));
  const allowed = codex ? (path, roots) => isCodexTranscriptPath(path, roots, session) : isClaudeTranscriptPath;
  const realpath = io.realpath ?? fsRealpath;
  let tail;
  let next = null;
  try {
    const path = pathOf(session);
    if (typeof path !== "string") return unknown(res);
    const roots = await (io.roots ?? (codex ? codexProfileSessionDirs : claudeTranscriptRoots))();
    if (!(io.isTranscriptPath ?? allowed)(path, roots)) return unknown(res);
    tail = await readTail(path, {
      lstat: io.lstat ?? fsLstat, open: io.open ?? fsOpen,
      realpath, roots, allowed,
    });
    if (continuation && tail && basename(path) === `${session}.jsonl`) {
      const candidate = continuedSession(tail.lines, session);
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
  if (!tail) return unknown(res);
  if (continuation) return send(res, 200, { ok: true, sessionId: next });
  const { turns, cut } = (codex ? codexTranscriptWindow : transcriptWindow)(tail.lines);
  // Not complete when the byte window began after the file's start, or when the
  // turn cap dropped turns from the front.
  return send(res, 200, { ok: true, complete: tail.complete && !cut, turns });
}
