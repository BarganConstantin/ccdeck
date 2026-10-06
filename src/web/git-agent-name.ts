// What every git surface calls an agent — the card's collision mark, the git
// view's history rows and its scope, its Uncommitted row, the files' group
// header and tags, the glance, the collision lines and the commit card — so
// the same agent reads the same everywhere, and the way the canvas tells it
// apart.
//
// A session goes by the name Claude Code gave it when it has one — short, and
// the cluster header shows it — and otherwise by its workspace, the card's
// label (a Codex session, a Claude session not named yet). Agents that collide
// or share a history usually share that workspace too, so a session that would
// read like another is told apart by the last characters of its id, the tail
// its cluster header shows ("web-app · 3893"). A subagent goes by its own
// label, its type, with its key's tail when its session has another of that
// type; the surfaces that set it apart write `↳` before it.
import { distinctIdTail } from "./session-id-tail";
import type { AgentNodeData, GitCollisionRef } from "./types";

/** The fields of a card the names are read from. */
export type NamedCard = Pick<AgentNodeData, "id" | "sessionId" | "kind" | "label"> & Partial<Pick<AgentNodeData, "sessionName">>;

/** A session's main thread (`agentId` null) or one of its subagents, by the
 *  name its card goes by; null when its card is not on the board, and the
 *  caller falls back to what the server sent. */
export type AgentNamer = (sessionId: string, agentId: string | null) => string | null;

/** What a session calls itself before it is told apart from another. */
const ownName = (card: NamedCard) => card.sessionName?.trim() || card.label;

/** Who a card has to be told apart from, by id: the sessions that would read
 *  the same as it, or its session's subagents of the same type. */
interface Peers {
  /** Sessions by the name Claude Code gave them. */
  named: Map<string, string[]>;
  /** Sessions by their workspace, named or not: the set the cluster header
   *  takes its id tail against. */
  workspace: Map<string, string[]>;
  /** Subagents by session and type, by their keys. */
  subs: Map<string, string[]>;
}

const subKeyOf = (card: NamedCard) => (card.id.startsWith(`${card.sessionId}::`) ? card.id.slice(card.sessionId.length + 2) : card.id);
const subGroup = (card: NamedCard) => `${card.sessionId}\u0000${card.label}`;
const push = (m: Map<string, string[]>, k: string, v: string) => { const at = m.get(k); if (at) at.push(v); else m.set(k, [v]); };

function peersOf(agents: Iterable<NamedCard>): Peers {
  const p: Peers = { named: new Map(), workspace: new Map(), subs: new Map() };
  for (const a of agents) {
    if (a.kind === "subagent") { push(p.subs, subGroup(a), subKeyOf(a)); continue; }
    if (a.kind !== "root") continue;
    push(p.named, ownName(a), a.sessionId);
    push(p.workspace, a.label, a.sessionId);
  }
  return p;
}

/**
 * A card's name on a board. A named session is told apart only from another
 * of the same name. One with no name goes by its workspace, as its cluster
 * header does, and like the header takes the id's tail whenever another
 * session on the board works in that workspace, named or not — so a Codex
 * session beside a named Claude one never reads as the other card's own title.
 * Two subagents of one session of the same type are told apart the same way,
 * by their own keys' tails.
 */
function nameWith(card: NamedCard, peers: Peers): string {
  if (card.kind === "subagent") {
    const same = peers.subs.get(subGroup(card)) ?? [];
    return same.length > 1 ? `${card.label} · ${distinctIdTail(subKeyOf(card), same)}` : card.label;
  }
  const name = ownName(card);
  const same = (card.sessionName?.trim() ? peers.named.get(name) : peers.workspace.get(card.label)) ?? [];
  return same.length > 1 ? `${name} · ${distinctIdTail(card.sessionId, same)}` : name;
}

const cardIdOf = (sessionId: string, agentId: string | null) => (agentId ? `${sessionId}::${agentId}` : sessionId);

/** Every agent's name on a board, worked out once: for a surface that names
 *  many agents in one pass (every card's collision mark). */
export function agentNamer(agents: Iterable<NamedCard>): AgentNamer {
  const byId = new Map<string, NamedCard>();
  for (const a of agents) byId.set(a.id, a);
  const peers = peersOf(byId.values());
  return (sessionId, agentId) => {
    const card = byId.get(cardIdOf(sessionId, agentId));
    return card ? nameWith(card, peers) : null;
  };
}

/** One agent's name, read off the board as it is now. */
export function agentNameIn(agents: ReadonlyMap<string, NamedCard>, sessionId: string, agentId: string | null): string | null {
  const card = agents.get(cardIdOf(sessionId, agentId));
  return card ? nameWith(card, peersOf(agents.values())) : null;
}

/** Each agent a history's commits were seen made by, once, in the order the
 *  history first lists them: the names its chips carry. */
export function commitAgentKeys(commits: readonly { agent?: object | null }[] | null | undefined): [string, string | null][] {
  const out: [string, string | null][] = [];
  const seen = new Set<string>();
  for (const c of commits ?? []) {
    const a = c.agent as { sessionId?: unknown; agentId?: unknown } | null | undefined;
    if (!a || typeof a.sessionId !== "string") continue;
    const agentId = typeof a.agentId === "string" ? a.agentId : null;
    const k = `${a.sessionId}\u0000${agentId ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([a.sessionId, agentId]);
  }
  return out;
}

/** A card's own name on the board it is on. */
export function cardName(agents: ReadonlyMap<string, NamedCard>, card: NamedCard): string {
  return agents.has(card.id) ? nameWith(card, peersOf(agents.values())) : card.kind === "subagent" ? card.label : ownName(card);
}

/** The other agent of a collision, as its mark on a card and its line in the
 *  git view say it: `↳ name` for a subagent, "a subagent of …" when that
 *  card has left the board, "another agent" when nothing of it is left. */
export function otherAgentName(name: AgentNamer, r: GitCollisionRef): string {
  if (r.agentId) {
    const sub = name(r.sessionId, r.agentId);
    if (sub) return `↳ ${sub}`;
    const session = name(r.sessionId, null);
    return session ? `a subagent of ${session}` : "another agent";
  }
  return name(r.sessionId, null) ?? "another agent";
}

/** The card a press on a collision goes to: the other agent's, or its
 *  session's when that subagent's card has left the board. */
export function collisionTarget(agents: ReadonlyMap<string, unknown>, r: GitCollisionRef): string {
  const id = cardIdOf(r.sessionId, r.agentId);
  return agents.has(id) || !agents.has(r.sessionId) ? id : r.sessionId;
}
