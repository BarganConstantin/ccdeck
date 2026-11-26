// What a session is still doing once its turn is over, for Chat's live row
// (ChatView draws it under the conversation's last line, over the composer):
// background agents still running, and the conversation being compacted.
// Pure; the stage hands the facts in.
//
// BACKGROUND AGENTS ARE THE BOARD'S OWN LIFECYCLE. A subagent is a node from
// its SubagentStart to its SubagentStop (subagent-lifecycle.ts), and the
// root's Stop leaves it alone, because one dispatched to the background
// outlives the turn that started it (session-lifecycle.ts applyTurnEnd). So
// the agents counted here are the session's subagents still `active` once
// the turn is over: never the Agent call that launched one (its transcript
// row says "launched", not "finished"), and never a guess from the footer or
// the terminal's text. Out-of-order, repeated and replayed Start and Stop
// land at one end state in the reducer, so the count follows it as it is.
//
// WHILE A TURN RUNS, a subagent may be the turn's own: a foreground Task, or
// one blocked on a permission prompt the root is waiting on. Only the ones
// that already outlived an earlier turn's end count then; the rest are part
// of the work Chat's working row speaks for.
//
// COMPACTION IS THE SCREEN'S. The deck receives no hook while Claude Code
// compacts, and the transcript's compact_boundary is written once it is done,
// so the live sign is the agent's own spinner line, read as Chat's working row
// reads it (screen-status.ts): "Compacting conversation…" while it is there.
// The line comes and goes between frames, so it ends only after
// COMPACTION_MISSES reads in a row without it, or at once when the spinner
// says something else. Done, failed or cancelled, the line goes.
import type { ChatLive, ChatLiveAgent } from "./components/chat/chat-model";
import { saysCompacting, type ScreenSpinner } from "./screen-status";
import type { AgentNodeData } from "./types";

/** The session's background agents still running, oldest first. None for a
 *  session that ended: nothing of it is running any more. */
export function backgroundAgents(root: AgentNodeData, agents: Iterable<AgentNodeData>): ChatLiveAgent[] {
  if (root.closedAt != null) return [];
  // The turn is over: Stop came, or the session waits at its prompt.
  const over = root.state !== "active" || root.waiting?.kind === "idle";
  const endedAt = root.lastTurnEndAt;
  const out: ChatLiveAgent[] = [];
  for (const a of agents) {
    if (a.kind !== "subagent" || a.sessionId !== root.sessionId || a.state !== "active") continue;
    if (!over && (endedAt == null || a.startedAt > endedAt)) continue;
    const task = a.spawnCall?.description;
    out.push({ id: a.id, label: a.label, ...(task ? { task } : {}), since: a.startedAt });
  }
  return out.sort((x, y) => x.since - y.since || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** How many reads in a row without the compaction's line end it. */
export const COMPACTION_MISSES = 2;

/** A compaction seen on the screen: since when, and how many reads have missed its line since. */
export interface CompactionSeen {
  since: number;
  missed: number;
}

/**
 * The compaction after one read of the screen: `spinner` is the spinner line
 * it found (null for none, or no screen to read). The same object when
 * nothing moved, so a read that changes nothing redraws nothing.
 */
export function compactionAfter(prev: CompactionSeen | null, spinner: ScreenSpinner | null, now: number): CompactionSeen | null {
  if (spinner && saysCompacting(spinner.words)) {
    if (prev) return prev.missed ? { since: prev.since, missed: 0 } : prev;
    // Its own clock, when the line prints one: the compaction began then.
    return { since: spinner.seconds !== undefined ? now - spinner.seconds * 1000 : now, missed: 0 };
  }
  // Another spinner line: the compaction is over and something else runs.
  if (spinner || !prev) return null;
  const missed = prev.missed + 1;
  return missed >= COMPACTION_MISSES ? null : { since: prev.since, missed };
}

/** What Chat's live row says, or undefined when there is nothing. Nothing
 *  while Chat's working row is drawn: it speaks for the turn, and already
 *  says "Compacting conversation…" when the screen does. */
export function chatLive(o: { agents?: readonly ChatLiveAgent[]; compacting?: { since: number } | null; working: boolean }): ChatLive | undefined {
  if (o.working) return undefined;
  const live: ChatLive = {};
  if (o.compacting) live.compacting = { since: o.compacting.since };
  if (o.agents?.length) live.agents = o.agents;
  return live.compacting || live.agents ? live : undefined;
}

/** What identifies the live row as drawn: what it says, not its clocks. */
export function liveKey(live: ChatLive | undefined): string {
  if (!live) return "";
  return `${live.compacting ? "c" : ""}|${live.agents?.map(a => a.id).join(",") ?? ""}`;
}
