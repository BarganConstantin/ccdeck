// Workspace split into panes (internal #102): up to four sessions side by
// side, above and below, as the reader arranges them — decided here without
// React, a terminal or a DOM, so the suite can walk every drop, close and
// move.
//
// A TREE OF HALVES. Every split cuts one box in two, side by side ("row": a
// left, b right) or one above the other ("col": a above, b below), at a
// ratio the divider between them moves. A pane is a leaf. Two panes beside
// each other with a third under both is one cut across and one cut down; the
// 2×2 grid is a row of two columns. Dropping on a pane's edge cuts that pane;
// closing a pane gives its half to the panes beside it (its sibling takes the
// cut's whole box).
//
// THE PANE IN FOCUS IS THE STAGE. use-stage.ts's shell, which every way into a
// session already goes through (a row, Enter, ⌘K, a notification, New
// session, a reload), shows what the pane with the keys shows. The other
// panes' targets are held here; the focused pane's entry in `targets` is what
// it showed when the keys last left it, and is not read while it has them.
//
// A PANE IS AN ID, NOT A SESSION. The id keys the pane's element, so a pane
// that moves, or whose neighbour closes, keeps its terminal, its output and
// its scroll: nothing reattaches. A session is in one pane at most; a second
// ask for it moves the keys to the pane that has it (paneWith).
//
// NEVER UNDER 40 × 8. A pane narrower than 40 columns or shorter than 8 rows
// is not a terminal anyone can read. Dividers stop there; a window too small
// for the whole arrangement shows the pane with the keys alone, with a strip
// naming the others, and the arrangement comes back when there is room.
import type { StageTarget } from "./stage-shell";
import { readStored, removeStored, writeStored } from "./storage";

/** The most panes the Workspace holds: a 2×2 grid. */
export const MAX_PANES = 4;
/** The columns and rows a pane is never made smaller than. */
export const MIN_PANE_COLS = 40;
export const MIN_PANE_ROWS = 8;
/** The line between two panes, in CSS pixels. */
export const SPLIT_GAP = 1;
/** How far in from a pane's edge a drop still means that edge (a fraction of
 *  the pane's width or height); the middle is "Here". */
export const EDGE_BAND = 0.3;
/** Where the arrangement is kept, per browser, in the agent-dag.* namespace
 *  every key this client stores lives in (display-name.test.ts). */
export const SPLIT_KEY = "agent-dag.workspace.split";

export type SplitDir = "row" | "col";
export type SplitNode =
  | { kind: "leaf"; id: string }
  | { kind: "split"; dir: SplitDir; ratio: number; a: SplitNode; b: SplitNode };
/** Where a drop lands on a pane: one of its four edges, or the pane itself. */
export type DropZone = "left" | "right" | "top" | "bottom" | "here";
export type EdgeZone = Exclude<DropZone, "here">;

export interface SplitState {
  root: SplitNode;
  /** What each pane shows; the focused pane's entry is stale while it has the
   *  keys (the shell's target is what it shows). */
  targets: Readonly<Record<string, StageTarget>>;
  /** The pane with the keys. */
  focused: string;
  /** ⤢ with several panes: the pane that fills the Workspace, or null. */
  max: string | null;
  /** The number the next new pane's id is made from. */
  next: number;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface MinSize { w: number; h: number }

const EMPTY: StageTarget = { kind: "empty" };

/** One pane, showing nothing yet: the Workspace as it was before #102. */
export function singleSplit(id = "p0"): SplitState {
  return { root: { kind: "leaf", id }, targets: { [id]: EMPTY }, focused: id, max: null, next: Number(id.slice(1)) + 1 || 1 };
}

/** The panes' ids, a's before b's. */
export function paneIds(root: SplitNode): string[] {
  return root.kind === "leaf" ? [root.id] : [...paneIds(root.a), ...paneIds(root.b)];
}

export function paneCount(s: SplitState): number {
  return paneIds(s.root).length;
}

/** What a pane shows: the shell's target for the pane in focus. */
export function paneTarget(s: SplitState, id: string, focusedTarget: StageTarget | null): StageTarget {
  if (id === s.focused && focusedTarget) return focusedTarget;
  return s.targets[id] ?? EMPTY;
}

/** The same reading-order numbers in the list, headers and narrow pane strip.
 * The shell owns the focused target; its saved entry can still name the previous session. */
export interface PaneLink { number: number; active: boolean }
export function sessionPaneLinks(s: SplitState, focusedTarget: StageTarget | null, order = paneIds(s.root)): Map<string, PaneLink> {
  const links = new Map<string, PaneLink>();
  if (order.length < 2) return links;
  order.forEach((id, index) => {
    const target = paneTarget(s, id, focusedTarget);
    if (target.kind === "session") links.set(target.id, { number: index + 1, active: id === s.focused });
  });
  return links;
}

/** The pane that shows `sessionId`, other than `except`, or null. */
export function paneWith(s: SplitState, sessionId: string, focusedTarget: StageTarget | null, except?: string): string | null {
  for (const id of paneIds(s.root)) {
    if (id === except) continue;
    const t = paneTarget(s, id, focusedTarget);
    if (t.kind === "session" && t.id === sessionId) return id;
  }
  return null;
}

/** The sessions the panes show, in pane order. */
export function paneSessions(s: SplitState, focusedTarget: StageTarget | null): string[] {
  return paneIds(s.root).flatMap(id => {
    const t = paneTarget(s, id, focusedTarget);
    return t.kind === "session" ? [t.id] : [];
  });
}

// ── sizes ────────────────────────────────────────────────────────────────────
/** The smallest box a subtree can be drawn in, every pane at its minimum. */
export function minExtent(node: SplitNode, min: MinSize, gap = SPLIT_GAP): MinSize {
  if (node.kind === "leaf") return min;
  const a = minExtent(node.a, min, gap), b = minExtent(node.b, min, gap);
  return node.dir === "row"
    ? { w: a.w + gap + b.w, h: Math.max(a.h, b.h) }
    : { w: Math.max(a.w, b.w), h: a.h + gap + b.h };
}

/** Whether every pane gets its minimum in a box of this size. */
export function fits(root: SplitNode, box: { w: number; h: number }, min: MinSize, gap = SPLIT_GAP): boolean {
  const need = minExtent(root, min, gap);
  return need.w <= box.w && need.h <= box.h;
}

/** a's share of a split's length, kept so neither side goes under its
 *  minimum when the length allows it, else the plain ratio. */
function aLength(length: number, ratio: number, minA: number, minB: number): number {
  const room = Math.max(0, length);
  const want = Math.round(room * ratio);
  if (minA + minB > room) return want;
  return Math.min(room - minB, Math.max(minA, want));
}

/** A divider: the line between a split's halves, and what moving it needs. */
export interface Divider {
  /** The split's place in the tree: "" the root, then "a"/"b" per step down. */
  path: string;
  dir: SplitDir;
  /** The line itself. */
  rect: Rect;
  /** The split's box along its direction: where it starts and how long. */
  start: number;
  length: number;
  /** The least a and b may be given there. */
  minA: number;
  minB: number;
  ratio: number;
}

/** Every pane's box and every divider, for the arrangement in `box`. */
export function layoutSplit(root: SplitNode, box: Rect, min: MinSize, gap = SPLIT_GAP): { panes: Map<string, Rect>; dividers: Divider[] } {
  const panes = new Map<string, Rect>();
  const dividers: Divider[] = [];
  const walk = (node: SplitNode, r: Rect, path: string) => {
    if (node.kind === "leaf") { panes.set(node.id, r); return; }
    const ma = minExtent(node.a, min, gap), mb = minExtent(node.b, min, gap);
    if (node.dir === "row") {
      const length = r.w - gap;
      const wa = aLength(length, node.ratio, ma.w, mb.w);
      walk(node.a, { x: r.x, y: r.y, w: wa, h: r.h }, path + "a");
      walk(node.b, { x: r.x + wa + gap, y: r.y, w: length - wa, h: r.h }, path + "b");
      dividers.push({ path, dir: "row", rect: { x: r.x + wa, y: r.y, w: gap, h: r.h }, start: r.x, length, minA: ma.w, minB: mb.w, ratio: node.ratio });
    } else {
      const length = r.h - gap;
      const ha = aLength(length, node.ratio, ma.h, mb.h);
      walk(node.a, { x: r.x, y: r.y, w: r.w, h: ha }, path + "a");
      walk(node.b, { x: r.x, y: r.y + ha + gap, w: r.w, h: length - ha }, path + "b");
      dividers.push({ path, dir: "col", rect: { x: r.x, y: r.y + ha, w: r.w, h: gap }, start: r.y, length, minA: ma.h, minB: mb.h, ratio: node.ratio });
    }
  };
  walk(root, box, "");
  return { panes, dividers };
}

/** The panes as the reader counts them for 1–4: left to right along the top
 *  row, then the next row down. A pane's row is where its top edge is. */
export function readingOrder(panes: ReadonlyMap<string, Rect>): string[] {
  return [...panes.entries()]
    .sort(([, a], [, b]) => (Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x))
    .map(([id]) => id);
}

/** The strip that names every pane while one fills the Workspace. */
export const STRIP_H = 32;

/** How the Workspace draws its panes now. */
export interface Arrangement {
  /** One pane (the Workspace before #102), the split, or one pane filling the
   *  Workspace under the strip. */
  mode: "one" | "split" | "strip";
  /** Why the strip is drawn: ⤢ on a pane, or a window too small for the split. */
  why: "max" | "narrow" | null;
  /** Each pane's box in the cell. Under the strip every pane has the one box
   *  below it, so the keys moving along the strip resize nothing. */
  rects: Map<string, Rect>;
  dividers: Divider[];
  /** The panes as 1–4 count them, from the split as it would be drawn. */
  order: string[];
  /** The strip's height when it is drawn, else 0. */
  strip: number;
}

/** The arrangement in a cell of this size: the split when every pane gets its
 *  minimum, else the pane with the keys alone under the strip. */
export function arrange(s: SplitState, box: { w: number; h: number }, min: MinSize, gap = SPLIT_GAP): Arrangement {
  const full: Rect = { x: 0, y: 0, w: Math.max(0, box.w), h: Math.max(0, box.h) };
  const ids = paneIds(s.root);
  if (ids.length < 2) return { mode: "one", why: null, rects: new Map([[s.focused, full]]), dividers: [], order: ids, strip: 0 };
  const split = layoutSplit(s.root, full, min, gap);
  const order = readingOrder(split.panes);
  const why = s.max && ids.includes(s.max) ? "max" : fits(s.root, full, min, gap) ? null : "narrow";
  if (!why) return { mode: "split", why: null, rects: split.panes, dividers: split.dividers, order, strip: 0 };
  const below: Rect = { x: 0, y: STRIP_H, w: full.w, h: Math.max(0, full.h - STRIP_H) };
  return { mode: "strip", why, rects: new Map(ids.map(id => [id, below])), dividers: [], order, strip: STRIP_H };
}

/** The ratio a divider moved to `at` (a page coordinate along its direction)
 *  gives, kept off both sides' minimum. */
export function ratioAt(d: Pick<Divider, "start" | "length" | "minA" | "minB">, at: number): number {
  if (!(d.length > 0)) return 0.5;
  let a = at - d.start;
  if (d.minA + d.minB <= d.length) a = Math.min(d.length - d.minB, Math.max(d.minA, a));
  return Math.min(0.95, Math.max(0.05, a / d.length));
}

// ── drops ────────────────────────────────────────────────────────────────────
/** The zone of `rect` a pointer at (x, y) is over. A pane that cannot take
 *  another beside it (four already) only offers Here. */
export function zoneAt(rect: Rect, x: number, y: number, canSplit: boolean): DropZone {
  if (!canSplit || !(rect.w > 0) || !(rect.h > 0)) return "here";
  const px = (x - rect.x) / rect.w, py = (y - rect.y) / rect.h;
  const edges: [EdgeZone, number][] = [["left", px], ["right", 1 - px], ["top", py], ["bottom", 1 - py]];
  const [zone, d] = edges.reduce((m, e) => (e[1] < m[1] ? e : m));
  return d < EDGE_BAND ? zone : "here";
}

/** The part of a pane a zone lights up: the half a new pane would take, or
 *  the whole pane for Here. */
export function zoneRect(rect: Rect, zone: DropZone): Rect {
  const hw = Math.round(rect.w / 2), hh = Math.round(rect.h / 2);
  switch (zone) {
    case "left": return { ...rect, w: hw };
    case "right": return { ...rect, x: rect.x + rect.w - hw, w: hw };
    case "top": return { ...rect, h: hh };
    case "bottom": return { ...rect, y: rect.y + rect.h - hh, h: hh };
    default: return rect;
  }
}

function replaceLeaf(node: SplitNode, id: string, make: (leaf: SplitNode) => SplitNode): SplitNode {
  if (node.kind === "leaf") return node.id === id ? make(node) : node;
  const a = replaceLeaf(node.a, id, make), b = replaceLeaf(node.b, id, make);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

function cut(at: SplitNode, zone: EdgeZone, fresh: SplitNode): SplitNode {
  const dir: SplitDir = zone === "left" || zone === "right" ? "row" : "col";
  const first = zone === "left" || zone === "top";
  return { kind: "split", dir, ratio: 0.5, a: first ? fresh : at, b: first ? at : fresh };
}

/** A new pane beside `at`, showing `target`; null when four are open already
 *  or there is no such pane. The new pane is not given the keys here. */
export function insertPane(s: SplitState, at: string, zone: EdgeZone, target: StageTarget): { state: SplitState; id: string } | null {
  const ids = paneIds(s.root);
  if (ids.length >= MAX_PANES || !ids.includes(at)) return null;
  let n = s.next;
  while (ids.includes(`p${n}`)) n++;
  const id = `p${n}`;
  const root = replaceLeaf(s.root, at, leaf => cut(leaf, zone, { kind: "leaf", id }));
  return { state: { ...s, root, targets: { ...s.targets, [id]: target }, next: n + 1, max: null }, id };
}

/** The leaf to hand the keys to when `id` goes: the nearest pane in the half
 *  that takes its place (the first of the sibling's subtree). */
function heir(node: SplitNode, id: string): string | null {
  if (node.kind === "leaf") return null;
  if (node.a.kind === "leaf" && node.a.id === id) return paneIds(node.b)[0] ?? null;
  if (node.b.kind === "leaf" && node.b.id === id) return paneIds(node.a).slice(-1)[0] ?? null;
  return heir(node.a, id) ?? heir(node.b, id);
}

function dropLeaf(node: SplitNode, id: string): SplitNode | null {
  if (node.kind === "leaf") return node.id === id ? null : node;
  const a = dropLeaf(node.a, id), b = dropLeaf(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** The pane gone; its half goes to the panes beside it. The last pane is
 *  never removed (it empties instead, as before #102: the caller's). When
 *  the pane had the keys, `focused` names the pane that takes them. */
export function removePane(s: SplitState, id: string): SplitState {
  const ids = paneIds(s.root);
  if (ids.length <= 1 || !ids.includes(id)) return s;
  const root = dropLeaf(s.root, id) ?? s.root;
  const targets = { ...s.targets };
  delete targets[id];
  const focused = s.focused === id ? heir(s.root, id) ?? paneIds(root)[0]! : s.focused;
  const max = s.max === id || paneIds(root).length < 2 ? null : s.max;
  return { ...s, root, targets, focused, max };
}

/** A pane dragged by its header onto another pane's zone: on an edge it
 *  moves there (the same id, so its terminal stays); on Here the two swap. */
export function movePane(s: SplitState, id: string, to: string, zone: DropZone): SplitState {
  const ids = paneIds(s.root);
  if (id === to || !ids.includes(id) || !ids.includes(to)) return s;
  if (zone === "here") {
    const swap = (node: SplitNode): SplitNode => {
      if (node.kind === "leaf") return node.id === id ? { kind: "leaf", id: to } : node.id === to ? { kind: "leaf", id } : node;
      return { ...node, a: swap(node.a), b: swap(node.b) };
    };
    return { ...s, root: swap(s.root) };
  }
  const without = dropLeaf(s.root, id);
  if (!without) return s;
  return { ...s, root: replaceLeaf(without, to, leaf => cut(leaf, zone, { kind: "leaf", id })), max: null };
}

function setAt(node: SplitNode, path: string, f: (n: Extract<SplitNode, { kind: "split" }>) => SplitNode): SplitNode {
  if (node.kind === "leaf") return node;
  if (!path) return f(node);
  const [step, rest] = [path[0], path.slice(1)];
  return step === "a" ? { ...node, a: setAt(node.a, rest, f) } : { ...node, b: setAt(node.b, rest, f) };
}

/** A divider moved: its split's new ratio. */
export function setRatio(s: SplitState, path: string, ratio: number): SplitState {
  if (!Number.isFinite(ratio)) return s;
  const r = Math.min(0.95, Math.max(0.05, ratio));
  return { ...s, root: setAt(s.root, path, n => (n.ratio === r ? n : { ...n, ratio: r })) };
}

/** The keys to another pane; what the pane in focus showed is kept for it. */
export function focusSplit(s: SplitState, id: string, focusedTarget: StageTarget | null): SplitState {
  if (!paneIds(s.root).includes(id)) return s;
  const targets = focusedTarget ? { ...s.targets, [s.focused]: focusedTarget } : s.targets;
  return { ...s, targets, focused: id, max: s.max && s.max !== id ? id : s.max };
}

/** What the pane in focus shows, written back into its entry. */
export function withFocusedTarget(s: SplitState, target: StageTarget): SplitState {
  const was = s.targets[s.focused];
  if (was && sameShown(was, target)) return s;
  return { ...s, targets: { ...s.targets, [s.focused]: target } };
}

function sameShown(a: StageTarget, b: StageTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "session" && b.kind === "session") return a.id === b.id && a.launch === b.launch;
  if (a.kind === "launch" && b.kind === "launch") return a.key === b.key;
  return true;
}

/** A launch a pane shows became a session the board knows: the pane shows
 *  it as that session, on the connection it already has. */
export function promoteLaunch(s: SplitState, key: string, sessionId: string): SplitState {
  let changed = false;
  const targets: Record<string, StageTarget> = {};
  for (const [id, t] of Object.entries(s.targets)) {
    if (t.kind === "launch" && t.key === key && id !== s.focused) { targets[id] = { kind: "session", id: sessionId, launch: key }; changed = true; }
    else targets[id] = t;
  }
  return changed ? { ...s, targets } : s;
}

// ── kept per browser ─────────────────────────────────────────────────────────
interface Stored {
  v: 1;
  root: SplitNode;
  panes: Record<string, string | null>;
  focused: string;
  next: number;
}

const PANE_ID = /^p\d{1,4}$/;

/** The arrangement as it is kept: the panes and their sessions, never a
 *  launch (a reload starts nothing). One pane is not kept: it is the
 *  Workspace as it was before #102, which the reader's own memory serves. */
export function serializeSplit(s: SplitState, focusedTarget: StageTarget | null): string | null {
  const ids = paneIds(s.root);
  if (ids.length < 2) return null;
  const panes: Record<string, string | null> = {};
  for (const id of ids) {
    const t = paneTarget(s, id, focusedTarget);
    panes[id] = t.kind === "session" ? t.id : null;
  }
  const stored: Stored = { v: 1, root: s.root, panes, focused: s.focused, next: s.next };
  return JSON.stringify(stored);
}

function validNode(n: unknown, seen: Set<string>, depth: number): n is SplitNode {
  if (!n || typeof n !== "object" || depth > 4) return false;
  const o = n as Record<string, unknown>;
  if (o.kind === "leaf") {
    if (typeof o.id !== "string" || !PANE_ID.test(o.id) || seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  }
  return o.kind === "split" && (o.dir === "row" || o.dir === "col")
    && typeof o.ratio === "number" && o.ratio >= 0.05 && o.ratio <= 0.95
    && validNode(o.a, seen, depth + 1) && validNode(o.b, seen, depth + 1);
}

/** The kept arrangement, or null for anything this version did not write. */
export function parseSplit(raw: string | null | undefined): SplitState | null {
  if (!raw) return null;
  let d: unknown;
  try { d = JSON.parse(raw); } catch { return null; }
  const o = d as Partial<Stored> | null;
  if (!o || o.v !== 1 || !o.panes || typeof o.panes !== "object") return null;
  const seen = new Set<string>();
  if (!validNode(o.root, seen, 0) || seen.size < 2 || seen.size > MAX_PANES) return null;
  const targets: Record<string, StageTarget> = {};
  for (const id of seen) {
    const sid = (o.panes as Record<string, unknown>)[id];
    targets[id] = typeof sid === "string" && sid.length > 0 && sid.length <= 200 ? { kind: "session", id: sid } : EMPTY;
  }
  const focused = typeof o.focused === "string" && seen.has(o.focused) ? o.focused : [...seen][0]!;
  const next = Number.isInteger(o.next) && (o.next as number) > 0 ? (o.next as number) : seen.size;
  return { root: o.root as SplitNode, targets, focused, max: null, next };
}

/** Panes whose session is gone close; nothing is started for them. */
export function pruneSplit(s: SplitState, known: (sessionId: string) => boolean): SplitState {
  let out = s;
  for (const id of paneIds(s.root)) {
    const t = out.targets[id];
    if (t?.kind === "session" && !known(t.id) && paneCount(out) > 1) out = removePane(out, id);
  }
  return out;
}

/** The kept arrangement, read once per page. */
export function loadSplit(read: (key: string) => string | null = readStored): SplitState | null {
  return parseSplit(read(SPLIT_KEY));
}

/** Keep the arrangement, or forget it once it is one pane again. */
export function saveSplit(s: SplitState, focusedTarget: StageTarget | null,
  write: (key: string, value: string) => void = writeStored, remove: (key: string) => void = removeStored): void {
  const raw = serializeSplit(s, focusedTarget);
  if (raw) write(SPLIT_KEY, raw);
  else remove(SPLIT_KEY);
}
