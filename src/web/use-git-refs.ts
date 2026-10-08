// The sidebar's lists for a session's repository (GET /api/git/refs): its
// branches, remotes, tags, stashes, worktrees and submodules.
//
// One read per session (and subagent), asked for when the sidebar first shows
// it and again when the stale counter the view passes in moves — the same
// counter every other read of the repository answers to — when the view
// follows the session to another worktree, and when a sidebar just shown
// would open on an answer older than REFS_FRESH_MS, as the history does.
// Nothing polls. The last answer stays on screen while the next one is read,
// so the tree never empties and refills under the reader; a failed refresh
// keeps it too. Another worktree's answer is never shown for this one.
import { useCallback, useEffect, useState } from "react";

import type { GitReadState, GitRefs } from "./git-view-types";
import { gitQuery } from "./use-git-view";

export interface GitRefsData {
  /** "loading" before the first answer; "off" while git is switched off. */
  state: GitReadState | "loading" | "off";
  refs: GitRefs | null;
  /** Why the last read failed, when it did. */
  reason: string | null;
}

export const EMPTY_REFS: GitRefsData = { state: "loading", refs: null, reason: null };

/** The route's answer, folded into what the sidebar draws. `prev` is kept
 *  through a failed refresh. */
export function foldRefs(prev: GitRefsData, status: number, a: Partial<GitRefs> & { ok?: boolean; state?: GitReadState; reason?: string; error?: string }): GitRefsData {
  if (status === 409) return { state: "off", refs: null, reason: null };
  if (status >= 400 || a.error) return { ...prev, state: prev.refs ? prev.state : "error", reason: a.error ?? `HTTP ${status}` };
  if (a.state && a.state !== "repo") return { state: a.state, refs: null, reason: null };
  if (a.ok === false) return { ...prev, state: "repo", reason: a.reason ?? "error" };
  return {
    state: "repo",
    refs: {
      branches: a.branches ?? [],
      remotes: a.remotes ?? [],
      tags: a.tags ?? [],
      stashes: a.stashes ?? [],
      worktrees: a.worktrees ?? [],
      submodules: a.submodules ?? [],
      clipped: a.clipped ?? [],
      unread: a.unread ?? [],
    },
    reason: null,
  };
}

/** Whether an answer stands until the counter moves. A failure, or git
 *  timing out or erring on the folder itself, is asked again by the next
 *  sidebar to show it, and by Try again. */
export const refsAnswered = (status: number, next: GitRefsData) =>
  status === 200 && !next.reason && next.state !== "timeout" && next.state !== "error";

/** A sidebar just shown reads again over an answer older than this (ms):
 *  the history's own rule for a view just opened. */
export const REFS_FRESH_MS = 10_000;

/** The last answer for one session and subagent: the stale counter it
 *  answered for (-1 when it failed), the worktree it was read in, and when. */
export interface KeptRefs { stale: number; top: string | null; at: number; data: GitRefsData }

/**
 * Whether the sidebar reads the refs again over what it kept: nothing kept
 * yet, the counter moved, the view now reads another worktree than the one
 * the answer came from, or a sidebar just shown would open on an old answer.
 * A worktree not known yet on either side is not a move.
 */
export function refsWanted(was: KeptRefs | undefined, { stale, top, fresh, now }: { stale: number; top: string | null; fresh: boolean; now: number }): boolean {
  if (!was || was.data.state === "loading" || was.stale !== stale) return true;
  if (top && was.top && was.top !== top) return true;
  return fresh && now - was.at > REFS_FRESH_MS;
}

/** The last answer per session and subagent, so a sidebar shown again opens
 *  on it rather than on nothing. A few repositories' worth. */
const kept = new Map<string, KeptRefs>();
const KEEP = 8;

/** What is kept for `key` that can be shown for worktree `top`. */
const shownFor = (key: string | null, top: string | null) => {
  const was = key ? kept.get(key) : undefined;
  return was && !(top && was.top && was.top !== top) ? was.data : EMPTY_REFS;
};

export function useGitRefs({ sessionId, agent, stale, top = null, fresh = false, enabled = true }: {
  sessionId: string | null;
  agent: string | null;
  stale: number;
  /** The worktree the view reads now (its repo answer's top level): another
   *  one than the kept answer's reads again, and that answer is not shown. */
  top?: string | null;
  /** The sidebar was just shown: an answer older than REFS_FRESH_MS is read again. */
  fresh?: boolean;
  enabled?: boolean;
}): GitRefsData & { retry: () => void } {
  const key = sessionId ? `${sessionId}|${agent ?? ""}` : null;
  const [data, setData] = useState<GitRefsData>(() => shownFor(key, top));
  // Another session, or the view moved to another worktree: what was last
  // read there, or nothing yet.
  const at = `${key}\n${top ?? ""}`;
  const [shownAt, setShownAt] = useState(at);
  if (shownAt !== at) {
    setShownAt(at);
    setData(shownFor(key, top));
  }
  // Try again: bumped to ask once more after a failed read.
  const [again, setAgain] = useState(0);
  const retry = useCallback(() => setAgain(n => n + 1), []);
  // Moves from one known worktree to another, within one session. The first
  // one becoming known is not a move: the read already on its way answers for it.
  const [moved, setMoved] = useState({ key, top, n: 0 });
  if (moved.key !== key) setMoved({ key, top, n: moved.n });
  else if (top && top !== moved.top) setMoved({ key, top, n: moved.top ? moved.n + 1 : moved.n });
  useEffect(() => {
    if (!enabled || !key || !sessionId) return;
    if (!refsWanted(kept.get(key), { stale, top, fresh, now: Date.now() })) return;
    let gone = false;
    fetch(`/api/git/refs?${gitQuery(sessionId, agent)}`)
      .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))
      .catch(() => ({ status: 0, body: { error: "the deck did not answer" } }))
      .then(({ status, body }) => {
        if (gone) return;
        setData(prev => {
          const next = foldRefs(prev, status, body ?? {});
          kept.delete(key);
          kept.set(key, {
            stale: refsAnswered(status, next) ? stale : -1,
            top: typeof body?.repo?.topLevel === "string" ? body.repo.topLevel : null,
            at: Date.now(),
            data: next,
          });
          while (kept.size > KEEP) kept.delete(kept.keys().next().value!);
          return next;
        });
      });
    return () => { gone = true; };
  }, [enabled, key, stale, moved.n, fresh, again]);
  return { ...data, retry };
}
