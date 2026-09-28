// Where the canvas's tool bubbles go, and what each one says: the last
// MAX_PER_AGENT calls of every agent on the canvas, laid out as a trail to the
// right of its card, each with the sub-bubble its skin gives it.
//
// Lifted out of components/ToolBursts.tsx unchanged. All of it is world space
// and plain data — the component turns a Burst into screen space and markup,
// and the camera never reaches this far, so a pan or a zoom does not re-run
// the walk (see ToolBursts).
import type { AgentNodeData, ToolCall } from "./types";
import { categoryFor, type ToolCategory } from "./tool-taxonomy";
import { cutSubLabel, primaryDisplayFor, skinFor } from "./tool-skin";

const FADE_MS = 600;
const MAX_PER_AGENT = 4;
const BUBBLE_VERT_GAP = 36;
export const BUBBLE_HALF_H = 16;
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
// used to be a private literal in ToolBursts.tsx and a near-identical private
// literal there, and the two drifted apart the first time Codex renamed a tool
// (#417).

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

export interface Burst {
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
