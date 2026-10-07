// The commits each session's agents made in the last half hour, told to the
// page for the lane drawn under its card: GitRecentCommits, one per session,
// last value wins.
//
//   { hook_event_name: "GitRecentCommits", session_id, repo,
//     commits: [{ sha, short, subject, at, agentId, label, branch }, …] }
//
// Newest first, at most RECENT_COMMITS_MAX. Only commits the deck saw an agent
// make: the lines of the commit store (agent-git-store.mjs), which the
// recorder writes from what a `git commit` printed and the repository
// confirmed — `sha` is the full SHA when it confirmed it, else the one git
// printed. `at` is when the deck saw it, `agentId` the subagent (null for the
// session's main thread) and `label` what the store calls it — a subagent's
// type — for a page whose card for it has left the board. `branch` is the
// branch it went to (null on a detached HEAD), and `repo` the repository of the
// newest one (its common git directory), which the page reads the branch's
// colour by.
//
// An amend takes the place of the commit it amended: that one is no longer on
// the branch, so the lane does not show it.
//
// WHEN. Never on a timer of its own for the window: the page ages each commit
// out on its own clock, and the lane goes with the last one. A list is worked
// out again when the deck records a commit for the session (the tap tells this
// module, agent-git-tap.mjs `onCommit`); when another deck on this machine is
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
import { agentGit } from "./agent-git-tap.mjs";
import { pushEvent } from "./event-sink.mjs";
import { gitEnabled } from "./git-watch.mjs";

/** How long a commit stays in the lane: the page's BAND_WINDOW_MS. */
export const RECENT_COMMITS_MS = 30 * 60_000;
/** The most commits one event carries. The lane shows five and folds the rest
 *  into a count; past this many in half an hour the count stops growing. */
export const RECENT_COMMITS_MAX = 24;
/** How long after another deck spotted a commit its line is looked for. */
export const ELSEWHERE_MS = 3_000;
const MAX_SESSIONS = 2048;

// sid -> the commits last sent for it, serialized; absent once they are empty
const sent = new Map();
// sid -> the seq and time of the event that carried its last answer, empty ones included
const sentSeq = new Map();
// The sessions another deck recorded a commit for, looked at together.
const elsewhere = new Set();
let elsewhereTimer = null;
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
});

/**
 * A session's lane from its store lines, oldest first in: newest first out,
 * an amend in the place of the commit it amended, at most
 * RECENT_COMMITS_MAX. Answers `{ repo, commits }`.
 *
 * @param {Array<{ sha: string, repo: string, branch?: string | null, amend?: boolean, at: number }>} lines
 */
export function laneOf(lines) {
  const kept = [];
  for (const r of [...lines].sort((a, b) => a.at - b.at)) {
    if (r.amend) {
      // The commit it rewrote: the newest before it on the same branch of the
      // same repository.
      for (let i = kept.length - 1; i >= 0; i--) {
        if (kept[i].repo === r.repo && (kept[i].branch ?? null) === (r.branch ?? null)) { kept.splice(i, 1); break; }
      }
    }
    kept.push(r);
  }
  const newest = kept.slice(-RECENT_COMMITS_MAX).reverse();
  return { repo: newest[0]?.repo ?? null, commits: newest.map(entry) };
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

/** Work the lanes of these sessions (all with a commit in the window when
 *  `sids` is null) out again, and send each that changed. */
async function lookAt(sids) {
  const gen = generation;
  if (!enabled()) return;
  let by;
  try { by = await linesBySession(); } catch { return; }
  if (gen !== generation || !enabled()) return;
  for (const sid of sids ?? by.keys()) {
    const lane = laneOf(by.get(sid) ?? []);
    const sig = lane.commits.length ? JSON.stringify(lane) : null;
    if (sig === (sent.get(sid) ?? null)) continue;
    send(sid, lane);
  }
}

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
    if (typeof sid === "string" && sid) { void lookAt([sid]); return; }
    if (typeof heard.elsewhere !== "string" || !heard.elsewhere) return;
    elsewhere.add(heard.elsewhere);
    if (elsewhereTimer) return;
    elsewhereTimer = setTimeout(() => {
      elsewhereTimer = null;
      const sids = [...elsewhere];
      elsewhere.clear();
      void lookAt(sids);
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
  if (elsewhereTimer) { clearTimeout(elsewhereTimer); elsewhereTimer = null; }
}

/** The clock the window is read against — replaced by the tests. */
export function setRecentCommitsClock(fn) {
  now = typeof fn === "function" ? fn : () => Date.now();
}
