// GitObserved: what the page is told about each session's repository, and when.
//
// Every live event with a folder lets the deck notice a session's repository
// once; after that, the events that can change a repository — an agent's
// finished Edit, Write, MultiEdit, NotebookEdit or Bash call, and any finished
// Codex tool call (its patches and its commands) — mark it stale
// (git-state.mjs) and schedule a fresh look. The look reads the folder's
// repository and HEAD, and sends
//
//   { hook_event_name: "GitObserved", session_id, provider?: "codex",
//     git: { subagent?, state, stale, topLevel?, name?, mainName?, folderName?,
//            nameDiffers?, linkedWorktree?, branch?, detached?, sha?, unborn?,
//            empty? } }
//
// for the session's root and for each subagent whose folder is not the
// root's (`git.subagent` is its key). `state` is "repo" or why there is none
// ("not-a-repo", "gone", "no-git", "bare", "unsafe"); a read that timed out
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
// Like the transcript scans' events, these are last-value-wins state
// (LAST_VALUE_WINS in ring-bounds.mjs): the ring does not count them against
// the hook events it keeps.
import { pushEvent } from "./event-sink.mjs";
import { sessionFolder, sessionSubagents } from "./git-sessions.mjs";
import { markStale, repoOf } from "./git-state.mjs";

/** The tools whose finished call can change a repository. */
const CHANGING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
const FINISHED = new Set(["PostToolUse", "PostToolUseFailure"]);
/** The states worth telling the page; the rest are a read that went wrong. */
const DEFINITE = new Set(["repo", "not-a-repo", "gone", "no-git", "bare", "unsafe"]);

export const FIRST_LOOK_MS = 250;
export const AFTER_COMMAND_MS = 600;
export const AFTER_EDIT_MS = 2_000;

const watched = new Map(); // sid -> { timer, due, seen: Set<key>, sent: Map<key, { sig, stale, top }> }
let enabled = () => true;
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
const mayMoveHead = (raw) => raw.provider === "codex" || raw.tool_name === "Bash";

/**
 * One live event, from pushEvent. Never throws, never waits.
 */
export function noteGitEvent(raw) {
  try {
    if (!raw || typeof raw !== "object" || !enabled()) return;
    const sid = raw.session_id;
    if (typeof sid !== "string" || sid === "" || typeof raw.cwd !== "string" || raw.cwd === "") return;
    let w = watched.get(sid);
    if (!w) {
      w = { timer: null, due: Infinity, seen: new Set(), sent: new Map() };
      watched.set(sid, w);
      while (watched.size > MAX_WATCHED) forgetGitSession(watched.keys().next().value);
    }
    if (changesRepo(raw)) {
      const tops = [...new Set([...w.sent.values()].map((s) => s.top).filter(Boolean))];
      markStale(raw.cwd, tops);
      schedule(sid, w, mayMoveHead(raw) ? AFTER_COMMAND_MS : AFTER_EDIT_MS);
    }
    // The session, or one of its subagents, not looked at yet.
    if (!w.seen.has(subagentKeyOf(raw) ?? "")) schedule(sid, w, FIRST_LOOK_MS);
  } catch { /* the event path must never fail for this */ }
}

const subagentKeyOf = (p) => [p.agent_id, p.parent_tool_use_id].find((k) => typeof k === "string" && k) ?? null;

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
    const sig = signature(git);
    const prev = w.sent.get(key);
    if (prev && prev.sig === sig && prev.stale === git.stale) continue;
    const identity = !prev || prev.sig !== sig;
    if (identity && prev && git.topLevel) moved.add(git.topLevel);
    w.sent.set(key, { sig, stale: git.stale, top: git.topLevel ?? null, state: git.state });
    // A folder that is not a repository is the common case, and a card with no
    // branch needs no event to say so; only a branch the page was shown is
    // taken back.
    if (git.state !== "repo" && prev?.state !== "repo") continue;
    pushEvent({
      hook_event_name: "GitObserved",
      session_id: sid,
      ...(root.provider === "codex" ? { provider: "codex" } : {}),
      git: key ? { subagent: key, ...git } : git,
    }, "internal", identity ? {} : { persist: false });
  }
  // A checkout in a folder other sessions share moves their HEAD too.
  if (moved.size) {
    for (const [other, ow] of watched) {
      if (other === sid) continue;
      if ([...ow.sent.values()].some((s) => s.top && moved.has(s.top))) schedule(other, ow, AFTER_COMMAND_MS);
    }
  }
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
