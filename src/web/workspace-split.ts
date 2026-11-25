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
// A PANE HOLDS TABS. Every session or launch a pane was asked to show stays
// open in it as a tab, in the order they came (a new one at the end); the
// pane shows one of them, its entry in `targets`. Asking again for a session
// that is open anywhere brings that exact tab back, and a pane never holds a
// session another pane holds. Switching tabs stops nothing: the terminals stay
// attached behind the one on show (StageShell.tsx). Past MAX_TABS the oldest
// tab not on show leaves the strip; its session runs on.
//
// NEVER UNDER 40 × 8. A pane narrower than 40 columns or shorter than 8 rows
// is not a terminal anyone can read. Dividers stop there; a window too small
// for the whole arrangement shows the pane with the keys alone, with a strip
// naming the others, and the arrangement comes back when there is room.
import type { PaneDirection } from "./terminal-keys";
import type { StageTarget } from "./stage-shell";
import { readStored, removeStored, writeStored } from "./storage";

/** The most panes the Workspace holds: a 2×2 grid. */
export const MAX_PANES = 4;
/** The most tabs a pane keeps: a ninth sends the oldest tab not on show out
 *  of the strip (never its session, which runs on). */
export const MAX_TABS = 8;
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
  /** Each pane's tabs, in the strip's order: the sessions and launches it
   *  holds open, the one it shows among them. Missing or empty: the pane
   *  holds only what it shows (paneTabs). */
  tabs: Readonly<Record<string, readonly StageTarget[]>>;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface MinSize { w: number; h: number }

const EMPTY: StageTarget = { kind: "empty" };

/** One pane, showing nothing yet: the Workspace as it was before #102. */
export function singleSplit(id = "p0"): SplitState {
  return { root: { kind: "leaf", id }, targets: { [id]: EMPTY }, focused: id, max: null, next: Number(id.slice(1)) + 1 || 1, tabs: { [id]: [] } };
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

// ── tabs ─────────────────────────────────────────────────────────────────────
/** A target a tab can hold: a session or a launch, never the empty pane. */
export function isTab(t: StageTarget | null | undefined): t is Exclude<StageTarget, { kind: "empty" }> {
  return t?.kind === "session" || t?.kind === "launch";
}

/** The launch a target came from, if any. */
function launchOf(t: StageTarget): string | undefined {
  return t.kind === "launch" ? t.key : t.kind === "session" ? t.launch : undefined;
}

/** Whether two targets are the same tab: the same session, or the same launch
 *  before and after it became a session. */
export function sameTab(a: StageTarget | null | undefined, b: StageTarget | null | undefined): boolean {
  if (!isTab(a) || !isTab(b)) return false;
  if (a.kind === "session" && b.kind === "session" && a.id === b.id) return true;
  const la = launchOf(a);
  return la !== undefined && la === launchOf(b);
}

/** A tab's lasting name, the same before and after its launch became a
 *  session: what keys its terminal, so the terminal is never mounted again. */
export function tabKey(t: StageTarget): string {
  const launch = launchOf(t);
  return launch !== undefined ? `l:${launch}` : t.kind === "session" ? `s:${t.id}` : "empty";
}

/** `tabs` with `target` among them: the tab it already is, kept (a launch's
 *  tab becomes its session, a session's tab never goes back to a launch), or
 *  a new tab at the end. */
function mergeTab(tabs: readonly StageTarget[], target: StageTarget): readonly StageTarget[] {
  if (!isTab(target)) return tabs;
  const i = tabs.findIndex(t => sameTab(t, target));
  if (i < 0) return [...tabs, target];
  const was = tabs[i]!;
  const keep = was.kind === "session" && (target.kind === "launch" || (target.id === was.id && !target.launch));
  if (keep || sameShown(was, target)) return tabs;
  return tabs.map((t, j) => (j === i ? target : t));
}

/** No more than MAX_TABS: the oldest tabs that are not `shown` leave first. */
function capTabs(tabs: readonly StageTarget[], shown: StageTarget | null | undefined): readonly StageTarget[] {
  if (tabs.length <= MAX_TABS) return tabs;
  const out = [...tabs];
  while (out.length > MAX_TABS) {
    const i = out.findIndex(t => !sameTab(t, shown));
    if (i < 0) break;
    out.splice(i, 1);
  }
  return out;
}

/** A pane's tabs as the strip draws them: those it holds, with what it shows
 *  (the shell's target for the pane in focus) among them. */
export function paneTabs(s: SplitState, id: string, focusedTarget: StageTarget | null): readonly StageTarget[] {
  const shown = paneTarget(s, id, focusedTarget);
  return capTabs(mergeTab(s.tabs?.[id] ?? [], shown), shown);
}

/** The pane that holds `sessionId` in any of its tabs, and that tab, as kept
 *  (a launch's tab keeps its launch). Panes in tree order. */
export function tabWith(s: SplitState, sessionId: string, focusedTarget: StageTarget | null, except?: string): { pane: string; target: StageTarget } | null {
  for (const id of paneIds(s.root)) {
    if (id === except) continue;
    const t = paneTabs(s, id, focusedTarget).find(x => x.kind === "session" && x.id === sessionId);
    if (t) return { pane: id, target: t };
  }
  return null;
}

/** The same reading-order numbers in the list, headers and narrow pane strip.
 * The shell owns the focused target; its saved entry can still name the previous session.
 * A session in a tab the pane does not show has its pane's number, not active. */
export interface PaneLink { number: number; active: boolean }
export function sessionPaneLinks(s: SplitState, focusedTarget: StageTarget | null, order = paneIds(s.root)): Map<string, PaneLink> {
  const links = new Map<string, PaneLink>();
  if (order.length < 2) return links;
  order.forEach((id, index) => {
    const shown = paneTarget(s, id, focusedTarget);
    for (const t of paneTabs(s, id, focusedTarget)) {
      if (t.kind === "session") links.set(t.id, { number: index + 1, active: id === s.focused && sameTab(t, shown) });
    }
  });
  return links;
}

/** The pane that holds `sessionId`, in any tab, other than `except`, or null. */
export function paneWith(s: SplitState, sessionId: string, focusedTarget: StageTarget | null, except?: string): string | null {
  return tabWith(s, sessionId, focusedTarget, except)?.pane ?? null;
}

/** The sessions open in the panes, every tab, in pane order. */
export function paneSessions(s: SplitState, focusedTarget: StageTarget | null): string[] {
  return paneIds(s.root).flatMap(id => paneTabs(s, id, focusedTarget).flatMap(t => (t.kind === "session" ? [t.id] : [])));
}

/** A tab closed: the pane keeps the others, and when it was the tab on show,
 *  shows its neighbour (the next one, else the one before). Null for the
 *  pane's last tab: closing it is the pane's own close (removePane, or the one
 *  pane emptied). */
export function closeTab(s: SplitState, paneId: string, tab: StageTarget, focusedTarget: StageTarget | null): { state: SplitState; shows: StageTarget; shown: boolean } | null {
  if (!paneIds(s.root).includes(paneId)) return null;
  const tabs = paneTabs(s, paneId, focusedTarget);
  const i = tabs.findIndex(t => sameTab(t, tab));
  const shown = paneTarget(s, paneId, focusedTarget);
  const rest = i < 0 ? tabs : tabs.filter((_, j) => j !== i);
  const wasShown = sameTab(shown, tab);
  if (rest.length === 0) return null;
  const shows = wasShown ? rest[Math.min(Math.max(i, 0), rest.length - 1)]! : shown;
  const state = { ...s, targets: { ...s.targets, [paneId]: shows }, tabs: { ...s.tabs, [paneId]: rest } };
  return { state, shows, shown: wasShown };
}

/** `next` in the place of tab `old` of a pane, and on show there: Start
 *  again, a continuation. A pane that does not hold `old` is left alone. */
export function replaceTab(s: SplitState, paneId: string, old: StageTarget, next: StageTarget): SplitState {
  if (!isTab(next)) return s;
  // A tab that already holds `next` gives way to the one it replaces.
  const held = (s.tabs?.[paneId] ?? []).filter(t => sameTab(t, old) || !sameTab(t, next));
  const at = held.findIndex(t => sameTab(t, old));
  if (at < 0) return s;
  const tabs = held.map((t, j) => (j === at ? next : t));
  return { ...s, targets: { ...s.targets, [paneId]: next }, tabs: { ...s.tabs, [paneId]: tabs } };
}

/** The pane emptied: it shows nothing and holds no tab. */
export function emptyPaneTabs(s: SplitState, paneId: string): SplitState {
  if (!paneIds(s.root).includes(paneId)) return s;
  return { ...s, targets: { ...s.targets, [paneId]: EMPTY }, tabs: { ...s.tabs, [paneId]: [] } };
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

/** Find a pane across the requested edge with a shared cross-axis span. */
export function adjacentPane(rects: ReadonlyMap<string, Rect>, from: string, direction: PaneDirection): string | null {
  const origin = rects.get(from);
  if (!origin) return null;
  const horizontal = direction === "left" || direction === "right";
  const reverse = direction === "left" || direction === "up";
  const [start, size, cross, span] = horizontal ? ["x", "w", "y", "h"] as const : ["y", "h", "x", "w"] as const;
  let best: { id: string; gap: number; overlap: number } | null = null;
  for (const [id, rect] of rects) {
    const gap = reverse ? origin[start] - (rect[start] + rect[size]) : rect[start] - (origin[start] + origin[size]);
    const overlap = Math.min(origin[cross] + origin[span], rect[cross] + rect[span]) - Math.max(origin[cross], rect[cross]);
    if (gap < 0 || overlap <= 0) continue;
    if (!best || gap < best.gap || (gap === best.gap && overlap > best.overlap)) best = { id, gap, overlap };
  }
  return best?.id ?? null;
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
  return { state: { ...s, root, targets: { ...s.targets, [id]: target }, tabs: { ...s.tabs, [id]: isTab(target) ? [target] : [] }, next: n + 1, max: null }, id };
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
  const tabs = { ...s.tabs };
  delete tabs[id];
  const focused = s.focused === id ? heir(s.root, id) ?? paneIds(root)[0]! : s.focused;
  const max = s.max === id || paneIds(root).length < 2 ? null : s.max;
  return { ...s, root, targets, tabs, focused, max };
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
  const kept = focusedTarget ? withFocusedTarget(s, focusedTarget) : s;
  return { ...kept, focused: id, max: s.max && s.max !== id ? id : s.max };
}

/** What the pane in focus shows, written back into its entry, and into its
 *  tabs: the tab it already is, or a new one at the end. */
export function withFocusedTarget(s: SplitState, target: StageTarget): SplitState {
  const was = s.targets[s.focused];
  const held = s.tabs?.[s.focused] ?? [];
  const tabs = capTabs(mergeTab(held, target), target);
  if (was && sameShown(was, target) && tabs === held) return s;
  return { ...s, targets: { ...s.targets, [s.focused]: target }, tabs: { ...s.tabs, [s.focused]: tabs } };
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
  const promoted: StageTarget = { kind: "session", id: sessionId, launch: key };
  const targets: Record<string, StageTarget> = {};
  for (const [id, t] of Object.entries(s.targets)) {
    if (t.kind === "launch" && t.key === key && id !== s.focused) { targets[id] = promoted; changed = true; }
    else targets[id] = t;
  }
  const tabs: Record<string, readonly StageTarget[]> = {};
  for (const [id, list] of Object.entries(s.tabs ?? {})) {
    const at = list.findIndex(t => t.kind === "launch" && t.key === key);
    if (at < 0) { tabs[id] = list; continue; }
    tabs[id] = list.map((t, j) => (j === at ? promoted : t));
    changed = true;
  }
  return changed ? { ...s, targets, tabs } : s;
}

/** The launches the panes hold that are not yet sessions, by key, except
 *  the one the pane in focus shows (the shell's own). */
export function heldLaunches(s: SplitState, focusedTarget: StageTarget | null): string[] {
  const keys = new Set<string>();
  for (const id of paneIds(s.root)) {
    for (const t of paneTabs(s, id, id === s.focused ? focusedTarget : null)) {
      if (t.kind === "launch" && !(id === s.focused && sameTab(t, focusedTarget))) keys.add(t.key);
    }
  }
  return [...keys];
}

// ── kept per browser ─────────────────────────────────────────────────────────
interface Stored {
  v: 1;
  root: SplitNode;
  /** The session each pane shows, or null. */
  panes: Record<string, string | null>;
  /** Each pane's tabs, sessions only, in the strip's order. Left out by the
   *  versions before tabs, whose arrangements load as one tab a pane. */
  tabs?: Record<string, string[]>;
  focused: string;
  next: number;
}

const PANE_ID = /^p\d{1,4}$/;
const validSession = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

/** The arrangement as it is kept: the panes and their sessions, every tab's,
 *  never a launch (a reload starts nothing). One pane with one tab is not
 *  kept: it is the Workspace as it was before panes, which the reader's own
 *  memory serves. */
export function serializeSplit(s: SplitState, focusedTarget: StageTarget | null): string | null {
  const ids = paneIds(s.root);
  const panes: Record<string, string | null> = {};
  const tabs: Record<string, string[]> = {};
  let many = false;
  for (const id of ids) {
    const t = paneTarget(s, id, focusedTarget);
    panes[id] = t.kind === "session" ? t.id : null;
    tabs[id] = paneTabs(s, id, focusedTarget).flatMap(x => (x.kind === "session" ? [x.id] : []));
    if (tabs[id]!.length > 1) many = true;
  }
  if (ids.length < 2 && !many) return null;
  const stored: Stored = { v: 1, root: s.root, panes, tabs, focused: s.focused, next: s.next };
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

/** The kept arrangement, or null for anything this version did not write.
 *  One written before tabs (no `tabs`) loads with one tab a pane. A session
 *  is in one pane at most: a second claim on it is dropped. */
export function parseSplit(raw: string | null | undefined): SplitState | null {
  if (!raw) return null;
  let d: unknown;
  try { d = JSON.parse(raw); } catch { return null; }
  const o = d as Partial<Stored> | null;
  if (!o || o.v !== 1 || !o.panes || typeof o.panes !== "object") return null;
  const seen = new Set<string>();
  if (!validNode(o.root, seen, 0) || seen.size < 1 || seen.size > MAX_PANES) return null;
  const kept = o.tabs && typeof o.tabs === "object" ? o.tabs as Record<string, unknown> : null;
  const claimed = new Set<string>();
  const targets: Record<string, StageTarget> = {};
  const tabs: Record<string, readonly StageTarget[]> = {};
  for (const id of seen) {
    const raw = (o.panes as Record<string, unknown>)[id];
    const shows = validSession(raw) && !claimed.has(raw) ? raw : null;
    const listed = Array.isArray(kept?.[id]) ? (kept![id] as unknown[]) : [];
    let list: string[] = [];
    for (const sid of listed) if (validSession(sid) && !claimed.has(sid) && !list.includes(sid)) list.push(sid);
    if (shows && !list.includes(shows)) list.push(shows);
    // No more than MAX_TABS, the one on show always among them.
    while (list.length > MAX_TABS) {
      const drop = list.findIndex(sid => sid !== shows);
      list = list.filter((_, i) => i !== drop);
    }
    for (const sid of list) claimed.add(sid);
    // A pane that showed a launch shows its newest session tab, if any.
    const on = shows ?? list[list.length - 1] ?? null;
    targets[id] = on ? { kind: "session", id: on } : EMPTY;
    tabs[id] = list.map(sid => ({ kind: "session", id: sid }));
  }
  // One pane is kept only for its tabs (serializeSplit).
  if (seen.size < 2 && (tabs[[...seen][0]!]?.length ?? 0) < 2) return null;
  const focused = typeof o.focused === "string" && seen.has(o.focused) ? o.focused : [...seen][0]!;
  const next = Number.isInteger(o.next) && (o.next as number) > 0 ? (o.next as number) : seen.size;
  return { root: o.root as SplitNode, targets, focused, max: null, next, tabs };
}

/** Tabs whose session is gone leave the strip, and a pane left with none
 *  closes; nothing is started for any of them. A pane that showed a session
 *  gone shows its neighbour. */
export function pruneSplit(s: SplitState, known: (sessionId: string) => boolean): SplitState {
  let out = s;
  for (const id of paneIds(s.root)) {
    const held = paneTabs(out, id, null);
    const keep = held.filter(t => t.kind !== "session" || known(t.id));
    const shown = out.targets[id];
    const gone = shown?.kind === "session" && !known(shown.id);
    if (keep.length === held.length && !gone) continue;
    if (keep.length === 0) {
      if (paneCount(out) > 1) out = removePane(out, id);
      continue;
    }
    const at = held.findIndex(t => sameTab(t, shown));
    const shows = gone ? keep[Math.min(Math.max(at, 0), keep.length - 1)]! : shown ?? EMPTY;
    out = { ...out, targets: { ...out.targets, [id]: shows }, tabs: { ...out.tabs, [id]: keep } };
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
