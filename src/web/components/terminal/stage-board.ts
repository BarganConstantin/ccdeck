// What the board knows, put in the shapes the stage draws — the session on it,
// the asks under it, the projects the New session popover offers.
//
// THE STAGE NEVER READS THE GRAPH. TerminalStage is handed what to show
// (StageShow) and the keys bar is handed its asks as plain data; this module is
// the one place a board agent becomes those, so the rules — which wait counts,
// which call the header names, what the end bar says — are pure functions the
// suite can call, not lines inside a component that would be copied the day a
// second view needed them.
//
// THE BOARD'S OWN WORDS. The header's sentence is the face's: waiting only for
// the two kinds the topbar counts (isAlarming), the open call named the way the
// card's bubbles name it (FACE_WORDS), the name the face prints (the root's
// label), the hue the cluster wears (sessionHue). Nothing here is worded twice.
import { isAlarming, type BlockedSession } from "../../ambient-counts";
import { FACE_WORDS } from "../../board-navigator";
import { faceSignal } from "../../node-face";
import { shortAgo } from "../../relative-time";
import { sessionHue } from "../../session-hue";
import type { StageTarget } from "../../stage-shell";
import type { AgentNodeData } from "../../types";
import type { AsksView as RunView } from "../../use-asks";
import type { AsksView as BarAsks, ArrivalView } from "./KeysBar";
import {
  agentName,
  folderName,
  projectChoices,
  stageStatusFrom,
  waitedFor,
  type BoardFacts,
  type ProjectChoice,
} from "./stage-model";
import type { StageShow } from "./TerminalStage";

/** The longest prompt a state card quotes before it cuts it. A card line is
 *  one line at the stage's measure; the whole prompt is in the pane. */
const PROMPT_MAX = 160;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** One line of a prompt: its first line, cut to the card's measure. */
function promptLine(text: string | undefined | null): string | null {
  const line = (text ?? "").split("\n").find(l => l.trim() !== "")?.trim() ?? "";
  return line ? cut(line, PROMPT_MAX) : null;
}

/** The session's subagents on the board. */
function subagentsOf(agents: Iterable<AgentNodeData>, sessionId: string): AgentNodeData[] {
  const out: AgentNodeData[] = [];
  for (const a of agents) if (a.sessionId === sessionId && a.kind === "subagent") out.push(a);
  return out;
}

/**
 * What the header's sentence is built from: the root's state, its alarming
 * wait, the call it has open, how many of its subagents are running.
 */
export function boardFactsFor(root: AgentNodeData, subagents: readonly AgentNodeData[]): BoardFacts {
  const w = root.waiting;
  let tool: BoardFacts["tool"] = null;
  if (root.state === "active") {
    for (let i = root.tools.length - 1; i >= 0; i--) {
      const t = root.tools[i];
      if (t.endedAt != null) continue;
      const said = FACE_WORDS.describeCall(t);
      tool = { name: said.name, subject: said.subject ?? null, startedAt: t.startedAt };
      break;
    }
  }
  return {
    closedAt: root.closedAt ?? null,
    waiting: w && isAlarming(w)
      ? { since: w.since, ...(w.tool?.name ? { tool: w.tool.name } : {}), ...(w.tool?.preview ? { detail: w.tool.preview } : {}) }
      : null,
    active: root.state === "active",
    tool,
    subagentsLive: subagents.filter(s => s.state === "active").length,
    lastTurnEndAt: root.lastTurnEndAt ?? null,
    // Nothing asked of it yet: a session the deck has just started, waiting
    // for its first prompt.
    fresh: root.prompts.length === 0 && !root.firstPrompt,
  };
}

/**
 * What the stage shows for `target`, from the board at `now`. A session the
 * board has lost — swept, removed — is still shown by id, with no sentence the
 * board cannot back: the pane is the truth about it then.
 */
export function stageShowFor(
  target: StageTarget | null,
  agents: ReadonlyMap<string, AgentNodeData>,
  now: number,
): StageShow {
  if (!target || target.kind === "empty") return { kind: "empty" };
  if (target.kind === "launch") {
    return { kind: "launch", agent: target.agent, cwd: target.cwd, name: folderName(target.cwd), hue: sessionHue(target.key), key: target.key };
  }
  const id = target.id;
  const root = agents.get(id);
  if (!root) {
    return {
      kind: "session",
      session: { ref: { sessionId: id, provider: "claude", cwd: "" }, name: id.slice(0, 8), hue: sessionHue(id), status: { state: "none", phrase: "" } },
    };
  }
  const subs = subagentsOf(agents.values(), id);
  const facts = boardFactsFor(root, subs);
  const provider = root.provider === "codex" ? "codex" : "claude";
  const lastPrompt = root.prompts.length ? root.prompts[root.prompts.length - 1].text : root.firstPrompt;
  const signal = faceSignal(root, undefined, FACE_WORDS);
  const fact = [
    facts.subagentsLive ? `${facts.subagentsLive} ${facts.subagentsLive === 1 ? "subagent" : "subagents"} working` : null,
    root.closedAt != null ? `ended ${shortAgo(now - root.closedAt)}` : null,
    `${agentName(provider)}${root.cwd ? ` · ${root.cwd}` : ""}`,
  ].filter(Boolean).join(" · ");
  return {
    kind: "session",
    session: {
      ref: { sessionId: id, provider, cwd: root.cwd ?? "" },
      name: root.label || root.cwdBasename || id.slice(0, 8),
      hue: sessionHue(id),
      model: root.model ?? null,
      status: stageStatusFrom(facts, now),
      // While the pane attaches: what the face says the session is doing, or
      // failing that, what it was last asked.
      ghostLine: signal?.long ?? promptLine(lastPrompt),
      context: { prompt: promptLine(lastPrompt), fact },
      endedAgo: root.closedAt != null ? shortAgo(now - root.closedAt) : null,
    },
  };
}

/**
 * The keys bar's half of an asks run (use-asks.ts's view): segment states, the
 * "1 of 2" (the bar counts from zero), the answered session's name, and the
 * next ask with how long it has waited — or null when there is no run.
 */
export function barAsks(view: RunView, waiting: readonly BlockedSession[], now: number): BarAsks | null {
  if (view.track.length === 0) return null;
  const fresh = view.track.findIndex(s => s.fresh);
  let next: BarAsks["next"] = null;
  if (view.next) {
    const w = waiting.find(s => s.id === view.next!.id);
    next = {
      name: view.next.label,
      waited: w ? waitedFor(now - w.waiting.since) : "",
      tool: w?.waiting.tool?.name ?? null,
    };
  }
  return {
    segments: view.track.map(s => s.state),
    freshIndex: fresh >= 0 ? fresh : null,
    position: view.position ? { index: view.position.index - 1, total: view.position.total } : null,
    resumed: view.resumed?.label ?? null,
    next,
    clear: view.clear,
  };
}

/** The one-line note for an ask that arrived with no run going. */
export function barArrival(view: RunView, waiting: readonly BlockedSession[]): ArrivalView | null {
  const a = view.arrival;
  if (!a) return null;
  const w = waiting.find(s => s.id === a.id);
  return { name: a.label, tool: w?.waiting.tool?.name ?? null };
}

/** The projects the New session popover offers: every folder a root on the
 *  board ran in, most recently heard from first, the stage's own leading. */
export function boardProjects(agents: Iterable<AgentNodeData>, currentCwd?: string | null): ProjectChoice[] {
  const seen = [];
  for (const a of agents) {
    if (a.kind !== "root" || !a.cwd) continue;
    seen.push({ cwd: a.cwd, hue: sessionHue(a.sessionId), at: a.lastEventAt ?? a.startedAt });
  }
  return projectChoices(seen, currentCwd);
}
