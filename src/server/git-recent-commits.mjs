// The commits each session's agents made in the last half hour, told to the
// page for the lane drawn under its card: GitRecentCommits, one per session,
// last value wins.
//
//   { hook_event_name: "GitRecentCommits", session_id, repo,
//     commits: [{ sha, short, subject, at, agentId, label, branch, repo }, …] }
//
// Newest first, at most RECENT_COMMITS_MAX. Only commits the deck saw an agent
// make: the lines of the commit store (agent-git-store.mjs), which the
// recorder writes from what a `git commit` printed and the repository
// confirmed — `sha` is the full SHA when it confirmed it, else the one git
// printed. `at` is when the deck saw it, `agentId` the subagent (null for the
// session's main thread) and `label` what the store calls it — a subagent's
// type — for a page whose card for it has left the board. `branch` is the
// branch it went to (null on a detached HEAD), and its `repo` the repository
// it is in (the common git directory). The lane's own `repo` is the
// repository the session works in now — what its git view reads, and what the
// page reads the branch colours by and keeps the main card's rows to, since a
// commit in a repository the session has left would open the view on a commit
// that is not there — else, with no repository to read, the newest commit's.
//
// ONLY WHAT IS STILL THERE. A commit no branch, tag, remote-tracking branch
// or HEAD reaches any more — what an amend, a rebase or a reset left behind,
// whoever made it, the deck watching or not — leaves the lane. Git is asked
// once per worktree the commits were made in, each time a lane is worked out.
// When git cannot say (the worktree is gone, the read failed), an amend the
// deck saw takes the place of the newest commit before it on the same branch.
//
// WHEN. Never on a timer of its own for the window: the page ages each commit
// out on its own clock, and the lane goes with the last one. A list is worked
// out again when the deck records a commit for the session — with every lane
// holding a commit in that repository, which the new commit may have rewritten
// (the tap tells this module, agent-git-tap.mjs `onCommit`); when the session is followed into
// another folder (git-watch.mjs onFollow); when a look at a worktree finds its
// HEAD on another commit than the last list worked out against it had — a
// reset, a rebase, an amend made in a terminal print no commit for the tap to
// record — with every lane holding a commit in that repository (git-watch.mjs
// onHeadSeen); when another deck on this machine is
// the one recording the session, a moment later, from the store the two share;
// after the boot, from the store, for every session with a commit still inside
// the window; and when the git view is switched back on. A list that says what
// the last one said is not sent again.
//
// NEVER LOGGED. Like GitCollisions it is sent with persist: false: a restarted
// deck rebuilds it from the store rather than replaying an old one, and like it
// it is LAST_VALUE_WINS in ring-bounds.mjs and handed again to a page that
// connects after the ring dropped the event that carried it
// (recentCommitsBehind, through withLostBehind in event-routes.mjs).
import { realpath } from "node:fs/promises";
import { agentGit } from "./agent-git-tap.mjs";
import { pushEvent } from "./event-sink.mjs";
import { readCommitsBySha } from "./git-reads.mjs";
import { sessionFolder } from "./git-sessions.mjs";
import { repoOf } from "./git-state.mjs";
import { gitEnabled, onFollow, onHeadSeen } from "./git-watch.mjs";

/** How long a commit stays in the lane: the page's BAND_WINDOW_MS. */
export const RECENT_COMMITS_MS = 30 * 60_000;
/** The most commits one event carries. The lane shows five and folds the rest
 *  into a count; past this many in half an hour the count stops growing. */
export const RECENT_COMMITS_MAX = 24;
/** How long after another deck spotted a commit its line is looked for. */
export const ELSEWHERE_MS = 3_000;
const MAX_SESSIONS = 2048;
/** The most worktrees one pass asks which commits are still reached. */
const MAX_REACH_READS = 16;
const MAX_HEADS = 256;

// sid -> the commits last sent for it, serialized; absent once they are empty
const sent = new Map();
// sid -> the seq and time of the event that carried its last answer, empty ones included
const sentSeq = new Map();
// The sessions another deck recorded a commit for, looked at together.
const elsewhere = new Set();
let elsewhereTimer = null;
// worktree top level -> the commit its HEAD was on when a lane was last worked out against it
const heads = new Map();
let generation = 0;
const enabled = () => gitEnabled();
const store = () => agentGit.store;
let now = () => Date.now();

/** One store line as the lane carries it. */
const entry = (r) => ({
  sha: r.sha,
  short: r.sha.slice(0, 7),
  subject: typeof r.subject === "string" ? r.subject : "",
  at: r.at,
  agentId: typeof r.agentId === "string" && r.agentId ? r.agentId : null,
  label: typeof r.label === "string" && r.label ? r.label : null,
  branch: typeof r.branch === "string" && r.branch ? r.branch : null,
  repo: typeof r.repo === "string" && r.repo ? r.repo : null,
});

/**
 * A session's lane from its store lines, oldest first in: newest first out,
 * without the commits git says nothing reaches any more (`reachable`, SHA →
 * whether it is), an amend in the place of the commit it amended where git
 * could not say, at most RECENT_COMMITS_MAX. Answers `{ repo, commits }`:
 * `repo` is the one the session works in when it is given, else the newest
 * commit's.
 *
 * @param {Array<{ sha: string, repo: string, branch?: string | null, amend?: boolean, at: number }>} lines
 * @param {{ repo?: string | null, reachable?: Map<string, boolean> | null }} [opts]
 */
export function laneOf(lines, { repo = null, reachable = null } = {}) {
  const known = (r) => reachable?.get(r.sha);
  const kept = [];
  for (const r of [...lines].sort((a, b) => a.at - b.at)) {
    if (known(r) === false) continue;
    if (r.amend) {
      // The commit it rewrote, when git could not say: the newest before it
      // on the same branch of the same repository.
      for (let i = kept.length - 1; i >= 0; i--) {
        if (kept[i].repo !== r.repo || (kept[i].branch ?? null) !== (r.branch ?? null)) continue;
        if (known(kept[i]) === undefined) kept.splice(i, 1);
        break;
      }
    }
    kept.push(r);
  }
  const newest = kept.slice(-RECENT_COMMITS_MAX).reverse();
  return { repo: repo ?? newest[0]?.repo ?? null, commits: newest.map(entry) };
}

/** The repository the session's git view reads now, as the store names one
 *  (the realpath of its common git directory), or null. */
async function workRepo(sid) {
  const folder = sessionFolder(sid);
  if (!folder) return null;
  const r = await repoOf(folder.cwd);
  if (r.state !== "repo") return null;
  return realpath(r.commonDir).catch(() => r.commonDir);
}

/** Every session's lines inside the window, from the store. */
async function linesBySession() {
  const lines = await store().since(now() - RECENT_COMMITS_MS);
  const out = new Map();
  for (const r of lines) {
    const list = out.get(r.sessionId);
    if (list) list.push(r);
    else out.set(r.sessionId, [r]);
  }
  return out;
}

/**
 * Which of these lines' commits a branch, tag, remote-tracking branch or HEAD
 * still reaches, SHA → boolean, asked once per worktree they were made in. A
 * line whose worktree cannot be read, or is another repository by now, is
 * left out: not known.
 */
async function stillReached(lines) {
  const out = new Map();
  const byTop = new Map();
  for (const r of lines) {
    const top = (typeof r.top === "string" && r.top) || (typeof r.cwd === "string" && r.cwd) || null;
    if (!top || typeof r.sha !== "string") continue;
    if (byTop.has(top)) byTop.get(top).push(r);
    else byTop.set(top, [r]);
  }
  for (const [top, rows] of [...byTop].slice(0, MAX_REACH_READS)) {
    const repo = await repoOf(top);
    if (repo.state !== "repo") continue;
    const common = await realpath(repo.commonDir).catch(() => repo.commonDir);
    const mine = rows.filter((r) => r.repo === common);
    if (!mine.length) continue;
    const read = await readCommitsBySha(repo.topLevel, mine.map((r) => r.sha), repo.head).catch(() => null);
    if (!read?.ok) continue;
    noteHead(repo.topLevel, repo.head?.sha ?? null);
    for (const r of mine) out.set(r.sha, read.commits.some((c) => c.sha.startsWith(r.sha)));
  }
  return out;
}

function noteHead(top, sha) {
  heads.delete(top);
  heads.set(top, sha);
  while (heads.size > MAX_HEADS) heads.delete(heads.keys().next().value);
}

let queue = Promise.resolve();
/** Work the lanes of these sessions (all with a commit in the window when
 *  `sids` is null, only those with one in `inRepo` when it is named) out again
 *  — with `shared`, also every lane holding a commit in a repository theirs
 *  are in — and send each that changed; one pass at a time, so a slower pass
 *  never sends after a newer one. */
function lookAt(sids, opts) {
  queue = queue.then(() => lookAtNow(sids, opts)).catch(() => {});
  return queue;
}

async function lookAtNow(sids, { shared = false, inRepo = null } = {}) {
  const gen = generation;
  if (!enabled()) return;
  let by;
  try { by = await linesBySession(); } catch { return; }
  if (gen !== generation || !enabled()) return;
  const targets = new Set(sids ?? by.keys());
  if (inRepo) for (const sid of targets) if (!by.get(sid)?.some((r) => r.repo === inRepo)) targets.delete(sid);
  if (sids && shared) {
    const repos = new Set([...targets].flatMap((sid) => (by.get(sid) ?? []).map((r) => r.repo)));
    for (const [sid, lines] of by) if (lines.some((r) => repos.has(r.repo))) targets.add(sid);
  }
  const reachable = await stillReached([...targets].flatMap((sid) => by.get(sid) ?? []));
  if (gen !== generation || !enabled()) return;
  for (const sid of targets) {
    const lines = by.get(sid) ?? [];
    if (!lines.length && !sent.has(sid)) continue;
    const repo = lines.length ? await workRepo(sid) : null;
    if (gen !== generation || !enabled()) return;
    const lane = laneOf(lines, { repo, reachable });
    const sig = lane.commits.length ? JSON.stringify(lane) : null;
    if (sig === (sent.get(sid) ?? null)) continue;
    send(sid, lane);
  }
}

// Followed into another folder: the repository its lane is read against may
// have changed with it.
onFollow((sid) => { if (enabled()) void lookAt([sid]); });
// HEAD is somewhere else than when a lane was worked out against its
// worktree, whoever moved it and however: what a reset, a rebase or an amend
// left behind leaves every lane holding a commit in that repository.
onHeadSeen(({ top, commonDir, sha }) => {
  if (!enabled() || !heads.has(top) || heads.get(top) === sha) return;
  noteHead(top, sha);
  void realpath(commonDir).catch(() => commonDir).then((inRepo) => lookAt(null, { inRepo }));
});

function send(sid, lane) {
  const evt = pushEvent({ hook_event_name: "GitRecentCommits", session_id: sid, repo: lane.repo, commits: lane.commits }, "internal", { persist: false });
  if (lane.commits.length) {
    sent.delete(sid);
    sent.set(sid, JSON.stringify(lane));
    while (sent.size > MAX_SESSIONS) forgetRecentCommitsSession(sent.keys().next().value);
  } else sent.delete(sid);
  sentSeq.set(sid, evt ? { seq: evt.seq, at: evt.receivedAt } : null);
}

/**
 * What the tap heard: a line this deck recorded, or a session whose commit
 * another deck records. Never throws.
 *
 * @param {{ line?: { sessionId?: unknown }, elsewhere?: unknown }} heard
 */
export function noteAgentCommit(heard) {
  try {
    if (!heard || !enabled()) return;
    const sid = heard.line?.sessionId;
    if (typeof sid === "string" && sid) { void lookAt([sid], { shared: true }); return; }
    if (typeof heard.elsewhere !== "string" || !heard.elsewhere) return;
    elsewhere.add(heard.elsewhere);
    if (elsewhereTimer) return;
    elsewhereTimer = setTimeout(() => {
      elsewhereTimer = null;
      const sids = [...elsewhere];
      elsewhere.clear();
      void lookAt(sids, { shared: true });
    }, ELSEWHERE_MS);
    elsewhereTimer.unref?.();
  } catch { /* the event path must never fail for this */ }
}

let listening = null; // { tap, stop }

/** Listen to the deck's tap, once however often the server is started;
 *  answers the way to stop, for the tests. */
export function connectRecentCommits(tap = agentGit) {
  if (listening?.tap !== tap) {
    listening?.stop();
    listening = { tap, stop: tap.onCommit(noteAgentCommit) };
  }
  return () => { listening?.stop(); listening = null; };
}

/** Every session with a commit still inside the window, sent now — after the
 *  boot replay, and when the git view is switched back on. */
export function refreshRecentCommits() {
  if (enabled()) void lookAt(null);
}

/**
 * The last lane of every session a connecting page cannot be replayed it for:
 * each whose event is newer than the page's last one (`after`) and has already
 * left the ring (older than `before`, its oldest). Only for the `sessions` the
 * page will draw a card for, only the commits still inside the window, and for
 * a page that has seen nothing yet only a lane that has one. Each under its
 * own seq and time, for that page alone (withLostBehind in event-routes.mjs).
 *
 * @param {{ after: number, before: number, sessions: Set<string> }} range
 * @returns {Array<{ seq: number, receivedAt: number, payload: object }>}
 */
export function recentCommitsBehind({ after, before, sessions }) {
  const out = [];
  if (!enabled()) return out;
  const since = now() - RECENT_COMMITS_MS;
  for (const [sid, as] of sentSeq) {
    if (!sessions.has(sid) || as === null || as.seq <= after || as.seq >= before) continue;
    const json = sent.get(sid);
    const lane = json ? JSON.parse(json) : { repo: null, commits: [] };
    const commits = lane.commits.filter((c) => c.at >= since);
    if (!commits.length && after === 0) continue;
    out.push({ seq: as.seq, receivedAt: as.at, payload: { hook_event_name: "GitRecentCommits", session_id: sid, repo: lane.repo, commits } });
  }
  return out;
}

/** The switch was pressed. Off takes every lane back and stops; on sends them
 *  again from the store. */
export function recentCommitsSwitched(on) {
  generation++;
  if (elsewhereTimer) { clearTimeout(elsewhereTimer); elsewhereTimer = null; }
  elsewhere.clear();
  heads.clear();
  if (!on) {
    for (const sid of [...sent.keys()]) send(sid, { repo: null, commits: [] });
    return;
  }
  refreshRecentCommits();
}

/** The page has let go of a session (session-tracking.mjs forgetSession). */
export function forgetRecentCommitsSession(sid) {
  sent.delete(sid);
  sentSeq.delete(sid);
}

/** Forget everything, for a Clear: the page has nothing left to take back. */
export function clearRecentCommits() {
  generation++;
  sent.clear();
  sentSeq.clear();
  elsewhere.clear();
  heads.clear();
  if (elsewhereTimer) { clearTimeout(elsewhereTimer); elsewhereTimer = null; }
}

/** The clock the window is read against — replaced by the tests. */
export function setRecentCommitsClock(fn) {
  now = typeof fn === "function" ? fn : () => Date.now();
}
