// The order the board's columns read in: the rail's.
//
// The board flows its sessions down a column and then across (layout.ts), and
// it puts first what the session list puts first — Needs you, Working, Done ·
// new, Done, Ready — so the session at the top of the rail is the one at the
// top left of the board. The rail's own sort is reused rather than restated:
// two copies of one order drift apart.
import { canvasSessions } from "./canvas-session";
import { buildRows } from "./components/SessionList";
import type { GraphState } from "./reducer";

/** Canvas session ids in the rail's order. A Codex thread drawn inside its
 *  parent's group gives the group its own place only if the group has none. */
export function attentionOrder(state: GraphState, now: number = Date.now()): string[] {
  const groups = canvasSessions(state.agents.values());
  const groupOf = new Map<string, string>();
  for (const a of state.agents.values()) {
    if (a.kind === "root" && !groupOf.has(a.sessionId)) groupOf.set(a.sessionId, groups.get(a.id) ?? a.sessionId);
  }
  const order: string[] = [];
  const seen = new Set<string>();
  for (const row of buildRows(state, now)) {
    const sid = groupOf.get(row.sessionId) ?? row.sessionId;
    if (seen.has(sid)) continue;
    seen.add(sid);
    order.push(sid);
  }
  return order;
}
