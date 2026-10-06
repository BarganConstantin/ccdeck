// The collision mark on a card: which agent this card can step on in git right
// now, said in one row the card can spare, and the card a press on it goes to.
//
// The server works the collisions out (src/server/git-collisions.mjs) and the
// page keeps them on the session's root card (git-events.ts). A card reads them
// the way the git view and its glance do (collisionsFor): a session's main
// card speaks for the whole team, a subagent's card for itself. Two levels,
// never blended. QUIET: the two share a working tree, or the same branch in two
// worktrees; often meant, so a calm muted row. SHARP: both edited the same file
// since it was last committed, while both run; a row in the error colour that
// names the file. Sharp wins the row; the quiet ones it covers go in its
// tooltip.
//
// The main card says what is the team's own as its own: its main thread's
// collisions, and those of subagents working in its folder. A subagent in a
// folder of its own is named in front of the other agent, with its own folder
// ("↳ docs-sync shares folder with web-ui"), and two of its subagents on one
// file are named both ("edited by ↳ writer-one and ↳ writer-two"), so the main
// card never says it shares a folder it does not, nor collided with its own.
//
// A subagent working in its session's own folder that did not edit the file
// itself still shares the danger with the session it works for: its card says
// so, "· in this session", and only while it runs. One in a folder of its own
// is about its own folder only.
//
// Pure. Built once per board revision for every card (canvas-flow.ts), and a
// mark that says the same thing as before keeps its identity, so a card with a
// mark re-renders for it only when the mark changes.
import { agentNamer, otherAgentName } from "./git-agent-name";
import { collisionCardId, collisionsFor, type Collision } from "./git-view-words";
import type { AgentNodeData, GitCollisionRef } from "./types";

export interface CardMark {
  level: "sharp" | "quiet";
  /** The card a press on the mark goes to: the first other agent's. */
  target: string;
  /** Sharp: the file's name, or "2 files". Quiet: nothing. Set first, in bold. */
  lead: string;
  /** The rest of the sentence, the part that gives way first:
   *  "also edited by web-bugfix", "shares folder with web-bugfix". */
  said: string;
  /** What never gives way: "+1" for more agents, "· in this session". */
  tail: string;
  /** Every agent and file, in sentences: the tooltip. */
  title: string;
  /** The row in one line, for the zoomed-out face's tooltip and the card's
   *  accessible name: "src/app.ts also edited by web-bugfix". */
  words: string;
  /** Sharp, from the session's other agents rather than this subagent's own
   *  files. */
  session: boolean;
}

/** The fields of a card this reads. */
export type MarkAgent = Pick<AgentNodeData, "id" | "sessionId" | "kind" | "label" | "state" | "cwd" | "git" | "gitCollisions" | "sessionName">;

/**
 * The mark every card on the board carries, by card id; a card with nothing
 * to say is absent. `prev` is the last board's answer: an entry that still says
 * the same thing is handed back as it was.
 */
export function cardMarks(agents: Iterable<MarkAgent>, prev?: ReadonlyMap<string, CardMark>): Map<string, CardMark> {
  const byId = new Map<string, MarkAgent>();
  for (const a of agents) byId.set(a.id, a);
  // The other agent is named as every git surface names it (git-agent-name.ts).
  const namer = agentNamer(byId.values());
  const names = (r: GitCollisionRef) => otherAgentName(namer, r);
  const out = new Map<string, CardMark>();
  for (const a of byId.values()) {
    const root = a.kind === "root" ? a : byId.get(a.sessionId);
    const c = root?.gitCollisions;
    if (!c) continue;
    const mark = markFor(a, c, names, byId);
    if (!mark) continue;
    const was = prev?.get(a.id);
    out.set(a.id, was && sameMark(was, mark) ? was : mark);
  }
  return out;
}

function markFor(a: MarkAgent, c: NonNullable<AgentNodeData["gitCollisions"]>, names: (r: GitCollisionRef) => string,
  byId: ReadonlyMap<string, MarkAgent>): CardMark | null {
  if (a.kind !== "subagent") {
    const team = teamEntries(a.sessionId, c, byId);
    return team.length ? said(a, team, false, names, byId) : null;
  }
  const key = subKey(a);
  if (!key) return null;
  const own = collisionsFor(c, { sessionId: a.sessionId, agentIds: [key] });
  if (own.length) return said(a, own.map(x => ({ ...x, who: [] })), false, names, byId);
  // A subagent in its session's folder, still running, while the session's
  // other agents collide there: the danger is its session's. Not one that a
  // teammate in a folder of its own has.
  if (a.git || a.state !== "active") return null;
  const team = teamEntries(a.sessionId, c, byId).filter(x => x.level === "sharp" && !x.away);
  return team.length ? said(a, team, true, names, byId) : null;
}

/** A collision as a card says it. `who` names the session's own agents that
 *  are party to it when the card's own agent is not — written before the other
 *  agent, so the main card never claims a subagent's collision as its own. */
interface Entry extends Collision {
  who: string[];
  /** In a folder other than the session's: a teammate's, worked elsewhere. */
  away?: boolean;
  /** Two of the session's own subagents. */
  inTeam?: boolean;
}

/**
 * The session's collisions as its main card speaks for them, its own first.
 * Its main thread's, and those of subagents working in its folder, are the
 * team's own. A subagent in a folder of its own is named before the other
 * agent, with its folder. Two of its subagents on one file are one pair,
 * named both.
 */
function teamEntries(sessionId: string, c: NonNullable<AgentNodeData["gitCollisions"]>, byId: ReadonlyMap<string, MarkAgent>): Entry[] {
  const own: Entry[] = [];
  const away: Entry[] = [];
  for (const x of collisionsFor(c, { sessionId, agentIds: null })) {
    // The session's own pairs come once each, below.
    if (x.with.sessionId === sessionId) continue;
    const members = x.by.filter((k): k is string => k != null);
    if (x.by.includes(null) || !members.some(k => worksElsewhere(byId.get(`${sessionId}::${k}`)))) own.push({ ...x, who: [] });
    else away.push({ ...x, who: members, away: true });
  }
  const pairs = new Map<string, Entry>();
  for (const s of c.sharp) {
    if (s.with.sessionId !== sessionId || !s.agentId || !s.with.agentId || s.agentId === s.with.agentId) continue;
    const [one, two] = [s.agentId, s.with.agentId].sort();
    const k = `${one}|${two}`;
    const had = pairs.get(k);
    pairs.set(k, {
      level: "sharp", with: { sessionId, agentId: two }, files: [...new Set([...(had?.files ?? []), ...s.files])],
      by: [one], who: [one], inTeam: true,
    });
  }
  return [...own, ...pairs.values(), ...away];
}

/** A subagent with a folder of its own: the server reads git for it apart
 *  from its session only then (git-chip.ts). */
const worksElsewhere = (card: MarkAgent | undefined) => card?.git != null;

function said(a: MarkAgent, list: Entry[], session: boolean, names: (r: GitCollisionRef) => string,
  byId: ReadonlyMap<string, MarkAgent>): CardMark {
  const sharp = list.filter(x => x.level === "sharp");
  const quiet = list.filter(x => x.level === "quiet");
  const level = sharp.length ? "sharp" : "quiet";
  const shown = level === "sharp" ? sharp : quiet;
  const first = shown[0];
  const member = (k: string) => names({ sessionId: a.sessionId, agentId: k });
  const parties = (x: Entry) => andList([...x.who.map(member), names(x.with)]);
  const more = shown.length > 1 ? `+${shown.length - 1}` : "";
  const lines: string[] = [];
  let lead = "", line: string, words: string;
  if (level === "sharp") {
    lead = first.files.length === 1 ? baseName(first.files[0]) : `${first.files.length} files`;
    line = sharpSaid(first, parties(first));
    words = `${first.files.length === 1 ? first.files[0] : lead} ${line}`;
    for (const s of sharp) {
      const n = s.files.length;
      const files = n === 1 ? s.files[0] : `${n} files (${s.files.join(", ")})`;
      const where = s.away ? folderOf(a, s, byId) : null;
      const how = s.who.length ? `edited by ${s.who.length === 1 ? "both " : ""}${parties(s)}` : sharpSaid(s, parties(s));
      lines.push(`${files} ${how} since ${n === 1 ? "it was" : "they were"} last committed${where ? `, in ${where}` : ""}.`);
    }
    lines.push(sharp.length > 1 ? "All of them are running." : "Both are running.");
    if (session) lines.push("In this session, not in this subagent's own files.");
    for (const q of quiet) lines.push(`Also ${quietSentence(q, names(q.with), q.who.map(member), folderOf(a, q, byId))}`);
  } else {
    line = quietSaid(first, names(first.with), first.who.map(member));
    words = line;
    for (const q of quiet) lines.push(quietSentence(q, names(q.with), q.who.map(member), folderOf(a, q, byId)));
  }
  // A pair of the session's own goes to the first of the two; any other, to
  // the other agent.
  const goTo = first.inTeam ? { sessionId: a.sessionId, agentId: first.who[0] } : first.with;
  lines.push(`Select ${names(goTo)}.`);
  return {
    level,
    target: cardOf(goTo, byId),
    lead,
    said: line,
    tail: [more, session ? "· in this session" : ""].filter(Boolean).join(" "),
    title: lines.join("\n"),
    words: [words, more, session ? "in this session" : ""].filter(Boolean).join(" "),
    session,
  };
}

/** The sharp row's words: "also edited by …" when the card's own agent is one
 *  of the two, else both named. */
const sharpSaid = (x: Entry, parties: string) => (x.who.length ? `edited by ${parties}` : `also edited by ${parties}`);

/** The quiet row's words: "shares folder with …", "same branch as …", with the
 *  teammate it is about in front when it is not the card's own agent. */
function quietSaid(q: Collision, name: string, who: string[] = []): string {
  if (!who.length) return q.reason === "same-branch" ? `same branch as ${name}` : `shares folder with ${name}`;
  const them = andList(who);
  return q.reason === "same-branch" ? `${them} on the same branch as ${name}` : `${them} ${who.length > 1 ? "share" : "shares"} folder with ${name}`;
}

/** A quiet collision in the tooltip: the row's own words, then where. Each
 *  tooltip line starts from what the row says, so a row cut short is whole in
 *  its tooltip. */
function quietSentence(q: Collision, name: string, who: string[], folder: string | null): string {
  if (q.reason === "same-branch") return `${quietSaid(q, name, who)}, in another folder.`;
  return `${quietSaid(q, name, who)}${folder ? ` (${folder})` : ""}.`;
}

/** The folder of the agent on this card's side: the teammate's own when the
 *  entry is a teammate's, else the card's. */
function folderOf(a: MarkAgent, x: Entry, byId: ReadonlyMap<string, MarkAgent>): string | null {
  const mate = x.who.length ? byId.get(`${a.sessionId}::${x.who[0]}`) : undefined;
  const at = mate ?? a;
  return at.git?.topLevel ?? at.cwd ?? null;
}

/** "a", "a and b", "a, b and c". */
function andList(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The card a press goes to: the other agent's, or its session's when that
 *  subagent's card has left the board. */
function cardOf(r: GitCollisionRef, byId: ReadonlyMap<string, MarkAgent>): string {
  const id = collisionCardId(r);
  return byId.has(id) || !byId.has(r.sessionId) ? id : r.sessionId;
}

const subKey = (a: MarkAgent) => (a.id.startsWith(`${a.sessionId}::`) ? a.id.slice(a.sessionId.length + 2) : null);
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

const sameMark = (x: CardMark, y: CardMark) =>
  x.level === y.level && x.target === y.target && x.lead === y.lead && x.said === y.said && x.tail === y.tail
  && x.title === y.title && x.words === y.words && x.session === y.session;
