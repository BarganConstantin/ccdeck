// The layout's structural signature: which agents are on the board, under
// which parents, and the two counters that move when a card changes size.
// Layout reruns only when this moves — not on every event — and the debounced
// save and the auto-fit both key off it too.
//
// Moved out of App.tsx's memo unchanged apart from taking the agents as an
// argument, so it can be run by a test.
import type { AgentNodeData } from "./types";
import { isAgentVisible } from "./visibility";

export function layoutSignature(
  agents: Iterable<AgentNodeData>,
  now: number,
  removedAgentIds: ReadonlySet<string>,
  sizeVersion: number,
  domSizeVersion: number,
): string {
  const ids: string[] = [];
  for (const a of agents) {
    // Mirror isAgentVisible exactly — layoutSig and visibleAgentIds must
    // agree, otherwise dagre re-runs for agents that never render and
    // the cached positions drift relative to what's actually on canvas.
    if (!isAgentVisible(a, now) || removedAgentIds.has(a.id)) continue;
    ids.push(a.id + (a.parentId ? `>${a.parentId}` : ""));
  }
  ids.sort();
  return `${ids.join("|")}#sv${sizeVersion}.${domSizeVersion}`;
}
