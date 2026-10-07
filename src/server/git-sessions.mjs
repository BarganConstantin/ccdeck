// Which folder each session runs in, as the deck has heard it — the only way a
// git read finds its repository. The routes take a session id and look the
// folder up here; a path from a request never reaches git.
//
// Fed by pushEvent with every event, the boot replay included, so a session
// that ended before this process started still opens on its folder. The rule
// is the card's own (adoptCwd in src/web/agent-attribution.ts): the first
// folder a session's root names is the one it keeps, and a subagent's first
// folder is its own. A subagent is keyed the way the card keys it, by
// `agent_id` and else `parent_tool_use_id`.
//
// A Claude session's transcript path is kept beside its folder — only one the
// transcript gate accepts, since a hook payload is not trusted to name a file —
// for the one question the repository cannot answer once its folder is gone.
//
// WHERE IT WORKS NOW. The folder a session started in is often not the one it
// works in: several agents started in one checkout each move to a worktree of
// their own, with a `cd` in every command or by entering the worktree. What it
// does says where — git-watch.mjs follows it (followFolder) — and from then on
// its git reads go to that worktree. A subagent started in its session's
// folder works where the session works until its own calls say otherwise.
import { isClaudeTranscriptPath } from "./transcript-gate.mjs";

/** The most sessions remembered; the least recently heard go first. Eight
 *  times the server's session cap, which is forty times the page's. */
export const MAX_GIT_SESSIONS = 2048;

const sessions = new Map(); // sid -> { cwd, work, heard, moved, provisional, provider, transcript, subagents: Map<key, { cwd, work, heard, moved }> }

const subagentKey = (p) => [p.agent_id, p.parent_tool_use_id].find((k) => typeof k === "string" && k) ?? null;

/** Note the folder an event names, if it names one. Never throws. */
export function noteSessionFolder(raw) {
  if (!raw || typeof raw !== "object") return;
  const sid = raw.session_id;
  const cwd = raw.cwd;
  if (typeof sid !== "string" || sid === "" || typeof cwd !== "string" || cwd === "") return;
  let s = sessions.get(sid);
  if (s) sessions.delete(sid);
  else s = { cwd: null, work: null, heard: null, moved: null, provisional: true, provider: "claude", transcript: null, subagents: new Map() };
  sessions.set(sid, s);
  if (raw.provider === "codex") s.provider = "codex";
  if (!s.transcript && isClaudeTranscriptPath(raw.transcript_path)) s.transcript = raw.transcript_path;
  const key = subagentKey(raw);
  if (key) {
    if (!s.subagents.has(key)) s.subagents.set(key, { cwd, work: null, heard: null, moved: null });
    // A session first heard through a subagent still needs a folder; the
    // root's own first event replaces it.
    if (!s.cwd) { s.cwd = cwd; s.provisional = true; }
  } else if (!s.cwd || s.provisional) {
    s.cwd = cwd;
    s.provisional = false;
  }
  while (sessions.size > MAX_GIT_SESSIONS) sessions.delete(sessions.keys().next().value);
}

/** Where a subagent works: the worktree its calls led it to, else its own
 *  first folder — or, started in its session's folder, wherever the session
 *  works now. */
const subagentFolder = (s, sub) => sub.work ?? (sub.cwd === s.cwd ? s.work ?? s.cwd : sub.cwd);

/**
 * The folder `sid` works in — the subagent's own when `agent` names one the
 * deck has heard with a folder, else the root's; the worktree its calls led it
 * to when they led it away from where it started — or null for a session this
 * deck has no folder for. `{ cwd, start, provider, agent }`: `start` is the
 * folder it would read with nothing followed, `agent` the key whose folder was
 * used or null for the root's.
 */
export function sessionFolder(sid, agent = null) {
  const s = typeof sid === "string" ? sessions.get(sid) : undefined;
  if (!s || !s.cwd) return null;
  const own = typeof agent === "string" && agent ? s.subagents.get(agent) : undefined;
  if (!own) return { cwd: s.work ?? s.cwd, start: s.cwd, provider: s.provider, agent: null };
  return { cwd: subagentFolder(s, own), start: subagentFolder(s, { ...own, work: null }), provider: s.provider, agent };
}

/**
 * Point the git reads of `sid` — of its subagent `key`, when one is named —
 * at `folder`, the worktree its calls show it working in; null puts them back
 * on the folder it started in. Answers whether anything changed. A session or
 * subagent the deck has not heard with a folder is left alone.
 */
export function followFolder(sid, key, folder) {
  const s = typeof sid === "string" ? sessions.get(sid) : undefined;
  if (!s || !s.cwd) return false;
  const target = typeof key === "string" && key ? s.subagents.get(key) : s;
  if (!target) return false;
  const next = typeof folder === "string" && folder ? folder : null;
  if (target.work === next) return false;
  target.work = next;
  return true;
}

/**
 * The folder a LIVE event of `sid` — of its subagent `key`, when one is named
 * — says it is in; never a replayed one. A folder that differs from the last
 * one heard is kept as where it moved until takeMove asks, so a move heard
 * while the git reads were switched off, or after the page let the session
 * go, is still followed once they look again.
 */
export function noteLiveFolder(sid, key, cwd) {
  const s = typeof sid === "string" ? sessions.get(sid) : undefined;
  const target = s && (typeof key === "string" && key ? s.subagents.get(key) : s);
  if (!target || typeof cwd !== "string" || !cwd) return;
  if (target.heard !== null && target.heard !== cwd) target.moved = cwd;
  target.heard = cwd;
}

/** The folder `sid` (its subagent `key`) moved to since this was last asked,
 *  or null; asking takes it. */
export function takeMove(sid, key) {
  const s = typeof sid === "string" ? sessions.get(sid) : undefined;
  const target = s && (typeof key === "string" && key ? s.subagents.get(key) : s);
  if (!target) return null;
  const moved = target.moved;
  target.moved = null;
  return moved;
}

/** The transcript the deck heard `sid` write to, or null. */
export function sessionTranscript(sid) {
  return (typeof sid === "string" && sessions.get(sid)?.transcript) || null;
}

/** The subagents `sid` has been heard with, as [key, folder] pairs, each
 *  folder where that subagent works now. */
export function sessionSubagents(sid) {
  const s = typeof sid === "string" ? sessions.get(sid) : undefined;
  return s ? [...s.subagents.entries()].map(([key, sub]) => [key, subagentFolder(s, sub)]) : [];
}

/** The `limit` sessions heard from most recently, newest first. */
export function recentSessions(limit) {
  const out = [];
  for (const [sid, s] of [...sessions.entries()].reverse()) {
    if (out.length >= limit) break;
    if (s.cwd) out.push(sid);
  }
  return out;
}

/** Forget every session, for a Clear. */
export function clearSessionFolders() {
  sessions.clear();
}
