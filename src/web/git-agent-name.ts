// What every git surface calls an agent — the card's collision mark, the git
// view's history rows and its scope, its Uncommitted row, the files' group
// header and tags, the glance, the collision lines and the commit card — so
// the same agent reads the same everywhere, and the way the canvas tells it
// apart.
//
// A session goes by the name Claude Code gave it when it has one — short, and
// the cluster header shows it — and otherwise by its workspace, the card's
// label (a Codex session, a Claude session not named yet). Agents that collide
// or share a history usually share that workspace too, so two sessions that
// would read the same are told apart by the last characters of their ids, the
// tail the cluster header shows ("web-app · 3893"). A subagent goes by its own
// label, its type; the surfaces that set it apart write `↳` before it.
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

function nameWith(card: NamedCard, peersOf: (name: string) => string[]): string {
  if (card.kind === "subagent") return card.label;
  const name = ownName(card);
  const same = peersOf(name);
  return same.length > 1 ? `${name} · ${distinctIdTail(card.sessionId, same)}` : name;
}

const cardIdOf = (sessionId: string, agentId: string | null) => (agentId ? `${sessionId}::${agentId}` : sessionId);

/** Every agent's name on a board, worked out once: for a surface that names
 *  many agents in one pass (every card's collision mark). */
export function agentNamer(agents: Iterable<NamedCard>): AgentNamer {
  const byId = new Map<string, NamedCard>();
  const peers = new Map<string, string[]>();
  for (const a of agents) {
    byId.set(a.id, a);
    if (a.kind !== "root") continue;
    const name = ownName(a);
    peers.set(name, [...(peers.get(name) ?? []), a.sessionId]);
  }
  return (sessionId, agentId) => {
    const card = byId.get(cardIdOf(sessionId, agentId));
    return card ? nameWith(card, name => peers.get(name) ?? []) : null;
  };
}

/** One agent's name, read off the board as it is now. */
export function agentNameIn(agents: ReadonlyMap<string, NamedCard>, sessionId: string, agentId: string | null): string | null {
  const card = agents.get(cardIdOf(sessionId, agentId));
  if (!card) return null;
  return nameWith(card, name => {
    const same: string[] = [];
    for (const a of agents.values()) if (a.kind === "root" && ownName(a) === name) same.push(a.sessionId);
    return same;
  });
}

/** A card's own name on the board it is on. */
export function cardName(agents: ReadonlyMap<string, NamedCard>, card: NamedCard): string {
  if (card.kind === "subagent") return card.label;
  return agentNameIn(agents, card.sessionId, null) ?? ownName(card);
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
