// What the git view and the glance say, worked out apart from how they draw
// it: the branch's standing against its upstream, the collisions that concern
// the agent in view, who made a commit and how the deck knows, and the one
// line a pane says when there is no repository to show.
import type { CommitAgent, GitReadState, GraphFocus, Repo } from "./git-view-types";
import type { GitCollisionRef, GitCollisions } from "./types";

/** The branch against its upstream, as of the last fetch somebody made. */
export function upstreamWords(repo: Pick<Repo, "upstream" | "head"> | null): { text: string; title: string; word: boolean } | null {
  if (!repo || repo.head.detached) return null;
  const u = repo.upstream;
  if (!u) return { text: "no upstream", title: "This branch has no upstream yet.", word: true };
  if (u.gone) return { text: "upstream gone", title: `Its upstream ${u.name} no longer exists on the remote, as of the last fetch.`, word: true };
  const parts = [u.ahead ? `↑${u.ahead}` : "", u.behind ? `↓${u.behind}` : ""].filter(Boolean);
  return {
    text: parts.length ? parts.join(" ") : "up to date",
    title: `Against ${u.name}, as of the last fetch. ccdeck never fetches.`,
    word: parts.length === 0,
  };
}

/** A collision with another agent, from the side of the agent in view. */
export interface Collision {
  level: "sharp" | "quiet";
  with: GitCollisionRef;
  /** Sharp: the files both edited since they were last committed. */
  files: string[];
  reason?: "same-worktree" | "same-branch";
}

/** The collisions that concern the focus: the whole team's from a main node,
 *  one subagent's when narrowed. Sharp first, one entry per other agent. */
export function collisionsFor(c: GitCollisions | undefined, focus: GraphFocus): Collision[] {
  if (!c) return [];
  const mine = (agentId: string | null) => focus.agentIds == null || (agentId != null && focus.agentIds.includes(agentId));
  const key = (r: GitCollisionRef) => `${r.sessionId}|${r.agentId ?? ""}`;
  const out = new Map<string, Collision>();
  for (const s of c.sharp) {
    if (!mine(s.agentId)) continue;
    const k = key(s.with);
    const had = out.get(k);
    out.set(k, { level: "sharp", with: s.with, files: [...new Set([...(had?.files ?? []), ...s.files])] });
  }
  for (const q of c.quiet) {
    if (!mine(q.agentId) || out.has(key(q.with))) continue;
    out.set(key(q.with), { level: "quiet", with: q.with, files: [], reason: q.reason });
  }
  return [...out.values()];
}

/** The card id of the other agent in a collision. */
export const collisionCardId = (r: GitCollisionRef) => (r.agentId ? `${r.sessionId}::${r.agentId}` : r.sessionId);

/** The mark a commit carries, and the words for it. */
export type MarkLevel = "seen" | "trailer" | "round";
export function commitMark(agent: CommitAgent | null): { level: MarkLevel; words: string } {
  if (!agent) return { level: "round", words: "no agent seen" };
  if (agent.confidence === "trailer") return { level: "trailer", words: "from the commit message" };
  if (agent.confidence === "matched") return { level: "seen", words: "seen by ccdeck, matched after a rewrite" };
  return { level: "seen", words: "seen by ccdeck" };
}

/** Who made a commit, in words: the agent's card name (a Codex session and an
 *  unnamed agent carry no label of their own), or the CLI a trailer names. */
export function commitWho(agent: CommitAgent | null, cardLabel: (id: string) => string | null): string | null {
  if (!agent) return null;
  if (agent.confidence === "trailer") return agent.agent === "codex" ? "Codex" : "Claude";
  const id = agent.agentId ? `${agent.sessionId}::${agent.agentId}` : agent.sessionId;
  return agent.label ?? cardLabel(id) ?? cardLabel(agent.sessionId);
}

/** The one line a pane says when the folder has no repository to show; the
 *  folder, when the line names it, is set apart as a path. */
export function readStateLine(state: GitReadState | "loading" | "off", folder: string | null): { folder?: string; lead: string; rest: string } | null {
  const named = (lead: string, rest = "") => (folder ? { folder, lead, rest } : { lead: `This folder ${lead}`, rest });
  switch (state) {
    case "repo": case "loading": return null;
    case "not-a-repo": return named("is not a git repository.");
    case "gone": return { lead: "This session's folder no longer exists.", rest: "Its commits stay marked in the repositories they went to." };
    case "no-git": return { lead: "git was not found on this machine,", rest: "so branches and changes cannot be read." };
    case "bare": return named("is a bare repository.", "It has no working tree to show.");
    case "unsafe": return named("belongs to another user, so git will not read it.", "ccdeck changes no git setting to get round that.");
    case "timeout": return { lead: "git took too long to answer.", rest: "It is read again when an agent next changes the repository." };
    case "off": return { lead: "Git is switched off in Settings.", rest: "" };
    case "error": default: return { lead: "git could not read this repository.", rest: "" };
  }
}

/** A commit's age the way a dense row says it: `now`, `4m`, `3h`, `2d`. */
export function shortAge(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** A conventional prefix (`feat(api):`) split from the rest of a subject, so
 *  it can be set in bold on the agent's own rows. */
export function subjectParts(subject: string): { prefix: string; rest: string } {
  const m = /^([a-z]+(?:\([^)]{1,40}\))?!?:)\s(.*)$/.exec(subject);
  return m ? { prefix: m[1], rest: m[2] } : { prefix: "", rest: subject };
}
