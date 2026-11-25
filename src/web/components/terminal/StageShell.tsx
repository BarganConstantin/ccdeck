// The stage in the deck: the navigator in the canvas's place, the stage over
// the canvas cell's right-hand side, and the morph and the fold that move
// between the board and the two of them — the lazy chunk's entry point.
//
// LAZY. Nothing in this file, nor anything it imports — the navigator, the
// stage, xterm's stylesheet, the session hook — is in the chunk every visit
// loads. App reaches it only through use-stage.ts's loadStageShell, by way of
// the two React.lazy slots in components/StageSlots.tsx; both resolve from the
// one import, so the navigator and the stage arrive together.
//
// TWO PIECES, ONE STAGE. The navigator is the board's compact form and lives
// inside <main>, where the board lives (CanvasMain's listeners still answer a
// press on its ground). The stage is a region beside the board and sits after
// <main> in the document, so the canvas's capture listeners never see a key or
// a press meant for the terminal. They share use-stage.ts's state and its
// navigator handle, and the dock runs the motion for both.
//
// THE MORPH STARTS ON THE PRESS (V4's motion spec). A click mounts the stage
// and the window opens out of the card in the same frame: the press is answered
// at once, and nothing waits for the pane. The session attaches behind it, and
// the terminal fades in over 150 once its seed is parsed (terminal-stage.css);
// when that is later than the morph, the attaching card follows the Waiting
// loader's rule (150 before it shows, 300 at least, StageBody.tsx). The morph
// and the navigator's fold start in the same frame on the same timer clock,
// and nothing waits on an animation's promise.
//
// A CLOSE DURING THE OPEN TURNS AROUND from the frame on screen: the close
// starts at the progress that draws the frame the open drew last, so nothing
// jumps. By a key there is no morph at all, and under reduced motion the stage
// crossfades in its column, the board and the navigator fading with it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { useReactFlow, useStoreApi } from "reactflow";
import type { BlockedSession } from "../../ambient-counts";
import { useT } from "../../i18n";
import { boardRect } from "../../board-rect";
import { clusterBounds } from "../../cluster-bounds";
import { FLIP_CLOSE_MS, FLIP_OPEN_MS, easeOutInverse, readBoardClusterRects, runTween, type Running } from "../../navigator-flip";
import { paletteReader, type Palette } from "../../palette";
import { tokenMs } from "../../rail-motion";
import type { GraphState } from "../../reducer";
import { targetSession } from "../../stage-shell";
import { columnSeed, crossfadeFrame, localRect, morphFrame, type MorphFrame, type MorphPlan, type MorphRect } from "../../stage-morph";
import type { Asks } from "../../use-asks";
import { useMirroredRef } from "../../use-mirrored-ref";
import type { Stage } from "../../use-stage";
import { beginDrag, currentDrag, endDrag, isOurDrag } from "../../split-drag";
import type { StageTarget } from "../../stage-shell";
import type { AgentNodeData } from "../../types";
import type { TerminalProvider } from "../../terminal-api";
import { prefersReducedMotion } from "../../viewport-motion";
import { tabStripMove } from "../../tablist-keys";
import { MAX_PANES, paneIds, paneTabs, paneTarget, sameTab, tabKey, zoneAt, zoneRect, type DropZone, type Rect } from "../../workspace-split";
import BoardNavigator from "../BoardNavigator";
import { rowGlyphOf } from "../SessionList";
import NewSessionPopover from "./NewSessionPopover";
import SplitDivider from "./SplitDivider";
import { useCodexLaunch } from "./codex-launch";
import { barArrival, barAsks, boardProjects, stageShowFor, waitingCardFor } from "./stage-board";
import { closedAnnouncement } from "./stage-model";
import TerminalStage, { stageName, type StageShow, type StageSplit } from "./TerminalStage";
import type { PaneTabItem, PaneTabsView } from "./PaneTabs";
import { WORKSPACE_PANE_ID } from "../../workspace-pane";

// ---------------------------------------------------------------------------
// The navigator, in the canvas.

export interface StageNavigatorProps {
  stage: Stage;
}

/** The board's compact form beside the stage. Nothing in the takeover a
 *  narrow window gets, where the stage has the whole cell. */
export function StageNavigator({ stage }: StageNavigatorProps) {
  const g = stage.geometry;
  if (!g || g.takeover) return null;
  return (
    <div
      className="stage-nav"
      data-phase={stage.shell.phase}
      data-grace={stage.shell.grace || undefined}
      style={{ "--nav-w": `${g.navW}px` } as CSSProperties}
    >
      <BoardNavigator
        ref={stage.navRef}
        width={g.navW}
        density={g.density}
        attachedId={targetSession(stage.shell.target)}
        onOpen={stage.openTile}
        onNewSession={stage.newSessionFrom}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stage, beside it.

export interface StageDockProps {
  stage: Stage;
  stateRef: MutableRefObject<GraphState>;
  canvasRef: MutableRefObject<HTMLElement | null>;
  /** The board's clock: the header's sentence moves with it. */
  now: number;
  palette: Palette;
  asks: Asks;
  waitingSessions: readonly BlockedSession[];
  /** WORKSPACE: ✕ on the empty pane leaves for the Board. */
  onBoard?(): void;
}

/** React Flow's own element, the one a fold fades and the stage makes inert. */
function flowOf(canvas: HTMLElement | null): HTMLElement | null {
  return canvas?.querySelector<HTMLElement>(":scope > .react-flow") ?? null;
}

/** A card's box, and where it prints its name, on the page — or nulls when
 *  the card is gone or off the canvas. */
function cardRects(canvas: HTMLElement | null, id: string | null): { card: DOMRect | null; name: DOMRect | null } {
  if (!canvas || !id) return { card: null, name: null };
  let el: Element | null = null;
  try { el = canvas.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`); } catch {}
  if (!el) return { card: null, name: null };
  const pane = boardRect(canvas);
  const card = el.getBoundingClientRect();
  const shows = card.width > 0 && card.right > pane.left && card.left < pane.right && card.bottom > pane.top && card.top < pane.bottom;
  if (!shows) return { card: null, name: null };
  const face = el.querySelector(".lod-name");
  const nameEl = face && face.getBoundingClientRect().width > 0 ? face : el.querySelector(".title .label");
  return { card, name: nameEl ? nameEl.getBoundingClientRect() : null };
}

/** Panes in the order they were made (p0, p1, …): a new pane is added after
 *  the others, and none of them moves in the document. */
function byPaneNumber(a: string, b: string): number {
  return (Number(a.slice(1)) || 0) - (Number(b.slice(1)) || 0);
}

const asRect = (r: DOMRect | { x: number; y: number; w: number; h: number }): MorphRect =>
  "width" in r ? { x: r.left, y: r.top, w: r.width, h: r.height } : r;

// ---------------------------------------------------------------------------
// WORKSPACE with panes side by side (internal #102).

/** One pane's place in the Workspace. Every pane, the one stage included, is
 *  drawn through this one keyed wrapper, so a split, a move or a switch of
 *  view never mounts the terminal on screen again. */
interface SplitPaneProps {
  id: string;
  /** Its box in the cell; null fills the cell (one pane, or the Board). */
  rect: Rect | null;
  /** Several panes on screen: the one with the keys is marked. */
  multi: boolean;
  focused: boolean;
  /** Behind the strip: kept running, out of sight and out of reach. */
  hidden: boolean;
  /** One pane on show and the strip names them all: this pane is the panel
   *  its tab in the strip controls. */
  strip: boolean;
  /** A press or a focus inside a pane without the keys gives it them. */
  onFocusIn(): void;
  children: ReactNode;
}

function SplitPane(p: SplitPaneProps) {
  const r = p.rect;
  const style: CSSProperties | undefined = r ? { left: r.x, top: r.y, width: r.w, height: r.h, right: "auto", bottom: "auto" } : undefined;
  const away = p.multi && !p.focused && !p.hidden;
  // `inert` is not in React 18's attribute types; it is a plain attribute.
  const inert = p.hidden ? { inert: "" } : {};
  const pane = {
    style,
    "data-pane": p.id,
    "data-focused": (p.multi && p.focused) || undefined,
    "data-hidden": p.hidden || undefined,
    "aria-hidden": p.hidden || undefined,
    ...inert,
    onPointerDownCapture: away ? p.onFocusIn : undefined,
    onFocusCapture: away ? p.onFocusIn : undefined,
  };
  // Under the strip the pane is the panel its tab names. The same <div> in
  // both branches, so React keeps it, and the terminal in it, between them.
  const id = p.id;
  return p.strip ? (
    <div className="wsp-pane" role="tabpanel" id={stripPanelId(id)} aria-labelledby={stripTabId(id)} {...pane}>
      {p.children}
    </div>
  ) : (
    <div className="wsp-pane" {...pane}>
      {p.children}
    </div>
  );
}

/** The strip's tab for a pane, and the pane it shows. */
const stripTabId = (pane: string) => `wsp-tab-${pane}`;
const stripPanelId = (pane: string) => `wsp-pane-${pane}`;

/** A Codex launch in any tab of a pane, on show or not, is found as its own
 *  (codex-launch.ts). Draws nothing. */
function LaunchWatch(p: { target: StageTarget | null; agents: ReadonlyMap<string, AgentNodeData>; onFound(sessionId: string, key: string): void }) {
  useCodexLaunch(p.target, p.agents, p.onFound);
  return null;
}

/** A pane's tab in its header's strip, and the pane's stage, the panel every
 *  tab of it shows. */
const paneTabId = (pane: string, key: string) => `wsp-ptab-${pane}-${key}`;
const panePanelId = (pane: string) => `wsp-ptabpanel-${pane}`;

/** One tab of a pane as the dock draws it. */
interface TabView {
  /** The tab's lasting key (tabKey). */
  key: string;
  target: StageTarget | null;
  show: StageShow;
  name: string;
  /** The tab the pane shows. */
  on: boolean;
}

/** What a drag over the Workspace would do, and where it lights up. */
interface DropView { pane: string; zone: DropZone; rect: Rect; label: string; already: boolean }

export function StageDock(p: StageDockProps) {
  const { stage, stateRef, canvasRef } = p;
  const { shell, geometry: g } = stage;
  const readToken = useMemo(() => paletteReader(p.palette), [p.palette]);
  const rf = useReactFlow();
  const store = useStoreApi();

  const dockRef = useRef<HTMLDivElement | null>(null);
  const inRef = useRef<HTMLDivElement | null>(null);
  const edgeRef = useRef<HTMLSpanElement | null>(null);
  const riderRef = useRef<HTMLSpanElement | null>(null);
  const motion = useRef<Running | null>(null);
  /** How far the open stands (0 → 1, the eased progress it drew last); 1 when
   *  nothing is opening. A close that turns it around starts from here. */
  const openedRef = useRef(1);

  const t = useT();
  const agents = stateRef.current.agents;
  const show = stageShowFor(shell.target, agents, p.now);
  const onFound = useCallback((sessionId: string, key: string) => stage.onLaunched({ sessionId, key }), [stage]);
  const fill = g?.fill === true;
  const [drop, setDrop] = useState<DropView | null>(null);
  // The agent New session opens with when a pane's folder-gone card opened
  // it (Choose folder… with no folder dialog): only for that popover.
  const [newWith, setNewWith] = useState<{ anchor: string; agent: TerminalProvider; gone: string } | null>(null);
  // A drag that ends anywhere, dropped or not, takes its zone away.
  useEffect(() => {
    if (!drop) return;
    const off = () => setDrop(null);
    window.addEventListener("dragend", off);
    window.addEventListener("drop", off);
    return () => { window.removeEventListener("dragend", off); window.removeEventListener("drop", off); };
  }, [drop]);
  const name = stageName(show, fill);
  // The empty stage's name is a description, not a session: closing it keeps
  // nothing running, so the sentence says only that the stage closed.
  const nameRef = useMirroredRef(show.kind === "empty" ? null : name);
  const waitingOnStage = show.kind === "session" && show.session.status.state === "waiting";
  const waitingRef = useMirroredRef(waitingOnStage);
  const shellRef = useMirroredRef(shell);
  const geometryRef = useMirroredRef(g);

  // ── uncovering the stage ───────────────────────────────────────────────────
  // The press is answered in the frame it came in: a stage that was only just
  // asked for is uncovered before it paints, with no wait for the pane.
  useLayoutEffect(() => {
    if (shell.phase === "waiting") stage.reveal();
  }, [shell.phase, stage.reveal]);
  // During the double-click window the header's buttons answer, except one the
  // pressed card lies under: the second press of the double click is aimed at
  // that card, and must reach it (stage-shell.css).
  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const o = shell.grace ? shell.origin : null;
    for (const b of dock.querySelectorAll<HTMLElement>(".ts-head button")) {
      const r = b.getBoundingClientRect();
      b.toggleAttribute("data-over-origin", !!o && r.left < o.x + o.w && r.right > o.x && r.top < o.y + o.h && r.bottom > o.y);
    }
  }, [shell.grace, shell.origin, shell.phase, g]);

  // ── the motion ─────────────────────────────────────────────────────────────
  /** Writes one frame of the morph onto the stage (and the board, when no
   *  fold is drawing it). */
  const paint = useCallback((f: MorphFrame, flow: HTMLElement | null) => {
    const dock = dockRef.current, inner = inRef.current, edge = edgeRef.current, rider = riderRef.current;
    if (!dock) return;
    dock.style.clipPath = f.clip;
    dock.style.opacity = f.stage < 1 ? String(f.stage) : "";
    if (inner) inner.style.opacity = f.content < 1 ? String(f.content) : "";
    // Custom properties the sheet reads only while a rider flies.
    dock.style.setProperty("--stage-late", String(f.late));
    dock.style.setProperty("--stage-chip", String(f.chip));
    if (edge) {
      edge.style.transform = `translate(${f.edge.rect.x}px, ${f.edge.rect.y}px)`;
      edge.style.width = `${f.edge.rect.w}px`;
      edge.style.height = `${f.edge.rect.h}px`;
      edge.style.borderRadius = `${f.edge.radius}px`;
      edge.style.opacity = String(f.edge.opacity);
    }
    if (rider) {
      rider.style.transform = f.rider ? f.rider.transform : "";
      rider.style.opacity = f.rider ? String(f.rider.opacity) : "";
    }
    if (flow) flow.style.opacity = String(f.board);
  }, []);

  /** Takes every inline style a motion wrote back off: the sheet draws the
   *  stage at rest. */
  const settle = useCallback(() => {
    const dock = dockRef.current;
    if (dock) {
      dock.style.clipPath = "";
      dock.style.opacity = "";
      dock.style.removeProperty("--stage-late");
      dock.style.removeProperty("--stage-chip");
      dock.removeAttribute("data-rider");
    }
    if (inRef.current) inRef.current.style.opacity = "";
    const navEl = canvasRef.current?.querySelector<HTMLElement>(".stage-nav .board-nav");
    if (navEl) navEl.style.opacity = "";
    for (const el of [edgeRef.current, riderRef.current]) {
      if (!el) continue;
      el.style.transform = "";
      el.style.opacity = "";
    }
    const flow = flowOf(canvasRef.current);
    if (flow) flow.style.opacity = "";
  }, [canvasRef]);

  const start = useCallback((dir: "open" | "close") => {
    // Where the open stood when this close came in (1 when none was running):
    // the close starts from the same frame instead of from the open stage.
    const turned = dir === "close" && motion.current != null ? openedRef.current : 1;
    motion.current?.cancel();
    motion.current = null;
    openedRef.current = dir === "open" ? 0 : 1;
    const dock = dockRef.current;
    const geo = geometryRef.current;
    const done = () => { openedRef.current = 1; if (dir === "open") stage.revealed(); else stage.closed(closedAnnouncement(nameRef.current)); };
    if (!dock || !geo) { done(); return; }
    // WORKSPACE: the pane is the cell, not a window growing out of a card. No
    // morph and no fold (there is no navigator): it is there, and the view
    // switch's own fade is the only motion (workspace.css).
    if (geo.fill) { settle(); done(); return; }
    // By a key there is no morph: the last input decides (input-modality.ts).
    if (document.documentElement.dataset.motion === "instant") { settle(); done(); return; }

    const box = dock.getBoundingClientRect();
    const origin = { x: box.left, y: box.top };
    const w = box.width, h = box.height;
    const column: MorphRect = geo.takeover ? { x: 0, y: 0, w, h } : { x: w - geo.stageW, y: 0, w: geo.stageW, h };
    const s = shellRef.current;
    let card: MorphRect | null = null, cardName: MorphRect | null = null;
    if (dir === "open") {
      card = s.origin ? localRect(s.origin, origin) : null;
      cardName = s.originName ? localRect(s.originName, origin) : null;
    } else {
      const found = cardRects(canvasRef.current, targetSession(s.target));
      card = found.card ? localRect(asRect(found.card), origin) : null;
      cardName = found.name ? localRect(asRect(found.name), origin) : null;
    }
    const seed = card ?? columnSeed(column);
    const header = dock.querySelector(".ts-name")?.getBoundingClientRect();
    // Under reduced motion the stage crossfades in its column: nothing flies,
    // so there is no rider to hold the header's name back for.
    const reduced = prefersReducedMotion();
    const plan: MorphPlan = {
      direction: dir,
      w, h,
      from: dir === "open" ? seed : column,
      to: dir === "open" ? column : seed,
      rider: !reduced && card && cardName && header && header.height > 0 ? { card: cardName, header: localRect(asRect(header), origin) } : null,
    };
    dock.toggleAttribute("data-rider", plan.rider != null);
    if (edgeRef.current) {
      edgeRef.current.style.borderColor = dir === "close" ? "var(--line)" : waitingRef.current ? "var(--warn)" : "var(--inflight)";
    }

    // The fold, in the same beat: the navigator's tiles fly from the board's
    // clusters (or back to them) and the fold draws the board's fade. With no
    // navigator — the takeover — the morph draws the fade itself.
    const flow = flowOf(canvasRef.current);
    const nav = stage.navRef.current;
    // A close that turns an open around starts at the raw progress whose frame
    // is the one the open drew last (the close runs the same curve downward).
    const from = turned < 1 ? easeOutInverse(1 - turned) : 0;
    let folding = false;
    // Reduced motion: no tile flies. The navigator is faded with the stage and
    // the board (paint), never folded, so no frame has neither of them.
    const navEl = canvasRef.current?.querySelector<HTMLElement>(".stage-nav .board-nav") ?? null;
    if (nav && flow && !geo.takeover && !reduced) {
      const board = readBoardClusterRects(flow, clusterBounds(store.getState().nodeInternals.values()), rf.getViewport());
      folding = true;
      void nav.fold(dir, board, { reduced, from, onFrame: f => { flow.style.opacity = String(f.board); } });
    }
    const ms = reduced ? tokenMs("--dur-xfade") : dir === "open" ? FLIP_OPEN_MS : FLIP_CLOSE_MS;
    const run = runTween(ms, (_raw, eased) => {
      if (dir === "open") openedRef.current = eased;
      const f = (reduced ? crossfadeFrame : morphFrame)(plan, eased);
      if (reduced && navEl && !geo.takeover) navEl.style.opacity = String(f.stage);
      paint(f, folding ? null : flow);
    }, undefined, from);
    motion.current = run;
    void run.finished.then(ran => {
      if (!ran || motion.current !== run) return;
      motion.current = null;
      done();
    });
  }, [stage, nameRef, waitingRef, shellRef, geometryRef, canvasRef, store, rf, paint, settle]);

  // Keyed on the phase alone: `start` closes over this render's stage, which
  // the deck's 250ms tick rebuilds, and a motion restarted on every tick
  // would never finish.
  const startRef = useMirroredRef(start);
  useLayoutEffect(() => {
    if (shell.phase === "opening") startRef.current("open");
    else if (shell.phase === "closing") startRef.current("close");
    else if (shell.phase === "open") {
      // At rest. A close that was overtaken by another open lands here too:
      // its motion stops, and the navigator's tiles, which a close leaves on
      // its last frame, are put back where they belong.
      const interrupted = motion.current != null;
      motion.current?.cancel();
      motion.current = null;
      openedRef.current = 1;
      settle();
      if (interrupted) void stage.navRef.current?.fold("open", new Map(), { reduced: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell.phase]);

  // A stage taken away mid-motion — the detail panel evicting it — leaves the
  // board as the sheet draws it.
  useEffect(() => () => {
    motion.current?.cancel();
    const flow = flowOf(canvasRef.current);
    if (flow) flow.style.opacity = "";
  }, [canvasRef]);

  // ── the panes (internal #102) ──────────────────────────────────────────────
  const split = stage.split ?? null;
  const focusedId = split?.focused ?? "p0";
  const arrangement = fill ? stage.arrangement ?? null : null;
  const multi = arrangement != null && arrangement.mode !== "one";
  const ids = multi && split ? [...paneIds(split.root)].sort(byPaneNumber) : [focusedId];
  const panes = ids.map(id => {
    const focused = id === focusedId;
    const target = focused ? shell.target : paneTarget(split!, id, null);
    const paneShow = focused ? show : stageShowFor(target, agents, p.now);
    // WORKSPACE: every tab the pane holds, the one it shows among them. The
    // Board's stage is one stage, whatever it shows.
    const tabs: TabView[] = fill && split
      ? paneTabs(split, id, focused ? shell.target : null).map(tab => {
        const on = sameTab(tab, target);
        const tabShow = on ? paneShow : stageShowFor(tab, agents, p.now);
        return { key: tabKey(tab), target: on ? target : tab, show: tabShow, name: stageName(tabShow, true), on };
      })
      : [];
    // The empty pane, or the Board's stage: what it shows.
    if (!tabs.some(x => x.on)) tabs.push({ key: tabKey(target ?? { kind: "empty" }), target, show: paneShow, name: stageName(paneShow, true), on: true });
    return { id, focused, target, show: paneShow, name: stageName(paneShow, true), tabs };
  });
  // Where the keyboard goes once a tab chosen from its strip is drawn: the
  // tab itself, in the header of the terminal now on show.
  const tabFocusRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = tabFocusRef.current;
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    tabFocusRef.current = null;
    el.focus();
    el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });

  const nameOfSession = (id: string) => stageName(stageShowFor({ kind: "session", id }, agents, p.now), true);
  /** A tab's mark: its session's row in the Sessions list, when the board
   *  knows the session (a tab and its row never say two states). */
  const markOf = (show: StageShow) => {
    const root = show.kind === "session" ? agents.get(show.session.ref.sessionId) : undefined;
    return root ? rowGlyphOf(root) : null;
  };
  /** The drop a drag at (x, y) of the cell would make, or null. */
  const dropAt = (x: number, y: number): DropView | null => {
    const dragged = currentDrag();
    if (!dragged || !split) return null;
    // A session already in a pane, in any of its tabs: that tab comes back,
    // with the keys, whichever pane it is dropped on.
    if (dragged.kind === "session") {
      const has = panes.find(x2 => x2.tabs.some(tab => tab.target?.kind === "session" && tab.target.id === dragged.id));
      if (has) {
        const r = multi ? arrangement!.rects.get(has.id) : null;
        const box = r ?? { x: 0, y: 0, w: inRef.current?.clientWidth ?? 0, h: inRef.current?.clientHeight ?? 0 };
        return { pane: has.id, zone: "here", rect: box, label: t("board.stage.split.already"), already: true };
      }
    }
    const shown = panes.filter(x2 => !(multi && arrangement!.mode === "strip" && !x2.focused));
    for (const pane of shown) {
      const r = multi ? arrangement!.rects.get(pane.id) : { x: 0, y: 0, w: inRef.current?.clientWidth ?? 0, h: inRef.current?.clientHeight ?? 0 };
      if (!r || x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) continue;
      if (dragged.kind === "pane" && dragged.id === pane.id) return null;
      const canSplit = dragged.kind === "pane" || (paneIds(split.root).length < MAX_PANES && pane.show.kind !== "empty");
      // An edge with no room for another pane of 40 × 8 is the pane's Here:
      // the session opens there as a tab (use-stage.ts openBeside).
      const edge = zoneAt(r, x, y, canSplit);
      const zone = edge !== "here" && dragged.kind === "session" && stage.roomBeside && !stage.roomBeside(pane.id, edge) ? "here" : edge;
      const key = dragged.kind === "pane"
        ? (zone === "here" ? "board.stage.split.moveSwap" : zone === "top" ? "board.stage.split.moveAbove" : zone === "bottom" ? "board.stage.split.moveBelow" : "board.stage.split.moveBeside")
        : (zone === "here" ? "board.stage.split.showHere" : zone === "top" ? "board.stage.split.openAbove" : zone === "bottom" ? "board.stage.split.openBelow" : "board.stage.split.openBeside");
      return { pane: pane.id, zone, rect: zoneRect(r, zone), label: t(key, { name: dragged.name }), already: false };
    }
    return null;
  };
  const point = (e: DragEvent<HTMLElement>) => {
    const box = inRef.current?.getBoundingClientRect();
    return box ? { x: e.clientX - box.left, y: e.clientY - box.top } : null;
  };
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!isOurDrag(e.dataTransfer?.types)) return;
    e.preventDefault();
    e.stopPropagation();
    const at = point(e);
    const next = at ? dropAt(at.x, at.y) : null;
    if (e.dataTransfer) e.dataTransfer.dropEffect = next ? "move" : "none";
    setDrop(prev => (prev && next && prev.pane === next.pane && prev.zone === next.zone && prev.label === next.label ? prev : next));
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    const to = e.relatedTarget as Node | null;
    if (to && inRef.current?.contains(to)) return;
    setDrop(null);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!isOurDrag(e.dataTransfer?.types)) return;
    e.preventDefault();
    e.stopPropagation();
    const at = point(e);
    const view = at ? dropAt(at.x, at.y) : null;
    const dragged = currentDrag();
    setDrop(null);
    endDrag();
    if (!view || !dragged) return;
    if (dragged.kind === "pane") stage.movePaneTo(dragged.id, view.pane, view.zone);
    else if (view.already) stage.dropHere(view.pane, dragged.id);
    else if (view.zone === "here") stage.dropHere(view.pane, dragged.id);
    else stage.openBeside(dragged.id, { at: view.pane, zone: view.zone });
  }

  /** The terminal of one pane: the stage as it always was for the pane with
   *  the keys, and the same stage, sized to its box, for every other pane.
   *  ONE STAGE A PANE, ITS TABS SWITCHED IN PLACE. A tab not on show holds no
   *  connection: the deck keeps four terminal sockets at most (one a pane),
   *  and a socket nobody looks at is a tmux client for nothing. The session
   *  runs on in tmux; a switch back attaches it again, as the one pane always
   *  switched sessions: the screen and the last of its history drawn again,
   *  its running turn where it got to. */
  const stageFor = (pane: typeof panes[number]) => {
    const own = pane.focused;
    const id = pane.id;
    const ps = pane.show;
    const tab = pane.tabs.find(x => x.on)!;
    const rect = multi ? arrangement!.rects.get(id) : null;
    const geometry = multi && rect ? stage.geometryFor(rect.w, rect.h) : g!;
    const keysHere = () => { if (!own) stage.focusPaneId(id); };
    // What a new session in place of this one would start: its agent, in its
    // folder. Claude and Codex are the agents the deck starts.
    const ref = ps.kind === "session" ? ps.session.ref : null;
    const fresh = ref && (ref.provider === "claude" || ref.provider === "codex") ? { agent: ref.provider, cwd: ref.cwd } : null;
    const splitView: StageSplit | null = multi ? {
      number: arrangement!.order.indexOf(id) + 1,
      primary: own,
      max: arrangement!.why === "max",
      onMax: () => (arrangement!.why === "max" ? stage.showAll() : stage.toggleMax(id)),
      onDragHead: e => beginDrag(e, { kind: "pane", id, name: tab.name }),
    } : null;
    // A tab of the Workspace closes alone (its neighbour comes on); the last
    // one closes its pane beside others, and empties the one pane. The empty
    // pane's ✕ leaves for the Board. The Board's ✕ closes the stage, as it did.
    const held = tab.target && tab.target.kind !== "empty" ? tab.target : null;
    const close = !fill ? stage.close
      : held ? () => stage.closeTab(id, held)
        : multi ? () => stage.closePane(id) : p.onBoard ?? stage.close;
    // The pane's strip, in its header, once it holds two. Every tab shows
    // this stage: the panel each of them controls.
    const strip = pane.tabs.filter(x => x.target && x.target.kind !== "empty");
    const panel = own ? WORKSPACE_PANE_ID : panePanelId(id);
    const tabsView: PaneTabsView | null = fill && strip.length > 1 ? {
      items: strip.map((x): PaneTabItem => ({
        key: x.key,
        id: paneTabId(id, x.key),
        name: x.name,
        status: x.show.kind === "session" ? x.show.session.status : { state: x.show.kind === "launch" ? "starting" : "none", phrase: "" },
        ...(markOf(x.show) ? { mark: markOf(x.show)! } : null),
        on: x.on,
        panel,
      })),
      onSelect: (key, how) => {
        const to = strip.find(x => x.key === key);
        if (!to?.target) return;
        // Space keeps the keyboard on the strip, on the tab it showed; Enter
        // and a press put it in the terminal.
        if (to.on) { if (how.keys) stage.focusPaneId(id, { keys: true }); return; }
        if (!how.keys) tabFocusRef.current = paneTabId(id, key);
        stage.activateTab(id, to.target, { keys: how.keys });
      },
      onClose: (key, how) => {
        const at = strip.findIndex(x => x.key === key);
        const gone = strip[at];
        if (!gone?.target || gone.target.kind === "empty") return;
        const rest = strip.filter(x => x.key !== key);
        // From the strip by keys, the keyboard stays on the strip: on the
        // neighbour, or in the pane once one tab is left and the strip goes.
        // From the strip's menu it stays in the menu, on its next row
        // (PaneTabs.tsx), until the strip goes.
        if (how.keys && !how.menu && rest.length > 1) tabFocusRef.current = paneTabId(id, rest[Math.min(at, rest.length - 1)]!.key);
        stage.closeTab(id, gone.target, { keys: !how.keys || rest.length < 2 });
        if (how.keys && rest.length < 2 && !gone.on) stage.focusPaneId(id, { keys: true });
      },
    } : null;
    return (
      <TerminalStage
        show={ps}
        geometry={geometry}
        cell={stage.cell}
        readToken={readToken}
        expanded={stage.expanded}
        firstRun={own ? stage.firstRun : false}
        asksWaiting={own && p.waitingSessions.length > 0}
        asks={own ? barAsks(p.asks.view, p.waitingSessions, p.now) : null}
        arrival={own ? barArrival(p.asks.view, p.waitingSessions) : null}
        // Held until the stage can be seen: a focus asked of a pane that is
        // still hidden would be spent on nothing and not asked again. With
        // panes side by side, only the pane it was asked for answers it.
        focusRequest={multi ? stage.requestFor(id) : shell.phase === "waiting" ? null : shell.focusRequest}
        takeTypeAhead={stage.takeTypeAhead}
        holdsTypeAhead={stage.holdsTypeAhead}
        onWantKeys={own ? stage.focusPane : () => stage.focusPaneId(id, { keys: true })}
        onNextAsk={p.asks.nextAsk}
        onOpenWaiting={id => stage.switchTo(id, { focusPane: true })}
        onAnswerArrival={p.asks.nextAsk}
        // Workspace: ✕ closes the tab, and on the empty pane leaves for the
        // Board. The Board's ✕ closes the stage, as it did. The agent ending
        // itself closes its own tab, on show or not.
        onClose={close}
        waiting={own && fill && ps.kind === "empty" ? waitingCardFor(p.waitingSessions, p.now) : null}
        onToggleExpand={stage.toggleExpand}
        onFirstRunDone={stage.firstRunDone}
        onNewSession={(anchor, elsewhere) => { keysHere(); setNewWith(elsewhere ? { anchor, ...elsewhere } : null); stage.openPopover(anchor); }}
        // The folder-gone card's Choose folder…, with a folder chosen in the
        // desktop app's dialog: a new session there, in this pane.
        onStartIn={(agent, cwd) => { keysHere(); stage.launch(agent, cwd); }}
        onCols={stage.onCols}
        onColsReset={stage.onColsReset}
        onRelease={stage.release}
        onCell={own ? stage.onCell : undefined}
        onBarH={own ? stage.onBarH : undefined}
        onHeadH={own ? stage.onHeadH : undefined}
        onLaunched={stage.onLaunched}
        onContinuation={(sessionId, cwd) => {
          const next = p.stateRef.current.agents.get(sessionId);
          if (!next || next.provider !== "claude" || next.cwd !== cwd) return false;
          if (multi) stage.dropHere(id, sessionId, held ? { replace: held } : undefined);
          else stage.switchTo(sessionId, { focusPane: true });
          return true;
        }}
        // Start again and a new session in place of this one take this tab's
        // place in the strip: the launch or session it replaces is not left
        // behind as a tab of its own.
        onLaunchAgain={ps.kind === "launch" ? () => { keysHere(); stage.launch(ps.agent, ps.cwd, ps.options, held ? { replace: held } : undefined); } : undefined}
        // A session Reopen here could not bring back: a new one of its agent
        // in its folder, in this pane, on that press only.
        onStartNew={fresh ? () => { keysHere(); stage.launch(fresh.agent, fresh.cwd, undefined, held ? { replace: held } : undefined); } : undefined}
        onAnnounce={stage.announce}
        windows={stage.windows}
        split={splitView}
        panelId={tabsView ? panel : undefined}
        tabs={tabsView}
        tabbedBy={tabsView ? paneTabId(id, tab.key) : undefined}
      />
    );
  };

  if (!g) return null;
  const morphing = shell.phase === "waiting" || shell.phase === "opening" || shell.phase === "closing";
  const currentCwd = show.kind === "session" ? show.session.ref.cwd : show.kind === "launch" ? show.cwd : null;
  return (
    <div
      ref={dockRef}
      className="stage-dock"
      data-phase={shell.phase}
      data-morph={morphing || undefined}
      data-grace={shell.grace || undefined}
      data-takeover={g.takeover || undefined}
      data-fill={fill || undefined}
      style={{ "--stage-w": `${g.stageW}px` } as CSSProperties}
    >
      <div className="stage-ground" aria-hidden="true" />
      <div
        ref={inRef}
        className="stage-in"
        data-split={multi ? arrangement!.mode : undefined}
        onDragOverCapture={fill ? onDragOver : undefined}
        onDragLeave={fill ? onDragLeave : undefined}
        onDropCapture={fill ? onDrop : undefined}
      >
        {arrangement?.mode === "strip" && (
          <div
            className="wsp-strip"
            role="tablist"
            aria-label={t("board.stage.split.strip")}
            style={{ height: arrangement.strip }}
            onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
              // The arrows walk the tabs as a click would choose one: that
              // pane on show. The keys stay on the tab, as on any tab strip;
              // ↵ or a click on the pane hands them to its terminal.
              if ((e.target as HTMLElement).getAttribute("role") !== "tab") return;
              const order = arrangement.order;
              const move = tabStripMove(e, order.indexOf(focusedId), order.length);
              if (move.kind !== "select") return;
              e.preventDefault();
              e.stopPropagation();
              const next = order[move.index];
              stage.focusPaneId(next);
              document.getElementById(stripTabId(next))?.focus();
            }}
          >
            {arrangement.order.map((id, n) => {
              const pane = panes.find(x => x.id === id);
              if (!pane) return null;
              const on = id === focusedId;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={stripTabId(id)}
                  aria-controls={stripPanelId(id)}
                  tabIndex={on ? 0 : -1}
                  className="wsp-tab"
                  aria-selected={on}
                  data-on={on || undefined}
                  title={pane.name}
                  onClick={() => stage.focusPaneId(id, { keys: true })}
                >
                  <span className="wsp-tab-n" aria-hidden="true">{n + 1}</span>
                  <span className="wsp-tab-name">{pane.name}</span>
                </button>
              );
            })}
            {arrangement.why === "max" && (
              <button type="button" className="wsp-all" onClick={stage.showAll}>
                {t("board.stage.split.showAll", { count: panes.length })}
              </button>
            )}
            {arrangement.why === "narrow" && (
              <span className="wsp-why" title={t("board.stage.split.narrowHint")}>
                {t("board.stage.split.narrow")}
              </span>
            )}
          </div>
        )}
        {panes.map(pane => (
          <SplitPane
            key={pane.id}
            id={pane.id}
            rect={multi ? arrangement!.rects.get(pane.id) ?? null : null}
            multi={multi}
            focused={pane.focused}
            hidden={multi && arrangement!.mode === "strip" && !pane.focused}
            strip={multi && arrangement!.mode === "strip"}
            onFocusIn={() => stage.focusPaneId(pane.id)}
          >
            {pane.tabs.map(tab => <LaunchWatch key={tab.key} target={tab.target} agents={agents} onFound={onFound} />)}
            {stageFor(pane)}
          </SplitPane>
        ))}
        {fill && (
          <p className="wsp-note" role="status" aria-atomic="true" data-on={stage.splitNote ? true : undefined}>
            {stage.splitNote}
          </p>
        )}
        {multi && arrangement!.mode === "split" && arrangement!.dividers.map(d => (
          <SplitDivider key={d.path || "root"} d={d} label={t("board.stage.split.divider")} inRef={inRef} onRatio={stage.setSplitRatio} />
        ))}
        {drop && (
          <div
            className="wsp-zone"
            data-zone={drop.zone}
            data-already={drop.already || undefined}
            style={{ left: drop.rect.x, top: drop.rect.y, width: drop.rect.w, height: drop.rect.h }}
            aria-hidden="true"
          >
            <span className="wsp-zone-label">{drop.label}</span>
          </div>
        )}
      </div>
      <span ref={edgeRef} className="stage-edge" aria-hidden="true" />
      <span ref={riderRef} className="stage-rider" aria-hidden="true">{name}</span>
      {shell.popover && (
        <NewSessionPopover
          anchorId={shell.popover}
          initialAgent={newWith?.anchor === shell.popover ? newWith.agent : undefined}
          // Choose folder… is for ANOTHER folder: the one that is gone is
          // neither offered nor chosen first (NewSessionForm `gone`).
          gone={newWith?.anchor === shell.popover ? newWith.gone : undefined}
          projects={boardProjects(agents.values(), currentCwd)}
          onStart={stage.launch}
          onClose={stage.closePopover}
          windows={stage.windows}
        />
      )}
    </div>
  );
}
