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
import { canvasSessions } from "./canvas-session";
import { agentAriaLabel } from "./agent-copy";
import { autoLayout, bubblePush, fillGapsWithNewSessions, joinSessions, laneSignature, separateOverlaps } from "./layout";
import { footprint, NODE_W, sessionOfNode } from "./layout-geometry";
import { noteSpot, tetherRecapNotes } from "./note-tether";
import { branchSummaries, type BranchSummary } from "./node-face";
import { sessionNames, twinClocks, type TwinCandidate, type TwinClock } from "./rail-row-copy";
import { isUnplaced, needsLayout, recordPlacement, stampPlaceholder, type Provisional } from "./placement";
import { liveNodeIds, measuredNodeIds, pruneStaleEntries } from "./prune";
import { sendSessionsHome } from "./return-home";
import { isRecapDismissed, isRecapNoteId, recapNoteId } from "./recap-note";
import { sessionHue, type GraphState } from "./reducer";
import { boardNote, noteTag } from "./session-note";
import type { AgentNodeData } from "./types";
import type React from "react";
import { t } from "./i18n";

// A recap note's size before React Flow has measured it, and the gap it keeps
// to its card: layout-geometry.ts's, since the gap pass reserves the note's
// room for a session that is still arriving.
export { RECAP_NOTE_GAP, RECAP_NOTE_H, RECAP_NOTE_W } from "./layout-geometry";

/** `branch` is on a root only, and only while it has subagents on the canvas:
 *  what they add up to, for the faces too small to show them one by one.
 *  `twin` is on a root only, and only while another card on the board reads
 *  the same, name and task: the card then draws when it started (twinClocks). */
export type FlowNodeData = AgentNodeData & { onOpenContext?: (sessionId: string) => void; branch?: BranchSummary; twin?: TwinClock };

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
  groups: Map<string, string>;
  /** Every root's name and task, read once per revision for twinClocks. */
  roots: TwinCandidate[];
  /** The look-alikes among the cards drawn, and their key: a removal or a
   *  fade changes which are drawn between revisions. */
  twins: Map<string, TwinClock>;
  twinKey: string;
}>();

/** `drawn`, when given, is the cards on the board: the look-alikes are decided
 *  among them (twinClocks), and a session off the board tells none apart. */
export function nodeDataFor(state: GraphState, onOpenContext: (sessionId: string) => void, drawn?: ReadonlySet<string>): (a: AgentNodeData) => FlowNodeData {
  let entry = NODE_DATA.get(state);
  if (!entry || entry.revision !== state.revision || entry.open !== onOpenContext) {
    entry = {
      revision: state.revision, open: onOpenContext, byId: new Map(), branches: branchSummaries(state.agents.values()), groups: canvasSessions(state.agents.values()),
      roots: twinCandidates(state), twins: new Map(), twinKey: "",
    };
    NODE_DATA.set(state, entry);
  }
  const twins = twinClocks(drawn ? entry.roots.filter(r => drawn.has(r.id)) : entry.roots);
  const twinKey = [...twins].map(([id, clock]) => `${id}:${clock}`).sort().join("\n");
  if (twinKey !== entry.twinKey) {
    // Copies made before say the old answer: made again, once, for every card.
    entry.byId.clear();
    entry.twins = twins;
    entry.twinKey = twinKey;
  }
  const { byId, branches, groups } = entry;
  const twinOf = entry.twins;
  return a => {
    let d = byId.get(a.id);
    if (!d) {
      const branch = a.kind === "root" ? branches.get(a.sessionId) : undefined;
      const twin = a.kind === "root" ? twinOf.get(a.id) : undefined;
      d = { ...a, onOpenContext, ...(branch ? { branch } : null), ...(twin ? { twin } : null) };
      d.canvasSessionId = groups.get(a.id);
      byId.set(a.id, d);
    }
    return d;
  };
}

/** Every root as twinClocks weighs it, named as its card names it. */
function twinCandidates(state: GraphState): TwinCandidate[] {
  const out: TwinCandidate[] = [];
  for (const a of state.agents.values()) {
    if (a.kind !== "root") continue;
    const { title, task } = sessionNames(a);
    out.push({ id: a.id, title, task, startedAt: a.startedAt });
  }
  return out;
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

/**
 * The order the frame hands its nodes to React Flow in, which is the order the
 * DOM holds them in and so the order Tab walks the cards.
 *
 * It was the reducer's agent map, and that is arrival order: a subagent spawned
 * after another session started landed in the DOM after that session, so Tab
 * went from one session's root into the next session and back for the rest of
 * its subagents, the ring jumping across the canvas. The board's own order is
 * the one the layout packs it in: down a column of sessions, then across, and
 * inside a session the root and then each rank of subagents from the top (a
 * recap note, which is no tab stop, sits ahead of its root, where it is drawn).
 *
 * A column is the sessions whose boxes overlap side to side. The packer leaves
 * a tool lane and a card's width between columns, so on a laid-out board no box
 * reaches the next column, and a note put down to the left of its card still
 * overlaps the column its card stands in.
 */
export function boardOrder<N extends Node>(nodes: readonly N[], depthOf: (n: N) => number): N[] {
  const sessionOf = (n: N) => sessionOfNode(n);
  const boxes = new Map<string, { minX: number; maxX: number; minY: number }>();
  for (const n of nodes) {
    const sid = sessionOf(n);
    const x2 = n.position.x + (n.width ?? NODE_W);
    const b = boxes.get(sid);
    if (!b) boxes.set(sid, { minX: n.position.x, maxX: x2, minY: n.position.y });
    else {
      b.minX = Math.min(b.minX, n.position.x);
      b.maxX = Math.max(b.maxX, x2);
      b.minY = Math.min(b.minY, n.position.y);
    }
  }
  // Left edge first; a session joins the column before it while its box
  // overlaps that column's.
  const columns: { maxX: number; sessions: { sid: string; top: number }[] }[] = [];
  for (const [sid, b] of [...boxes].sort((p, q) => p[1].minX - q[1].minX)) {
    const last = columns[columns.length - 1];
    if (last && b.minX < last.maxX) {
      last.maxX = Math.max(last.maxX, b.maxX);
      last.sessions.push({ sid, top: b.minY });
    } else columns.push({ maxX: b.maxX, sessions: [{ sid, top: b.minY }] });
  }
  const rank = new Map<string, number>();
  for (const col of columns) {
    for (const { sid } of col.sessions.sort((p, q) => p.top - q.top)) rank.set(sid, rank.size);
  }
  return nodes.slice().sort((p, q) =>
    (rank.get(sessionOf(p))! - rank.get(sessionOf(q))!)
    || (depthOf(p) - depthOf(q))
    || (p.position.y - q.position.y)
    || (p.position.x - q.position.x));
}

/**
 * WHEN THE WHOLE BOARD FLOWS INTO ITS COLUMNS, in the rail's order: once, on
 * the first layout of a board storage brought nothing back for, and on R
 * (which empties every place, so the layout below lays the whole board out).
 * Never on a zoom, a panel opening or closing, or a window resize
 * (use-reframe.ts only moves the camera for those), and never because a
 * session came or went: a re-flow then moves every card on the board, and with
 * auto hide on that is all the time — the cards walking around the board of
 * #2291. A session arriving takes the board's next place, a gap or a column's
 * foot or a new column, and moves nothing else (fill-gaps.ts); one coming back
 * from auto hide goes home (return-home.ts).
 */
export interface BoardFlow {
  /** Whether the board has had its first layout's flow — or had a stored
   *  layout to keep instead. False until the board has settled. */
  flowed: { current: boolean };
  /** The board's sessions in reading order, the rail's (board-order.ts).
   *  Asked only when the layout runs. */
  order: () => readonly string[];
  /** Told when a pass moved cards with the layout signature unmoved: the first
   *  flow, a push (bubblePush), or a restored board's hold lifting onto cards
   *  that had grown since it was stored. The signature is what the auto-fit
   *  and the autosave wait on, so without this the camera kept framing the
   *  board from before the move (two columns drawn at the zoom of one, in the
   *  left half of the canvas; a pushed card below the pane) and a reload
   *  brought back the board from before it, for the same move to run again
   *  (use-auto-fit.ts fitSoon, use-board-layout.ts saveSoon). */
  onMoved?: () => void;
}

/** Where the board's cards stand, as one string to compare across a pass. */
function placesKey(nodes: readonly Node[], positions: ReadonlyMap<string, { x: number; y: number }>): string {
  return nodes.map(n => {
    const p = positions.get(n.id);
    return p ? `${n.id}@${Math.round(p.x)},${Math.round(p.y)}` : n.id;
  }).join("|");
}

/** The sessions whose cards a pass moved: what the board carries across with
 *  its own motion (use-bubble-animation.ts), not a jump. */
function movedSessions(nodes: readonly Node[], before: ReadonlyMap<string, { x: number; y: number }>,
  after: ReadonlyMap<string, { x: number; y: number }>): string[] {
  const moved = new Set<string>();
  for (const n of nodes) {
    const p = before.get(n.id), q = after.get(n.id);
    if (p && q && (Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5)) moved.add(sessionOfNode(n));
  }
  return [...moved];
}

/** How many parents up an agent's root is: 0 for a root, 1 for its subagents. */
function depthIn(state: GraphState, a: AgentNodeData): number {
  let depth = 0;
  for (let p = a.parentId; p != null && depth < state.agents.size; p = state.agents.get(p)?.parentId) depth++;
  return depth;
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
  /**
   * The event log has finished replaying, so the agents in `state` are all the
   * agents there are. Until then `positions` and `pinned` hold a board restored
   * from storage for agents that have not arrived yet (#1333).
   */
  historyReplayed: boolean,
  /**
   * Ids whose position came back from storage and has not yet been seen on the
   * board it was saved with (#1333). An id leaves it when it is laid out
   * afresh, and the whole set is emptied, for good, once the log has replayed
   * and the page has settled.
   */
  restored: Set<string>,
  /**
   * Sessions that have just come back onto the board — from the session list,
   * or by working again after Hide finished sessions took them off. Each goes
   * back to the place it kept, unless that ground was taken meanwhile
   * (return-home.ts). Spent as each session's cards are drawn.
   */
  returning: Set<string> = new Set(),
  /** The board's first flow into its columns, and the order it reads in
   *  (BoardFlow). Without it, sessions are laid out in id order and the board
   *  as the replay left it stands. */
  flow?: BoardFlow,
): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const nodes: Node<FlowNodeData>[] = [];
  const edges: Edge[] = [];
  const dataFor = nodeDataFor(state, onOpenContext, visibleIds);
  for (const a of state.agents.values()) {
    if (!visibleIds.has(a.id)) continue;
    const exiting = a.exitAt != null;
    // Spotlight: out-of-lineage agents fade hard when a selection is active.
    const spotlitOut = lineage != null && !lineage.has(a.id);
    // The selection's ring is drawn from this class, not from React Flow's own
    // `selected`: the canvas hands React Flow a controlled `nodes` with no
    // onNodesChange, so its click and keyboard selection land in a store this
    // board skips and the prop is never true. Not `selected: true` on the node
    // either — React Flow would then drag every selected card together, against
    // use-node-drag's patch.
    const cls = [
      exiting ? "rf-exiting" : "",
      spotlitOut ? "rf-spotlit-out" : "",
      selectedIds.has(a.id) ? "rf-selected" : "",
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
      ariaLabel: agentAriaLabel(a, now, selectedIds.has(a.id)),
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
        ? 0
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
        ariaLabel: t("board.edge.aria", { label: a.label }),
        animated: a.state === "active" && !fading,
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
        style: { "--session-hue": hue, strokeWidth: `calc(${selectedWidth}px * var(--edge-k, 1))`, opacity: effectiveOpacity, transition: "var(--edge-transition)",
          // An edge that leaves fades in Exit: the same custom property, set to the Exit fade on this one edge.
          ...(fading ? { "--edge-transition": "opacity var(--dur-exit) var(--ease)" } : null) } as React.CSSProperties,
        className: cls,
      });
    }
    // The session's note, as a node of its own beside the root — RecapNoteNode
    // holds why a node and not something drawn over the canvas. What it says is
    // session-note.ts's rule: what the session is doing while a turn runs, what
    // came of it once it ends, and Claude Code's recap when that arrives — one
    // note, so it appears with the work and the recap takes its place. Built
    // only while there is something to say and nobody has put it away, and tied
    // to the root by an edge FROM the note, which is also what makes dagre rank
    // it to the left of the card.
    // The session's plan rides on the same note, or holds one of its own while
    // there is nothing else to say (session-note.ts, boardNote).
    const board = a.kind === "root" ? boardNote(a) : null;
    const note = board?.note ?? null;
    const noteKey = board ? board.key : null;
    if (board && noteKey && !isRecapDismissed(noteKey)) {
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
        data: { sessionId: a.sessionId, canvasSessionId: dataFor(a).canvasSessionId, parentId: a.id, note, plan: board.plan, noteKey, hue },
        className: spotlitOut ? "rf-spotlit-out" : undefined,
        selectable: false,
        // Not a keyboard stop either, like the session drag handles: Enter on a
        // focused node selects its id, and a note's id is not an agent's. Its ×
        // is still a button, and still reached by Tab.
        focusable: false,
        ariaLabel: !note ? t("board.note.planFor", { label: a.label }) : note.kind === "recap" ? t("board.note.recapFor", { label: a.label }) : `${a.label}: ${noteTag(note.kind)}`,
        ...(mn ? { width: mn.width, height: mn.height } : null),
      } as unknown as (typeof nodes)[number]);
      edges.push({
        id: `e:recap:${a.id}`,
        source: noteId,
        target: a.id,
        type: "recapTie",
        className: "recap-edge",
        ariaLabel: t("board.edge.aria", { label: a.label }),
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
  //
  // A RESTORED POSITION IS NOT REPAIRED BEFORE ITS BOARD IS BACK (#1333). It was
  // clear of everything on the board it was saved from, and until the log has
  // replayed and the cards have measured, the board here is not that one: the
  // agents replayed so far, at the default card size, beside sessions from the
  // log that the tick's sweep evicts right after the replay. A render in the
  // middle of the replay lays out the first of those while the restored agents
  // they will land on have not arrived — nothing tells autoLayout where a card
  // that is not on the board yet is coming back to. When the restored ones did
  // arrive, the overlap pass slid whichever of the two was lower, often the
  // restored card; the sweep then took the arrival away and left the card
  // lower than it was saved, and a reload drew a different board. So until the
  // log is back and the page has settled, restored cards stand still and
  // whatever covers one slides off it instead. `#held` leaving the key is what
  // runs the pass once more when the hold lifts, and an overlap still there
  // then is real and is repaired as ever. A board that starts empty restores
  // nothing and is never held. (A replay that outlasts the settle delay lifts
  // the hold on its own last frame, a tick before the sweep: that board is
  // repaired the way every board was before this.)
  const holding = restored.size > 0 && !(settled && historyReplayed);
  // Read before the set empties: the cards still standing where storage put
  // them are a board somebody arranged, which the first flow leaves alone.
  const keptFromStorage = !holding && nodes.some(n => restored.has(n.id));
  if (!holding) restored.clear();
  const ancestry = nodes.filter(n => n.data.provider === "codex" && n.data.parentId).map(n => `${n.id}:${sessionOfNode(n)}:${n.data.parentId}`).sort().join("|");
  const sig = `${layoutSig}${ancestry ? `#codex:${ancestry}` : ""}#lanes:${laneSignature(lanes)}${holding ? "#held" : ""}`;
  // The pass the hold lifts on repairs a restored board against the cards as
  // they measure now; where that moves one, the board moved (BoardFlow onMoved).
  const placesBeforeLift = !holding && lastLayoutSigRef.current.endsWith("#held") ? placesKey(nodes, positions) : null;
  // A node holding a placeholder counts as missing however real its entry in
  // `positions` looks — see placement.ts. Without that, the one write that
  // exists to keep a node on screen for a frame was also the write that told
  // this filter the node had been laid out.
  // A recap note that is not on the board forgets where the layout put it, so
  // the next one is placed beside its card as the card sits THEN — a note put
  // away before its card moved must not come back to where the card used to
  // be. Where somebody DRAGGED one is a pin, and pins are kept (liveNodeIds).
  // After the replay, like the prune further down (#1333): while it streams in,
  // a note is off the board because its recap has not been replayed yet, not
  // because it was put away. Forgetting it then placed it again from a card
  // that had not measured, a few pixels off the spot it was saved at — and,
  // with the restored cards around it holding still, slid it down the column
  // away from its card, which stretched the session's box across its
  // neighbours for the push to shove the whole board apart once it settled.
  const shownNotes = new Set(nodes.filter(n => n.type === "recapNote").map(n => n.id));
  for (const id of Array.from(positions.keys())) {
    if (historyReplayed && isRecapNoteId(id) && !shownNotes.has(id) && !pinned.has(id)) {
      positions.delete(id);
      provisional.delete(id);
    }
  }
  // A session back from being hidden stands where it stood, or, when that
  // ground has been taken, arrives whole: its places are forgotten here, so it
  // is among the missing below and the gap pass finds it room.
  if (historyReplayed) sendSessionsHome(nodes, positions, provisional, pinned, measured, lanes, returning);
  // THE FIRST LAYOUT'S FLOW (BoardFlow), once the board's sessions are all
  // known — the log replayed and the cards measured. Every layout is cut in the
  // rail's order from the first frame, but the frames before this one were cut
  // for cards that had not measured, in a frame the panels had not narrowed
  // yet, and the replay may have brought the sessions in a few at a time, each
  // taking a gap. So the board is laid out whole once more, here; where that
  // agrees with what is on screen nothing moves, and what does move travels
  // with the board's own motion (onBubble below), which reduced motion turns
  // into a jump. A board a reload brought back stays as it was stored. Not
  // mid-drag: the flow waits for the card to be let go, and a dragged card is a
  // pin and keeps its place. A hidden session's place is not on the board and
  // is kept for its way home.
  let flowing = false;
  let beforeFlow: Map<string, { x: number; y: number }> | null = null;
  if (flow && !flow.flowed.current && settled && historyReplayed) {
    if (keptFromStorage) flow.flowed.current = true;
    else if (!dragging) {
      flow.flowed.current = true;
      flowing = true;
      beforeFlow = new Map();
      for (const n of nodes) {
        if (pinned.has(n.id)) continue;
        const p = isUnplaced(n.id, positions, provisional) ? undefined : positions.get(n.id);
        if (p) beforeFlow.set(n.id, { ...p });
        positions.delete(n.id);
        provisional.delete(n.id);
      }
    }
  }
  const missing = nodes.filter(n => needsLayout(n.id, pinned, positions, provisional));
  if (missing.length > 0 || sig !== lastLayoutSigRef.current) {
    if (missing.length > 0) {
      // Laid out afresh — after R, the first flow, or anything else that
      // emptied its place — so this page's arrangement, not the stored board's.
      for (const n of missing) restored.delete(n.id);
      // A card joining a session already on the canvas goes beside that session
      // as it sits now, not where a layout from scratch would have it — and a
      // subagent under the siblings its parent already has there.
      const laidOut = joinSessions(
        autoLayout(nodes, edges, { direction: "LR", pinned, measured, availableWidth, availableHeight, lanes, order: flow?.order() }),
        pinned,
        id => (isUnplaced(id, positions, provisional) ? undefined : positions.get(id)),
        id => footprint(id, measured, lanes),
      );
      for (const n of laidOut) if (isUnplaced(n.id, positions, provisional)) recordPlacement(n.id, n.position, positions, provisional);
      // Finished sessions are pruned as they complete, so the column they were
      // in has holes while new work keeps being appended underneath. Offer the
      // arrivals those holes first, and past them whichever of a column's foot
      // or a new column to the right lets the fit show the board largest.
      // Not on the first flow: its columns are the arrangement, and offered the
      // board's gaps one by one, its sessions would leave their reading order.
      if (!flowing) fillGapsWithNewSessions(
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
        recordPlacement(n.id, noteSpot(n.id, rootId, root, measured), positions, provisional);
      }
    }
    separateOverlaps(nodes, positions, pinned, measured, lanes, holding ? restored : undefined);
    lastLayoutSigRef.current = sig;
  }
  // A note goes where its card went. The overlap repair above slides cards one
  // by one, and a note covering nothing stayed behind each time its card slid —
  // see note-tether.ts for the board that made. Every frame, not only after a
  // layout: a card or a note measuring a new size moves the spot too. Not while
  // a restored board is held still (#1333); the hold lifting runs this.
  if (!holding) tetherRecapNotes(nodes, positions, provisional, pinned, measured);
  // A session that just fanned out subagents is wider and taller than it was a
  // frame ago, and is now sitting on whatever was beside it. separateOverlaps
  // would clear that by sliding the covered session down past the whole grown
  // block; this nudges the neighbours aside by the least that works, which is
  // both shorter and legible as a cause — the box grew, so the others moved.
  // Self-gating: returns immediately unless something actually grew. The first
  // flow only records: it has just laid every session out clear of the others.
  const bubbled = bubblePush(nodes, positions, pinned, measured, prevSessionSize, !settled || dragging || flowing, lanes);
  // The first flow's moves travel the way a push does, the cards too young for
  // their own easing included.
  const carried = beforeFlow ? [...new Set([...movedSessions(nodes, beforeFlow, positions), ...bubbled])] : bubbled;
  if (carried.length > 0) onBubble(carried);
  const liftMoved = placesBeforeLift !== null && placesBeforeLift !== placesKey(nodes, positions);
  if (flowing || carried.length > 0 || liftMoved) flow?.onMoved?.();
  // Evict cached positions for agents that aren't in state.agents anymore.
  // Stale positions for invisible-but-still-tracked agents are KEPT so a
  // transient flicker out of visibleIds (e.g. one frame where isAgentVisible
  // is false during a state transition) doesn't lose the position and snap
  // the node to {0,0} on return — that was causing "nodes vanish on action
  // change" while bursts (which gate on visibleIds) also disappeared.
  // Like the pins below, this waits for the replay to finish: positions are
  // restored from storage before the event log has replayed, so pruning them
  // against an empty agent map would wipe the whole saved arrangement on every
  // page load and re-derive it with dagre. Guarding on an empty map alone was
  // not enough (#1333). The replay renders once at its end, but anything else
  // that renders while it streams in — the clock's tick, the stream opening —
  // runs this against the few agents replayed so far, and every restored
  // position the rest were coming back to was dropped. They were then laid out
  // afresh as they arrived, and a reload drew a different board.
  const live = liveNodeIds(state.agents.values());
  if (historyReplayed) pruneStaleEntries(positions, live);
  // A mark normally lives one frame — the pass it asks for clears it — but an
  // agent that leaves between the stamp and that pass would leave its id in the
  // set for the life of the tab, which is the leak the size cache below had.
  pruneStaleEntries(provisional, live);
  // And a session marked as coming back that left the board for good first.
  pruneStaleEntries(returning, live);
  // Drop pins for agents that are gone. Pinned positions are restored from
  // localStorage on every load, so without this a drag from some previous run
  // outlives the agent it belonged to and keeps claiming that spot on the
  // canvas — where a later session, laid out from the top, gets stacked
  // straight onto it. After the replay, for the same reason as the positions:
  // a pin is the user's own placement, and the partial map would drop it too.
  if (historyReplayed) pruneStaleEntries(pinned, live);
  // Drop measurements for nodes that no longer exist. This cache is not
  // restored from storage, but it is not rebuilt either: nothing but the Clear
  // button ever removed an id, so a tab left open for days holds a size for
  // every agent and every session that has ever been on the canvas. The column
  // gap was once the widest measured node of all, and a session drag handle is
  // as wide as the whole session box, so a single long-gone session kept the
  // gap between columns at its width for the rest of the tab's life.
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
  // In board order rather than arrival order, because it is also Tab's order.
  // Sorted only here, after every pass above has run in the order it always
  // ran in, so the layout cannot tell.
  const depthOf = (n: Node<FlowNodeData>) => {
    if (n.type === "recapNote") return -1;
    const a = state.agents.get(n.id);
    return a ? depthIn(state, a) : 0;
  };
  return { nodes: boardOrder(finalNodes, depthOf), edges };
}
