// Where each session's decorative box goes on the canvas, and how far its
// header may reach past it — the geometry the cluster layer draws, worked out
// from the agent cards React Flow has measured.
//
// Lifted out of components/SessionClusters.tsx unchanged. None of it touches
// React: the component hands clusterBounds the store's nodes through a
// selector, re-renders only when shallowEqualClusters says a box moved, and
// draws what comes back. The words on each header are cluster-header.ts's.
import { isAlarming } from "./ambient-counts";
import { clusterHeader, type ClusterHeader } from "./cluster-header";
import { branchShort, type BranchSummary } from "./node-face";
import { sessionDisplay } from "./session-display";
import type { AgentNodeData } from "./types";

export interface Cluster extends ClusterHeader {
  sessionId: string;
  x: number; y: number; w: number; h: number;
  /** The session is stopped until a human answers — the root's `waiting`, the
   *  two kinds isAlarming names. The label is the one thing on a cluster drawn
   *  at 1× at every zoom, so it is where that has to be findable from afar. */
  alarm?: boolean;
  /** What the session's subagents add up to, `→ 8 · 7 live` — drawn only at
   *  the overview distance, where the tiles are a column of marks too small to
   *  count by eye. Absent for a session with no subagent on the canvas. */
  branch?: string;
}

/** The part of a React Flow node the cluster geometry reads. */
export interface ClusterNode {
  type?: string;
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  data?: AgentNodeData;
}

// PAD must match GROUP_PAD in session-group-nodes.ts so the decorative card's
// rim lines up with the invisible draggable group-handle node sitting under it —
// the handle is the cards' box plus GROUP_PAD on every side.
//
// HEADER_H and LABEL_LIFT are this file's own and are deliberately NOT part of
// the handle: the header strip is where the clickable fit-view label lives, so
// extending the handle over it would swallow the click (see
// session-group-nodes.ts). layout-geometry.ts folds all three into
// SESSION_CHROME, which the layout budgets the space between two stacked
// sessions with.
const PAD = 18;
const HEADER_H = 26;
export const LABEL_LIFT = 12; // px the label tab sits above the box's top edge

/**
 * How far past its own cluster box the header may reach, in LAYOUT units.
 *
 * One card width, which is the same 240 the NAME_COLUMNS note in
 * cluster-header.ts argues the cap by: layout.ts puts the next column a full
 * card plus a 420px burst lane away, so a cluster box's right edge and the
 * next box's left edge are 624 units apart however wide the sessions are.
 * Spending 240 of those leaves 384 of clear canvas between the end of this
 * pill and anything belonging to somebody else.
 *
 * Not tied to the box's own width: at the narrowest cluster there is, 276, a
 * proportional budget would have to be over 100% to draw the headers
 * cluster-header.ts measures.
 */
const LABEL_GUTTER = 240;

/**
 * The widest the header pill may draw, in SCREEN px, for a cluster box `w`
 * layout units wide shown at `zoom`.
 *
 * Screen px because that is the unit the pill actually has: the layer carries
 * `scale(zoom)` and the pill divides it back out, so a CSS width of N on this
 * button is N px on the display at every zoom and N/zoom layout units on the
 * canvas. The bound has to be expressed in the unit that shrinks with the
 * board, or it is not a bound on where the button lands.
 *
 * `|| 1` for the same reason the transform beside it has one: React Flow clamps
 * to minZoom and never hands out a zero, and a zero here would make the cap
 * zero and hide the header entirely.
 */
export function labelMaxWidth(clusterWidth: number, zoom: number): number {
  return (clusterWidth + LABEL_GUTTER) * (zoom || 1);
}

/**
 * Where each session's decorative card goes, from the agent cards on screen.
 *
 * Pure so the geometry can be pinned without a store: the store is where the
 * bug came from, not the arithmetic.
 */
export function clusterBounds(nodes: Iterable<ClusterNode>): Cluster[] {
  const bySession = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; label: string; name?: string; alarm?: boolean; branch?: string }>();
  for (const n of nodes) {
    // Only agent cards define a session's bounds. The invisible per-session
    // drag handle is a React Flow node like any other and its data carries the
    // session's own sessionId, so walking the store by data alone counted the
    // handle as a member — and the handle is already the cards' box plus PAD.
    // The card then settled one PAD larger than the handle it exists to trace:
    // an 18px rim of visible session box that no session drag responds to, and
    // half the breathing room layout.ts budgets between two stacked sessions.
    // A recap note is a member too: it is laid out, fitted and moved with its
    // session (RecapNoteNode), so the frame — which traces what a session drag
    // moves — goes round it as well as round the cards.
    if (n.type !== "agent" && n.type !== "recapNote") continue;
    const d = n.data as AgentNodeData;
    if (!d?.sessionId) continue;
    // Skip retiring agents — they're fading out. Including them keeps the
    // cluster card at its old size while the nodes go invisible, which looks
    // like the background "stays behind" the nodes.
    if (d.exitAt != null) continue;
    // Skip un-measured nodes (width/height still null) — falling back to a
    // default size before React Flow has measured causes one frame of wrong
    // cluster bounds.
    if (n.width == null || n.height == null) continue;
    const x1 = n.position.x;
    const y1 = n.position.y;
    const x2 = x1 + n.width;
    const y2 = y1 + n.height;
    const existing = bySession.get(d.sessionId);
    if (!existing) {
      bySession.set(d.sessionId, {
        minX: x1, minY: y1, maxX: x2, maxY: y2,
        label: rootLabel(d) ?? d.sessionId,
        name: rootName(d),
        alarm: d.kind === "root" && isAlarming(d.waiting),
        branch: rootBranch(d),
      });
    } else {
      existing.minX = Math.min(existing.minX, x1);
      existing.minY = Math.min(existing.minY, y1);
      existing.maxX = Math.max(existing.maxX, x2);
      existing.maxY = Math.max(existing.maxY, y2);
      if (d.kind === "root") existing.label = rootLabel(d) ?? existing.label;
      // Same rule as the label, and for the same reason: only the session root
      // speaks for the session. A subagent carries no sessionName at all, so
      // reading one off whichever node arrived first would leave the header
      // waiting on iteration order for a field the root has had all along.
      if (d.kind === "root") existing.name = rootName(d);
      if (d.kind === "root") existing.alarm = isAlarming(d.waiting);
      if (d.kind === "root") existing.branch = rootBranch(d);
    }
  }

  // When multiple sessions resolve to the same label (e.g. two Claude sessions
  // running in the same cwd both pick the basename as their label), append a
  // short session-id suffix so the user can tell them apart at a glance.
  const labelCounts = new Map<string, number>();
  for (const b of bySession.values()) {
    labelCounts.set(b.label, (labelCounts.get(b.label) ?? 0) + 1);
  }

  const out: Cluster[] = [];
  for (const [sessionId, b] of bySession) {
    const needsSuffix = (labelCounts.get(b.label) ?? 0) > 1;
    out.push({
      sessionId,
      ...clusterHeader(b.label, b.name, sessionId, needsSuffix),
      x: b.minX - PAD,
      y: b.minY - PAD - HEADER_H,
      w: b.maxX - b.minX + PAD * 2,
      h: b.maxY - b.minY + PAD * 2 + HEADER_H,
      ...(b.alarm ? { alarm: true } : null),
      ...(b.branch ? { branch: b.branch } : null),
    });
  }
  return out;
}

/** The summary App puts on a root's node data (FlowNodeData.branch), in the
 *  card's own `→ N` notation. Only the root carries one. */
function rootBranch(d: AgentNodeData): string | undefined {
  if (d.kind !== "root") return undefined;
  const b = (d as AgentNodeData & { branch?: BranchSummary }).branch;
  return b && b.total > 0 ? branchShort(b) : undefined;
}

function rootLabel(d: AgentNodeData): string | undefined {
  if (d.kind !== "root") return undefined;
  return d.label;
}

/**
 * The header reads the SAME field the card does — the name when the session has
 * one, the title when it does not — via the one function that decides it.
 *
 * Not `d.sessionName` alone, which is what #521 shipped. On the transcripts
 * under ~/.claude/projects here that field is present on 0.2% of sessions and
 * the title on 4.1%, so a header keyed on the name alone was blank for
 * essentially every deck. The cap in cluster-header.ts survives the change
 * unaltered: it is derived from where the CARD ellipsises, which is a fact
 * about a 240px node and not about which record filled it.
 */
function rootName(d: AgentNodeData): string | undefined {
  if (d.kind !== "root") return undefined;
  return sessionDisplay(d.sessionName, d.sessionTitle).face;
}

export function shallowEqualClusters(a: Cluster[], b: Cluster[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (
      x.sessionId !== y.sessionId ||
      x.label !== y.label ||
      // Both halves of the name. Two different names can truncate to the same
      // shown text, and only fullLabel would notice — that is the string the
      // tooltip serves, so skipping it would hold a stale one behind a header
      // that had already settled.
      x.name !== y.name ||
      x.shortId !== y.shortId ||
      x.alarm !== y.alarm ||
      x.branch !== y.branch ||
      x.fullLabel !== y.fullLabel ||
      x.x !== y.x || x.y !== y.y ||
      x.w !== y.w || x.h !== y.h
    ) return false;
  }
  return true;
}
