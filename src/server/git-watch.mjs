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
//            empty?, fromLog? } }
//
// for the session's root and for each subagent whose folder is not the
// root's (`git.subagent` is its key). `state` is "repo" or why there is none
// ("not-a-repo", "gone", "no-git", "bare", "unsafe") — sent only to take back
// a branch the page was already shown, since a card without one needs no
// event. The exception is a root whose folder is "gone": its own log still
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
import { pushEvent } from "./event-sink.mjs";
import { gitOn } from "./deck-prefs.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { recentSessions, sessionFolder, sessionSubagents, sessionTranscript } from "./git-sessions.mjs";
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

export const FIRST_LOOK_MS = 250;
export const AFTER_COMMAND_MS = 600;
export const AFTER_EDIT_MS = 2_000;

const watched = new Map(); // sid -> { timer, due, seen: Set<key>, sent: Map<key, { sig, stale, top, state, drawn, payload, seq, at }> }
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
    w = { timer: null, due: Infinity, seen: new Set(), sent: new Map() };
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
    if (!enabled()) return;
    const sid = raw.session_id;
    if (typeof sid !== "string" || sid === "" || typeof raw.cwd !== "string" || raw.cwd === "") return;
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
  const root = sessionFolder(sid);
  if (!w || !root || !enabled()) return;
  const targets = [["", root.cwd]];
  w.seen.add("");
  for (const [key, cwd] of sessionSubagents(sid)) {
    w.seen.add(key);
    if (cwd !== root.cwd) targets.push([key, cwd]);
  }
  const moved = new Set();
  for (const [key, cwd] of targets) {
    const repo = await repoOf(cwd);
    if (!DEFINITE.has(repo.state) || watched.get(sid) !== w) continue;
    const git = describeRepo(repo);
    // A deleted folder still names the branch its session last ran on, from
    // the session's own log — the root's only; a subagent keeps no log of one.
    if (git.state === "gone" && !key) {
      const branch = await loggedBranch(sid, root.provider);
      if (branch) Object.assign(git, { branch, fromLog: true });
    }
    const sig = signature(git);
    const prev = w.sent.get(key);
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
