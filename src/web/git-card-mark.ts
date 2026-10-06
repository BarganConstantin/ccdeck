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
  const key = a.kind === "subagent" ? subKey(a) : null;
  if (a.kind === "subagent" && !key) return null;
  const own = collisionsFor(c, { sessionId: a.sessionId, agentIds: key ? [key] : null });
  if (own.length) return said(a, own, false, names, byId);
  // A subagent in its session's folder, still running, while the session's
  // other agents collide: the danger is its session's.
  if (a.kind !== "subagent" || a.git || a.state !== "active") return null;
  const team = collisionsFor(c, { sessionId: a.sessionId, agentIds: null }).filter(x => x.level === "sharp");
  return team.length ? said(a, team, true, names, byId) : null;
}

function said(a: MarkAgent, list: Collision[], session: boolean, names: (r: GitCollisionRef) => string,
  byId: ReadonlyMap<string, MarkAgent>): CardMark {
  const sharp = list.filter(x => x.level === "sharp");
  const quiet = list.filter(x => x.level === "quiet");
  const level = sharp.length ? "sharp" : "quiet";
  const shown = level === "sharp" ? sharp : quiet;
  const first = shown[0];
  const name = names(first.with);
  const more = shown.length > 1 ? `+${shown.length - 1}` : "";
  const lines: string[] = [];
  let lead = "", line: string, words: string;
  if (level === "sharp") {
    lead = first.files.length === 1 ? baseName(first.files[0]) : `${first.files.length} files`;
    line = `also edited by ${name}`;
    words = `${first.files.length === 1 ? first.files[0] : lead} ${line}`;
    for (const s of sharp) {
      const n = s.files.length;
      lines.push(`${n === 1 ? s.files[0] : `${n} files (${s.files.join(", ")})`} also edited by ${names(s.with)} since ${n === 1 ? "it was" : "they were"} last committed.`);
    }
    lines.push(sharp.length > 1 ? "All of them are running." : "Both are running.");
    if (session) lines.push("In this session, not in this subagent's own files.");
    for (const q of quiet) lines.push(`Also ${quietSentence(q, names(q.with), a)}`);
  } else {
    line = quietSaid(first, name);
    words = line;
    for (const q of quiet) lines.push(quietSentence(q, names(q.with), a));
  }
  const target = cardOf(first.with, byId);
  lines.push(`Select ${name}.`);
  return {
    level,
    target,
    lead,
    said: line,
    tail: [more, session ? "· in this session" : ""].filter(Boolean).join(" "),
    title: lines.join("\n"),
    words: [words, more, session ? "in this session" : ""].filter(Boolean).join(" "),
    session,
  };
}

/** The quiet row's words: "shares folder with …", "same branch as …". */
const quietSaid = (q: Collision, name: string) => (q.reason === "same-branch" ? `same branch as ${name}` : `shares folder with ${name}`);

/** A quiet collision in the tooltip: the row's own words, then where. Each
 *  tooltip line starts from what the row says, so a row cut short is whole in
 *  its tooltip. */
function quietSentence(q: Collision, name: string, a: MarkAgent): string {
  const folder = a.git?.topLevel ?? a.cwd;
  if (q.reason === "same-branch") return `${quietSaid(q, name)}, in another folder.`;
  return `${quietSaid(q, name)}${folder ? ` (${folder})` : ""}.`;
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
