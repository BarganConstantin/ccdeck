// When two live agents can step on each other in git, told to the page as it
// changes: GitCollisions, one per session, last value wins.
//
//   { hook_event_name: "GitCollisions", session_id,
//     collisions: {
//       quiet: [{ agentId, with: { sessionId, agentId }, reason: "same-worktree" | "same-branch", branch }],
//       sharp: [{ agentId, with: { sessionId, agentId }, files: [path in the repository, …] }],
//     } }
//
// `agentId` is the agent of THIS session the entry is about — null for its
// main thread — and `with` the other agent. QUIET: the two share a working tree
// (the same git top level), or have the same branch of one repository checked
// out in two worktrees. SHARP: both edited the same file through their edit
// tools and git still reports that file changed — committed since, it is not
// sharp any more. Two different worktrees on different branches never collide.
// The rules themselves are agent-git-collisions.mjs's; this module feeds them
// what is true right now and says when the answer changes.
//
// WHO IS LIVE. A session is live until its SessionEnd, or until nothing has
// been heard from it for STALE_SESSION_MS — the board's own rule for a session
// that ended without saying so (board-sweeps.ts), and the only end a Codex
// session has. A subagent runs from its first event until its SubagentStop;
// once stopped, its edits count as its session's (the session asked for that
// work), and a session never collides with its own subagents. A session the
// page has let go of (forgetSession) is not live either.
//
// WHERE AND WHAT. Each agent's repository and branch are read the way
// GitObserved reads them (git-state.mjs, from the agent's own folder); its
// edits are the edit tracker's (agent-git-edits.mjs), placed in that
// repository (git-edits.mjs); "still changed" is the repository's cached
// status, which the agents' own tool calls mark stale — and, for a changed
// file two agents edited, its last commit since the earlier edit: an agent
// that committed the file and moved on does not collide with one that edited
// it afterwards.
//
// WHEN. Never on a timer of its own: a recompute is scheduled by the events
// that can change the answer — a call that can change a repository (the same
// test git-watch.mjs marks the repository stale on), a session or subagent
// starting or ending, an agent seen for the first time — and runs once for a
// burst of them. The one clock is the staleness above: when a session in a
// collision would go quiet past STALE_SESSION_MS, one recompute is set for that
// moment. A change in the answer is sent; the same answer is not sent again.
//
// NEVER LOGGED. This is live state: a restarted deck works it out afresh after
// its boot replay rather than replaying an old one, so every GitCollisions is
// sent with persist: false and only the page and the ring hold it. Like
// GitObserved it is LAST_VALUE_WINS in ring-bounds.mjs — and like it, sent
// again to a page that connects after the ring dropped the event that carried
// it (reannounceCollisions), since an unchanged answer is never sent twice.
import { join } from "node:path";
import { collisionFacts } from "./agent-git-collisions.mjs";
import { agentGit, editsFor } from "./agent-git-tap.mjs";
import { pushEvent } from "./event-sink.mjs";
import { placeInRepo } from "./git-edits.mjs";
import { sessionFolder, sessionSubagents } from "./git-sessions.mjs";
import { readLastCommitTime } from "./git-reads.mjs";
import { repoOf, statusOf } from "./git-state.mjs";
import { changesRepo, gitEnabled } from "./git-watch.mjs";

/** A session nothing has been heard from for this long is over — the page's
 *  STALE_SESSION_MS (src/web/board-sweeps.ts), so a card the board has
 *  settled carries no collision. */
export const STALE_SESSION_MS = 90 * 60_000;
/** How long a burst of events waits before one recompute. */
export const RECOMPUTE_MS = 500;
const MAX_SESSIONS = 2048;
const MAX_AGENTS_PER_SESSION = 512;
/** The most files whose last commit one recompute reads. */
const MAX_COMMIT_READS = 64;
/** A commit time no edit can follow: what a file git reports unchanged is
 *  given, so it is never sharp. */
const NEVER = Number.MAX_SAFE_INTEGER;

/** The events that are a session's own traffic — what says it is alive. */
const TRAFFIC = new Set([
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "SubagentStart", "SubagentStop", "Stop", "Notification",
]);
/** The ones that change who is live. */
const LIFECYCLE = new Set(["SessionStart", "SessionEnd", "SubagentStart", "SubagentStop"]);
const FOLDS_CASE = process.platform === "win32" || process.platform === "darwin";

// sid -> { lastAt, ended, stopped: Set<key>, agents: Set<key> }, least recently heard first
const sessions = new Map();
// sid -> the collisions last sent for it, serialized; absent once they are empty
const sent = new Map();
// sid -> the seq of the event that carried its last answer, empty ones included
const sentSeq = new Map();
let timer = null;
let due = Infinity;
let deadline = null;
let generation = 0;
let running = false;
let again = false;
let enabled = () => gitEnabled();
let now = () => Date.now();

const subagentKeyOf = (p) => [p.agent_id, p.parent_tool_use_id].find((k) => typeof k === "string" && k) ?? null;

/**
 * One event, from pushEvent — live or replayed. Never throws, never waits.
 *
 * @param {any} raw the payload
 * @param {{ replay?: boolean, at?: number, source?: string }} [opts] `at` is
 *   when the event was received; `source` where it came from — only an agent's
 *   own events ("hook", "codex") say anything about who is live.
 */
export function noteCollisionEvent(raw, { replay = false, at = Date.now(), source = "hook" } = {}) {
  try {
    if (!raw || typeof raw !== "object" || (source !== "hook" && source !== "codex")) return;
    const sid = raw.session_id;
    const name = raw.hook_event_name;
    if (typeof sid !== "string" || sid === "" || (!TRAFFIC.has(name) && name !== "SessionEnd")) return;
    let s = sessions.get(sid);
    const fresh = !s;
    if (s) sessions.delete(sid);
    else s = { lastAt: 0, ended: false, stopped: new Set(), agents: new Set() };
    sessions.set(sid, s);
    while (sessions.size > MAX_SESSIONS) forgetCollisionSession(sessions.keys().next().value);
    if (typeof at === "number" && at > s.lastAt) s.lastAt = at;
    // Traffic after a SessionEnd is the session back (a resume).
    s.ended = name === "SessionEnd";
    const key = subagentKeyOf(raw);
    let firstSight = fresh;
    if (key && !s.agents.has(key) && s.agents.size < MAX_AGENTS_PER_SESSION) { s.agents.add(key); firstSight = true; }
    if (key && name === "SubagentStop") s.stopped.add(key);
    if (key && name === "SubagentStart") s.stopped.delete(key);
    if (replay || !enabled()) return;
    if (firstSight || LIFECYCLE.has(name) || changesRepo(raw)) schedule(RECOMPUTE_MS);
  } catch { /* the event path must never fail for this */ }
}

function schedule(delay) {
  const at = now() + delay;
  if (timer !== null && due <= at) return;
  if (timer !== null) clearTimeout(timer);
  due = at;
  timer = setTimeout(() => {
    timer = null;
    due = Infinity;
    void run();
  }, delay);
  timer.unref?.();
}

async function run() {
  if (running) { again = true; return; }
  running = true;
  try {
    await compute();
  } catch { /* the next event tries again */ } finally {
    running = false;
    if (again) { again = false; schedule(RECOMPUTE_MS); }
  }
}

const live = (s, t) => !s.ended && t - s.lastAt <= STALE_SESSION_MS;
const fold = (p) => (FOLDS_CASE ? p.toLowerCase() : p);
const refOf = (a) => ({ sessionId: a.sessionId, agentId: a.agentId });
const byRef = (x, y) => (x.with.sessionId < y.with.sessionId ? -1 : x.with.sessionId > y.with.sessionId ? 1
  : String(x.with.agentId ?? "") < String(y.with.agentId ?? "") ? -1 : String(x.with.agentId ?? "") > String(y.with.agentId ?? "") ? 1
    : String(x.agentId ?? "") < String(y.agentId ?? "") ? -1 : String(x.agentId ?? "") > String(y.agentId ?? "") ? 1 : 0);

/** The repository an agent's folder is in, or null. */
async function repoFor(cwd) {
  const r = await repoOf(cwd);
  return r.state === "repo" ? r : null;
}

/** Work the collisions out from what is true now, and send what changed. */
async function compute() {
  const gen = generation;
  if (!enabled()) return;
  const t = now();
  const agents = [];         // what collisionFacts reads
  const rootTop = new Map(); // sid -> the main thread's top level
  const repos = new Map();   // top level -> the resolved repository
  const placed = new Map();  // edited path (canonical, folded) -> { top, rel }
  const holders = new Map(); // edited path (canonical, folded) -> how many agents

  for (const [sid, s] of sessions) {
    if (!live(s, t)) continue;
    const root = sessionFolder(sid);
    if (!root) continue;
    const rootRepo = await repoFor(root.cwd);
    if (gen !== generation) return;
    if (rootRepo) { rootTop.set(sid, rootRepo.topLevel); repos.set(rootRepo.topLevel, rootRepo); }
    const main = { sessionId: sid, agentId: null, repo: rootRepo, edits: [] };
    const members = [[main, editsFor(sid)]];
    const folders = new Map(sessionSubagents(sid));
    for (const key of agentGit.edits.agentsOf(sid)) if (key && !folders.has(key)) folders.set(key, root.cwd);
    for (const [key, cwd] of folders) {
      const repo = cwd === root.cwd ? rootRepo : await repoFor(cwd);
      if (gen !== generation) return;
      if (repo) repos.set(repo.topLevel, repo);
      const own = editsFor(sid, { agentId: key });
      // A stopped subagent's edits are its session's from now on.
      if (s.stopped.has(key)) members.push([{ foldInto: main, repo }, own]);
      else members.push([{ sessionId: sid, agentId: key, repo, edits: [] }, own]);
    }
    for (const [member, rows] of members) {
      const target = member.foldInto ?? member;
      if (!member.foldInto) agents.push(target);
      if (!member.repo || !rows.length) continue;
      const where = await placeInRepo(member.repo.topLevel, rows.map((r) => r.path));
      if (gen !== generation) return;
      for (const r of rows) {
        const rel = where.get(r.path);
        if (!rel) continue;
        const path = join(member.repo.topLevel, rel);
        target.edits.push({ path, at: r.at });
        placed.set(fold(path), { top: member.repo.topLevel, rel });
      }
    }
  }

  // Each path's holders, counted once per agent, and the earliest edit of it,
  // to know which repositories' status is worth reading at all.
  const earliest = new Map(); // edited path (canonical, folded) -> ms
  for (const a of agents) {
    for (const e of a.edits) {
      const k = fold(e.path);
      if (!(earliest.get(k) <= e.at)) earliest.set(k, e.at);
    }
    for (const k of new Set(a.edits.map((e) => fold(e.path)))) holders.set(k, (holders.get(k) ?? 0) + 1);
  }
  const shared = new Set();
  for (const [k, n] of holders) if (n > 1) shared.add(placed.get(k).top);
  // top -> { files: folded rel -> { path git spelled, untracked }, folders: folded rel prefixes }
  const dirty = new Map();
  for (const top of shared) {
    const status = await statusOf(repos.get(top));
    if (gen !== generation) return;
    if (!status?.ok) continue;
    const files = new Map();
    const folders = [];
    for (const e of status.entries) {
      if (e.directory) folders.push(`${fold(e.path)}/`);
      else if (!files.has(fold(e.path)) || e.area !== "untracked") files.set(fold(e.path), { path: e.path, untracked: e.area === "untracked" });
      if (e.from) files.set(fold(e.from), { path: e.from, untracked: false });
    }
    dirty.set(top, { files, folders });
  }
  /** git's own entry for an edited path that is changed now, or null; an
   *  untracked folder git did not list file by file covers what is in it. */
  const dirtyEntry = (path) => {
    const at = placed.get(fold(path));
    const d = at && dirty.get(at.top);
    if (!d) return null;
    const rel = fold(at.rel);
    return d.files.get(rel) ?? (d.folders.some((f) => rel.startsWith(f)) ? { path: null, untracked: true } : null);
  };
  // "Since it was last committed": a file changed now may still have been
  // committed after one of the two edits — the agent that committed it moved
  // on, and the other's edit came later. Its last commit since the earliest
  // edit is read for each changed file two agents edited.
  const committed = new Map(); // edited path (canonical, folded) -> ms
  let reads = 0;
  for (const [k, n] of holders) {
    if (n < 2 || reads >= MAX_COMMIT_READS) continue;
    const entry = dirtyEntry(k);
    if (!entry || entry.untracked || !entry.path) continue;
    reads++;
    const t = await readLastCommitTime(placed.get(k).top, entry.path, earliest.get(k));
    if (gen !== generation) return;
    if (t !== null) committed.set(k, t);
  }
  // Clean now, or committed after an edit: not sharp. Changed and not
  // committed since the edits began: sharp.
  const lastCommittedAt = (path) => (dirtyEntry(path) ? committed.get(fold(path)) ?? null : NEVER);

  const facts = collisionFacts(agents.map((a) => ({
    sessionId: a.sessionId,
    agentId: a.agentId,
    repo: a.repo ? { top: a.repo.topLevel, commonDir: a.repo.commonDir } : null,
    branch: a.repo?.head?.branch ?? null,
    edits: a.edits,
  })), { lastCommittedAt });

  // A subagent in its session's own folder is covered by the session's mark.
  const inRootFolder = (ref) => ref.agentId !== null
    && agents.some((a) => a.sessionId === ref.sessionId && a.agentId === ref.agentId && a.repo?.topLevel === rootTop.get(ref.sessionId));
  const out = new Map();
  const slot = (sid) => {
    if (!out.has(sid)) out.set(sid, { quiet: [], sharp: [] });
    return out.get(sid);
  };
  for (const q of facts.quiet) {
    if (inRootFolder(q.a) || inRootFolder(q.b)) continue;
    slot(q.a.sessionId).quiet.push({ agentId: q.a.agentId, with: refOf(q.b), reason: q.reason, branch: q.branch ?? null });
    slot(q.b.sessionId).quiet.push({ agentId: q.b.agentId, with: refOf(q.a), reason: q.reason, branch: q.branch ?? null });
  }
  for (const x of facts.sharp) {
    const files = [...new Set(x.files.map((f) => placed.get(fold(f))?.rel).filter(Boolean))].sort();
    if (!files.length) continue;
    slot(x.a.sessionId).sharp.push({ agentId: x.a.agentId, with: refOf(x.b), files });
    slot(x.b.sessionId).sharp.push({ agentId: x.b.agentId, with: refOf(x.a), files });
  }
  for (const c of out.values()) { c.quiet.sort(byRef); c.sharp.sort(byRef); }

  if (gen !== generation || !enabled()) return;
  for (const sid of new Set([...out.keys(), ...sent.keys()])) {
    const c = out.get(sid) ?? null;
    const sig = c ? JSON.stringify(c) : null;
    if (sig === (sent.get(sid) ?? null)) continue;
    send(sid, c);
  }

  // The one moment the answer changes with nothing heard: a session in a
  // collision going quiet for good.
  let first = Infinity;
  for (const sid of out.keys()) first = Math.min(first, (sessions.get(sid)?.lastAt ?? Infinity) + STALE_SESSION_MS + 1000);
  if (deadline) { clearTimeout(deadline); deadline = null; }
  if (Number.isFinite(first)) {
    deadline = setTimeout(() => { deadline = null; void run(); }, Math.max(0, first - now()));
    deadline.unref?.();
  }
}

function send(sid, collisions) {
  const c = collisions ?? { quiet: [], sharp: [] };
  const evt = pushEvent({ hook_event_name: "GitCollisions", session_id: sid, collisions: c }, "internal", { persist: false });
  if (collisions) sent.set(sid, JSON.stringify(collisions));
  else sent.delete(sid);
  sentSeq.set(sid, evt?.seq ?? null);
}

/**
 * Send again the last collisions of every session a connecting page cannot be
 * replayed them for: each whose event is newer than the page's last one
 * (`after`) and has already left the ring (older than `before`, its oldest).
 * Only for the `sessions` the page will draw a card for, and, for a page that
 * has seen nothing yet, only a collision that holds — it has none to clear.
 * Answers how many.
 *
 * @param {{ after: number, before: number, sessions: Set<string> }} range
 */
export function reannounceCollisions({ after, before, sessions }) {
  let n = 0;
  if (!enabled()) return n;
  for (const [sid, seq] of sentSeq) {
    if (!sessions.has(sid) || seq === null || seq <= after || seq >= before) continue;
    const json = sent.get(sid);
    if (!json && after === 0) continue;
    const c = json ? JSON.parse(json) : { quiet: [], sharp: [] };
    const evt = pushEvent({ hook_event_name: "GitCollisions", session_id: sid, collisions: c }, "internal", { persist: false });
    sentSeq.set(sid, evt?.seq ?? null);
    n++;
  }
  return n;
}

/** Work everything out again soon — after the boot replay, and when the git
 *  view is switched back on. */
export function refreshCollisions() {
  if (enabled()) schedule(RECOMPUTE_MS);
}

/** The switch was pressed. Off takes back every mark the page holds and stops;
 *  on works them out again. */
export function collisionsSwitched(on) {
  generation++;
  if (timer) { clearTimeout(timer); timer = null; due = Infinity; }
  if (deadline) { clearTimeout(deadline); deadline = null; }
  if (!on) {
    for (const sid of [...sent.keys()]) send(sid, null);
    return;
  }
  refreshCollisions();
}

/** The page has let go of a session (session-tracking.mjs forgetSession): it
 *  is no longer live, and what it was sent is forgotten with it. The sessions
 *  it collided with are worked out again. */
export function forgetCollisionSession(sid) {
  const had = sessions.delete(sid);
  sent.delete(sid);
  sentSeq.delete(sid);
  if (had && enabled()) schedule(RECOMPUTE_MS);
}

/** Forget everything, for a Clear: the page has nothing left to take back. */
export function clearCollisions() {
  generation++;
  sessions.clear();
  sent.clear();
  sentSeq.clear();
  if (timer) { clearTimeout(timer); timer = null; due = Infinity; }
  if (deadline) { clearTimeout(deadline); deadline = null; }
}

/** Whether recomputes happen at all, and the clock staleness reads — both
 *  replaced by the tests. */
export function setCollisionsEnabled(fn) {
  enabled = typeof fn === "function" ? fn : () => gitEnabled();
}
export function setCollisionClock(fn) {
  now = typeof fn === "function" ? fn : () => Date.now();
}

/** Resolves once no recompute is waiting or running — for the tests. */
export async function collisionsSettled() {
  for (let i = 0; i < 400 && (timer !== null || running); i++) await new Promise((r) => setTimeout(r, 25));
}
