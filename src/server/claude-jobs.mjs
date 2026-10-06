// Claude Code's own account of a background session, read from the file its
// agent view draws from.
//
// WHAT IT IS. A session started with `claude --bg`, or dispatched from
// `claude agents`, is a background job, and Claude Code keeps one folder per job
// at `<config dir>/jobs/<short id>/`. Its `state.json` is what the agent view
// prints: `state` (working, blocked, done, failed, stopped), a one-line `detail`,
// the question it is stuck on (`needs`), the reply Claude Code would suggest
// (`suggestedReply`) and the headline of a finished job (`output.result`).
//
// Those lines are written by Claude Code's classifier: a pattern match on the
// session's last words ("result:", "needs input:", "failed:"), and a small model
// when the pattern finds nothing — at every turn end, and inside a long turn
// once a minute or so. Read off the 2.1.289 bundle and this machine's job
// folders on 2026-10-05.
//
// WHY THE DECK READS IT. That classifier has already been paid for, by Claude
// Code, and it answers the question the deck's waiting queue cannot: not that a
// session stopped, but what it is asking and what it got done. For a background
// session the deck would otherwise show nothing at all between hooks.
//
// WHY EVERY FIELD IS CHECKED. Claude Code's documentation says in as many words
// that these files "are not a stable interface" (code.claude.com/docs/en/
// agent-view), and `claude agents --json`, the supported reader, carries the
// state but none of the words. So the shape is treated as untrusted: an unknown
// state is no job, a field of the wrong type is absent, a file that stops
// parsing is a session with no line. Nothing here may throw, and nothing here
// can make the deck worse than it was before it read the file.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";

/** The states the agent view groups by. `stopped` is a job somebody ended,
 *  or one the supervisor found dead; it says nothing worth a line. */
const JOB_STATES = new Set(["working", "blocked", "done", "failed", "stopped"]);

/** Claude Code caps its own `detail` at 800 characters. A line on a card is
 *  far shorter than that, but cutting is the renderer's job; this only bounds
 *  what a malformed file could put on the wire. */
const JOB_TEXT_MAX_CHARS = 800;
const REPLY_MAX_CHARS = 200;

/** How many job folders one pass will look at. The folders are removed when a
 *  job is deleted, so this is tens on a working machine; the bound is for the
 *  one that never deletes anything. */
const MAX_JOB_DIRS = 500;

function text(raw, max) {
  if (typeof raw !== "string") return "";
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/**
 * One `state.json`, as the deck can use it, or null.
 *
 * `updatedAt` is the file's own clock: the client compares it against the
 * session's recap to show whichever is newer, and the deck may be reading a
 * file written while it was down. A job with no session id cannot be matched to
 * anything the deck draws, so it is not a job here.
 */
export function jobStatusOf(raw, jobId) {
  if (!raw || typeof raw !== "object") return null;
  const state = raw.state;
  if (!JOB_STATES.has(state)) return null;
  const sessionId = typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null;
  if (!sessionId) return null;
  const updatedAt = typeof raw.updatedAt === "string" ? Date.parse(raw.updatedAt) : NaN;
  const out = {
    id: typeof jobId === "string" ? jobId : "",
    state,
    detail: text(raw.detail, JOB_TEXT_MAX_CHARS),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
  const needs = text(raw.needs, JOB_TEXT_MAX_CHARS);
  if (needs && state === "blocked") out.needs = needs;
  const reply = text(raw.suggestedReply, REPLY_MAX_CHARS);
  if (reply && state === "blocked") out.suggestedReply = reply;
  const result = text(raw.output?.result, JOB_TEXT_MAX_CHARS);
  if (result) out.result = result;
  return { sessionId, resumeSessionId: typeof raw.resumeSessionId === "string" ? raw.resumeSessionId : null, job: out };
}

/**
 * The watch over `<config dir>/jobs`.
 *
 * Shaped like the output watch: `io` is injectable so the suite can drive a
 * folder that grows, changes and loses files without arranging any of it for
 * real. A file is re-read only when its size or mtime moved, so a quiet machine
 * costs one `readdir` and one `stat` per job per pass.
 */
export function createJobWatch(io = {}) {
  const jobsDir = io.dir ?? (() => join(claudeConfigDir(), "jobs"));
  const listDir = io.readdir ?? (p => readdir(p, { withFileTypes: true }));
  const statFile = io.stat ?? (p => stat(p));
  const readText = io.readFile ?? (p => readFile(p, "utf8"));
  /** jobId -> { size, mtimeMs, parsed } — the last read of each file. */
  const files = new Map();
  let polling = false;

  /**
   * One pass. Answers `Map<sessionId, job>` for every job folder that holds a
   * readable state, or null when a pass is already running — an overlapping
   * caller has nothing new to say, and answering with the same map would only
   * re-run the caller's change gate for nothing.
   *
   * Two folders naming one session is a job that was resumed or re-dispatched;
   * the one written most recently is the one the agent view is showing.
   */
  async function poll() {
    if (polling) return null;
    polling = true;
    try {
      const out = new Map();
      let entries;
      try { entries = await listDir(jobsDir()); } catch { files.clear(); return out; }
      const seen = new Set();
      for (const e of entries.slice(0, MAX_JOB_DIRS)) {
        if (!e?.isDirectory?.()) continue;
        const id = e.name;
        seen.add(id);
        const path = join(jobsDir(), id, "state.json");
        let st;
        try { st = await statFile(path); } catch { files.delete(id); continue; }
        const size = Number(st?.size ?? 0);
        const mtimeMs = Number(st?.mtimeMs ?? 0);
        let entry = files.get(id);
        if (!entry || entry.size !== size || entry.mtimeMs !== mtimeMs) {
          let parsed = null;
          // A file caught mid-write fails the parse; the next pass reads it whole.
          try { parsed = jobStatusOf(JSON.parse(await readText(path)), id); } catch { parsed = null; }
          entry = { size, mtimeMs, parsed };
          files.set(id, entry);
        }
        const p = entry.parsed;
        if (!p) continue;
        for (const sid of new Set([p.sessionId, p.resumeSessionId].filter(Boolean))) {
          const prev = out.get(sid);
          if (!prev || p.job.updatedAt >= prev.updatedAt) out.set(sid, p.job);
        }
      }
      for (const id of files.keys()) if (!seen.has(id)) files.delete(id);
      return out;
    } finally {
      polling = false;
    }
  }

  function clear() { files.clear(); }

  return { poll, clear };
}
