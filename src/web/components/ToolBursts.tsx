// Overlay that renders a small "tool bubble" next to each agent for the
// last MAX_PER_AGENT tool calls — a persistent trail of recent activity.
// Bubbles fly out FROM the agent's centre (via per-bubble --spawn-dx/dy
// custom properties) on spawn, get pushed out FIFO when newer tools land,
// and only fade away when the owning agent retires (exitAt set). Earlier
// versions hid bubbles a few seconds after the tool finished, which left
// idle/just-finished sessions looking empty next to a wall of "DONE" cards.
// They live on a layer above React Flow's nodes, drawn in world coordinates,
// and follow the canvas pan/zoom through one transform per layer (BurstCamera).
import React, { memo } from "react";
import { useViewport } from "reactflow";
import type { AgentNodeData } from "../types";
import type { ToolCategory } from "../tool-taxonomy";
import { BUBBLE_HALF_H, collectBursts, type Burst } from "../burst-layout";

interface ToolBurstsProps {
  /** The full agents Map. */
  agents: Map<string, AgentNodeData>;
  /** The exact set of agent ids currently on the canvas (computed in
   *  use-board-graph.ts via computeVisibleIds). Bursts only render for agents
   *  in this set — guarantees burst visibility matches card visibility. */
  visibleAgentIds: Set<string>;
  /** Same maps that feed ReactFlow's `nodes` prop. Reading from these means
   *  bursts and agents share a single source of truth for positions — they
   *  can never disagree, even mid-reflow. */
  positions: Map<string, { x: number; y: number }>;
  pinned: Map<string, { x: number; y: number }>;
  measured: Map<string, { width: number; height: number }>;
  /** When set, bursts whose agent isn't in this set get dimmed (matches the
   *  /-search behaviour applied to nodes). null = no filter. */
  /** Spotlight: when an agent is selected, this set contains its lineage
   *  (ancestors + descendants). Bursts outside the lineage fade hard.
   *  null = no selection, full brightness everywhere. */
  spotlight?: Set<string> | null;
  /** Bursts whose category is in this set are skipped entirely (user
   *  toggled the category off via the filter chips). */
  hiddenCategories?: Set<ToolCategory>;
  now: number;
  /** Open the existing ToolModal for the given tool id. */
  onOpenTool?: (agentId: string, toolId: string) => void;
}

export default function ToolBursts({ agents, visibleAgentIds, positions, pinned, measured, spotlight, hiddenCategories, now, onOpenTool }: ToolBurstsProps) {
  // Deliberately NOT subscribed to the viewport. useViewport() fires on every
  // frame of a pan/zoom gesture, and this walk of the agents map — regex
  // parsing every tool input, allocating a fresh Burst per bubble — is pure
  // waste when nothing but the camera moved. It lives in the parent so it runs
  // once per data change (App re-renders whenever positions, sizes, the agents
  // map or the clock move), and the camera is read one level down.
  const all = collectBursts(agents, visibleAgentIds, positions, pinned, measured, now);
  const bursts = hiddenCategories && hiddenCategories.size > 0
    ? all.filter(b => !hiddenCategories.has(b.category))
    : all;
  // We always render the layer — even when empty — so that the bubbles'
  // CSS spawn animations don't re-run every time the agent's tool list
  // briefly normalises. Returning null here would unmount the entire
  // layer (and every bubble inside) on any momentary empty state.
  return (
    <BurstLayer
      bursts={bursts}
      spotlight={spotlight}
      onOpenTool={onOpenTool}
    />
  );
}

interface BurstLayerProps {
  bursts: Burst[];
  spotlight?: Set<string> | null;
  onOpenTool?: (agentId: string, toolId: string) => void;
}

/** Every bubble and connector, in WORLD coordinates — the ones collectBursts
 *  and React Flow's node positions are in — so nothing drawn here depends on
 *  the camera. It runs once per data change, like ToolBursts above it; the
 *  camera is BurstCamera's alone. */
function BurstLayer({ bursts, spotlight, onOpenTool }: BurstLayerProps) {
  const connectors = bursts.map(b => {
    const sx = b.anchorX;
    const sy = b.anchorY;
    const tx = b.worldX + 6;
    const ty = b.worldY + BUBBLE_HALF_H;
    // FOUR CURVES THAT LEFT AS ONE. Every connector starts at the same
    // point — the card's right edge, mid-height — and every one of them
    // put its control point at that same height, so they ran the
    // identical horizontal line out of the anchor and only came apart
    // once their vertical legs did. Four coincident strokes for the first
    // half of the run, told apart by colour alone.
    //
    // The bend now depends on how far the row has to travel: a bubble
    // level with the card keeps the long flat lead it always had, and one
    // several rows up or down breaks away sooner. Nothing moves — same
    // anchor, same targets, same curve family — the strokes simply stop
    // sharing their first half, so the eye can follow one of them back.
    // (`lean` is a ratio, so it reads the same in world units as it did in
    // screen pixels.)
    const run = Math.max(1, tx - sx);
    const lean = Math.min(1, Math.abs(ty - sy) / run);
    const cx = sx + run * (0.55 - 0.22 * lean);
    const isSpotOut = spotlight != null && !spotlight.has(b.agentId);
    const opacity = b.fade * (isSpotOut ? 0.14 : 1);
    // `non-scaling-stroke` keeps the line's width and its dashes in screen
    // pixels under the camera's scale, which is what they were drawn in
    // when every path was redrawn in screen space each frame.
    return (
      <path
        key={`l:${b.id}`}
        d={`M ${sx} ${sy} Q ${cx} ${sy}, ${tx} ${ty}`}
        className={`tool-conn status-${b.status}${b.fading ? " fading" : ""}`}
        opacity={opacity}
        vectorEffect="non-scaling-stroke"
      />
    );
  });
  const bubbles = bursts.map(b => (
    <Bubble
      key={b.id}
      b={b}
      dim={spotlight != null && !spotlight.has(b.agentId)}
      onOpenTool={onOpenTool}
    />
  ));
  return <BurstCamera connectors={connectors} bubbles={bubbles} />;
}

/** The part that genuinely depends on the camera, and the only part: one
 *  transform on each of the layer's two halves, the one React Flow writes to
 *  .react-flow__viewport to carry the cards, built from the same three numbers.
 *
 *  It used to be folded into every bubble's left, top and scale and every
 *  connector's path, so a pan or zoom frame restyled all of them — about 60,000
 *  DOM writes for 40 wheel steps on a board of 751 bubbles, against 244 with
 *  the bubbles hidden, and a frame rate that fell from 59 to 34–45. Now a frame
 *  re-renders this and nothing below it: `connectors` and `bubbles` are the
 *  elements BurstLayer made, unchanged while only the camera moves, so React
 *  skips every one of them. The session boxes moved the same way in #353. */
function BurstCamera({ connectors, bubbles }: { connectors: React.ReactNode; bubbles: React.ReactNode }) {
  const { x, y, zoom } = useViewport();
  return (
    // aria-hidden on the whole layer, connectors and bubbles alike, and nothing
    // inside it takes focus — see the note on the bubble below for why this is
    // decoration rather than a control surface.
    <div className="tool-bursts-layer" aria-hidden>
      <svg className="tool-bursts-svg">
        <g transform={`translate(${x} ${y}) scale(${zoom})`}>{connectors}</g>
      </svg>
      {/* transformOrigin lives in the sheet, with the rest of the layer's
          geometry, as it does for .session-clusters. */}
      <div className="tool-bursts-world" style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }}>
        {bubbles}
      </div>
    </div>
  );
}

interface BubbleProps {
  b: Burst;
  dim: boolean;
  onOpenTool?: (agentId: string, toolId: string) => void;
}

/** What a bubble draws, value by value (#873). `collectBursts` builds a fresh
 *  Burst for every bubble on every render — it has to, the clock moves the fades
 *  on the connectors — so identity says nothing; these are the fields the markup
 *  below reads, and a bubble whose fields did not move is not rendered again. */
function sameBubble(p: BubbleProps, q: BubbleProps): boolean {
  const a = p.b, c = q.b;
  return p.dim === q.dim && p.onOpenTool === q.onOpenTool
    && a.id === c.id && a.toolId === c.toolId && a.worldX === c.worldX && a.worldY === c.worldY
    && a.spawnDx === c.spawnDx && a.spawnDy === c.spawnDy && a.status === c.status && a.fading === c.fading
    && a.category === c.category && a.mcpHue === c.mcpHue && a.isSub === c.isSub && a.emoji === c.emoji
    && a.name === c.name && a.fullName === c.fullName && a.toolName === c.toolName && a.inputPreview === c.inputPreview;
}

/** One bubble, memoised on what it draws (#873). On an idle board the clock
 *  ticks four times a second and every Burst is rebuilt; a bubble none of whose
 *  drawn values changed now stays exactly as it is. */
const Bubble = memo(function Bubble({ b, dim, onOpenTool }: BubbleProps) {
  // World coordinates: BurstCamera's transform puts them on the screen, and
  // scales the bubble with the cards as each wrap's own `scale(zoom)` did.
  const wrapStyle: React.CSSProperties & Record<string, string> = {
    left: `${b.worldX}px`,
    top: `${b.worldY}px`,
    "--spawn-dx": `${b.spawnDx}px`,
    "--spawn-dy": `${b.spawnDy}px`,
  };
  // Tooltip always shows the underlying tool (Bash/PowerShell/…) so
  // the transport is never hidden, plus the input preview when present.
  // A sub's word is the uncut one: the tooltip is where a cut name is
  // read in full.
  const titleHead = b.isSub ? `${b.toolName} · ${b.fullName ?? b.name}` : b.toolName;
  const title = b.inputPreview ? `${titleHead} · ${b.inputPreview}` : titleHead;
  const clickable = onOpenTool != null;
  // For unknown MCP servers we hand the sheet the hashed hue and let
  // .tool-burst.cat-mcp.mcp-hue build --cat-accent from it, so the same
  // server reads the same on either canvas — the literal colour that
  // used to be here was 1.40:1 on a white bubble at its worst hue.
  const innerStyle: React.CSSProperties & Record<string, string | number> = b.mcpHue != null
    ? { "--mcp-hue": b.mcpHue }
    : {};
  const dimClass = dim ? " dim" : "";
  return (
    <div className="tool-burst-wrap" style={wrapStyle}>
      {/* Decoration, and now honest about it.

          Every clickable bubble used to be a role="button" tabIndex={0}
          with a carefully written aria-label, inside a layer marked
          aria-hidden — the classic focusable-inside-aria-hidden failure,
          and at the scale this layer works at: a live deck put 105 of the
          page's 166 focusables in here, so two thirds of the tab order
          was stops that announce as nothing and expire on their own
          timer while the user is tabbing through them.

          Of the two ways out, this is the one the layer's own behaviour
          already argues for. The bubbles are a transient trace of what
          each agent just ran; they fade, they move with the viewport, and
          they are a second view of the tools the detail panel lists as
          real <button>s (ToolRow), which is where a keyboard reaches the
          exact same modal with a stable, ordered, announced list. So the
          mouse affordance stays — hover, cursor and onClick are
          untouched — and the accessibility tree keeps the one statement
          that was already true about this layer. */}
      <div
        className={`tool-burst cat-${b.category}${b.mcpHue != null ? " mcp-hue" : ""} status-${b.status}${b.fading ? " fading" : ""}${clickable ? " clickable" : ""}${b.isSub ? " sub" : ""}${dimClass}`}
        style={innerStyle}
        title={title}
        onClick={clickable ? () => onOpenTool!(b.agentId, b.toolId) : undefined}
      >
        <span className="tb-emoji">{b.emoji}</span>
        <span className="tb-name">{b.name}</span>
        {b.status === "inflight" && <span className="tb-spin" />}
        {b.status === "done" && <span className="tb-mark done">✓</span>}
        {b.status === "err" && <span className="tb-mark err">×</span>}
      </div>
    </div>
  );
}, sameBubble);
