// Where each session's decorative box goes on the canvas, and how far its
// header may reach past it — the geometry the cluster layer draws, worked out
// from the agent cards React Flow has measured.
//
// Lifted out of components/SessionClusters.tsx. None of it touches React: the
// component hands clusterBounds the store's nodes through a selector,
// re-renders only when shallowEqualClusters says a box moved, and draws what
// comes back in the two inline styles clusterBoxStyle and clusterLabelStyle
// build. The words on each header are cluster-header.ts's.
import type React from "react";
import { isAlarming } from "./ambient-counts";
import { clusterHeader, type ClusterHeader } from "./cluster-header";
import { branchShort, type BranchSummary } from "./node-face";
import { HEADER_H, LABEL_LIFT, PAD } from "./session-chrome";
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

/** How far inside its box's left edge the header pill starts, in LAYOUT
 *  units. cluster-label-room.ts brings it through the camera to find where the
 *  pill lands on screen, so the two cannot disagree about it. */
export const LABEL_INDENT = 16;

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
 * The decorative box under a session's cards: where it sits and how big it is,
 * and the session's hue for the sheet to build its rim and wash from.
 *
 * Layout coordinates, straight out of clusterBounds, with no camera in
 * them. clusterBounds already works in the same space React Flow keeps
 * node positions in, so these four change when — and only when — the
 * layout changes, which is the single event .cluster-card's 320ms
 * easing was written for.
 *
 * They read `c.x * zoom + x`, `c.y * zoom + y`, `c.w * zoom` and
 * `c.h * zoom` before #353. Folding the camera in is what made that
 * easing fire on every pan and zoom frame as well, and once it was
 * folded in no rule in the sheet could tell a camera move from a layout
 * move ever again, because by then they were the same number.
 * The position is a translate since #864: the box still eases over the
 * 320ms the nodes do when the layout moves, but on the compositor
 * rather than through left and top. The size stays width and height,
 * which change only when a session gains or loses a node.
 */
export function clusterBoxStyle(c: Cluster, hue: number): React.CSSProperties {
  return {
    position: "absolute",
    left: 0,
    top: 0,
    transform: `translate(${c.x}px, ${c.y}px)`,
    width: c.w,
    height: c.h,
    "--session-hue": hue,
  } as React.CSSProperties;
}

/**
 * The header pill over a session's box, at `zoom`: placed in layout space
 * like the box, drawn at 1× on screen, and capped at labelMaxWidth.
 *
 * The label is the one child that must not scale with the camera: it is
 * text, and a session name drawn at 0.2× is a smudge. It sits in layout
 * space like the box, so the layer's own scale(zoom) is divided back out.
 *
 * AND IT STAYS ITS OWN SIZE ALL THE WAY OUT (#846). It used to shrink
 * with a zoom-out — `scale(min(1, zoom))` on screen — so at the 0.32 a
 * real board settles into, a 10px label drew at about 3px and the one
 * line that says which session a cluster is could not be read. It is
 * 1× on screen at every zoom now. The lift is divided out the same
 * way, so the tab keeps the geometry it has at 1× — 12px above the
 * box's top edge, over the handle's top strip — instead of sliding down
 * over the cards as the box shrinks under it.
 *
 * `|| 1` guards a zoom of zero, which would make this Infinity and put
 * the label nowhere. React Flow clamps to minZoom (0.2 on this canvas)
 * and never hands one out, so this is a fallback rather than a case.
 *
 * AND IT IS BOUND TO THE GUTTER IT WAS MEASURED AGAINST (#977). The cap
 * on NAME_COLUMNS in cluster-header.ts is argued entirely in LAYOUT
 * units — "a capped header stays inside the 240px gutter layout.ts
 * leaves between two session columns" — and the line above is what
 * stopped that from being true: at 1× a header spans the same number
 * of layout units as screen px, but at zoom z it spans `screen / z` of
 * them, and the cap does not shrink with the board.
 *
 * Measured in Firefox against this sheet, a workspace + capped ai-title
 * pill draws 302.7px at every zoom. In layout units that is 302.7 at
 * 1×, 796.7 at 0.38 and 946 at the 0.32 a real board settles into —
 * against a cluster box of 276 and 624 units of clear canvas to the
 * next column's box. So at 0.32 it reached 686 units past its own box,
 * 62 units INTO the box next door, and `document.elementFromPoint` on
 * the neighbour returned this button: the label is `pointer-events:
 * auto` in a layer that clips nothing, so a click there called
 * focusSession for the wrong session and a drag there was captured by
 * the label instead of panning. The z-index: 0 that keeps the paint
 * harmless does nothing for the hit box.
 *
 * The bound is the same 240 the cap was justified by, in screen px so
 * it tracks the camera: its own box plus one card width of the gutter,
 * which at every zoom leaves the remaining 384 units of canvas — and
 * all of the next column — to whoever owns them. It costs text only
 * below about 0.58, where the pill would otherwise be reaching across
 * the gap anyway, and `title` still carries the whole header.
 *
 * `maxWidth` is that cap unless the caller has less room to give: the
 * layer passes what cluster-label-room.ts's labelRoom allows, which is the
 * cap or less — less where the pane's right edge or the chrome over it
 * comes first.
 */
export function clusterLabelStyle(c: Cluster, zoom: number, hue: number, maxWidth?: number): React.CSSProperties {
  return {
    position: "absolute",
    left: c.x + LABEL_INDENT,
    top: c.y - LABEL_LIFT / (zoom || 1),
    transform: `scale(${1 / (zoom || 1)})`,
    transformOrigin: "left top",
    maxWidth: maxWidth ?? labelMaxWidth(c.w, zoom),
    "--session-hue": hue,
  } as React.CSSProperties;
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
    const root = rootFields(d);
    if (!existing) {
      bySession.set(d.sessionId, {
        minX: x1, minY: y1, maxX: x2, maxY: y2,
        label: root?.label ?? d.sessionId,
        name: root?.name,
        alarm: root?.alarm ?? false,
        branch: root?.branch,
      });
    } else {
      existing.minX = Math.min(existing.minX, x1);
      existing.minY = Math.min(existing.minY, y1);
      existing.maxX = Math.max(existing.maxX, x2);
      existing.maxY = Math.max(existing.maxY, y2);
      if (root) {
        existing.label = root.label ?? existing.label;
        existing.name = root.name;
        existing.alarm = root.alarm;
        existing.branch = root.branch;
      }
    }
  }

  // When multiple sessions resolve to the same label (e.g. two Claude sessions
  // running in the same cwd both pick the basename as their label), append a
  // short session-id suffix so the user can tell them apart at a glance.
  // The ids themselves rather than a count of them, so the suffix can be made
  // long enough to differ from every other session under the label (#1732).
  const idsByLabel = new Map<string, string[]>();
  for (const [sessionId, b] of bySession) {
    const ids = idsByLabel.get(b.label);
    if (ids) ids.push(sessionId);
    else idsByLabel.set(b.label, [sessionId]);
  }

  const out: Cluster[] = [];
  for (const [sessionId, b] of bySession) {
    const peers = idsByLabel.get(b.label) ?? [];
    const needsSuffix = peers.length > 1;
    out.push({
      sessionId,
      ...clusterHeader(b.label, b.name, sessionId, needsSuffix, peers, { branch: b.branch, alarm: b.alarm }),
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

/**
 * What a session's root card says for the whole session's header — its
 * workspace label, its name, whether it is stopped on a human and what its
 * subagents add up to — or null for any other card.
 *
 * Only the session root speaks for the session, and the rule is the same for
 * all four fields, so it is one check here rather than one per field. A
 * subagent carries the session's id and no sessionName at all, so reading a
 * field off whichever node arrived first would leave the header waiting on
 * iteration order for a field the root has had all along.
 */
function rootFields(d: AgentNodeData): { label?: string; name?: string; alarm: boolean; branch?: string } | null {
  if (d.kind !== "root") return null;
  const b = (d as AgentNodeData & { branch?: BranchSummary }).branch;
  return {
    label: d.label,
    // The header reads the SAME field the card does — the name when the
    // session has one, the title when it does not — via the one function that
    // decides it.
    //
    // Not `d.sessionName` alone, which is what #521 shipped. On the transcripts
    // under ~/.claude/projects here that field is present on 0.2% of sessions
    // and the title on 4.1%, so a header keyed on the name alone was blank for
    // essentially every deck. The cap in cluster-header.ts survives the change
    // unaltered: it is derived from where the CARD ellipsises, which is a fact
    // about a 240px node and not about which record filled it.
    name: sessionDisplay(d.sessionName, d.sessionTitle).face,
    alarm: isAlarming(d.waiting),
    // The summary App puts on a root's node data (FlowNodeData.branch), in the
    // card's own `→ N` notation. Only the root carries one.
    branch: b && b.total > 0 ? branchShort(b) : undefined,
  };
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
      x.title !== y.title ||
      x.x !== y.x || x.y !== y.y ||
      x.w !== y.w || x.h !== y.h
    ) return false;
  }
  return true;
}
