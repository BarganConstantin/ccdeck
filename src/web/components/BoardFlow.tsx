// The board React Flow draws: the nodes and edges it is handed and the terms
// it is handed them on — no edge a keyboard stop, a drag threshold, the zoom
// range, the opening fit — and what shares its pane: the grid, the session
// labels, the tool bubbles, the auto-fit chip, the command stack, the minimap
// and Claude FM.
//
// Moved out of App.tsx's markup unchanged, with nodeTypes, edgeTypes and the
// opening fit's duration. App.tsx keeps the <main> around it and everything the
// board is built from. A hook's return comes in whole and is taken apart here
// under the names the markup already used.
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import ReactFlow, { Background, MiniMap } from "reactflow";
import type { ClearSource } from "../clear-confirm";
import { customFmSelection } from "../fm-stations";
import type { GraphState } from "../reducer";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from "../stored-viewport";
import type { useAppearance } from "../use-appearance";
import type { useAutoFitSwitch } from "../use-auto-fit-switch";
import type { useBoardGraph } from "../use-board-graph";
import type { useBoardLayout } from "../use-board-layout";
import type { useCanvasClicks } from "../use-canvas-clicks";
import type { useCanvasViewport } from "../use-canvas-viewport";
import type { useCategoryFilterBar } from "../use-category-filter-bar";
import type { useClaudeFm } from "../use-claude-fm";
import type { useNodeDrag } from "../use-node-drag";
import type { useNodeMeasurements } from "../use-node-measurements";
import type { PauseControls } from "../use-pause-gate";
import { shouldAnimateViewport } from "../viewport-motion";
import AgentNode from "./AgentNode";
import AutoFitChip from "./AutoFitChip";
import CanvasControls from "./CanvasControls";
import ClaudeFm from "./ClaudeFm";
import RecapNoteNode from "./RecapNoteNode";
import RecapTieEdge from "./RecapTieEdge";
import SessionClusters from "./SessionClusters";
import SessionGroupNode from "./SessionGroupNode";
import ToolBursts from "./ToolBursts";

const nodeTypes = { agent: AgentNode, sessionGroup: SessionGroupNode, recapNote: RecapNoteNode };
/** The recap note's tie to its card — see RecapTieEdge. At module scope like
 *  nodeTypes, since a new object each render makes React Flow warn and remount. */
const edgeTypes = { recapTie: RecapTieEdge };

/** How long React Flow's own opening fit takes, when there is anyone watching
 *  it. Named because the answer to "should this animate" is asked of it too. */
const OPENING_FIT_MS = 400;

export default function BoardFlow({
  graph, layout, viewport, clicks, drag, appearance, fm, autoFit, pause,
  stateRef, measuredRef, hiddenCats, now, openTool, focusAgent, requestClear, setKeyHelpOpen,
}: {
  /** What is drawn: the nodes with a drag patched over them, the edges, and
   *  the visibility and spotlight sets the bubbles gate on. */
  graph: ReturnType<typeof useBoardGraph>;
  /** The positions and pins the bubbles are placed from, and R. */
  layout: ReturnType<typeof useBoardLayout>;
  viewport: ReturnType<typeof useCanvasViewport>;
  clicks: ReturnType<typeof useCanvasClicks>;
  drag: ReturnType<typeof useNodeDrag>;
  appearance: ReturnType<typeof useAppearance>;
  fm: ReturnType<typeof useClaudeFm>;
  autoFit: ReturnType<typeof useAutoFitSwitch>;
  pause: PauseControls;
  /** Read during render, as App.tsx read it: this renders only when App does. */
  stateRef: MutableRefObject<GraphState>;
  measuredRef: ReturnType<typeof useNodeMeasurements>["measuredRef"];
  hiddenCats: ReturnType<typeof useCategoryFilterBar>["hiddenCats"];
  now: number;
  openTool: (agentId: string, toolId: string) => void;
  focusAgent: (id: string) => void;
  requestClear: (source: ClearSource) => void;
  setKeyHelpOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const { allNodes, edges, visibleAgentIds, spotlightSet } = graph;
  const { positionsRef, pinnedRef, handleRelayout } = layout;
  const { restoredViewport, onMoveStart, onMove } = viewport;
  const { onNodeClick, onPaneClick, onNodeDoubleClick, onNodeMouseEnter, onNodeMouseLeave } = clicks;
  const { onNodeDragStart, onNodeDrag, onNodeDragStop } = drag;
  const { palette, minimapNodeFill, characterEnabled } = appearance;
  const { fmVolume, fmMuted, fmSource, fmPlayRequest, customFmStations, markFmStationAvailability } = fm;
  const { autoFitDisabled, enableAutoFitAndRefit } = autoFit;
  const { paused, pauseGate, togglePause } = pause;
  return (
    <ReactFlow
      nodes={allNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      /* EDGES ARE NOT KEYBOARD STOPS. React Flow's store defaults
         `edgesFocusable` to true, and its EdgeWrapper gates on that flag
         alone rather than on `disableKeyboardA11y` below — so every parent
         -> child connector took tabIndex 0, role="button", an aria-label of
         `Edge from ${source} to ${target}`, and a description reading
         "Press enter or space to select an edge. You can then press delete
         to remove it or escape to cancel."

         Subagent ids are `${sessionId}::${agentId}`, so that label was
         about 110 characters of UUID, read out at a stop between every
         parent and child. And every key it named was then swallowed:
         `disableKeyboardA11y` short-circuits EdgeWrapper's onKeyDown, so
         Enter, Space, Delete and Escape on a focused edge all did nothing.

         This is what #853 and #367 fixed for nodes, applied to nodes only.
         The edge keeps role="img" and its label, which is harmless — the
         target node already carries the name. */
      edgesFocusable={false}
      edgeTypes={edgeTypes}
      fitView={!restoredViewport}
      /* The opening frame is React Flow's own, and it goes through the same
         d3 transition every other viewport animation does — so a deck that
         opened its tab behind whatever the user was already looking at drew
         its graph and then left the pane at the identity transform, an
         empty-looking canvas until the tab was brought forward. The library
         re-reads this object into its store on every render and only fits
         once, when the first nodes are measured, so asking for no animation
         while the page is not being rendered takes the branch that applies
         the transform outright. A visible tab still gets the 400ms. */
      fitViewOptions={{
        padding: 0.25,
        duration: shouldAnimateViewport({ durationMs: OPENING_FIT_MS, documentHidden: document.hidden })
          ? OPENING_FIT_MS
          : 0,
      }}
      minZoom={CANVAS_MIN_ZOOM}
      maxZoom={CANVAS_MAX_ZOOM}
      panOnScroll
      nodesDraggable
      nodesConnectable={false}
      selectionOnDrag={false}
      // Without a threshold React Flow begins a drag on pointerdown, so a
      // plain click ran onNodeDragStart/onNodeDragStop at zero delta: it
      // pinned the card — every card of the session, for the group handle —
      // and switched auto-fit off for good. The distance is measured in
      // flow units, so it scales with the zoom; 5 is roughly the slop a
      // mouse, a trackpad or a finger has to beat before the gesture counts
      // as a drag instead of a click.
      nodeDragThreshold={5}
      // React Flow's own keyboard layer told a screen reader, on every card,
      // "use the arrow keys to move the node around. Press delete to remove
      // it" (#853). Neither is true here: the nodes are a controlled prop with
      // no onNodesChange, so its arrow moves and deletes never land, and the
      // deck answers Enter itself (canvas-keys.ts). So the description goes,
      // with the live region that would announce a move that never happens,
      // and Backspace stops being a key React Flow listens for at all.
      disableKeyboardA11y
      deleteKeyCode={null}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeMouseEnter={onNodeMouseEnter}
      onNodeMouseLeave={onNodeMouseLeave}
      onMoveStart={onMoveStart}
      onMove={onMove}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
    >
      <Background gap={28} size={1} color={palette["--grid-line"]} />
      {/* The stamp that keeps a click on a session's name from reading as
          the user grabbing the canvas — see the note on the component
          (#785). Same line use-agent-focus.ts's focusSession runs after its
          fitView. */}
      <SessionClusters onFocusSession={focusAgent} />
      <ToolBursts
        agents={stateRef.current.agents}
        visibleAgentIds={visibleAgentIds}
        positions={positionsRef.current}
        pinned={pinnedRef.current}
        measured={measuredRef.current}
        spotlight={spotlightSet}
        hiddenCategories={hiddenCats}
        now={now}
        onOpenTool={openTool}
      />
      {/* The state the recenter tint used to be the only sign of (#820).
          While the reader's own pan or zoom holds the view, new sessions
          can land off-screen; this says so on the canvas they would be
          looked for on, with the way back in the same place. */}
      {/* A status and an action, not one big button. The words say what
          the state is and are not a control; Resume is the one thing here
          that can be pressed, and it does what the whole chip used to. */}
      {autoFitDisabled && <AutoFitChip enableAutoFitAndRefit={enableAutoFitAndRefit} />}
      {/* No React Flow fit-view button (#840). Recenter below does the same
          fit and also turns autofit back on, so two near-identical buttons
          sat side by side and the reader had to guess the difference. F
          still fits from the keyboard. */}
      <CanvasControls
        autoFitDisabled={autoFitDisabled} enableAutoFitAndRefit={enableAutoFitAndRefit}
        paused={paused} pauseGate={pauseGate} togglePause={togglePause}
        handleRelayout={handleRelayout} requestClear={requestClear} setKeyHelpOpen={setKeyHelpOpen}
      />
      <MiniMap
        zoomable
        pannable
        nodeColor={minimapNodeFill}
        nodeStrokeWidth={2}
        maskColor={palette["--minimap-mask"]}
        // The frame the view is showing, outlined. The minimap's surface
        // sits close to the canvas now (.react-flow__minimap), so the mask
        // alone no longer separates it well; a --line keyline does, in
        // the same neutral the chrome's edges are drawn in.
        maskStrokeColor={palette["--line"]}
      />
      {/* Above the minimap, and absent unless there is something to play —
          ClaudeFm renders null until the server says the channel is on air,
          so on a deck with no network this is nothing at all. */}
      {characterEnabled && (
        <ClaudeFm
          volume={fmVolume}
          muted={fmMuted}
          source={fmSource}
          playRequest={fmPlayRequest}
          customStation={customFmStations.find(station => customFmSelection(station.id) === fmSource)}
          onAvailabilityChange={markFmStationAvailability}
        />
      )}
    </ReactFlow>
  );
}
