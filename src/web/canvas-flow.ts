// What the canvas is, one frame at a time.
//
// `snapshotToFlow` turns the reducer's agent map into the nodes and edges React
// Flow draws, and decides everything about WHERE they are: which cards and
// edges exist at all, when dagre is allowed to run again, where a recap note
// goes beside its card, which cached positions are still meaningful, and what
// happens to a node that has no position yet.
//
// It lived in App.tsx, a file at 0% coverage and 2,831 lines, and nothing could
// import it (#1175). The pieces it calls — `autoLayout`, `joinSessions`,
// `fillGapsWithNewSessions`, `separateOverlaps`, `pruneStaleEntries`,
// `stampPlaceholder` — each had tests; the decision that composes them had
// REPLICAS, tests that re-typed "the layout branch of snapshotToFlow" and went
// on passing after the real branch moved. Both of them had already drifted:
// they passed `lanes` as undefined to `autoLayout` and `fillGapsWithNewSessions`
// where the real code passes the lane map, and they did not exclude recap notes
// from the gap-fill set where the real code does. The regressions that hides
// are canvas-shaped — cards stacked on their neighbours' tool lanes, a note
// returning to where its card used to be, a node stuck at x = 0 — and a replica
// cannot see any of them, because it is not running this code.
//
// No React here: types from reactflow, and the same modules App.tsx was calling.
import { type Edge, type Node } from "reactflow";
import { agentAriaLabel } from "./components/AgentNode";
import { autoLayout, bubblePush, fillGapsWithNewSessions, joinSessions, laneSignature, separateOverlaps } from "./layout";
import { branchSummaries, type BranchSummary } from "./node-face";
import { isUnplaced, needsLayout, recordPlacement, stampPlaceholder, type Provisional } from "./placement";
import { liveNodeIds, measuredNodeIds, pruneStaleEntries } from "./prune";
import { isRecapDismissed, isRecapNoteId, recapKey, recapNoteId } from "./recap-note";
import { sessionHue, type GraphState } from "./reducer";
import { recapShown } from "./session-recap";
import type { AgentNodeData } from "./types";
import type React from "react";

/** A recap note's size before React Flow has measured it — the sheet's width,
 *  and about a card's height — and the gap it keeps to the left of its card:
 *  dagre's rank gap in layout.ts, so a note placed on arrival sits where R
 *  would put it. */
export const RECAP_NOTE_W = 300;
export const RECAP_NOTE_H = 130;
export const RECAP_NOTE_GAP = 160;

/** `branch` is on a root only, and only while it has subagents on the canvas:
 *  what they add up to, for the faces too small to show them one by one. */
export type FlowNodeData = AgentNodeData & { onOpenContext?: (sessionId: string) => void; branch?: BranchSummary };

/**
 * Node data that keeps its identity while the board has not changed (#873).
 *
 * This was `{ ...a, now, onOpenContext }`: a fresh object for every card on every
 * 250ms tick, so React Flow's memoised node wrapper never bailed and every card
 * and its sparkline re-rendered four times a second on an idle board. The
 * reducer bumps `state.revision` on every change it makes to an agent, so a copy
 * taken at one revision is still true until the next — and the cards, memoised
 * on it, sit still between events. Time reaches them through the leaves that
 * print it, on their own beat (use-now.ts).
 */
const NODE_DATA = new WeakMap<GraphState, {
  revision: number;
  open: (sessionId: string) => void;
  byId: Map<string, FlowNodeData>;
  /** The branch summaries, counted once per revision — a pass over the board
   *  that every root's copy reads, rather than one pass per root. */
  branches: Map<string, BranchSummary>;
}>();

export function nodeDataFor(state: GraphState, onOpenContext: (sessionId: string) => void): (a: AgentNodeData) => FlowNodeData {
  let entry = NODE_DATA.get(state);
  if (!entry || entry.revision !== state.revision || entry.open !== onOpenContext) {
    entry = { revision: state.revision, open: onOpenContext, byId: new Map(), branches: branchSummaries(state.agents.values()) };
    NODE_DATA.set(state, entry);
  }
  const { byId, branches } = entry;
  return a => {
    let d = byId.get(a.id);
    if (!d) {
      const branch = a.kind === "root" ? branches.get(a.sessionId) : undefined;
      d = branch ? { ...a, onOpenContext, branch } : { ...a, onOpenContext };
      byId.set(a.id, d);
    }
    return d;
  };
}

/**
 * How much room each agent's bubbles need.
 *
 * ToolBursts keeps the last four tools as a permanent trail — no time-based
 * culling — so an agent that has called a tool occupies its lane for as long as
 * it is on the canvas, and every pass that places a box has to be told. Without
 * it the next rank is placed 160px away and lands on top of bubbles that reach
 * 420px out, and the repair passes — which run far more often than dagre does —
 * pack the neighbours straight back over the chips.
 *
 * A named function rather than four lines inside snapshotToFlow because the
 * reframe effect has to ask layout.ts the same question about the same board
 * (#995), and a second copy of this loop is a second thing to keep in step.
 */
export function laneMap(state: GraphState): Map<string, number> {
  const lanes = new Map<string, number>();
  for (const a of state.agents.values()) {
    if (a.tools.length > 0) lanes.set(a.id, Math.min(4, a.tools.length));
  }
  return lanes;
}

export function snapshotToFlow(
  state: GraphState,
  now: number,
  availableWidth: number,
  availableHeight: number,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  prevSessionSize: Map<string, { w: number; h: number }>,
  onBubble: (sessions: string[]) => void,
  /** False while the page is still mounting and measuring. */
  settled: boolean,
  /**
   * A drag is in progress.
   *
   * Dragging a card out of its session makes that session's bounding box
   * bigger, which is indistinguishable from the session growing — so the push
   * fired on every pointer move and shoved the other sessions around while the
   * user was still holding the mouse down. The new size is still recorded, so
   * letting go does not then trigger a push for a change the user made by hand.
   */
  dragging: boolean,
  positions: Map<string, { x: number; y: number }>,
  /** Ids in `positions` that hold a placeholder rather than a laid-out spot. */
  provisional: Provisional,
  layoutSig: string,
  lastLayoutSigRef: { current: string },
  selectedIds: Set<string>,
  lineage: Set<string> | null,
  visibleIds: Set<string>,
  onOpenContext: (sessionId: string) => void,
): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const nodes: Node<FlowNodeData>[] = [];
  const edges: Edge[] = [];
  const dataFor = nodeDataFor(state, onOpenContext);
  for (const a of state.agents.values()) {
    if (!visibleIds.has(a.id)) continue;
    const exiting = a.exitAt != null;
    // Spotlight: out-of-lineage agents fade hard when a selection is active.
    const spotlitOut = lineage != null && !lineage.has(a.id);
    const cls = [
      exiting ? "rf-exiting" : "",
      spotlitOut ? "rf-spotlit-out" : "",
    ].filter(Boolean).join(" ") || undefined;
    // ReactFlow's createNodeInternals wipes width/height from internals on
    // every setNodes call — and we re-pass `nodes` on every `now` tick.
    // Without supplying them on the node prop, RF flips `initialized=false`
    // → `visibility:hidden` until ResizeObserver re-fires. Under live event
    // storms RO lags multiple frames → nodes persistently invisible while
    // tool bursts (which read positions directly) keep rendering. Pull
    // cached measurements through so internals survive the rewrite.
    const m = measured.get(a.id);
    nodes.push({
      id: a.id,
      type: "agent",
      position: { x: 0, y: 0 },
      data: dataFor(a),
      className: cls,
      // Composed, not read off the card: see agentAriaLabel (#853).
      ariaLabel: agentAriaLabel(a, now),
      ...(m ? { width: m.width, height: m.height } : null),
    });
    if (a.parentId && visibleIds.has(a.parentId)) {
      const hue = sessionHue(a.sessionId);
      const fading = exiting;
      // Selected-edge emphasis: thicker stroke + animated for edges that
      // touch any selected agent (multi-select: any in the set counts).
      const isSelectedEdge = selectedIds.size > 0 && (selectedIds.has(a.id) || selectedIds.has(a.parentId));
      // Spotlight: edges entirely outside the lineage fade too.
      const spotlitOutEdge = lineage != null && !lineage.has(a.id) && !lineage.has(a.parentId);
      const baseWidth = a.state === "active" ? 2 : 1.5;
      const selectedWidth = isSelectedEdge ? baseWidth + 1.5 : baseWidth;
      const effectiveOpacity = fading
        ? 0.2
        : spotlitOutEdge ? 0.12 : 1;
      // The class picks the tier, the tier picks the lightness. Which of the
      // two an edge wears is a state this loop owns; how bright that state has
      // to be to survive its canvas is the sheet's, and used to be decided
      // here at a value tuned for #0b0c10 (1.19:1 on white at its worst hue).
      const cls = [
        "sess-edge",
        a.state === "active" ? "sess-live" : "sess-idle",
        fading ? "rf-edge-exiting" : "",
        isSelectedEdge ? "rf-edge-selected" : "",
      ].filter(Boolean).join(" ");
      edges.push({
        id: `e:${a.parentId}->${a.id}`,
        source: a.parentId,
        target: a.id,
        animated: (a.state === "active" || isSelectedEdge) && !fading,
        type: "smoothstep",
        // No edge label — the target node already displays the agent name.
        // The transition is named here and valued in the stylesheet. An inline
        // style outranks every selector, so the literal string this used to
        // carry could not be answered by a `prefers-reduced-motion` rule at
        // all (#357) — a reader who asked for less motion still got 200ms of
        // stroke-width travel on every edge that gained or lost a selection.
        // `--edge-transition` moves that decision into styles.css, where the
        // media query drops the stroke-width half and keeps the opacity fade,
        // and it costs this component nothing: no hook, no listener, and no
        // re-render of the canvas when the preference changes.
        //
        // The width is multiplied by `--edge-k`, which is 1 at the detail tier
        // and grows as the canvas zooms out below it (styles.css, `data-lod`):
        // the ratio between a live, a settled and a selected edge is still
        // this loop's, and only the scale is the mode's.
        style: { "--session-hue": hue, strokeWidth: `calc(${selectedWidth}px * var(--edge-k, 1))`, opacity: effectiveOpacity, transition: "var(--edge-transition)" } as React.CSSProperties,
        className: cls,
      });
    }
    // Claude Code's recap, as a node of its own beside the root — RecapNoteNode
    // holds why a node and not something drawn over the canvas. Built only while
    // the recap still describes the session and nobody has put it away, and tied
    // to the root by an edge FROM the note, which is also what makes dagre rank
    // it to the left of the card.
    const recap = a.kind === "root" ? recapShown(a) : null;
    const noteKey = recap ? recapKey(a.sessionId, recap.at) : null;
    if (recap && noteKey && !isRecapDismissed(noteKey)) {
      const noteId = recapNoteId(a.id);
      const hue = sessionHue(a.sessionId);
      const mn = measured.get(noteId);
      // A second shape of node in an array typed for cards. Every reader here
      // that treats a node's data as a card's checks the node's type first —
      // the frame, the minimap, the click, the j/k step.
      nodes.push({
        id: noteId,
        type: "recapNote",
        position: { x: 0, y: 0 },
        data: { sessionId: a.sessionId, parentId: a.id, recap, noteKey, hue },
        className: spotlitOut ? "rf-spotlit-out" : undefined,
        selectable: false,
        // Not a keyboard stop either, like the session drag handles: Enter on a
        // focused node selects its id, and a note's id is not an agent's. Its ×
        // is still a button, and still reached by Tab.
        focusable: false,
        ariaLabel: `Claude Code's recap for ${a.label}`,
        ...(mn ? { width: mn.width, height: mn.height } : null),
      } as unknown as (typeof nodes)[number]);
      edges.push({
        id: `e:recap:${a.id}`,
        source: noteId,
        target: a.id,
        type: "recapTie",
        className: "recap-edge",
        // Decoration: not a stop for Tab. It draws no hit area to click either
        // (RecapTieEdge renders none, and the sheet gives it no pointer).
        focusable: false,
        style: { "--session-hue": hue } as React.CSSProperties,
      });
    }
  }
  // Only rerun dagre when the structure or measured sizes actually change.
  // Between layouts, reuse cached positions so per-event renders don't shift
  // nodes — that was the source of canvas flicker + drag-snap-back.
  // A structural change no longer reshuffles the canvas. Nodes that already
  // have a position keep it — the arrangement on screen is one the user has
  // been reading, and rebuilding it under them costs more than the tidier
  // result is worth. Only nodes without a position are laid out, and only
  // nodes that end up overlapping get moved. The relayout button (R) is the
  // way to ask for a full reflow.
  const lanes = laneMap(state);
  // A lane appearing is a structural change, so it invalidates the cached
  // arrangement the way a new node or a re-measured card does.
  //
  // Without this the reservation was applied on exactly one frame per node —
  // the frame it first appears, which is the frame it has just been created by
  // SessionStart and has called nothing, so its lane is zero. It then made
  // forty tool calls, grew 420px sideways, and nothing ever reconsidered its
  // neighbours. Clamping at four bubbles is what keeps this cheap: the string
  // stops changing after an agent's fourth tool call.
  const sig = `${layoutSig}#lanes:${laneSignature(lanes)}`;
  // A node holding a placeholder counts as missing however real its entry in
  // `positions` looks — see placement.ts. Without that, the one write that
  // exists to keep a node on screen for a frame was also the write that told
  // this filter the node had been laid out.
  // A recap note that is not on the board forgets where the layout put it, so
  // the next one is placed beside its card as the card sits THEN — a note put
  // away before its card moved must not come back to where the card used to
  // be. Where somebody DRAGGED one is a pin, and pins are kept (liveNodeIds).
  const shownNotes = new Set(nodes.filter(n => n.type === "recapNote").map(n => n.id));
  for (const id of Array.from(positions.keys())) {
    if (isRecapNoteId(id) && !shownNotes.has(id) && !pinned.has(id)) {
      positions.delete(id);
      provisional.delete(id);
    }
  }
  const missing = nodes.filter(n => needsLayout(n.id, pinned, positions, provisional));
  if (missing.length > 0 || sig !== lastLayoutSigRef.current) {
    if (missing.length > 0) {
      // A card joining a session already on the canvas goes beside that session
      // as it sits now, not where a layout from scratch would have it.
      const laidOut = joinSessions(
        autoLayout(nodes, edges, { direction: "LR", pinned, measured, availableWidth, availableHeight, lanes }),
        pinned,
        id => (isUnplaced(id, positions, provisional) ? undefined : positions.get(id)),
      );
      for (const n of laidOut) if (isUnplaced(n.id, positions, provisional)) recordPlacement(n.id, n.position, positions, provisional);
      // Finished sessions are pruned as they complete, so the column they were
      // in has holes while new work keeps being appended underneath. Offer the
      // arrivals those holes first, and past them whichever of a column's foot
      // or a new column to the right lets the fit show the board largest.
      fillGapsWithNewSessions(
        nodes, positions, pinned, measured,
        // Cards only: a recap note joins a session that is already here, and
        // offered a hole it was taken for a session of its own and dropped in
        // a gap at the foot of some column, nowhere near its card.
        new Set(missing.filter(n => n.type !== "recapNote").map(n => n.id)), lanes,
        { width: availableWidth, height: availableHeight },
      );
      // A recap note joining a card that is already on the canvas goes to the
      // LEFT of that card, where R puts it too. It is tied to its root by an
      // edge, but a card somebody has dragged is pinned, and dagre lays out only
      // what still flows — so the note was laid out on its own and the overlap
      // pass slid it underneath the card. Placed from the card, it cannot be.
      for (const n of missing) {
        if (n.type !== "recapNote") continue;
        const rootId = (n.data as { parentId?: string } | undefined)?.parentId;
        if (!rootId) continue;
        const root = pinned.get(rootId) ?? (isUnplaced(rootId, positions, provisional) ? undefined : positions.get(rootId));
        if (!root) continue;
        const nw = measured.get(n.id)?.width ?? RECAP_NOTE_W;
        const nh = measured.get(n.id)?.height ?? RECAP_NOTE_H;
        const rh = measured.get(rootId)?.height ?? RECAP_NOTE_H;
        recordPlacement(n.id, { x: root.x - RECAP_NOTE_GAP - nw, y: root.y + (rh - nh) / 2 }, positions, provisional);
      }
    }
    separateOverlaps(nodes, positions, pinned, measured, lanes);
    lastLayoutSigRef.current = sig;
  }
  // A session that just fanned out subagents is wider and taller than it was a
  // frame ago, and is now sitting on whatever was beside it. separateOverlaps
  // would clear that by sliding the covered session down past the whole grown
  // block; this nudges the neighbours aside by the least that works, which is
  // both shorter and legible as a cause — the box grew, so the others moved.
  // Self-gating: returns immediately unless something actually grew.
  const bubbled = bubblePush(nodes, positions, pinned, measured, prevSessionSize, !settled || dragging, lanes);
  if (bubbled.length > 0) onBubble(bubbled);
  // Evict cached positions for agents that aren't in state.agents anymore.
  // Stale positions for invisible-but-still-tracked agents are KEPT so a
  // transient flicker out of visibleIds (e.g. one frame where isAgentVisible
  // is false during a state transition) doesn't lose the position and snap
  // the node to {0,0} on return — that was causing "nodes vanish on action
  // change" while bursts (which gate on visibleIds) also disappeared.
  // Like the pins below, this is guarded on a non-empty graph: positions are
  // restored from storage before the event log has replayed, so pruning them
  // against an empty agent map would wipe the whole saved arrangement on every
  // page load and re-derive it with dagre.
  const live = liveNodeIds(state.agents.values());
  pruneStaleEntries(positions, live);
  // A mark normally lives one frame — the pass it asks for clears it — but an
  // agent that leaves between the stamp and that pass would leave its id in the
  // set for the life of the tab, which is the leak the size cache below had.
  pruneStaleEntries(provisional, live);
  // Drop pins for agents that are gone. Pinned positions are restored from
  // localStorage on every load, so without this a drag from some previous run
  // outlives the agent it belonged to and keeps claiming that spot on the
  // canvas — where a later session, laid out from the top, gets stacked
  // straight onto it.
  pruneStaleEntries(pinned, live);
  // Drop measurements for nodes that no longer exist. This cache is not
  // restored from storage, but it is not rebuilt either: nothing but the Clear
  // button ever removed an id, so a tab left open for days holds a size for
  // every agent and every session that has ever been on the canvas. columnGap()
  // takes the widest measured node of all, and a session drag handle is as wide
  // as the whole session box, so a single long-gone session kept the gap
  // between columns at its width for the rest of the tab's life.
  pruneStaleEntries(measured, measuredNodeIds(state.agents.values()));
  // Never silently drop a visible node — if its position is missing, place
  // it at {0,0} for THIS frame and force a fresh layout pass on the next
  // frame by invalidating lastLayoutSigRef. The previous skip-this-frame
  // strategy caused the catastrophic "every node vanished while bursts
  // remained" symptom when, for whatever reason, positions got out of sync
  // with state.agents (the bursts gate on visibleAgentIds + positions; the
  // node renderer gated on positions only, so the two halves disagreed).
  const finalNodes: typeof nodes = [];
  let missingPosition = false;
  for (const n of nodes) {
    let p = pinned.get(n.id) ?? positions.get(n.id);
    if (!p) {
      p = stampPlaceholder(n.id, positions, provisional);
      missingPosition = true;
    }
    finalNodes.push({ ...n, position: p });
  }
  if (missingPosition) {
    // Force the layout branch above to run again on the next render, even if
    // nothing else changed. The stamp is recorded as provisional, so that pass
    // sees the node in `missing` and hands it to dagre — which is what the
    // invalidation was always meant to buy and never did while a placeholder
    // was indistinguishable from a placement, leaving separateOverlaps as the
    // only thing that ever touched the node and the x=0 column as the only
    // place it could be.
    lastLayoutSigRef.current = "";
  }
  return { nodes: finalNodes, edges };
}
