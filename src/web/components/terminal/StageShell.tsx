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
// THE MORPH WAITS FOR THE PANE. A click mounts the stage unseen and the
// session attaches behind it; the window opens out of the card only once the
// body has something to show — the pane with its seed already parsed, or the
// card that says why there is none — or after REVEAL_WAIT_MS, when it opens on
// the attaching card rather than keep a click unanswered (DESIGN-UI decision
// 2). The morph and the navigator's fold then start in the same frame on the
// same timer clock, and nothing waits on an animation's promise.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type MutableRefObject } from "react";
import { useReactFlow, useStoreApi } from "reactflow";
import type { BlockedSession } from "../../ambient-counts";
import { clusterBounds } from "../../cluster-bounds";
import { FLIP_CLOSE_MS, FLIP_OPEN_MS, readBoardClusterRects, runTween, type Running } from "../../navigator-flip";
import { paletteReader, type Palette } from "../../palette";
import type { GraphState } from "../../reducer";
import { targetSession, type StageTarget } from "../../stage-shell";
import { columnSeed, localRect, morphFrame, type MorphFrame, type MorphPlan, type MorphRect } from "../../stage-morph";
import type { Asks } from "../../use-asks";
import { useMirroredRef } from "../../use-mirrored-ref";
import type { Stage } from "../../use-stage";
import { prefersReducedMotion } from "../../viewport-motion";
import BoardNavigator from "../BoardNavigator";
import NewSessionPopover from "./NewSessionPopover";
import { barArrival, barAsks, boardProjects, stageShowFor } from "./stage-board";
import { closedAnnouncement, type StagePhaseKind } from "./stage-model";
import TerminalStage, { stageName } from "./TerminalStage";

/** How long a stage waits, unseen, for its pane before it opens on the
 *  attaching card instead. Past v3's 300ms "no spinner" line, so a pane that
 *  attaches promptly is never preceded by a card it would replace at once. */
export const REVEAL_WAIT_MS = 400;

/** The body phases a session's stage can be uncovered on: the pane, or the
 *  card that says why there is none — anything but an attach in flight. */
const SESSION_SHOWABLE: ReadonlySet<StagePhaseKind> = new Set<StagePhaseKind>([
  "live", "not-attachable", "tmux-missing", "ended", "detached", "error",
]);

/**
 * Whether a stage showing `target` can be uncovered on a body in `kind`.
 *
 * By target, because "empty" is two things: the empty stage's own card, and
 * the phase every terminal session starts in before it has been told what to
 * show — a stage that opened on that would open on nothing, a frame before
 * its attach began. A new session is shown from its "starting" line on.
 */
export function showable(kind: StagePhaseKind, target: StageTarget["kind"] | null | undefined): boolean {
  if (target === "empty") return kind === "empty";
  if (target === "launch") return kind === "starting" || SESSION_SHOWABLE.has(kind);
  return SESSION_SHOWABLE.has(kind);
}

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
  const pane = canvas.getBoundingClientRect();
  const card = el.getBoundingClientRect();
  const shows = card.width > 0 && card.right > pane.left && card.left < pane.right && card.bottom > pane.top && card.top < pane.bottom;
  if (!shows) return { card: null, name: null };
  const face = el.querySelector(".lod-name");
  const nameEl = face && face.getBoundingClientRect().width > 0 ? face : el.querySelector(".title .label");
  return { card, name: nameEl ? nameEl.getBoundingClientRect() : null };
}

const asRect = (r: DOMRect | { x: number; y: number; w: number; h: number }): MorphRect =>
  "width" in r ? { x: r.left, y: r.top, w: r.width, h: r.height } : r;

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

  const agents = stateRef.current.agents;
  const show = stageShowFor(shell.target, agents, p.now);
  const name = stageName(show);
  const nameRef = useMirroredRef(name);
  const waitingOnStage = show.kind === "session" && show.session.status.state === "waiting";
  const waitingRef = useMirroredRef(waitingOnStage);
  const shellRef = useMirroredRef(shell);
  const geometryRef = useMirroredRef(g);

  // ── uncovering the stage ───────────────────────────────────────────────────
  const onPhase = useCallback((kind: StagePhaseKind) => {
    const s = shellRef.current;
    if (s.phase === "waiting" && showable(kind, s.target?.kind)) stage.reveal();
  }, [shellRef, stage.reveal]);
  useEffect(() => {
    if (shell.phase !== "waiting") return;
    const t = window.setTimeout(stage.reveal, REVEAL_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [shell.phase, stage.reveal]);

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
    for (const el of [edgeRef.current, riderRef.current]) {
      if (!el) continue;
      el.style.transform = "";
      el.style.opacity = "";
    }
    const flow = flowOf(canvasRef.current);
    if (flow) flow.style.opacity = "";
  }, [canvasRef]);

  const start = useCallback((dir: "open" | "close") => {
    motion.current?.cancel();
    motion.current = null;
    const dock = dockRef.current;
    const geo = geometryRef.current;
    const done = () => (dir === "open" ? stage.revealed() : stage.closed(closedAnnouncement(nameRef.current)));
    if (!dock || !geo) { done(); return; }

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
    const plan: MorphPlan = {
      direction: dir,
      w, h,
      from: dir === "open" ? seed : column,
      to: dir === "open" ? column : seed,
      rider: card && cardName && header && header.height > 0 ? { card: cardName, header: localRect(asRect(header), origin) } : null,
    };
    dock.toggleAttribute("data-rider", plan.rider != null);
    if (edgeRef.current) {
      edgeRef.current.style.borderColor = dir === "close" ? "var(--line)" : waitingRef.current ? "var(--warn)" : "var(--inflight)";
    }

    // The fold, in the same beat: the navigator's tiles fly from the board's
    // clusters (or back to them) and the fold draws the board's fade. With no
    // navigator — the takeover — the morph draws the fade itself.
    const reduced = prefersReducedMotion();
    const flow = flowOf(canvasRef.current);
    const nav = stage.navRef.current;
    let folding = false;
    if (nav && flow && !geo.takeover) {
      const board = readBoardClusterRects(flow, clusterBounds(store.getState().nodeInternals.values()), rf.getViewport());
      folding = true;
      void nav.fold(dir, board, { reduced, onFrame: f => { flow.style.opacity = String(f.board); } });
    }
    const run = runTween(reduced ? 0 : dir === "open" ? FLIP_OPEN_MS : FLIP_CLOSE_MS, (_raw, eased) => {
      paint(morphFrame(plan, eased), folding ? null : flow);
    });
    motion.current = run;
    void run.finished.then(ran => {
      if (!ran || motion.current !== run) return;
      motion.current = null;
      done();
    });
  }, [stage, nameRef, waitingRef, shellRef, geometryRef, canvasRef, store, rf, paint]);

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
      style={{ "--stage-w": `${g.stageW}px` } as CSSProperties}
    >
      <div className="stage-ground" aria-hidden="true" />
      <div ref={inRef} className="stage-in">
        <TerminalStage
          show={show}
          geometry={g}
          cell={stage.cell}
          readToken={readToken}
          expanded={stage.expanded}
          firstRun={stage.firstRun}
          asksWaiting={p.waitingSessions.length > 0}
          asks={barAsks(p.asks.view, p.waitingSessions, p.now)}
          arrival={barArrival(p.asks.view, p.waitingSessions)}
          // Held until the stage can be seen: a focus asked of a pane that is
          // still hidden would be spent on nothing and not asked again.
          focusRequest={shell.phase === "waiting" ? null : shell.focusRequest}
          onNextAsk={p.asks.nextAsk}
          onAnswerArrival={p.asks.nextAsk}
          onClose={stage.close}
          onToggleExpand={stage.toggleExpand}
          onFirstRunDone={stage.firstRunDone}
          onNewSession={stage.openPopover}
          onCols={stage.onCols}
          onColsReset={stage.onColsReset}
          onRelease={stage.release}
          onCell={stage.onCell}
          onLaunched={stage.onLaunched}
          onAnnounce={stage.announce}
          onPhase={onPhase}
        />
      </div>
      <span ref={edgeRef} className="stage-edge" aria-hidden="true" />
      <span ref={riderRef} className="stage-rider" aria-hidden="true">{name}</span>
      {shell.popover && (
        <NewSessionPopover
          anchorId={shell.popover}
          projects={boardProjects(agents.values(), currentCwd)}
          onStart={stage.launch}
          onClose={stage.closePopover}
        />
      )}
    </div>
  );
}
