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

/** The most sessions remembered; the least recently heard go first. Eight
 *  times the server's session cap, which is forty times the page's. */
export const MAX_GIT_SESSIONS = 2048;

const sessions = new Map(); // sid -> { cwd, provisional, provider, subagents: Map<key, cwd> }

const subagentKey = (p) => [p.agent_id, p.parent_tool_use_id].find((k) => typeof k === "string" && k) ?? null;

/** Note the folder an event names, if it names one. Never throws. */
export function noteSessionFolder(raw) {
  if (!raw || typeof raw !== "object") return;
  const sid = raw.session_id;
  const cwd = raw.cwd;
  if (typeof sid !== "string" || sid === "" || typeof cwd !== "string" || cwd === "") return;
  let s = sessions.get(sid);
  if (s) sessions.delete(sid);
  else s = { cwd: null, provisional: true, provider: "claude", subagents: new Map() };
  sessions.set(sid, s);
  if (raw.provider === "codex") s.provider = "codex";
  const key = subagentKey(raw);
  if (key) {
    if (!s.subagents.has(key)) s.subagents.set(key, cwd);
    // A session first heard through a subagent still needs a folder; the
    // root's own first event replaces it.
    if (!s.cwd) { s.cwd = cwd; s.provisional = true; }
  } else if (!s.cwd || s.provisional) {
    s.cwd = cwd;
    s.provisional = false;
  }
  while (sessions.size > MAX_GIT_SESSIONS) sessions.delete(sessions.keys().next().value);
}

/**
 * The folder `sid` runs in — the subagent's own when `agent` names one the
 * deck has heard with a folder, else the root's — or null for a session this
 * deck has no folder for. `{ cwd, provider, agent }`, where `agent` is the key
 * whose folder was used or null for the root's.
 */
export function sessionFolder(sid, agent = null) {
  const s = typeof sid === "string" ? sessions.get(sid) : undefined;
  if (!s || !s.cwd) return null;
  const own = typeof agent === "string" && agent ? s.subagents.get(agent) : undefined;
  return { cwd: own ?? s.cwd, provider: s.provider, agent: own ? agent : null };
}

/** The subagents `sid` has been heard with, as [key, folder] pairs. */
export function sessionSubagents(sid) {
  const s = typeof sid === "string" ? sessions.get(sid) : undefined;
  return s ? [...s.subagents.entries()] : [];
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
