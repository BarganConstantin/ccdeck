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
import type { AgentNodeData, ToolCall } from "../types";
import { categoryFor, type ToolCategory } from "../tool-taxonomy";
import { cutSubLabel, primaryDisplayFor, skinFor } from "../tool-skin";

const FADE_MS = 600;
const MAX_PER_AGENT = 4;
const BUBBLE_VERT_GAP = 36;
const BUBBLE_HALF_H = 16;
const BUBBLE_OFFSET_X = 60;
/** Vertical inset from the agent's top — first bubble sits this far below
 *  the agent's top edge, then they stack downward. Anchoring to the top
 *  (rather than the middle) keeps the trail from overflowing above the
 *  card or running over the card's own header/title area. */
const BUBBLE_TOP_INSET = 6;
/** Floor for the agent's measured width — the .agent-node CSS has
 *  min-width:220px, so even an unmeasured card is at least this wide. Using
 *  it stops bubbles from being computed flush with a wrong-tiny width and
 *  then visually overlapping the card once measurement settles. */
const AGENT_W_MIN = 220;
/** Minimum reserved width of a bubble before it is measured. */
const ESTIMATED_BUBBLE_W = 96;
const SUB_GAP = 28;

// Which category a tool falls in — file = blue, shell = amber, web = cyan,
// agent = pink, tasks/todos = green, plan = violet, mcp = teal — now lives in
// tool-taxonomy.ts, shared with App.tsx's detail strip and filter chips. It
// used to be a private literal here and a near-identical private literal
// there, and the two drifted apart the first time Codex renamed a tool (#417).

/** Reserve space for the same visible label for every tool family. The CSS
 *  caps the primary at 190px, leaving at least 22px of the 28px chain gap
 *  even when a wide glyph makes the rendered label wider than this estimate. */
export function primaryBubbleWidth(_toolName: string, label: string): number {
  return Math.max(ESTIMATED_BUBBLE_W, 61 + [...label].length * 6.8);
}

type Status = "inflight" | "done" | "err";

function statusOf(t: ToolCall): Status {
  if (t.endedAt == null) return "inflight";
  return t.ok === false ? "err" : "done";
}

/** Bubble opacity — full while inflight or in the last-N trail. The fade
 *  branch is only used when an agent is retiring (exitAt set); otherwise
 *  the bubble stays at full opacity so the trail of recent activity
 *  persists. `agentExitAt` is the agent's exitAt timestamp, or null. */
function fadeAt( now: number, agentExitAt: number | null): number {
  if (agentExitAt == null) return 1;
  const since = now - agentExitAt;
  if (since < 0) return 1;
  return Math.max(0, 1 - since / FADE_MS);
}

interface Burst {
  /** React key — unique per visible bubble (a tool can produce 1 or 2).
   *  Scoped by the owning agent, because tool ids are only unique within an
   *  agent: the same tool_use_id can legitimately be echoed to a parent and
   *  its subagent, and a bare tool id would then key two bubbles the same. */
  id: string;
  /** Underlying ToolCall id, used for click-to-open. Same for primary and
   *  its shell sub-bubble. */
  toolId: string;
  agentId: string;
  /** Original tool name (e.g. "Bash"). Always present; goes into the tooltip. */
  toolName: string;
  /** Display label — cut to what the pill can show. */
  name: string;
  /** A sub-bubble's word before it was cut, for the tooltip: a tooltip that
   *  repeats the cut label recovers nothing. A primary's tooltip leads with
   *  the raw tool name instead, so it has no need of one. */
  fullName?: string;
  /** Display emoji. */
  emoji: string;
  /** True for shell sub-bubbles. Lets us style them slightly differently. */
  isSub?: boolean;
  status: Status;
  category: ToolCategory;
  /** For unknown MCP servers — hash-based hue so 5 distinct servers read
   *  as 5 distinct colors instead of all 🔌. */
  mcpHue?: number;
  inputPreview: string;
  fade: number;
  fading: boolean;
  worldX: number;
  worldY: number;
  anchorX: number;
  anchorY: number;
  /** Worldspace delta from final position back to agent centre. Drives the
   *  spawn-from-origin animation via CSS custom properties. */
  spawnDx: number;
  spawnDy: number;
}

/** The tail of `tools` that actually gets bubbles: the last `limit` calls,
 *  with at most one entry per tool id.
 *
 *  `tools` is a plain array and nothing upstream guarantees a tool id appears
 *  only once — a repeated PreToolUse for the same tool_use_id pushes a second
 *  record. Both copies land on identical coordinates (the slot geometry is
 *  derived from the agent's position), so the duplicate is invisible clutter,
 *  and it used to give two bubbles the same React key, which corrupts the
 *  keyed list and leaves orphan DOM behind. Collapsing the window here means
 *  the keys built from these ids are unique by construction.
 *
 *  The LAST record of an id wins: PostToolUse settles the tool the reducer's
 *  toolIndex points at, which is the most recently pushed one, so the survivor
 *  is the copy carrying the real status instead of a spinner that never ends.
 *  Walking backwards also stops as soon as the window is full, so this stays
 *  O(limit) on an agent with a long history. */
export function distinctRecentTools(tools: ToolCall[], limit: number): ToolCall[] {
  const out: ToolCall[] = [];
  const seen = new Set<string>();
  for (let i = tools.length - 1; i >= 0 && out.length < limit; i--) {
    const t = tools[i];
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out.reverse();
}

export function collectBursts(
  agents: Map<string, AgentNodeData>,
  visibleAgentIds: Set<string>,
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  now: number,
): Burst[] {
  const out: Burst[] = [];
  for (const a of agents.values()) {
    // HARD gate: if the agent isn't on the canvas, no bursts for it either.
    // This is the single source of truth shared with snapshotToFlow so
    // bursts can never linger after their owning card has been filtered out
    // (the classic "orphan bursts floating with no agent card" bug).
    if (!visibleAgentIds.has(a.id)) continue;
    if (a.exitAt != null && now - a.exitAt > FADE_MS) continue;
    const pos = pinned.get(a.id) ?? positions.get(a.id);
    if (!pos) continue; // no position yet — agent not laid out
    // Always show the last MAX_PER_AGENT tools' bubbles as a persistent
    // "trail" of recent activity — no time-based culling. Bubbles only
    // leave when newer tools push them out of the window, or when the
    // agent itself retires (exitAt set, handled via fadeAt above).
    const visible = distinctRecentTools(a.tools, MAX_PER_AGENT);
    if (visible.length === 0) continue;
    const agentExitAt = a.exitAt ?? null;
    const size = measured.get(a.id);
    // Floor to the CSS min-width so we never under-estimate the card's
    // right edge and end up positioning a bubble inside it.
    const aW = Math.max(size?.width ?? AGENT_W_MIN, AGENT_W_MIN);
    const aH = size?.height ?? 130;
    const aX = pos.x;
    const aY = pos.y;
    const anchorX = aX + aW;
    const anchorY = aY + aH / 2;
    visible.forEach((t, idx) => {
      const offsetY = idx * BUBBLE_VERT_GAP;
      const worldX = aX + aW + BUBBLE_OFFSET_X;
      const worldY = aY + BUBBLE_TOP_INSET + offsetY;
      const fade = fadeAt(now, agentExitAt);
      // The delta is from the bubble's anchor point (its visual left-centre)
      // back to the agent's right edge. The bubble starts there during spawn
      // and rides outward to its resting place.
      const inputPreview = t.inputPreview ?? "";
      const status = statusOf(t);
      const fading = fade < 0.999;
      // Primary bubble — the actual tool name as CC reported it. For MCP
      // calls we substitute the server name + branded emoji so the eye
      // reads "🐙 GitHub → create_pr" instead of two identical 🔌s.
      const primary = primaryDisplayFor(t.name);
      out.push({
        id: `${a.id}::${t.id}`,
        toolId: t.id,
        agentId: a.id,
        toolName: t.name,
        name: primary.label,
        emoji: primary.emoji,
        status,
        category: categoryFor(t.name),
        mcpHue: primary.hue,
        inputPreview,
        fade,
        fading,
        worldX,
        worldY,
        anchorX,
        anchorY,
        spawnDx: anchorX - worldX,
        spawnDy: anchorY - (worldY + BUBBLE_HALF_H),
      });
      // Chained sub-bubble — applies to:
      //   - Bash/PowerShell: show the parsed underlying command (git, npm…)
      //   - Read/Write/Edit/MultiEdit/NotebookEdit/LS/Glob: show the file
      //     basename (or directory / glob pattern)
      // Pass raw t.input, not inputPreview — CC's tool_input is an object
      // and stringifying it loses field access.
      const skin = skinFor(t.name, t.input);
      if (skin) {
        const primaryW = primaryBubbleWidth(t.name, primary.label);
        const subWorldX = worldX + primaryW + SUB_GAP;
        const subWorldY = worldY;
        const subAnchorX = worldX + primaryW;
        const subAnchorY = worldY + BUBBLE_HALF_H;
        out.push({
          id: `sub:${a.id}::${t.id}`,
          toolId: t.id,
          agentId: a.id,
          toolName: t.name,
          name: cutSubLabel(skin.label, skin.category),
          fullName: skin.label,
          emoji: skin.emoji,
          isSub: true,
          status,
          category: skin.category,
          // For sub-bubbles, prefer the richer `detail` (full path or full
          // command) over the raw JSON inputPreview — both end up in the
          // tooltip but `detail` reads better.
          inputPreview: skin.detail ?? inputPreview,
          fade,
          fading,
          worldX: subWorldX,
          worldY: subWorldY,
          anchorX: subAnchorX,
          anchorY: subAnchorY,
          spawnDx: subAnchorX - subWorldX,
          spawnDy: 0,
        });
      }
    });
  }
  return out;
}

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
