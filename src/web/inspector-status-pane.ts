// The Inspector's title, in the pane's own words (see inspector-state.ts, which
// loads this file on demand: it reaches the stage's modules, which the first
// load does not).
import { boardFactsFor } from "./components/terminal/stage-board";
import { stageStatusFrom } from "./components/terminal/stage-model";
import type { InspectorStatus } from "./inspector-state";
import { sessionRoot } from "./inspector-tree";
import { sessionMark } from "./node-face";
import type { KitStateName } from "./components/kit-icons";
import type { AgentNodeData } from "./types";

/** The pane's sentence for a session, from the very functions the pane's header
 *  uses, and the kit glyph that goes with its state. */
export function paneStatus(selected: AgentNodeData, agents: ReadonlyMap<string, AgentNodeData>, now: number): InspectorStatus {
  const root = sessionRoot(agents, selected.sessionId) ?? selected;
  const subagents = [...agents.values()].filter(a => a.sessionId === root.sessionId && a.kind === "subagent");
  const status = stageStatusFrom(boardFactsFor(root, subagents), now);
  const phrase = [status.phrase, status.emphasis].filter(Boolean).join(" ") + (status.arg ? ` · ${status.arg}` : "");
  // The mark every surface draws for the session (node-face.ts sessionMark):
  // a finished turn whose calls failed is the partial mark, a stopped one the
  // cross.
  const mark = sessionMark(root);
  const glyph: KitStateName = mark === "partial" ? "partial"
    : mark === "err" ? "error"
    : status.state === "working" ? "working"
    : status.state === "waiting" ? "waiting"
    : status.state === "ready" ? "idle"
    : status.state === "ended" ? "done"
    : root.lastTurnEndAt != null ? "done" : "idle";
  return { glyph, phrase };
}
