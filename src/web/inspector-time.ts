// The Inspector's Time tab: where one session's turn went, and the calls it was
// made of.
//
// The three lanes (Claude, this machine, you) are the server's: GET
// /api/tool-audit?session=<id> answers with the session's current turn, or its
// last, cut by the very rules Tool activity cuts every turn by (see
// tool-audit-report.mjs), so the two surfaces cannot print different numbers for
// one turn. The spans are the client's own: the session's tool calls hold their
// two timestamps, and a turn starts at the last prompt the session was given.
import { elapsed } from "./duration";
import { sessionRoot } from "./inspector-tree";
import { skinFor } from "./tool-skin";
import type { AgentNodeData, ToolCall, WaitingBlock } from "./types";

export interface SessionTurn { open: boolean; totalMs: number; claudeMs: number; machineMs: number; youMs: number }

/** What a call ran on, as the board's sub-bubble says it (the command, the file),
 *  else the raw input preview: a Bash row reads "npm test", not its JSON. */
const callArg = (call: ToolCall): string => skinFor(call.name, call.input)?.detail ?? call.inputPreview ?? "";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** The route's answer as a turn, `null` for "no turn", or `undefined` for a body
 *  that is not one of the two (the reader keeps what it had). */
export function parseSessionTurn(body: unknown): SessionTurn | null | undefined {
  if (body === null) return null;
  const t = body as Partial<SessionTurn> | undefined;
  if (typeof t !== "object" || typeof t.open !== "boolean" || !finite(t.totalMs) || !finite(t.claudeMs) || !finite(t.machineMs) || !finite(t.youMs)) return undefined;
  return { open: t.open, totalMs: t.totalMs, claudeMs: t.claudeMs, machineMs: t.machineMs, youMs: t.youMs };
}

/** Asks for the session's turn. A busy report (another is running) and any
 *  answer that is not a turn come back `undefined`: not an error, just not an
 *  answer, and the last one stands. */
export async function readSessionTurn(session: string, signal: AbortSignal): Promise<SessionTurn | null | undefined> {
  const res = await fetch(`/api/tool-audit?session=${encodeURIComponent(session)}`, { signal });
  if (!res.ok) return undefined;
  return parseSessionTurn(await res.json());
}

/** How often an open turn is asked for again while the tab is shown. */
export const TURN_POLL_MS = 5000;
/** How soon the tab asks again after an answer that was not one (the deck busy,
 *  away or the session unknown): slower, so a struggling deck is not pressed. */
export const TURN_RETRY_MS = 15000;

/** A permission prompt still waiting is yours, not the machine's. The journal holds
 *  no event for a prompt being answered, so the server counts a call it has not
 *  seen end as running; the session's own state says when it began waiting, and
 *  that much of the machine's time (up to when the answer was read) moves to you. */
export function withPromptWait(turn: SessionTurn, waiting: WaitingBlock | null | undefined, readAt: number): SessionTurn {
  if (!turn.open || waiting?.kind !== "permission" || !finite(waiting.since)) return turn;
  const ms = Math.min(turn.machineMs, Math.max(0, readAt - waiting.since));
  return ms > 0 ? { ...turn, machineMs: turn.machineMs - ms, youMs: turn.youMs + ms } : turn;
}

/** A span of time as the Time tab prints it: "0.3s" and "8.8s" below ten
 *  seconds, then the card's own clock, "18s" and "7m 14s". */
export function turnSpan(ms: number): string {
  const whole = Math.max(0, Math.round(ms));
  if (Math.round(whole / 100) < 100) return `${(Math.round(whole / 100) / 10).toFixed(1)}s`;
  return elapsed(0, Math.round(whole / 1000) * 1000, 0);
}

/** The share of the turn that was waiting on you, as a whole percent. */
export function waitingShare(turn: SessionTurn): number {
  return turn.totalMs > 0 ? Math.round(turn.youMs / turn.totalMs * 100) : 0;
}

export type TurnLane = "you" | "claude" | "machine";
/** The turn's bar: the lanes that held any time, the time you waited first. */
export function turnPieces(turn: SessionTurn): { lane: TurnLane; ms: number }[] {
  return ([["you", turn.youMs], ["claude", turn.claudeMs], ["machine", turn.machineMs]] as const)
    .filter(([, ms]) => ms > 0).map(([lane, ms]) => ({ lane, ms }));
}

export interface SpanRow {
  key: string;
  name: string;
  arg: string;
  /** 0 for a call of the session's root, one more for each agent it sits under. */
  depth: number;
  /** A call that started a subagent: it holds that agent's calls below it. */
  group: boolean;
  /** The groups this row sits under, outermost first. */
  under: string[];
  from: number;
  /** Null while the call is still going. */
  to: number | null;
  /** When the call began waiting on you, for the one that does. */
  waitingSince: number | null;
}

export interface SpanTable { rows: SpanRow[]; start: number; end: number }

const HOLDERS = new Set(["Task", "Agent"]);

/** The turn's start on the client: the last prompt the session was given. A
 *  session that has none held (the deck joined it mid-turn) starts at its
 *  earliest call. */
export function turnStartOf(root: AgentNodeData): number | null {
  const prompt = root.prompts.at(-1)?.at;
  if (prompt !== undefined) return prompt;
  let first: number | null = null;
  for (const call of root.tools) if (first === null || call.startedAt < first) first = call.startedAt;
  return first;
}

/** The session's calls in the turn as table rows: the root's, each Task or Agent
 *  call followed by the calls of the subagent it started. A subagent is tied to
 *  the newest Task call that began before it did and has no agent yet; one that
 *  matches none (its call fell out of the window the deck keeps) gets a row of
 *  its own, from its own start. */
export function spanTable(opts: {
  agents: ReadonlyMap<string, AgentNodeData>; sessionId: string; start: number; end: number; now: number;
}): SpanTable {
  const { agents, sessionId, start, now } = opts;
  const root = sessionRoot(agents, sessionId);
  const rows: SpanRow[] = [];
  if (!root) return { rows, start, end: opts.end };
  const kids = new Map<string, AgentNodeData[]>();
  for (const a of agents.values()) {
    if (a.sessionId !== sessionId || a === root || !a.parentId) continue;
    const list = kids.get(a.parentId);
    if (list) list.push(a); else kids.set(a.parentId, [a]);
  }
  const seen = new Set<string>();
  const add = (agent: AgentNodeData, depth: number, under: string[]) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    const calls = [...agent.tools].sort((a, b) => a.startedAt - b.startedAt);
    const mine = (kids.get(agent.id) ?? []).sort((a, b) => a.startedAt - b.startedAt);
    const taken = new Map<string, AgentNodeData>();
    const loose: AgentNodeData[] = [];
    for (const kid of mine) {
      let holder: ToolCall | undefined;
      for (const call of calls) if (HOLDERS.has(call.name) && !taken.has(call.id) && call.startedAt <= kid.startedAt + 1000) holder = call;
      if (holder) taken.set(holder.id, kid); else loose.push(kid);
    }
    type Item = { at: number; call?: ToolCall; kid?: AgentNodeData };
    const items: Item[] = [
      ...calls.map(call => ({ at: call.startedAt, call, kid: taken.get(call.id) })),
      ...loose.map(kid => ({ at: kid.startedAt, kid })),
    ].sort((a, b) => a.at - b.at);
    for (const { at, call, kid } of items) {
      if (at < start) continue;
      if (kid) {
        const key = `g:${kid.id}`;
        rows.push({
          key, name: kid.label || call?.name || "Agent", arg: call ? callArg(call) : "", depth, group: true, under,
          from: at, to: call ? call.endedAt ?? null : kid.endedAt ?? null, waitingSince: null,
        });
        add(kid, depth + 1, [...under, key]);
      } else if (call) {
        rows.push({
          key: `c:${agent.id}:${call.id}`, name: call.name, arg: callArg(call), depth, group: false, under,
          from: at, to: call.endedAt ?? null, waitingSince: null,
        });
      }
    }
  };
  add(root, 0, []);
  markWaiting(rows, root.waiting);
  let end = opts.end;
  for (const row of rows) end = Math.max(end, row.to ?? Math.min(now, end));
  return { rows, start, end };
}

/** The call a permission prompt or a question is holding: the newest call still
 *  going that bears the tool's name (any, when the block names none). */
function markWaiting(rows: SpanRow[], block: WaitingBlock | null | undefined) {
  if (!block || block.kind === "idle") return;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.group || row.to !== null) continue;
    if (block.tool && block.tool.name !== row.name) continue;
    row.waitingSince = block.since;
    return;
  }
}

/** The four ticks of the axis: the start, a third, two thirds and the end. */
export function axisTicks(table: SpanTable): string[] {
  const span = Math.max(1, table.end - table.start);
  return [0, 1, 2, 3].map(i => i === 0 ? "0" : turnSpan(span * i / 3));
}

/** Where a row's bar sits on the lane, as percentages of the axis. */
export function barBox(row: SpanRow, table: SpanTable, now: number): { left: number; width: number } {
  const span = Math.max(1, table.end - table.start);
  const to = row.to ?? Math.min(now, table.end);
  const left = Math.min(100, Math.max(0, (row.from - table.start) / span * 100));
  return { left, width: Math.min(100 - left, Math.max(0, (to - row.from) / span * 100)) };
}
