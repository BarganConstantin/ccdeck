// GitObserved: what the page is told about each session's repository, and when.
//
// Every live event with a folder lets the deck notice a session's repository
// once; after that, the events that can change a repository — an agent's
// finished Edit, Write, MultiEdit, NotebookEdit, Bash or PowerShell call, and
// any finished Codex tool call (its patches and its commands) — mark it stale
// (git-state.mjs) and schedule a fresh look. How far a mark reaches follows
// what the call could have changed: an edit marks the working tree of the
// worktree holding the file it edited, wherever that is; a command marks the
// repository it ran in and every folder its text names (a `cd`, a `git -C`),
// with every worktree of each. Every session watching a marked worktree is
// looked at again, not only the one that made the call, so a view open on
// a session that shares a folder or a repository with it refetches too. The
// look reads the folder's repository and HEAD, and sends
//
//   { hook_event_name: "GitObserved", session_id, provider?: "codex",
//     git: { subagent?, state, stale, topLevel?, name?, mainName?, folderName?,
//            nameDiffers?, linkedWorktree?, branch?, detached?, sha?, unborn?,
//            empty?, fromLog?, followed?, sameAsRoot? } }
//
// for the session's root and for each subagent whose folder is not the
// root's (`git.subagent` is its key) — and for a subagent that had a folder of
// its own and is back in the root's, one `sameAsRoot: true` to take that back.
// `state` is "repo" or why there is none ("not-a-repo", "gone", "no-git",
// "bare", "unsafe") — sent only to take back a branch the page was already
// shown, since a card without one needs no event. The exception is a root whose folder is "gone": its own log still
// names a branch (the transcript's `gitBranch`, a Codex rollout's
// session_meta), sent as `branch` with `fromLog: true`. A read that timed out
// or failed sends nothing, so a slow disk never takes a branch off a card.
// `sha` is the short SHA, which a detached HEAD is named by. `stale` counts
// the worktree's marks — a page with a view open on that repository refetches
// when it moves.
//
// WHEN IT IS SENT. A change of identity — another repository, another branch,
// a HEAD that detached or reattached — is sent and kept in the log, so a
// restarted deck replays it. A mark with no change of identity is sent only to
// the pages that are open (persist: false): the log has no use for it. Looks
// are spaced out: the first look at a session and the one after a command
// (the only kind of call that can move HEAD) come quickly, a look after edits
// waits a little so a burst of them costs one. A pending look is brought
// forward, never pushed back, so a session that edits without pause is still
// looked at.
//
// WHERE A SESSION WORKS. The folder a session started in is not always where
// it works: agents started in one checkout often each move to a worktree of
// their own. What a call does says where it works, and the session's reads
// follow it there (followFolder in git-sessions.mjs):
//   - its folder changed (it entered a worktree), or a command `cd`s or runs
//     `git -C` into a folder, or a Codex command names its `workdir` — the
//     last of these inside a repository is where it works, from that call on;
//   - an edit says so more quietly: a session follows its edits to another
//     worktree after EDITS_TO_FOLLOW calls there in a row, so one stray file
//     written elsewhere (a note, a memory file) moves nothing.
// A folder outside every repository says nothing. A worktree it was followed
// to and that has since been deleted is let go of, back to the folder it
// started in while that is still there (letGoOfGone, before each look and
// each route's read). The worktree it moved to rides on its GitObserved,
// marked `followed`, which the log keeps, so a restarted deck puts the
// session back where it was working (seedFromLog).
//
// AFTER A BOOT, the sessions the replay put back are looked at once
// (refreshGit), and the GitObserved lines the replay found are taken as sent,
// so only what changed while the deck was down goes out.
//
// A PAGE BEHIND THE RING. What was sent is sent once, and the ring drops its
// oldest events as new ones come; a page that connects after the event that
// told a card its branch has fallen off the head — a reload, a second tab, on
// a busy deck — would never be told again. gitBehind hands that page the last
// GitObserved of each card whose own event it can no longer be replayed, as it
// was sent — its seq and its time — for event-routes.mjs to put ahead of the
// replay; nothing goes back into the ring, the log or the other pages. The Settings switch
// (`git` in prefs.json) stops all of it: off, nothing is looked at and the
// routes refuse; on again, the recent sessions are looked at straight away.
//
// Like the transcript scans' events, these are last-value-wins state
// (LAST_VALUE_WINS in ring-bounds.mjs): the ring does not count them against
// the hook events it keeps.
import { dirname } from "node:path";
import { pushEvent } from "./event-sink.mjs";
import { codexCwdInWorkspace } from "./log-election.mjs";
import { gitOn } from "./deck-prefs.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { followFolder, noteLiveFolder, recentSessions, sessionFolder, sessionSubagents, sessionTranscript, takeMove } from "./git-sessions.mjs";
import { markStale, repoOf } from "./git-state.mjs";
// What a call edited and the folders its commands name.
import { digestToolCall } from "./agent-git-digest.mjs";
import { commandFolders } from "./agent-git-detect.mjs";
// The two records of a branch that outlive a deleted folder.
import { scanTranscript } from "./transcript-scan.mjs";
import { codexRolloutBranch } from "./codex-watch.mjs";

/** The tools whose finished call can change a repository. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const CHANGING_TOOLS = new Set([...EDIT_TOOLS, ...SHELL_TOOLS]);
const FINISHED = new Set(["PostToolUse", "PostToolUseFailure"]);
/** The states worth telling the page; the rest are a read that went wrong. */
const DEFINITE = new Set(["repo", "not-a-repo", "gone", "no-git", "bare", "unsafe"]);

/** How many calls in a row must edit files in another worktree before the
 *  session is taken to be working there. */
export const EDITS_TO_FOLLOW = 2;

export const FIRST_LOOK_MS = 250;
export const AFTER_COMMAND_MS = 600;
export const AFTER_EDIT_MS = 2_000;

const watched = new Map(); // sid -> { timer, due, seen: Set<key>, sent: Map<key, { sig, stale, top, state, drawn, payload, seq, at }>, pending: Map<key, { top, n }>, following: Promise }
/** The Settings switch: off, the deck runs no git at all. */
let enabled = () => gitOn(heldPrefs.current());
/** How many of the most recently heard sessions a refresh looks at — every
 *  card a board can be showing, with room to spare. */
export const REFRESH_SESSIONS = 64;
/** A backstop on the sessions looked after; the session cap forgets them
 *  first (forgetGitSession), this only bounds a map fed from outside. */
const MAX_WATCHED = 2048;

/** Whether this finished call may have changed the repository it ran in. */
export function changesRepo(raw) {
  if (!raw || !FINISHED.has(raw.hook_event_name)) return false;
  return raw.provider === "codex" || CHANGING_TOOLS.has(raw.tool_name);
}

/** Whether it may have moved HEAD: a command can check out or commit; an edit
 *  cannot. Codex's tool calls carry no name on their outcome, so all count. */
const mayMoveHead = (raw) => raw.provider === "codex" || SHELL_TOOLS.has(raw.tool_name);

/** Whether the deck may read repositories at all. */
export const gitEnabled = () => enabled();

function watching(sid) {
  let w = watched.get(sid);
  if (!w) {
    w = { timer: null, due: Infinity, seen: new Set(), sent: new Map(), pending: new Map(), following: Promise.resolve() };
    watched.set(sid, w);
    while (watched.size > MAX_WATCHED) forgetGitSession(watched.keys().next().value);
  }
  return w;
}

/**
 * One event, from pushEvent. Never throws, never waits.
 *
 * A REPLAYED GitObserved is what the page will be shown again from the ring,
 * so it is taken as already sent: a refresh after the boot says only what has
 * changed since. Nothing else from a replay is looked at.
 */
export function noteGitEvent(raw, { replay = false, seq = null, at = null } = {}) {
  try {
    if (!raw || typeof raw !== "object") return;
    if (replay) {
      if (raw.hook_event_name === "GitObserved") seedFromLog(raw, seq, at);
      return;
    }
    const sid = raw.session_id;
    if (typeof sid !== "string" || sid === "" || typeof raw.cwd !== "string" || raw.cwd === "") return;
    // The folder it is in, heard with the reads switched off too: a move made
    // meanwhile is followed once they are on again.
    noteLiveFolder(sid, subagentKeyOf(raw), raw.cwd);
    if (!enabled()) return;
    const w = watching(sid);
    if (changesRepo(raw)) {
      const marked = mark(raw, w);
      schedule(sid, w, mayMoveHead(raw) ? AFTER_COMMAND_MS : AFTER_EDIT_MS);
      // Every other session on a worktree this call marked: a view open on it
      // refetches when its stale count moves. Spaced like a look after edits,
      // so a burst of calls costs each of them one look.
      if (marked.size) {
        for (const [other, ow] of watched) {
          if (other !== sid && [...ow.sent.values()].some((s) => s.top && marked.has(s.top))) schedule(other, ow, AFTER_EDIT_MS);
        }
      }
    }
    const evidence = whereItWorks(raw, sid);
    if (evidence.moves.length || evidence.edits.length) {
      const key = subagentKeyOf(raw) ?? "";
      w.following = w.following.then(() => follow(sid, key, evidence, w)).catch(() => {});
    }
    // The session, or one of its subagents, not looked at yet.
    if (!w.seen.has(subagentKeyOf(raw) ?? "")) schedule(sid, w, FIRST_LOOK_MS);
  } catch { /* the event path must never fail for this */ }
}

const subagentKeyOf = (p) => [p.agent_id, p.parent_tool_use_id].find((k) => typeof k === "string" && k) ?? null;

/**
 * Mark what one finished call may have changed, and answer the worktrees
 * marked.
 *
 * An edit marks the working tree of the worktree holding the file — another
 * repository's, when the path leads there — and nothing else, since an edit
 * moves no branch. When no worktree the deck has read holds the path (a
 * spelling through a symlink, a file outside every repository), the agent's
 * own worktree is marked instead, as it always was.
 *
 * A command — or any Codex call — marks the repository it ran in, every
 * folder its text names, and with each every worktree of its repository.
 * `tops` (the session's own worktrees) are marked whatever the folder's
 * spelling says.
 */
function mark(raw, w) {
  const marked = new Set();
  const add = (tops) => { for (const t of tops) marked.add(t); };
  if (raw.provider !== "codex" && EDIT_TOOLS.has(raw.tool_name)) {
    for (const file of digestToolCall(raw.tool_name, raw.tool_input, raw.cwd).edits) add(markStale(file, [], { tree: true }));
    if (!marked.size) {
      const own = w.sent.get(subagentKeyOf(raw) ?? "")?.top ?? w.sent.get("")?.top;
      add(markStale(raw.cwd, own ? [own] : [], { tree: true }));
    }
    return marked;
  }
  add(markStale(raw.cwd, [...new Set([...w.sent.values()].map((s) => s.top).filter(Boolean))]));
  if (raw.provider !== "codex" && SHELL_TOOLS.has(raw.tool_name)) {
    for (const { command, cwd } of digestToolCall(raw.tool_name, raw.tool_input, raw.cwd).commands) {
      for (const dir of commandFolders(command, cwd)) if (dir !== raw.cwd) add(markStale(dir));
    }
  }
  return marked;
}

/**
 * What one event says about where its agent works: `moves`, the folders it
 * went to — its own folder when that changed since the last live event heard
 * from it (git-sessions.mjs takeMove, which also keeps a change heard while
 * the reads were off or the session was let go), then each folder its commands
 * `cd` or `git -C` into, in order — and `edits`, the folders of the files it
 * edited. A Claude call counts once it finished; a Codex call as it starts,
 * since its outcome names no tool.
 */
function whereItWorks(raw, sid) {
  const moves = [];
  const edits = [];
  const moved = takeMove(sid, subagentKeyOf(raw));
  if (moved) moves.push(moved);
  const codex = raw.provider === "codex";
  if (codex ? raw.hook_event_name === "PreToolUse" : FINISHED.has(raw.hook_event_name) && CHANGING_TOOLS.has(raw.tool_name)) {
    const call = digestToolCall(raw.tool_name, raw.tool_input, raw.cwd);
    for (const file of call.edits) edits.push(dirname(file));
    for (const { command, cwd } of call.commands) {
      if (cwd && cwd !== raw.cwd) moves.push(cwd);
      moves.push(...commandFolders(command, cwd));
    }
  }
  return { moves, edits };
}

/** The worktree `folder` is in, or null outside every repository. */
async function worktreeOf(folder) {
  const repo = await repoOf(folder);
  return repo.state === "repo" ? repo.topLevel : null;
}

/**
 * Follow one event's evidence: the last folder it moved to inside a
 * repository is where the agent works now; failing that, its edits take it to
 * another worktree once EDITS_TO_FOLLOW calls in a row have edited there, and
 * an edit back home ends the count. A move is looked at straight away, so its
 * card and an open view change with it.
 */
async function follow(sid, key, { moves, edits }, w) {
  const here = sessionFolder(sid, key || null);
  if (!here || watched.get(sid) !== w || !enabled()) return;
  let top = null;
  for (let i = moves.length - 1; i >= 0 && !top; i--) top = await worktreeOf(moves[i]);
  const current = await worktreeOf(here.cwd);
  if (!top) {
    for (const dir of edits) top = (await worktreeOf(dir)) ?? top;
    if (!top) return;
    if (top === current) { w.pending.delete(key); return; }
    const n = w.pending.get(key)?.top === top ? w.pending.get(key).n + 1 : 1;
    if (n < EDITS_TO_FOLLOW) { w.pending.set(key, { top, n }); return; }
  }
  w.pending.delete(key);
  if (top === current) return;
  // Back where it would be with nothing followed: forget the followed folder,
  // so the folder it started in reads as it always did.
  const home = await worktreeOf(here.start);
  if (followFolder(sid, key || null, home === top ? null : top)) workMoved(sid, w);
}

/** Where `sid` works has just changed: look at it now, and tell whoever
 *  reads that folder too (git-collisions.mjs, git-recent-commits.mjs). */
function workMoved(sid, w) {
  if (w) schedule(sid, w, FIRST_LOOK_MS);
  for (const fn of followers) {
    try { fn(sid); } catch { /* a listener never breaks the event path */ }
  }
}

/**
 * Let go of a followed worktree that is gone — for the root of `sid` and each
 * of its subagents — when the folder it started in is still there: it can
 * only be working there now, and nothing else would bring it back while it
 * runs plain commands at home. Answers whether anything changed.
 */
async function letGoOfGone(sid) {
  let changed = false;
  for (const key of [null, ...sessionSubagents(sid).map(([k]) => k)]) {
    const f = sessionFolder(sid, key);
    if (!f || f.cwd === f.start) continue;
    if ((await repoOf(f.cwd)).state !== "gone" || (await repoOf(f.start)).state === "gone") continue;
    if (followFolder(sid, f.agent, null)) changed = true;
  }
  return changed;
}

/**
 * The folder `sid` — its subagent `agent`, when one is named — works in, as
 * sessionFolder answers it, after letting go of a followed worktree that is
 * gone (and then looking at the session again, so its card hears it too). What
 * the routes read, so a view opened before the session's next call is not
 * told the folder is gone while the agent works at home.
 */
export async function workingFolder(sid, agent = null) {
  if (enabled() && sessionFolder(sid) && await letGoOfGone(sid)) workMoved(sid, watched.get(sid));
  return sessionFolder(sid, agent);
}

const followers = new Set();
/**
 * Call `fn(sid)` each time a live call moves the folder a session (or one of
 * its subagents) works in — the folder the collision check and the lane read
 * too, which nothing else would tell them changed. Answers the way to stop.
 */
export function onFollow(fn) {
  followers.add(fn);
  return () => followers.delete(fn);
}

function schedule(sid, w, delay) {
  const due = Date.now() + delay;
  if (w.timer !== null && w.due <= due) return;
  if (w.timer !== null) clearTimeout(w.timer);
  w.due = due;
  w.timer = setTimeout(() => {
    w.timer = null;
    w.due = Infinity;
    look(sid).catch(() => {});
  }, delay);
  w.timer.unref?.();
}

/** The signature of a subagent taken back into its session's folder. */
const SAME_AS_ROOT = "same-as-root";

/** The identity part of an observation: what a card would draw differently. */
function signature(git) {
  return JSON.stringify([git.state, git.topLevel ?? null, git.branch ?? null, git.detached ? git.sha : null, Boolean(git.unborn)]);
}

/**
 * The branch a session's own log recorded, for a session whose folder no
 * longer exists: the newest `gitBranch` on its Claude transcript, or the
 * branch its Codex rollout named when the session began. Null when neither
 * says, and for a detached HEAD, which both spell "HEAD" or not at all.
 */
export async function loggedBranch(sid, provider) {
  let branch = null;
  if (provider === "codex") branch = codexRolloutBranch(sid);
  else {
    const path = sessionTranscript(sid);
    if (path) branch = (await scanTranscript(path).catch(() => null))?.gitBranch ?? null;
  }
  return typeof branch === "string" && branch && branch !== "HEAD" ? branch : null;
}

/** Whether a card draws a branch for this observation. */
const drawable = (git) => git?.state === "repo" || (git?.state === "gone" && typeof git.branch === "string");

/** What GitObserved says about one folder's repository. */
export function describeRepo(repo) {
  if (repo.state !== "repo") return { state: repo.state, stale: 0 };
  return {
    state: "repo",
    topLevel: repo.topLevel,
    name: repo.name,
    mainName: repo.mainName,
    folderName: repo.folderName,
    nameDiffers: repo.nameDiffers,
    linkedWorktree: repo.linkedWorktree,
    branch: repo.head.branch,
    detached: repo.head.detached,
    sha: repo.head.short,
    unborn: repo.head.unborn,
    empty: repo.empty,
    stale: repo.stale ?? 0,
  };
}

/** Look at a session's repositories now and send what changed. */
async function look(sid) {
  const w = watched.get(sid);
  if (!w || !sessionFolder(sid) || !enabled()) return;
  if (await letGoOfGone(sid)) workMoved(sid, null);
  const root = sessionFolder(sid);
  if (!root || watched.get(sid) !== w) return;
  const targets = [["", root.cwd]];
  w.seen.add("");
  for (const [key, cwd] of sessionSubagents(sid)) {
    w.seen.add(key);
    if (cwd !== root.cwd) targets.push([key, cwd]);
  }
  // A subagent that worked in a folder of its own and is back in the
  // session's: what it was told of its own is taken back, so its card reads
  // the session's again (`sameAsRoot`). Logged like any change of identity,
  // so a restart does not follow it back out (seedFromLog).
  const here = new Set(targets.map(([key]) => key));
  for (const [key, prev] of w.sent) {
    if (key === "" || here.has(key) || prev.sameAsRoot) continue;
    const entry = { sig: SAME_AS_ROOT, stale: 0, top: null, state: "repo", drawn: false, sameAsRoot: true, payload: null, seq: null, at: null };
    w.sent.set(key, entry);
    if (!prev.payload) continue;
    entry.payload = {
      hook_event_name: "GitObserved",
      session_id: sid,
      ...(root.provider === "codex" ? { provider: "codex" } : {}),
      git: { subagent: key, state: "repo", sameAsRoot: true, stale: 0 },
    };
    const evt = pushEvent(entry.payload, "internal");
    entry.seq = evt?.seq ?? null;
    entry.at = evt?.receivedAt ?? null;
  }
  const moved = new Set();
  for (const [key, cwd] of targets) {
    const repo = await repoOf(cwd);
    if (!DEFINITE.has(repo.state) || watched.get(sid) !== w) continue;
    const git = describeRepo(repo);
    // Read somewhere other than the folder it started in: said, so a restart
    // follows it there again (seedFromLog) whatever the two folders' paths.
    const own = key ? sessionFolder(sid, key) : root;
    if (git.state === "repo" && own && own.cwd !== own.start) git.followed = true;
    // A deleted folder still names the branch its session last ran on, from
    // the session's own log — the root's only; a subagent keeps no log of one.
    if (git.state === "gone" && !key) {
      const branch = await loggedBranch(sid, root.provider);
      if (branch) Object.assign(git, { branch, fromLog: true });
    }
    const sig = signature(git);
    const told = w.sent.get(key);
    const prev = told?.sameAsRoot ? undefined : told;
    if (prev && prev.sig === sig && prev.stale === git.stale) continue;
    const identity = !prev || prev.sig !== sig;
    if (identity && prev && git.topLevel) moved.add(git.topLevel);
    const entry = { sig, stale: git.stale, top: git.topLevel ?? null, state: git.state, drawn: drawable(git), payload: null, seq: null, at: null };
    w.sent.set(key, entry);
    // A folder that is not a repository is the common case, and a card with no
    // branch needs no event to say so; only a branch the page was shown is
    // taken back.
    if (!drawable(git) && !prev?.drawn) continue;
    entry.payload = {
      hook_event_name: "GitObserved",
      session_id: sid,
      ...(root.provider === "codex" ? { provider: "codex" } : {}),
      git: key ? { subagent: key, ...git } : git,
    };
    const evt = pushEvent(entry.payload, "internal", identity ? {} : { persist: false });
    entry.seq = evt?.seq ?? null;
    entry.at = evt?.receivedAt ?? null;
  }
  // A checkout in a folder other sessions share moves their HEAD too.
  if (moved.size) {
    for (const [other, ow] of watched) {
      if (other === sid) continue;
      if ([...ow.sent.values()].some((s) => s.top && moved.has(s.top))) schedule(other, ow, AFTER_COMMAND_MS);
    }
  }
}

function seedFromLog(raw, seq, at) {
  const sid = raw.session_id;
  const git = raw.git;
  if (typeof sid !== "string" || sid === "" || !git || typeof git !== "object" || typeof git.state !== "string") return;
  const key = typeof git.subagent === "string" ? git.subagent : "";
  // A subagent back in its session's folder: nothing of its own followed.
  if (key && git.sameAsRoot === true) {
    followFolder(sid, key, null);
    watching(sid).sent.set(key, {
      sig: SAME_AS_ROOT, stale: 0, top: null, state: "repo", drawn: false, sameAsRoot: true,
      payload: raw, seq: typeof seq === "number" ? seq : null, at: typeof at === "number" ? at : null,
    });
    return;
  }
  // Where it was working when this was sent: a worktree away from the folder
  // it started in is followed again, so a restart does not send it home.
  // `followed` says so; a line from before it was written is judged by its
  // path — the folder it started in outside the worktree named.
  if (git.state === "repo" && typeof git.topLevel === "string" && git.topLevel) {
    const start = sessionFolder(sid, key || null)?.start;
    const away = git.followed === true || (start && !codexCwdInWorkspace(start, git.topLevel));
    if (start) followFolder(sid, key || null, away ? git.topLevel : null);
  }
  // The counter is this process's own and starts at nought.
  watching(sid).sent.set(key, {
    sig: signature(git), stale: 0, top: git.topLevel ?? null, state: git.state, drawn: drawable(git),
    payload: { ...raw, git: { ...git, stale: 0 } }, seq: typeof seq === "number" ? seq : null, at: typeof at === "number" ? at : null,
  });
}

/**
 * The last GitObserved of every card a connecting page cannot be replayed it
 * for: each whose event is newer than the page's last one (`after`) and has
 * already left the ring (older than `before`, its oldest). Only for the
 * `sessions` the page will draw a card for — the ones the ring still holds an
 * event of — and, for a page that has seen nothing yet, only a branch: it has
 * none to take back. Each as it was sent, its seq and its time, for the page
 * alone (withLostBehind in event-routes.mjs): sending it again would push it
 * to every page open and stamp it as just heard.
 *
 * @param {{ after: number, before: number, sessions: Set<string> }} range
 * @returns {Array<{ seq: number, receivedAt: number, payload: object }>}
 */
export function gitBehind({ after, before, sessions }) {
  const out = [];
  if (!enabled()) return out;
  for (const [sid, w] of watched) {
    if (!sessions.has(sid)) continue;
    for (const entry of w.sent.values()) {
      if (!entry.payload || entry.seq === null || entry.seq <= after || entry.seq >= before) continue;
      if (after === 0 && !entry.drawn) continue;
      out.push({ seq: entry.seq, receivedAt: entry.at ?? 0, payload: entry.payload });
    }
  }
  return out;
}

/**
 * Look again at the sessions heard from most recently — after the boot replay,
 * and when the switch is turned back on — so every card on a board gets its
 * branch without waiting for its session's next event.
 */
export function refreshGit(limit = REFRESH_SESSIONS) {
  if (!enabled()) return;
  for (const sid of recentSessions(limit)) schedule(sid, watching(sid), FIRST_LOOK_MS);
}

/** The switch was pressed. Off forgets what the page was told, so turning it
 *  back on tells it everything again. */
export function gitSwitched(on) {
  clearGitWatch();
  if (on) refreshGit();
}

/** Forget what was sent for a session, so the next event sends it again — the
 *  page no longer has it. See forgetSession in session-tracking.mjs. */
export function forgetGitSession(sid) {
  const w = watched.get(sid);
  if (w?.timer) clearTimeout(w.timer);
  watched.delete(sid);
}

/** Forget every session, for a Clear. */
export function clearGitWatch() {
  for (const w of watched.values()) if (w.timer) clearTimeout(w.timer);
  watched.clear();
}

/** Whether looks happen at all; the setting that switches the git view off
 *  replaces it. */
export function setGitWatchEnabled(fn) {
  enabled = typeof fn === "function" ? fn : () => true;
}
