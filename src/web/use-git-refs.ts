// The sidebar's lists for a session's repository (GET /api/git/refs): its
// branches, remotes, tags, stashes, worktrees and submodules.
//
// One read per session (and subagent), asked for when the sidebar first shows
// it and again only when the stale counter the view passes in moves — the
// same counter every other read of the repository answers to. Nothing polls.
// The last answer stays on screen while the next one is read, so the tree
// never empties and refills under the reader; a failed refresh keeps it too.
import { useEffect, useState } from "react";

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

/** The last answer per session and subagent, so a sidebar shown again opens
 *  on it rather than on nothing. A few repositories' worth. */
const kept = new Map<string, { stale: number; data: GitRefsData }>();
const KEEP = 8;

export function useGitRefs({ sessionId, agent, stale, enabled = true }: {
  sessionId: string | null;
  agent: string | null;
  stale: number;
  enabled?: boolean;
}): GitRefsData {
  const key = sessionId ? `${sessionId}|${agent ?? ""}` : null;
  const [data, setData] = useState<GitRefsData>(() => (key ? kept.get(key)?.data : null) ?? EMPTY_REFS);
  // Another session: what it last said, or nothing yet.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setData((key ? kept.get(key)?.data : null) ?? EMPTY_REFS);
  }
  useEffect(() => {
    if (!enabled || !key || !sessionId) return;
    const was = kept.get(key);
    if (was && was.stale === stale && was.data.state !== "loading") return;
    let gone = false;
    fetch(`/api/git/refs?${gitQuery(sessionId, agent)}`)
      .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))
      .catch(() => ({ status: 0, body: { error: "the deck did not answer" } }))
      .then(({ status, body }) => {
        if (gone) return;
        setData(prev => {
          const next = foldRefs(prev, status, body ?? {});
          // A read that failed is asked again by the next sidebar to show it.
          const answered = status === 200 && !next.reason;
          kept.delete(key);
          kept.set(key, { stale: answered ? stale : -1, data: next });
          while (kept.size > KEEP) kept.delete(kept.keys().next().value!);
          return next;
        });
      });
    return () => { gone = true; };
  }, [enabled, key, stale]);
  return data;
}
