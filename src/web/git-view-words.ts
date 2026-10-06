// What the git view and the glance say, worked out apart from how they draw
// it: the branch's standing against its upstream, the collisions that concern
// the agent in view, who made a commit and how the deck knows, and the one
// line a pane says when there is no repository to show.
import type { CommitAgent, GitReadState, GraphFocus, Repo } from "./git-view-types";
import type { AgentNodeData, GitCollisionRef, GitCollisions } from "./types";

/** When the agent's work really ended, or undefined while it may go on. A
 *  session's root ends only with the session (a SessionEnd, or the deck giving
 *  up on it): its `endedAt` says just that its last turn finished, which is
 *  true of an idle terminal about to be typed into. A subagent is done when it
 *  stopped. */
export function endedAt(agent: Pick<AgentNodeData, "kind" | "state" | "endedAt" | "closedAt">): number | undefined {
  if (agent.kind === "root") return agent.closedAt;
  return agent.state === "done" ? agent.endedAt : undefined;
}

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
  /** Who on the focus's side it is about: null for the session's main
   *  thread, a subagent's key for that subagent. From a main node several
   *  agents of the team can collide with the same other agent. */
  by: (string | null)[];
}

/** The collisions that concern the focus: the whole team's from a main node,
 *  one subagent's when narrowed. Sharp first, one entry per other agent. */
export function collisionsFor(c: GitCollisions | undefined, focus: GraphFocus): Collision[] {
  if (!c) return [];
  const mine = (agentId: string | null) => focus.agentIds == null || (agentId != null && focus.agentIds.includes(agentId));
  const key = (r: GitCollisionRef) => `${r.sessionId}|${r.agentId ?? ""}`;
  const out = new Map<string, Collision>();
  const by = (had: Collision | undefined, agentId: string | null) => (had?.by.includes(agentId) ? had.by : [...(had?.by ?? []), agentId]);
  for (const s of c.sharp) {
    if (!mine(s.agentId)) continue;
    const k = key(s.with);
    const had = out.get(k);
    out.set(k, { level: "sharp", with: s.with, files: [...new Set([...(had?.files ?? []), ...s.files])], by: by(had, s.agentId) });
  }
  for (const q of c.quiet) {
    if (!mine(q.agentId)) continue;
    const k = key(q.with);
    const had = out.get(k);
    if (had?.level === "sharp") continue;
    out.set(k, { level: "quiet", with: q.with, files: [], reason: had?.reason ?? q.reason, by: by(had, q.agentId) });
  }
  return [...out.values()];
}

/** A collision as the agent in view speaks for it. `who`: the session's own
 *  subagents it is about when the agent in view is not party to it, named
 *  before the other agent so a main thread never claims a subagent's
 *  collision as its own. `away`: theirs is about a folder of their own, not
 *  the one in view. */
export interface FocusCollision extends Collision {
  who: string[];
  away: boolean;
}

/**
 * The collisions the focus speaks for, sharp first and its own first — as the main card's
 * collision mark speaks for them (git-card-mark.ts). Narrowed to one
 * subagent, each is its own. From a main node the team's own come first: its
 * main thread's, and those of subagents working in its folder. Then two of
 * the session's own agents on one file, as one pair named both. Last, those
 * of subagents working in a folder of their own, each named.
 * `worksElsewhere` says which of the session's subagents have a folder of
 * their own.
 */
export function focusCollisions(c: GitCollisions | undefined, focus: GraphFocus, worksElsewhere: (agentId: string) => boolean): FocusCollision[] {
  const list = collisionsFor(c, focus);
  if (focus.agentIds != null) return list.map(x => ({ ...x, who: [], away: false }));
  const own: FocusCollision[] = [], away: FocusCollision[] = [];
  const pairs = new Map<string, FocusCollision>();
  for (const x of list) {
    const members = x.by.filter((k): k is string => k != null);
    if (x.with.sessionId === focus.sessionId) {
      // The server says a pair from both sides: one entry for the two.
      const two = x.with.agentId;
      if (!two || !members.length) continue;
      const k = [members[0], two].sort().join("|");
      const had = pairs.get(k);
      pairs.set(k, { ...x, files: [...new Set([...(had?.files ?? []), ...x.files])], who: had?.who ?? [members[0]], with: had?.with ?? x.with, away: false });
    } else if (x.by.includes(null) || !members.some(worksElsewhere)) own.push({ ...x, who: [], away: false });
    else away.push({ ...x, who: members, away: true });
  }
  // Sharp wins the line, as it wins the card's row; within a level, the
  // team's own first.
  return [...own, ...pairs.values(), ...away].sort((a, b) => (a.level === b.level ? 0 : a.level === "sharp" ? -1 : 1));
}

/** "a", "a and b", "a, b and c". */
export function andList(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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

/** Who made a commit, in words: the name its card goes by on the board
 *  (git-agent-name.ts), else the label the server recorded, else its
 *  session's card (a Codex session and an unnamed agent carry no label of
 *  their own) — or the CLI a trailer names. */
export function commitWho(agent: CommitAgent | null, cardName: (sessionId: string, agentId: string | null) => string | null): string | null {
  if (!agent) return null;
  if (agent.confidence === "trailer") return agent.agent === "codex" ? "Codex" : "Claude";
  return cardName(agent.sessionId, agent.agentId) ?? agent.label ?? cardName(agent.sessionId, null);
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
