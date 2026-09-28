// Overlay that renders a small "tool bubble" next to each agent for the
// last MAX_PER_AGENT tool calls — a persistent trail of recent activity.
// Bubbles fly out FROM the agent's centre (via per-bubble --spawn-dx/dy
// custom properties) on spawn, get pushed out FIFO when newer tools land,
// and only fade away when the owning agent retires (exitAt set). Earlier
// versions hid bubbles a few seconds after the tool finished, which left
// idle/just-finished sessions looking empty next to a wall of "DONE" cards.
// They live on a layer above React Flow's nodes and follow the canvas
// pan/zoom via useViewport().
import React, { memo } from "react";
import { useViewport } from "reactflow";
import type { AgentNodeData } from "../types";
import type { ToolCategory } from "../tool-taxonomy";
import { BUBBLE_HALF_H, collectBursts, type Burst } from "../burst-layout";

interface ToolBurstsProps {
  /** The full agents Map. */
  agents: Map<string, AgentNodeData>;
  /** The exact set of agent ids currently on the canvas (computed in
   *  App.tsx via computeVisibleIds). Bursts only render for agents in this
   *  set — guarantees burst visibility matches card visibility. */
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
  onOpenTool?: (toolId: string) => void;
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
  onOpenTool?: (toolId: string) => void;
}

/** The part that genuinely depends on the camera: bursts carry world-space
 *  coordinates, and every bubble/connector is drawn in screen space. Keeping
 *  the useViewport() subscription here — and only here — means a pan/zoom
 *  frame re-renders this and nothing above it. */
function BurstLayer({ bursts, spotlight, onOpenTool }: BurstLayerProps) {
  const { x, y, zoom } = useViewport();

  return (
    // aria-hidden on the whole layer, connectors and bubbles alike, and nothing
    // inside it takes focus — see the note on the bubble below for why this is
    // decoration rather than a control surface.
    <div className="tool-bursts-layer" aria-hidden>
      <svg className="tool-bursts-svg">
        {bursts.map(b => {
          const sx = b.anchorX * zoom + x;
          const sy = b.anchorY * zoom + y;
          const tx = (b.worldX + 6) * zoom + x;
          const ty = (b.worldY + BUBBLE_HALF_H) * zoom + y;
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
          const run = Math.max(1, tx - sx);
          const lean = Math.min(1, Math.abs(ty - sy) / run);
          const cx = sx + run * (0.55 - 0.22 * lean);
          const isSpotOut = spotlight != null && !spotlight.has(b.agentId);
          const opacity = b.fade * (isSpotOut ? 0.14 : 1);
          return (
            <path
              key={`l:${b.id}`}
              d={`M ${sx} ${sy} Q ${cx} ${sy}, ${tx} ${ty}`}
              className={`tool-conn status-${b.status}${b.fading ? " fading" : ""}`}
              opacity={opacity}
            />
          );
        })}
      </svg>
      {bursts.map(b => (
        <Bubble
          key={b.id}
          b={b}
          x={x}
          y={y}
          zoom={zoom}
          dim={spotlight != null && !spotlight.has(b.agentId)}
          onOpenTool={onOpenTool}
        />
      ))}
    </div>
  );
}

interface BubbleProps {
  b: Burst;
  x: number;
  y: number;
  zoom: number;
  dim: boolean;
  onOpenTool?: (toolId: string) => void;
}

/** What a bubble draws, value by value (#873). `collectBursts` builds a fresh
 *  Burst for every bubble on every render — it has to, the clock moves the fades
 *  on the connectors — so identity says nothing; these are the fields the markup
 *  below reads, and a bubble whose fields did not move is not rendered again. */
function sameBubble(p: BubbleProps, q: BubbleProps): boolean {
  const a = p.b, c = q.b;
  return p.x === q.x && p.y === q.y && p.zoom === q.zoom && p.dim === q.dim && p.onOpenTool === q.onOpenTool
    && a.id === c.id && a.toolId === c.toolId && a.worldX === c.worldX && a.worldY === c.worldY
    && a.spawnDx === c.spawnDx && a.spawnDy === c.spawnDy && a.status === c.status && a.fading === c.fading
    && a.category === c.category && a.mcpHue === c.mcpHue && a.isSub === c.isSub && a.emoji === c.emoji
    && a.name === c.name && a.fullName === c.fullName && a.toolName === c.toolName && a.inputPreview === c.inputPreview;
}

/** One bubble, memoised on what it draws (#873). On an idle board the clock
 *  ticks four times a second and every Burst is rebuilt; a bubble none of whose
 *  drawn values changed now stays exactly as it is. */
const Bubble = memo(function Bubble({ b, x, y, zoom, dim, onOpenTool }: BubbleProps) {
        const px = b.worldX * zoom + x;
        const py = b.worldY * zoom + y;
        const wrapStyle: React.CSSProperties & Record<string, string> = {
          left: `${px}px`,
          top: `${py}px`,
          transform: `scale(${zoom})`,
          transformOrigin: "left top",
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
              onClick={clickable ? () => onOpenTool!(b.toolId) : undefined}
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
