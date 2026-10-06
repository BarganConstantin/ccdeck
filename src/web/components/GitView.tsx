// The git view: the detail rail widening to the left into a panel over the
// right of the canvas — the selected agent's history on top, its changed files
// and the selected file's diff below — with the canvas framing that agent's
// session in the part the panel leaves.
//
// It opens from the card's branch chip, from `g` and from the glance's rows,
// slides in over 200ms from a pointer and appears at once from the keyboard,
// and steps back one layer per Esc. While it is open it owns its keys
// (git-view-keys.ts), the detail rail it covers is inert, and so is the canvas
// when it is a full sheet below 1100px. When it closes, focus goes back to
// what opened it, or to the selected card when that is gone.
//
// Two parts: GitView, which lives as long as the deck does and holds what has
// to outlast the panel — its phase, the sizes, the camera beside it, focus to
// give back — and GitViewBody, mounted only while the panel is, which draws it.
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useReactFlow, type Node } from "reactflow";

import { blockedSessions } from "../ambient-counts";
import { laneMap } from "../canvas-flow";
import { elapsed } from "../duration";
import { foldMarkers, gitViewFrame, markerRoom, markerTop, setGitViewFrame, stackMarkers, whollyCovered, type FitCard, type SessionCard } from "../git-view-fit";
import { paneForLostFocus, splitterMove, viewKeyIntent, type GitViewPane } from "../git-view-keys";
import { panelMounted, useGitViewPhase } from "../git-view-phase";
import {
  GIT_VIEW_DEFAULTS, edgeBounds, filesBounds, graphBounds, clampTo, isSheet, panelWidth, readGitViewPrefs,
  splitterTarget, writeGitViewPrefs, type GitViewPrefs, type SplitterKind,
} from "../git-view-sizes";
import { agentNameIn, cardName as cardNameIn, collisionTarget, commitAgentKeys, otherAgentName } from "../git-agent-name";
import { pressHow } from "../agent-goto";
import { flashCard } from "../card-flash";
import { elsewhereRows } from "../git-files-model";
import { gitFactsFor, gitFocus, gitViewOpens } from "../git-view-target";
import { UNREADABLE, madeByFocus, useFocusCounts, useGitData, useGitSelection } from "../use-git-view";
import { commitWho, focusCollisions, upstreamWords } from "../git-view-words";
import { setGitViewNewest } from "../git-view-request";
import { shortAgo } from "../relative-time";
import { shortModel } from "../model-label";
import type { GitFileRef, GraphFocus, SubagentElsewhere } from "../git-view-types";
import { UNCOMMITTED } from "../git-view-types";
import { useGitViewRequest, type GitViewHow, type GitViewRequest } from "../git-view-request";
import type { FlowBox } from "../focus-camera";
import type { GraphState } from "../reducer";
import { sessionHue } from "../session-hue";
import { isTypingTarget } from "../shortcuts";
import type { AgentNodeData, GitCollisionRef } from "../types";
import { TOOL_LANE_ALLOWANCE } from "../use-camera";
import { useMirroredRef } from "../use-mirrored-ref";
import GitHandoffs from "./GitHandoffs";
import { CollisionLine, CommitCard, GvIcon, ReadStateLine, useFittedName, type CommitCardFacts } from "./GitViewParts";
import GitDiff, { readDiffWrap, writeDiffWrap, type GitDiffHandle } from "./GitDiff";
import GitFiles, { type GitFilesHandle } from "./GitFiles";
import GitGraph from "./GitGraph";

export type { GitViewHow, GitViewRequest } from "../git-view-request";

// ── the window ───────────────────────────────────────────────────────────
/** The window's width, settled once per frame while it is being resized. */
function useWindowWidth(): number {
  const [w, setW] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setW(window.innerWidth)); };
    window.addEventListener("resize", on);
    return () => { window.removeEventListener("resize", on); cancelAnimationFrame(raf); };
  }, []);
  return w;
}

/** The canvas box: where the panel's top goes, and how much of the window the
 *  panel and the canvas share (the window less a left column). */
function canvasBox(canvas: HTMLElement | null): { top: number; left: number; right: number; width: number; height: number } | null {
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, width: r.width, height: r.height };
}

type CanvasBox = NonNullable<ReturnType<typeof canvasBox>>;
const sameBox = (a: CanvasBox | null, b: CanvasBox | null) =>
  a === b || (a != null && b != null && a.top === b.top && a.left === b.left && a.right === b.right && a.width === b.width && a.height === b.height);

/** Elements made inert while the view is open, and what to give back. */
function setInert(els: Iterable<Element>, on: boolean, held: Set<Element>) {
  for (const el of els) {
    const h = el as HTMLElement & { inert: boolean };
    if (on && !h.inert) { h.inert = true; held.add(el); }
    if (!on && held.has(el)) { h.inert = false; held.delete(el); }
  }
}

/** How many history rows the panel's first frame draws: a tall pane's worth. */
const FIRST_ROWS = 24;

/** What the panel's body lends the keys: moving between panes, and the newest diff. */
interface BodyActions { focusPane: (p: GitViewPane) => void; newest: () => void }
const NO_ACTIONS: BodyActions = { focusPane: () => {}, newest: () => {} };

/** What a waiting or failed agent left out of the frame is marked with. The
 *  last marker of a column too long for the canvas counts the agents it
 *  folds (`more`), and goes to the first of them. */
interface EdgeMarker { id: string; label: string; alarm: "waiting" | "failed"; since: number; top: number; more?: { waiting: number; failed: number } }

export interface GitViewProps {
  /** The primary selection, which the view is about. */
  agent: AgentNodeData | null;
  stateRef: MutableRefObject<GraphState>;
  now: number;
  /** Whether the detail rail is on screen: the panel slides out of it. */
  detailShown: boolean;
  canvasRef: MutableRefObject<HTMLElement | null>;
  nodesRef: MutableRefObject<Node[]>;
  measuredRef: MutableRefObject<Map<string, { width: number; height: number }>>;
  moveCamera: (want: { x: number; y: number; zoom: number }, duration: number) => number;
  /** What had focus when the view was asked to open. */
  openerRef: MutableRefObject<HTMLElement | null>;
  onClose: (how: GitViewHow) => void;
  /** Select another agent: the view follows the selection. */
  onSelectAgent: (id: string) => void;
  /** Show an agent's card on the canvas, keeping the view on what it shows. */
  onShowCard: (id: string) => void;
  /** Focus is back on what opened the view, after a close. */
  onFocusBack?: (el: HTMLElement) => void;
}

export default function GitView(props: GitViewProps) {
  const request = useGitViewRequest();
  const { agent, stateRef, now, detailShown, canvasRef, nodesRef, measuredRef, moveCamera, openerRef, onClose, onSelectAgent, onShowCard, onFocusBack } = props;
  const rf = useReactFlow();
  const root = agent ? stateRef.current.agents.get(agent.sessionId) ?? null : null;
  const opens = agent != null && gitViewOpens(gitFactsFor(agent, root));
  const want = request.open && agent != null && opens;
  const { phase, motion, panelRef, onTransitionEnd } = useGitViewPhase(want, request.how === "pointer");
  const mounted = panelMounted(phase);
  // The agent the panel shows while it slides out after the selection went.
  const shownRef = useRef<AgentNodeData | null>(null);
  if (agent && opens) shownRef.current = agent;
  const shown = shownRef.current;
  // A subagent of the session working in another folder, which the files
  // pane's "works in" line narrowed the view to; the scope chip widens back.
  // It belongs to the agent it was chosen from, and a new open starts over.
  const [narrowed, setNarrowed] = useState<{ from: string; row: SubagentElsewhere } | null>(null);
  useEffect(() => setNarrowed(null), [request.seq]);
  const away = narrowed && shown && narrowed.from === shown.id ? narrowed.row : null;
  const shownId = shown?.id ?? null;
  const setAway = useCallback((row: SubagentElsewhere | null) => setNarrowed(row && shownId ? { from: shownId, row } : null), [shownId]);
  const awayCard = away && shown ? stateRef.current.agents.get(`${shown.sessionId}::${away.agentId}`) ?? null : null;

  const win = useWindowWidth();
  const sheet = isSheet(win);
  const [prefs, setPrefs] = useState<GitViewPrefs>(readGitViewPrefs);
  const savePrefs = useCallback((next: GitViewPrefs) => { setPrefs(next); writeGitViewPrefs(next); }, []);
  // The canvas box is read in the frame after the panel's first paint (and
  // kept from the last open until then), so the press reads no layout.
  const [box, setBox] = useState(() => canvasBox(canvasRef.current));
  const room = box ? win - box.left : win;
  const width = sheet ? win : panelWidth(prefs.w, win, room);
  // How much of the canvas the panel covers: its width less the detail rail
  // beside the canvas. It slides out from that rail's edge.
  const cover = Math.max(0, width - (box ? win - box.right : detailShown ? 360 : 0));
  const travel = sheet ? 32 : cover;

  // ── the camera beside the view ────────────────────────────────────────
  const savedViewport = useRef<{ x: number; y: number; zoom: number } | null>(null);
  // Where a close is taking the camera back to, until it gets there: a reopen
  // on the way keeps that as the camera to give back, not the one mid-flight.
  const restoring = useRef<{ to: { x: number; y: number; zoom: number }; until: number } | null>(null);
  const inertCards = useState(() => new Set<Element>())[0];
  const [markers, setMarkers] = useState<EdgeMarker[]>([]);
  const live = useMirroredRef({ agent, width, sheet, box });
  const focusAfterFrame = useRef<string | null>(null);

  const frame = useCallback((duration: number) => {
    const { agent: a, width: w, sheet: sh } = live.current;
    const canvas = canvasRef.current;
    if (!a || sh || !canvas) { setMarkers([]); return; }
    const rect = canvas.getBoundingClientRect();
    const cover = Math.max(0, w - (window.innerWidth - rect.right));
    const lanes = laneMap(stateRef.current);
    const boxOf = (n: Node): FlowBox | null => {
      const m = measuredRef.current.get(n.id);
      return m ? { x: n.position.x, y: n.position.y, width: m.width, height: m.height } : null;
    };
    const nodes = nodesRef.current.filter(n => n.type === "agent" || n.type === "recapNote");
    const own = nodes.find(n => n.id === a.id);
    const anchor = own ? boxOf(own) : null;
    if (!anchor) { setMarkers([]); return; }
    const session: SessionCard[] = [];
    for (const n of nodes) {
      if ((n.data as { sessionId?: string } | undefined)?.sessionId !== a.sessionId) continue;
      const b = boxOf(n);
      if (b) session.push({ ...b, lane: n.type === "agent" && lanes.has(n.id) ? TOOL_LANE_ALLOWANCE : 0 });
    }
    // Waiting on the reader (a session's root carries the block) or failed.
    const agents = stateRef.current.agents;
    const alarmOf = new Map<string, "waiting" | "failed">();
    for (const s of blockedSessions(agents.values())) if (s.id !== a.sessionId) alarmOf.set(s.id, "waiting");
    for (const ag of agents.values()) if (ag.state === "err" && ag.sessionId !== a.sessionId && !alarmOf.has(ag.id)) alarmOf.set(ag.id, "failed");
    const alarms: FitCard[] = [];
    for (const n of nodes) {
      if (!alarmOf.has(n.id)) continue;
      const b = boxOf(n);
      if (b) alarms.push({ id: n.id, ...b });
    }
    // The category filter bar sits over the canvas's top left: the frame starts
    // under it, so no framed card or cluster name lands beneath it.
    const bar = canvas.querySelector(".cat-filter-bar")?.getBoundingClientRect();
    const top = bar && bar.height > 0 ? bar.bottom - rect.top : 0;
    const plan = gitViewFrame({ pane: { width: rect.width, height: rect.height }, cover, top, session, alarms, anchor });
    // The camera the plane is drawn with until this move lands.
    const was = rf.getViewport();
    moveCamera(plan.viewport, duration);
    // Cards wholly under the panel cannot be seen, so they cannot be Tab stops either.
    const coverLeft = window.innerWidth - w;
    const { x, zoom } = plan.viewport;
    const under = new Set<Element>(), clear = new Set<Element>();
    for (const n of nodes) {
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`);
      if (!el) continue;
      const m = measuredRef.current.get(n.id);
      const left = rect.left + x + n.position.x * zoom;
      (whollyCovered({ left, right: left + (m?.width ?? 0) * zoom }, coverLeft) ? under : clear).add(el);
    }
    // So do the session clusters' name tags, anchored on the same plane
    // (drawn at one size whatever the zoom): where each one's left edge lands
    // once the camera has moved.
    for (const el of canvas.querySelectorAll<HTMLElement>(".cluster-label")) {
      const r = el.getBoundingClientRect();
      const left = rect.left + x + ((r.left - rect.left - was.x) / was.zoom) * zoom;
      (whollyCovered({ left, right: left + r.width }, coverLeft) ? under : clear).add(el);
    }
    setInert(clear, false, inertCards);
    setInert(under, true, inertCards);
    const out = plan.leftOut.map((id): EdgeMarker => {
      const ag = agents.get(id);
      const alarm = alarmOf.get(id)!;
      const top = markerTop(alarms.find(c => c.id === id)!, plan.viewport, rect.height);
      return { id, label: ag ? cardNameIn(agents, ag) : id, alarm, since: alarm === "waiting" ? ag?.waiting?.since ?? 0 : 0, top };
    });
    // More than the edge has rows for: the last row counts the rest.
    const { kept, folded } = foldMarkers(out, markerRoom(rect.height));
    const column = folded.length ? [...kept, {
      ...folded[0], top: rect.height,
      more: { waiting: folded.filter(m => m.alarm === "waiting").length, failed: folded.filter(m => m.alarm === "failed").length },
    }] : kept;
    const stacked = stackMarkers(column.map(m => m.top), rect.height);
    setMarkers(column.map((m, i) => ({ ...m, top: stacked[i] })));
    // A marker the keyboard activated is gone once its agent is selected:
    // focus goes on to that agent's card, now framed and a Tab stop again.
    if (focusAfterFrame.current === a.id) {
      focusAfterFrame.current = null;
      document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(a.id)}"]`)?.focus({ preventScroll: true });
    }
  }, [moveCamera]);

  const reframeNow = useCallback(() => frame(0), [frame]);

  // ── what the panel covers ─────────────────────────────────────────────
  // While it is open the detail rail under it is inert and out of sight, and
  // so is everything beside the canvas when it is a full sheet. Marked on the
  // root (`data-git-view`) rather than found by a :has() over the app, which
  // made every open restyle the whole board.
  const heldInert = useState(() => new Set<Element>())[0];
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const settledRef = useRef(false);
  settledRef.current = phase === "open";
  const coverBehind = useCallback((on: boolean) => {
    const behind = on ? [...document.querySelectorAll(sheetRef.current
      ? ".app > :is(main, .detail, .session-list, .accounts-panel, .usage-panel, .sysdetail)"
      : ".app > .detail")] : [];
    setInert([...heldInert].filter(el => !behind.includes(el)), false, heldInert);
    setInert(behind, true, heldInert);
    const root = document.documentElement;
    if (on) root.setAttribute("data-git-view", sheetRef.current && settledRef.current ? "sheet" : "beside");
    else root.removeAttribute("data-git-view");
  }, []);
  // A settled sheet hides the canvas it covers; while it is still fading in,
  // the canvas shows through.
  useEffect(() => {
    const root = document.documentElement;
    if (want && sheet && phase === "open" && root.hasAttribute("data-git-view")) root.setAttribute("data-git-view", "sheet");
    else if (root.getAttribute("data-git-view") === "sheet") root.setAttribute("data-git-view", "beside");
  }, [want, sheet, phase === "open"]);

  // ── focus in, and focus back ───────────────────────────────────────────
  const [pane, setPane] = useState<GitViewPane>("graph");
  const bodyActions = useRef<BodyActions>(NO_ACTIONS);
  // A pointer open leaves focus where it was — unless that is nowhere: the
  // chip pressed was on a card the frame has since zoomed to a face with no
  // chip, or put under the panel. Asked after the frame and again when the
  // panel has settled, which is when the camera has too.
  const takeLostFocus = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel || (active && panel.contains(active))) return;
    if (!active || active === document.body || !active.isConnected || active.closest("[inert]")) bodyActions.current.focusPane("graph");
  }, []);
  useEffect(() => {
    // An instant open settles at once; its focus comes after the cover and
    // the camera, below.
    if (phase !== "open" || !want || motion === "instant") return;
    const raf = requestAnimationFrame(takeLostFocus);
    return () => cancelAnimationFrame(raf);
  }, [phase === "open"]);

  // Open, close, follow the selection, a new width: frame again. On open the
  // panel paints first; the cover, the camera and focus follow a frame apart,
  // each its own task, so the press itself stays light.
  const wasWanted = useRef(false);
  const focusInsideRef = useRef(false);
  focusInsideRef.current = request.focusInside;
  const fileHintRef = useRef(false);
  fileHintRef.current = request.file != null;
  useEffect(() => {
    const animate = request.how === "pointer";
    if (want) {
      const opening = !wasWanted.current;
      // The reader's camera, to give back on close — taken on a sheet too,
      // which leaves the camera alone until a wider window puts the view beside it.
      if (opening) {
        const back = restoring.current && performance.now() < restoring.current.until ? restoring.current.to : null;
        savedViewport.current = back ?? rf.getViewport();
        restoring.current = null;
      }
      wasWanted.current = true;
      setGitViewFrame(frame, cover);
      let raf2 = 0, raf3 = 0;
      // Two frames: the first paints the panel, the second does the rest.
      const raf = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => {
        const measured = canvasBox(canvasRef.current);
        setBox(prev => (sameBox(prev, measured) ? prev : measured));
        coverBehind(true);
        frame(animate ? 200 : 0);
        // A glance file row hands focus to that file, a commit row to its row.
        if (opening) raf3 = requestAnimationFrame(() => (focusInsideRef.current ? bodyActions.current.focusPane(fileHintRef.current ? "files" : "graph") : takeLostFocus()));
      }); });
      return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); cancelAnimationFrame(raf3); };
    }
    if (!wasWanted.current) return;
    wasWanted.current = false;
    setGitViewFrame(null);
    setMarkers([]);
    coverBehind(false);
    setInert([...inertCards], false, inertCards);
    if (savedViewport.current) {
      const duration = animate ? 150 : 0;
      moveCamera(savedViewport.current, duration);
      restoring.current = { to: savedViewport.current, until: performance.now() + duration + 50 };
    }
    savedViewport.current = null;
  }, [want, agent?.id, width, sheet, detailShown]);

  // The canvas changes size under the open view on its own — the session list
  // or another side column opening beside it: the box is measured again, which
  // keeps the canvas beside the panel at its least width, and the camera, the
  // inert cards and the edge markers follow.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!want || !canvas || typeof ResizeObserver === "undefined") return;
    let raf = 0, seen = false;
    const ro = new ResizeObserver(() => {
      // The first call only reports the size the view opened on.
      if (!seen) { seen = true; return; }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const measured = canvasBox(canvas);
        setBox(prev => (sameBox(prev, measured) ? prev : measured));
        frame(0);
      });
    });
    ro.observe(canvas);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [want]);
  useEffect(() => () => {
    setGitViewFrame(null);
    setInert([...inertCards], false, inertCards);
    document.documentElement.removeAttribute("data-git-view");
  }, []);

  // The selection moved to an agent whose folder git cannot read: the view
  // has nothing to show for it, so it steps back.
  useEffect(() => {
    if (request.open && agent && !opens) onClose("pointer");
  }, [request.open, agent?.id, opens]);

  // Back to what opened it, on a close the reader asked for — and only when
  // focus was in the view, so a close the selection caused never pulls focus
  // off the card just clicked. The cover comes off first: the opener may be
  // a row of the rail it was keeping inert.
  const lastSeq = useRef(request.seq);
  useLayoutEffect(() => {
    if (lastSeq.current === request.seq) return;
    lastSeq.current = request.seq;
    if (request.open) return;
    const panel = panelRef.current;
    const active = document.activeElement;
    const inView = !active || active === document.body || (panel != null && panel.contains(active));
    coverBehind(false);
    if (!inView) return;
    const opener = openerRef.current;
    openerRef.current = null;
    const cardId = shown?.id ?? "";
    // A frame later, once the uncovered rail has been restyled in its own
    // frame rather than inside the key's handler. The opener is taken only
    // while it can be seen: a card's chip on a face zoomed out too far to
    // draw it is hidden, and focus put there would land nowhere.
    const raf = requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(cardId)}"]`);
      const usable = opener && opener.isConnected && !opener.closest("[inert]") && !panelRef.current?.contains(opener)
        && (typeof opener.checkVisibility !== "function" || opener.checkVisibility({ visibilityProperty: true }));
      const target = usable ? opener : card;
      target?.focus({ preventScroll: true });
      if (target !== card && document.activeElement !== target) card?.focus({ preventScroll: true });
      if (target && document.activeElement === target) onFocusBack?.(target);
    });
    return () => cancelAnimationFrame(raf);
  }, [request.seq]);

  if (!mounted || !shown) return null;

  const style = {
    "--gv-w": `${width}px`,
    "--gv-travel": `${travel}px`,
    "--gv-top": `${box?.top ?? 52}px`,
    "--gv-graph-h": `${(prefs.graphH * 100).toFixed(1)}%`,
    "--gv-files-w": `${(prefs.filesW * 100).toFixed(1)}%`,
  } as CSSProperties;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    const paneEl = t.closest?.("[data-gv-pane]");
    const intent = viewKeyIntent(e, {
      pane: (paneEl?.getAttribute("data-gv-pane") as GitViewPane | null) ?? null,
      typing: isTypingTarget({ tagName: t.tagName, isContentEditable: t.isContentEditable, type: (t as HTMLInputElement).type }),
      handled: e.defaultPrevented,
      control: t.tagName === "BUTTON" || t.tagName === "A",
    });
    if (intent.kind === "pass") return;
    e.stopPropagation();
    if (intent.kind === "swallow") return;
    e.preventDefault();
    if (intent.kind === "close") onClose("key");
    else if (intent.kind === "focus") bodyActions.current.focusPane(intent.pane);
    else if (intent.kind === "newest") bodyActions.current.newest();
  };

  // Mounted on <body>, outside the app's grid: a new child of `.app` made
  // the sheet's :has() rules and sibling selectors restyle the whole board
  // (1,700 elements) on every open. It is position: fixed, so where it sits in
  // the DOM changes nothing on screen; Tab reaches it after the rest of the deck.
  return (
    <>
      {createPortal(<section
        ref={panelRef as MutableRefObject<HTMLElement | null>}
        className="gv-wide"
        aria-label="Git view"
        data-key-scope="git"
        data-pane={pane}
        data-phase={phase}
        data-motion={motion}
        data-sheet={sheet ? "" : undefined}
        style={style}
        onKeyDown={onKeyDown}
        onTransitionEnd={onTransitionEnd}
      >
        <GitViewBody
          agent={shown} root={root} agentKey={bodyKey(stateRef.current.agents, shown, root, awayCard)} rootKey={null} request={request} sheet={sheet} prefs={prefs} savePrefs={savePrefs}
          away={away} setAway={setAway} awayCard={awayCard}
          width={width} room={room} win={win} panelRef={panelRef as MutableRefObject<HTMLElement | null>}
          pane={pane} setPane={setPane} actions={bodyActions} onClose={onClose}
          onResized={reframeNow} stateRef={stateRef} onSelectAgent={onSelectAgent} onShowCard={onShowCard}
        />
      </section>, document.body)}
      {markers.length > 0 && canvasRef.current && createPortal(
        <EdgeMarkers markers={markers} right={cover + 12} now={now} onGo={id => { focusAfterFrame.current = id; onSelectAgent(id); }} />,
        canvasRef.current,
      )}
    </>
  );
}

function EdgeMarkers({ markers, right, now, onGo }: { markers: EdgeMarker[]; right: number; now: number; onGo: (id: string) => void }) {
  return (
    <>
      {markers.map(m => {
        if (m.more) {
          const { waiting, failed } = m.more;
          const said = !failed ? "waiting" : !waiting ? "failed" : `${waiting} waiting · ${failed} failed`;
          return (
            <button
              key="more" type="button" className="gv-edge-mark" data-alarm={waiting ? "waiting" : "failed"}
              style={{ top: m.top, right }}
              title={`${waiting + failed} more agents ${waiting ? "waiting for you" : "stopped on an error"} outside this view. Select ${m.label}.`}
              onClick={() => onGo(m.id)}
            >
              <span className="gv-edge-dot" aria-hidden="true" /><b>+{waiting + failed} more</b><span>{said}</span><GvIcon name="chev" />
            </button>
          );
        }
        const said = m.alarm === "waiting" ? `waiting ${elapsed(m.since, undefined, now)}` : "failed";
        return (
          <button
            key={m.id} type="button" className="gv-edge-mark" data-alarm={m.alarm}
            style={{ top: m.top, right }}
            title={`${m.label} is ${m.alarm === "waiting" ? "waiting for you" : "stopped on an error"}, outside this view. Select it.`}
            onClick={() => onGo(m.id)}
          >
            <span className="gv-edge-dot" aria-hidden="true" /><b>{m.label}</b><span>{said}</span><GvIcon name="chev" />
          </button>
        );
      })}
    </>
  );
}

// ── the panel ────────────────────────────────────────────────────────────

/** The fields of an agent the panel reads, joined: when none of them moved,
 *  the panel has nothing to redraw. Git facts and collisions are compared by
 *  identity — each GitObserved and GitCollisions replaces them. */
const serials = new WeakMap<object, number>();
let serialNext = 0;
const serialOf = (o: object | undefined | null): number => {
  if (!o) return 0;
  let n = serials.get(o);
  if (n === undefined) { n = ++serialNext; serials.set(o, n); }
  return n;
};
function bodyKey(agents: GraphState["agents"], agent: AgentNodeData, root: AgentNodeData | null, away: AgentNodeData | null): string {
  return [agent.id, cardNameIn(agents, agent), agent.kind, agent.cwd ?? "", root ? cardNameIn(agents, root) : "",
    serialOf(agent.git), serialOf(root?.git), serialOf(root?.gitCollisions),
    away ? cardNameIn(agents, away) : "", serialOf(away?.git)].join("\u0000");
}

interface BodyProps {
  agent: AgentNodeData;
  root: AgentNodeData | null;
  /** What of the agent and its root the panel draws, as one comparable key. */
  agentKey: string;
  rootKey: unknown;
  request: GitViewRequest;
  sheet: boolean;
  prefs: GitViewPrefs;
  savePrefs: (p: GitViewPrefs) => void;
  width: number;
  room: number;
  win: number;
  panelRef: MutableRefObject<HTMLElement | null>;
  pane: GitViewPane;
  setPane: (p: GitViewPane) => void;
  actions: MutableRefObject<BodyActions>;
  onClose: (how: GitViewHow) => void;
  onResized: () => void;
  stateRef: MutableRefObject<GraphState>;
  /** Select another agent: the view follows. */
  onSelectAgent: (id: string) => void;
  /** Show an agent's card on the canvas; the view stays where it is. */
  onShowCard: (id: string) => void;
  /** The subagent working in another folder the view is narrowed to, or null. */
  away: SubagentElsewhere | null;
  setAway: (away: SubagentElsewhere | null) => void;
  /** Its card, while it is on the board: its git facts and its name. */
  awayCard: AgentNodeData | null;
}

/** The panel redraws for what it shows, not for the deck's 250ms clock: the
 *  agent's card is one object mutated in place, so the fields the panel reads
 *  are compared, and its git facts by identity (each GitObserved replaces them). */
function bodyPropsEqual(a: BodyProps, b: BodyProps): boolean {
  for (const k of Object.keys(a) as Array<keyof BodyProps>) {
    if (k === "agent" || k === "root") continue;
    if (a[k] !== b[k]) return false;
  }
  return a.agent === b.agent && a.root === b.root && a.agentKey === b.agentKey && a.rootKey === b.rootKey;
}

const GitViewBody = memo(GitViewBodyRaw, bodyPropsEqual);

function GitViewBodyRaw({ agent, root, request, sheet, prefs, savePrefs, width, room, win, panelRef, pane, setPane, actions, onClose, onResized, stateRef, onSelectAgent, onShowCard, away, setAway, awayCard }: BodyProps) {
  const [widened, setWidened] = useState(false);
  useEffect(() => setWidened(false), [agent.id]);
  // Narrowed from the files pane to a subagent in another folder, the view is
  // that subagent's alone, read in its own folder.
  const focus: GraphFocus = away ? { sessionId: agent.sessionId, agentIds: [away.agentId] } : gitFocus(agent, widened);
  const narrow = focus.agentIds != null;
  const agentParam = away ? away.agentId : narrow ? focus.agentIds![0] : null;
  // From a subagent widened to its session, the session's repository is read.
  const facts = away ? awayCard?.git : narrow ? gitFactsFor(agent, root) : root?.git ?? gitFactsFor(agent, root);
  const data = useGitData({
    sessionId: agent.sessionId, agent: agentParam, stale: facts?.stale ?? 0, enabled: true, fresh: true,
    ownFolder: away != null || (narrow && agent.git != null),
  });
  const view = useGitSelection({
    data, sessionId: agent.sessionId, agent: agentParam, focus, active: request.open,
    // The row and file a request named are in the session's folder, not in
    // the one a subagent was narrowed to.
    initial: away ? {} : { sel: request.sel, file: request.file }, seq: request.seq,
  });
  const { sel, file } = view;
  // The view followed the selection to a folder git cannot read before the
  // server had said so on the card: its own read says it, and the view steps
  // back to the glance's one line, which answers as it does for `g` there.
  useEffect(() => {
    if (!request.open || away || !UNREADABLE.has(data.state)) return;
    onClose("pointer");
    window.dispatchEvent(new CustomEvent("gitview:unreadable", { detail: agent.id }));
  }, [data.state, request.open, agent.id, away]);
  // The panel's first frame draws the history's first rows — what fits in its
  // pane — and the rest a frame later, so a press shows the view at once
  // rather than after a hundred rows have rendered.
  const [allRows, setAllRows] = useState(false);
  useEffect(() => {
    setAllRows(false);
    let raf2 = 0;
    const raf = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setAllRows(true)); });
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); };
  }, [request.seq, agent.id]);
  // The history is laid out on every commit from the first frame (one graph
  // width, its fold and its lanes final at once); only the rows drawn wait.
  const rowLimit = useMemo(() => {
    const all = data.commits;
    if (!all || allRows) return undefined;
    // A row asked for further down is drawn with everything from the start.
    return sel === UNCOMMITTED || all.slice(0, FIRST_ROWS).some(c => c.sha === sel) ? FIRST_ROWS : undefined;
  }, [data.commits, allRows, sel]);
  const counts = useFocusCounts(data, focus);
  // The commits the last history read brought, one object per read: the
  // history counts an arrival once and glows it once.
  const liveInsert = useMemo(() => (data.newShas.length ? { newShas: data.newShas } : null), [data.newShas]);
  const [wrap, setWrap] = useState(readDiffWrap);
  const filesHandle = useRef<GitFilesHandle>(null);
  const diffHandle = useRef<GitDiffHandle>(null);

  const panesRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLElement>(null);
  // The two boxes the inner dividers resize against, kept for their
  // aria-value* (a divider says where it stands as a share of its box).
  const [boxes, setBoxes] = useState({ panes: 0, bottom: 0 });
  useEffect(() => {
    const panes = panesRef.current, bottom = bottomRef.current;
    if (!panes || !bottom || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBoxes(prev => {
      const next = { panes: panes.clientHeight, bottom: bottom.clientWidth };
      return prev.panes === next.panes && prev.bottom === next.bottom ? prev : next;
    }));
    ro.observe(panes);
    ro.observe(bottom);
    return () => ro.disconnect();
  }, []);

  // A pane asked for focus before its rows were drawn — a keyboard open with
  // nothing read yet — holds focus itself, inside the view that owns the keys,
  // and hands it to its row once the row is there.
  const pendingPane = useRef<GitViewPane | null>(null);
  // The history's selected row not drawn yet — a detached HEAD's Uncommitted
  // row waits on the status read — so its one tab stop holds focus for it.
  const standIn = useRef<HTMLElement | null>(null);
  const focusPane = useCallback((p: GitViewPane) => {
    const section = panelRef.current?.querySelector<HTMLElement>(`[data-gv-pane="${p}"]`);
    if (!section) return;
    setPane(p);
    // The files and the diff take the keyboard through their own handles;
    // the history goes to its selected row, else its one tab stop.
    const handle = p === "files" ? filesHandle.current : p === "diff" ? diffHandle.current : null;
    if (handle) handle.focus();
    else {
      const chosen = section.querySelector<HTMLElement>('[aria-selected="true"][tabindex]');
      const row = chosen ?? section.querySelector<HTMLElement>('[tabindex="0"], [role="region"][tabindex]');
      row?.focus({ preventScroll: true });
      row?.scrollIntoView?.({ block: "nearest" });
      standIn.current = chosen ? null : row ?? null;
    }
    const active = document.activeElement;
    if (active !== section && section.contains(active)) { pendingPane.current = null; return; }
    section.focus({ preventScroll: true });
    pendingPane.current = p;
  }, []);
  useEffect(() => {
    // Only while the stand-in still has focus: the reader may have moved on.
    const s = standIn.current;
    if (s) {
      if (document.activeElement !== s) standIn.current = null;
      else {
        const chosen = panelRef.current?.querySelector<HTMLElement>('[data-gv-pane="graph"] [aria-selected="true"][tabindex]');
        if (chosen && chosen !== s) { standIn.current = null; chosen.focus({ preventScroll: true }); chosen.scrollIntoView?.({ block: "nearest" }); }
      }
    }
    const p = pendingPane.current;
    if (!p) return;
    // Only while the pane still holds it: the reader may have moved on.
    if (document.activeElement === panelRef.current?.querySelector(`[data-gv-pane="${p}"]`)) focusPane(p);
    else pendingPane.current = null;
  });
  // What last held focus in the view can leave the page with its data — a
  // file committed or put back, a commit amended away, the Uncommitted row of
  // a detached HEAD gone clean — and focus would fall to the page, where every
  // deck key acts again. Its pane takes focus back in the same frame.
  const lostFrom = useRef<{ el: HTMLElement; pane: GitViewPane | null } | null>(null);
  useLayoutEffect(() => {
    const was = lostFrom.current;
    if (!request.open || !was) return;
    const active = document.activeElement;
    const p = paneForLostFocus({ connected: was.el.isConnected, pane: was.pane }, !active || active === document.body);
    if (p) { lostFrom.current = null; focusPane(p); }
  });
  actions.current = { focusPane, newest: view.showLatest };
  // `n` from the deck, with focus outside the view, reaches the same action.
  useEffect(() => { setGitViewNewest(view.showLatest); return () => setGitViewNewest(null); }, [view.showLatest]);

  // ── narrowing to a subagent in another folder ─────────────────────────
  // The files pane's "works in" line narrows the view; focus never falls to
  // the page while that folder is read: it waits on the scope chip's way back,
  // and goes to the narrowed files once they are drawn — unless the reader
  // has moved it meanwhile.
  const wantFiles = useRef(false);
  const narrowTo = useCallback((agentId: string) => {
    const row = data.subagents?.find(s => s.agentId === agentId && s.state === "repo");
    if (!row) return;
    wantFiles.current = true;
    setAway(row);
  }, [data.subagents]);
  useLayoutEffect(() => {
    if (!away) return;
    headRef.current?.querySelector<HTMLElement>(".gv-scope-x")?.focus({ preventScroll: true });
  }, [away?.agentId]);
  useEffect(() => {
    if (!wantFiles.current || !filesHandle.current) return;
    wantFiles.current = false;
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || active.classList.contains("gv-scope-x")) focusPane("files");
  });

  // ── dividers ──────────────────────────────────────────────────────────
  const boundsFor = (kind: SplitterKind) => {
    if (kind === "edge") return edgeBounds(win, room);
    if (kind === "graph") return graphBounds(panesRef.current?.clientHeight ?? boxes.panes);
    return filesBounds(bottomRef.current?.clientWidth ?? boxes.bottom);
  };
  const sizeOf = (kind: SplitterKind) =>
    kind === "edge" ? width
      : kind === "graph" ? graphRef.current?.getBoundingClientRect().height ?? 0
      : filesRef.current?.getBoundingClientRect().width ?? 0;
  const commit = (kind: SplitterKind, px: number) => {
    if (kind === "edge") savePrefs({ ...prefs, w: px / win });
    else if (kind === "graph") savePrefs({ ...prefs, graphH: px / Math.max(1, panesRef.current?.clientHeight ?? 1) });
    else savePrefs({ ...prefs, filesW: px / Math.max(1, bottomRef.current?.clientWidth ?? 1) });
    if (kind === "edge") requestAnimationFrame(onResized);
  };
  const resetTo = (kind: SplitterKind) =>
    kind === "edge" ? win * GIT_VIEW_DEFAULTS.w
      : kind === "graph" ? (panesRef.current?.clientHeight ?? 0) * GIT_VIEW_DEFAULTS.graphH
      : (bottomRef.current?.clientWidth ?? 0) * GIT_VIEW_DEFAULTS.filesW;
  const onSplitterKey = (kind: SplitterKind, orientation: "vertical" | "horizontal") => (e: KeyboardEvent<HTMLDivElement>) => {
    const move = splitterMove(e.key, orientation);
    if (!move) return;
    e.preventDefault();
    commit(kind, splitterTarget(kind, move, sizeOf(kind), boundsFor(kind), resetTo(kind)));
  };
  const onSplitterDouble = (kind: SplitterKind) => () => commit(kind, clampTo(resetTo(kind), boundsFor(kind)));
  // A drag writes the size straight onto the panel once a frame and commits
  // it — and re-fits the canvas — once, when the pointer comes up.
  const onSplitterDown = (kind: SplitterKind) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const panel = panelRef.current;
    if (!panel) return;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
    const bounds = boundsFor(kind);
    const start = { x: e.clientX, y: e.clientY, size: sizeOf(kind) };
    const total = kind === "graph" ? panesRef.current?.clientHeight ?? 1 : bottomRef.current?.clientWidth ?? 1;
    let raf = 0, px = start.size, last: PointerEvent | null = null;
    handle.classList.add("is-dragging");
    const apply = () => {
      raf = 0;
      if (!last) return;
      const d = kind === "graph" ? last.clientY - start.y : last.clientX - start.x;
      px = clampTo(start.size + (kind === "edge" ? -d : d), bounds);
      if (kind === "edge") panel.style.setProperty("--gv-w", `${Math.round(px)}px`);
      else panel.style.setProperty(kind === "graph" ? "--gv-graph-h" : "--gv-files-w", `${((px / Math.max(1, total)) * 100).toFixed(2)}%`);
    };
    const move = (ev: PointerEvent) => { last = ev; if (!raf) raf = requestAnimationFrame(apply); };
    const up = () => {
      if (raf) { cancelAnimationFrame(raf); apply(); }
      handle.classList.remove("is-dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      commit(kind, px);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const splitter = (kind: SplitterKind, orientation: "vertical" | "horizontal", label: string, controls: string, className: string): ReactNode => {
    const b = kind === "edge" ? edgeBounds(win, room) : kind === "graph" ? graphBounds(boxes.panes) : filesBounds(boxes.bottom);
    const total = kind === "edge" ? win : kind === "graph" ? boxes.panes : boxes.bottom;
    const pct = (px: number) => (total ? Math.round((px / total) * 100) : 0);
    const now = kind === "edge" ? width : kind === "graph" ? prefs.graphH * (total ?? 0) : prefs.filesW * (total ?? 0);
    return (
      <div
        className={className} role="separator" tabIndex={0} aria-orientation={orientation} aria-label={label}
        aria-controls={controls} aria-valuemin={pct(b.min)} aria-valuemax={pct(b.max)} aria-valuenow={pct(now)}
        onKeyDown={onSplitterKey(kind, orientation)} onDoubleClick={onSplitterDouble(kind)} onPointerDown={onSplitterDown(kind)}
      />
    );
  };

  // ── header ────────────────────────────────────────────────────────────
  const repo = data.repo;
  const head = repo?.head;
  const detached = head ? head.detached : facts?.detached === true;
  const shortSha = head?.short ?? facts?.sha ?? "";
  const branch = head ? head.branch : facts?.branch ?? null;
  const branchName = detached ? `detached at ${shortSha}` : branch ?? "";
  const unborn = head ? head.unborn : facts?.unborn === true;
  const upstream = upstreamWords(repo);
  const nWord = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const scopeCounts = data.state === "repo" && data.commits && data.entries
    ? `${counts.commits ? nWord(counts.commits, "commit") : "no commits"} · ${nWord(counts.files, "file")}` : null;
  const nameRef = useFittedName(branchName, headRef, `${upstream?.text}|${scopeCounts}|${unborn}`, detached ? shortSha : null);
  const folder = away ? away.folder : agent.cwd ?? null;
  const repoName = repo?.name ?? facts?.name ?? (away ? away.folderName : agent.cwdBasename) ?? "";
  const linked = repo ? repo.linkedWorktree && repo.mainName !== repo.name : facts?.linkedWorktree && facts.mainName && facts.mainName !== facts.name;
  const repoTitle = linked ? `worktree ${repoName} of ${repo?.mainName ?? facts?.mainName}` : repo?.topLevel ?? facts?.topLevel ?? repoName;
  const team = root ?? agent;
  const hue = sessionHue(agent.sessionId);
  // Every agent the view names goes by the name its card does
  // (git-agent-name.ts); the server's label answers for a card that is gone.
  // The namer reads the live cards; it is a new one whenever a name the
  // history's chips carry changes, so a session renamed while the view is
  // open is renamed in its history too.
  const chipNames = commitAgentKeys(data.commits).map(([s, a]) => agentNameIn(stateRef.current.agents, s, a) ?? "").join("\u0001");
  const nameOf = useCallback((sessionId: string, agentId: string | null) => agentNameIn(stateRef.current.agents, sessionId, agentId), [chipNames]);
  const cardName = useCallback((agentId: string | null) => nameOf(agent.sessionId, agentId), [agent.sessionId]);
  const teamName = cardNameIn(stateRef.current.agents, team);
  const focusName = away ? nameOf(agent.sessionId, away.agentId) ?? away.label ?? "subagent" : narrow ? cardNameIn(stateRef.current.agents, agent) : teamName;
  // The team's own first; a subagent's own collision is named as its, never
  // claimed for the main thread (git-view-words.ts).
  const collisions = focusCollisions(root?.gitCollisions, focus,
    key => stateRef.current.agents.get(`${agent.sessionId}::${key}`)?.git != null);
  const collision = collisions[0] ?? null;
  // The other agent of a collision, as the card's own mark names it, and the
  // session's own agents it is about.
  const otherOf = (c: { with: GitCollisionRef }) => otherAgentName(nameOf, c.with);
  const whoOf = (c: { who: string[] }) => c.who.map(k => otherAgentName(nameOf, { sessionId: agent.sessionId, agentId: k }));
  const cliOf = (c: { with: { sessionId: string } }) => {
    const m = stateRef.current.agents.get(c.with.sessionId)?.model ?? "";
    return /^(gpt|o\d|codex)/i.test(m) ? "Codex" : m ? "Claude Code" : null;
  };

  // ── panes ─────────────────────────────────────────────────────────────
  const reading = data.state !== "repo";
  // A subagent's collision in a folder of its own names files of that folder, not of this one.
  const fileCollisions = collisions.filter(c => c.level === "sharp" && !c.away).flatMap(c => c.files.map(path => ({ path, with: otherOf(c) })));
  const diffCollision = sel === UNCOMMITTED && file ? fileCollisions.find(c => c.path === file.path) ?? null : null;
  const selectedCommit = sel === UNCOMMITTED ? null : data.commits?.find(c => c.sha === sel) ?? null;
  const commitBy = selectedCommit ? commitWho(selectedCommit.agent, nameOf) : null;
  // The session's subagents in other folders, named under its own files.
  const elsewhere = !narrow && sel === UNCOMMITTED ? elsewhereRows(data.subagents ?? [], cardName) : [];
  const lastOwn = (data.commits ?? []).find(c => madeByFocus(c, focus));

  // ── the commit card ───────────────────────────────────────────────────
  const [card, setCard] = useState<{ sha: string; anchor: DOMRect | null } | null>(null);
  useEffect(() => setCard(null), [agent.id, request.seq]);
  const cardFacts = (sha: string): CommitCardFacts | null => {
    const c = data.commits?.find(x => x.sha === sha);
    if (!c) return null;
    const a = c.agent;
    const seenBy = a && "sessionId" in a ? a : null;
    const cardId = seenBy ? (seenBy.agentId ? `${seenBy.sessionId}::${seenBy.agentId}` : seenBy.sessionId) : null;
    const known = cardId != null && stateRef.current.agents.has(cardId);
    return {
      commit: c, who: commitWho(a, nameOf), sub: seenBy?.agentId != null, hue: seenBy ? sessionHue(seenBy.sessionId) : null,
      model: seenBy?.model ? `${seenBy.kind === "codex" ? "Codex" : "Claude Code"} · ${shortModel(seenBy.model)}` : null,
      worked: seenBy?.durationMs != null ? elapsed(0, seenBy.durationMs, seenBy.durationMs) : null,
      cardId: known ? cardId : null,
    };
  };
  const openCard = useCallback((sha: string) => {
    const row = panelRef.current?.querySelector<HTMLElement>(`[data-gv-pane="graph"] [role="option"][data-id="${CSS.escape(sha)}"]`);
    setCard({ sha, anchor: row?.getBoundingClientRect() ?? null });
  }, []);
  const cardNow = useMirroredRef(card);
  const closeCard = useCallback((refocus: boolean) => {
    const was = cardNow.current;
    setCard(null);
    if (was && refocus) panelRef.current?.querySelector<HTMLElement>(`[data-gv-pane="graph"] [role="option"][data-id="${CSS.escape(was.sha)}"]`)?.focus({ preventScroll: true });
  }, []);
  const shownCard = card ? cardFacts(card.sha) : null;

  return (
    <>
      {!sheet && splitter("edge", "vertical", "Resize the git view", "gv-panel", "gv-edge")}
      <div className="gv-inner" id="gv-panel" onFocus={e => {
        const p = (e.target as HTMLElement).closest?.("[data-gv-pane]")?.getAttribute("data-gv-pane") as GitViewPane | null;
        lostFrom.current = { el: e.target as HTMLElement, pane: p };
        if (p && p !== pane) setPane(p);
      }}>
        <header className="gv-head" ref={headRef}>
          <button type="button" className="btn gv-back" aria-label="Back to the canvas" onClick={e => onClose(pressHow(e))}>
            <GvIcon name="back" /><span>Canvas</span>
          </button>
          <div className="gv-crumbs">
            <span className="gv-repo" title={repoTitle}>{repoName}</span>
            {branchName && <span className="gv-crumb-sep" aria-hidden="true">/</span>}
            {branchName && (
              <span className={`gv-crumb-branch${detached ? " is-detached" : ""}`} title={branchName}>
                <GvIcon name={detached ? "commit" : "branch"} />
                <span className="gv-crumb-branch-name" ref={nameRef} data-name={branchName}>{branchName}</span>
              </span>
            )}
            {unborn ? <span className="gv-fetch gv-fetch-word">no commits yet</span>
              : upstream && <span className={`gv-fetch${upstream.word ? " gv-fetch-word" : ""}`} title={upstream.title}>{upstream.text}</span>}
          </div>
          <span
            className={`gv-scope${narrow ? " is-narrow" : ""}`}
            style={{ "--session-hue": hue } as CSSProperties}
            title={narrow ? `Narrowed to ${focusName}${away ? `, working in ${away.folder}` : ""}` : `${focusName}${team.kind === "root" ? " and its subagents" : ""}`}
          >
            <i className="gv-swatch" aria-hidden="true" />
            <span className="gv-scope-who">{narrow ? `↳ ${focusName}` : focusName}</span>
            {scopeCounts && <span className="gv-scope-n">{scopeCounts}</span>}
            {narrow && (
              <button type="button" className="gv-scope-x" aria-label={`Show the whole session, ${root ? cardNameIn(stateRef.current.agents, root) : "its main agent"} and its subagents`}
                title="Show the whole session" onClick={() => {
                  wantFiles.current = false;
                  if (away) setAway(null); else setWidened(true);
                  requestAnimationFrame(() => focusPane("graph"));
                }}>
                <GvIcon name="close" />
              </button>
            )}
          </span>
          <div className="gv-head-end">
            <GitHandoffs
              sessionId={agent.sessionId} agentId={agentParam}
              branch={detached ? null : branch} sha={selectedCommit?.sha ?? (detached ? head?.sha ?? null : null)}
              path={folder} compact
            />
            <span className="gv-head-rule" aria-hidden="true" />
            <button type="button" className="glyph-btn gv-close" title="Close the git view (Esc)" aria-label="Close the git view" onClick={e => onClose(pressHow(e))}>
              <GvIcon name="close" />
            </button>
          </div>
        </header>
        {collision && (
          <CollisionLine c={collision} who={whoOf(collision)} other={otherOf(collision)} otherCli={cliOf(collision)} where="wide"
            onFocus={how => {
              // The view follows the selection to the other agent; a pointer also lights its card once.
              const id = collisionTarget(stateRef.current.agents, collision.with);
              onSelectAgent(id);
              if (how === "pointer") requestAnimationFrame(() => flashCard(id));
            }} />
        )}
        {detached && !reading && (
          <p className="gv-detached-note">
            <GvIcon name="commit" />
            <span>HEAD is detached at <b>{shortSha}</b>, not on a branch.{data.entries && !data.entries.length ? " The folder has no changes." : ""}</span>
          </p>
        )}
        <div className="gv-panes" ref={panesRef}>
          <section className="gv-graph" id="gv-graph" aria-label="History" data-gv-pane="graph" tabIndex={-1} ref={graphRef}>
            {reading || !data.commits ? (
              <>
                <div className="gv-pane-head"><span className="gv-pane-title">History</span></div>
                {reading && <ReadStateLine state={data.state} folder={folder} />}
              </>
            ) : (
              <GitGraph
                repoKey={repo?.commonDir ?? repo?.topLevel ?? agent.sessionId} commits={data.commits} rowLimit={rowLimit} head={head ?? null} defaultBranch={repo?.defaultBranch ?? null}
                uncommitted={{ files: counts.changed, byFocus: counts.files, label: focusName }} focus={focus} selected={sel}
                onSelect={view.setSel} onOpen={() => focusPane("files")}
                onAgentCard={openCard} liveInsert={liveInsert}
                agentName={nameOf}
              />
            )}
          </section>
          {splitter("graph", "horizontal", "Resize the history and the files", "gv-graph", "gv-split-h")}
          <div className="gv-bottom" ref={bottomRef}>
            <section className="gv-files" id="gv-files" aria-label="Files" data-gv-pane="files" tabIndex={-1} ref={filesRef}>
              {reading || !data.entries ? (
                <div className="gv-pane-head"><span className="gv-pane-title">{sel === UNCOMMITTED ? "Uncommitted" : sel.slice(0, 7)}</span></div>
              ) : (
                <GitFiles
                  ref={filesHandle}
                  entries={sel === UNCOMMITTED ? data.entries : Array.isArray(view.commitFiles) ? view.commitFiles : []}
                  mode={sel === UNCOMMITTED ? "uncommitted" : "commit"} edits={data.edits ?? []} focus={focus}
                  selected={file} onSelect={view.pickFile} onOpen={() => focusPane("diff")} collisions={fileCollisions}
                  name={focusName} sha={sel === UNCOMMITTED ? null : sel} commitBy={commitBy ?? undefined}
                  cleanNote={lastOwn ? `Last commit ${shortAgo(Date.now() - Date.parse(lastOwn.date))} by ${commitWho(lastOwn.agent, nameOf) ?? focusName}.` : undefined}
                  cardName={cardName} elsewhere={elsewhere} onElsewhere={narrowTo}
                  reading={sel === UNCOMMITTED ? null : view.commitFiles == null ? "loading" : Array.isArray(view.commitFiles) ? null : view.commitFiles}
                  onRetry={view.retryCommit}
                />
              )}
            </section>
            {splitter("files", "vertical", "Resize the files and the diff", "gv-files", "gv-split-v")}
            <section className="gv-diffpane" aria-label="Diff" data-gv-pane="diff" tabIndex={-1}>
              {reading || !data.entries ? null : (
                <GitDiff
                  ref={diffHandle}
                  file={view.diff.file ?? file} diff={view.diff.loading ? null : view.diff.diff} loading={view.diff.loading}
                  stale={view.diff.stale} onShowLatest={view.showLatest}
                  wrap={wrap} onToggleWrap={() => { writeDiffWrap(!wrap); setWrap(!wrap); }}
                  collision={diffCollision ? { with: diffCollision.with } : null}
                  emptyReason={sel === UNCOMMITTED && !data.entries.length ? "clean" : "unselected"}
                  error={view.diff.error} gone={view.diff.gone} onRetry={view.showLatest}
                  diffKey={view.diff.file && view.diff.sel ? `${view.diff.sel}:${view.diff.file.area}:${view.diff.file.path}` : undefined}
                  onReload={view.showLatest} editorFor={{ sessionId: agent.sessionId, agentId: agentParam }}
                />
              )}
            </section>
          </div>
        </div>
      </div>
      {shownCard && (
        <CommitCard facts={shownCard} anchor={card!.anchor} onClose={closeCard}
          onShow={(id, how) => {
            closeCard(false);
            if (sheet) onClose(how);
            onShowCard(id);
            // As a collision mark does: lit once from a pointer; from a key the ring on the card answers.
            if (how === "pointer") requestAnimationFrame(() => flashCard(id));
          }} />
      )}
    </>
  );
}
