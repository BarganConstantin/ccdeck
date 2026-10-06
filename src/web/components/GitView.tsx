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
  memo, useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useReactFlow, type Node } from "reactflow";

import { blockedSessions } from "../ambient-counts";
import { laneMap } from "../canvas-flow";
import { elapsed } from "../duration";
import { fitBranch } from "../git-chip";
import { gitViewFrame, markerTop, setGitViewFrame, stackMarkers, whollyCovered, type FitCard, type SessionCard } from "../git-view-fit";
import { splitterMove, viewKeyIntent, type GitViewPane } from "../git-view-keys";
import { panelMounted, useGitViewPhase } from "../git-view-phase";
import {
  GIT_VIEW_DEFAULTS, edgeBounds, filesBounds, graphBounds, clampTo, isSheet, panelWidth, readGitViewPrefs,
  splitterTarget, writeGitViewPrefs, type GitViewPrefs, type SplitterKind,
} from "../git-view-sizes";
import { gitFactsFor, gitFocus, gitViewOpens, subagentKey } from "../git-view-target";
import type { GitFileRef } from "../git-view-types";
import { UNCOMMITTED } from "../git-view-types";
import { useGitViewRequest, type GitViewHow, type GitViewRequest } from "../git-view-request";
import type { FlowBox } from "../focus-camera";
import type { GraphState } from "../reducer";
import { sessionHue } from "../session-hue";
import { isTypingTarget } from "../shortcuts";
import type { AgentNodeData } from "../types";
import { TOOL_LANE_ALLOWANCE } from "../use-camera";
import { useMirroredRef } from "../use-mirrored-ref";
import GitHandoffs from "./GitHandoffs";
import GitDiff from "./GitDiff";
import GitFiles from "./GitFiles";
import GitGraph from "./GitGraph";

export type { GitViewHow, GitViewRequest } from "../git-view-request";

// ── icons ────────────────────────────────────────────────────────────────
// The view's own glyphs, drawn to the deck's 14px grid at a 1.4 stroke.
const PATHS = {
  branch: <><circle cx="4.4" cy="3.3" r="1.4" /><circle cx="4.4" cy="10.7" r="1.4" /><circle cx="9.8" cy="4.6" r="1.4" /><path d="M4.4 4.7v4.6M9.8 6c0 2.4-2.2 2.8-5.2 3.5" /></>,
  commit: <><circle cx="7" cy="7" r="2.3" /><path d="M1.6 7h3.1M9.3 7h3.1" /></>,
  back: <path d="M8.6 3 4.6 7l4 4" />,
  close: <path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" />,
  chev: <path d="M5.2 3.4 8.8 7l-3.6 3.6" />,
  share: <path d="M2.4 5h8.8l-2.1-2.1M11.6 9H2.8l2.1 2.1" />,
  // two arrows meeting at a bar: "both here", never read as a close ×
  clash: <path d="M7 2.6v8.8M1.4 7h3.4M3.4 5 5.2 7 3.4 9M12.6 7H9.2M10.6 5 8.8 7l1.8 2" />,
  copy: <><rect x="4.8" y="4.8" width="6.8" height="6.8" rx="1.3" /><path d="M9.2 4.8V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v4.7a1 1 0 0 0 1 1h1.3" /></>,
} as const;
export type GvIconName = keyof typeof PATHS;
export function GvIcon({ name, size = 13 }: { name: GvIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={name === "clash" ? 1.5 : 1.4}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>
  );
}

/** The three marks a commit can carry: seen by ccdeck, from the commit's
 *  message, no agent seen — a shape each, so colour never carries it alone. */
export function GvMark({ level }: { level: "seen" | "trailer" | "round" }) {
  return (
    <svg className="gv-mark" data-level={level} viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      {level === "round" ? <circle cx="5" cy="5" r="3.2" /> : <path d="M5 0.9 9.1 5 5 9.1 0.9 5z" />}
    </svg>
  );
}

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

/** Elements made inert while the view is open, and what to give back. */
function setInert(els: Iterable<Element>, on: boolean, held: Set<Element>) {
  for (const el of els) {
    const h = el as HTMLElement & { inert: boolean };
    if (on && !h.inert) { h.inert = true; held.add(el); }
    if (!on && held.has(el)) { h.inert = false; held.delete(el); }
  }
}

/** What the panel's body lends the keys: moving between panes, and the newest diff. */
interface BodyActions { focusPane: (p: GitViewPane) => void; newest: () => void }
const NO_ACTIONS: BodyActions = { focusPane: () => {}, newest: () => {} };

/** What a waiting or failed agent left out of the frame is marked with. */
interface EdgeMarker { id: string; label: string; alarm: "waiting" | "failed"; since: number; top: number }

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
}

export default function GitView(props: GitViewProps) {
  const request = useGitViewRequest();
  const { agent, stateRef, now, detailShown, canvasRef, nodesRef, measuredRef, moveCamera, openerRef, onClose, onSelectAgent } = props;
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
  const inertCards = useState(() => new Set<Element>())[0];
  const [markers, setMarkers] = useState<EdgeMarker[]>([]);
  const live = useMirroredRef({ agent, width, sheet, box });

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
    const plan = gitViewFrame({ pane: { width: rect.width, height: rect.height }, cover, session, alarms, anchor });
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
    setInert(clear, false, inertCards);
    setInert(under, true, inertCards);
    const tops = plan.leftOut.map(id => markerTop(alarms.find(c => c.id === id)!, plan.viewport, rect.height));
    const stacked = stackMarkers(tops, rect.height);
    setMarkers(plan.leftOut.map((id, i) => {
      const ag = agents.get(id);
      const alarm = alarmOf.get(id)!;
      return { id, label: ag?.label ?? id, alarm, since: alarm === "waiting" ? ag?.waiting?.since ?? 0 : 0, top: stacked[i] };
    }));
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
  useEffect(() => {
    const animate = request.how === "pointer";
    if (want) {
      const opening = !wasWanted.current;
      if (opening && !sheet) savedViewport.current = rf.getViewport();
      wasWanted.current = true;
      setGitViewFrame(frame, cover);
      let raf2 = 0, raf3 = 0;
      // Two frames: the first paints the panel, the second does the rest.
      const raf = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => {
        const measured = canvasBox(canvasRef.current);
        setBox(prev => (prev && measured && Object.keys(measured).every(k => prev[k as keyof typeof prev] === measured[k as keyof typeof measured]) ? prev : measured));
        coverBehind(true);
        frame(animate ? 200 : 0);
        if (opening) raf3 = requestAnimationFrame(() => (focusInsideRef.current ? bodyActions.current.focusPane("graph") : takeLostFocus()));
      }); });
      return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); cancelAnimationFrame(raf3); };
    }
    if (!wasWanted.current) return;
    wasWanted.current = false;
    setGitViewFrame(null);
    setMarkers([]);
    coverBehind(false);
    setInert([...inertCards], false, inertCards);
    if (savedViewport.current) moveCamera(savedViewport.current, animate ? 150 : 0);
    savedViewport.current = null;
  }, [want, agent?.id, width, sheet, detailShown]);
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
    const target = opener && opener.isConnected && !opener.closest("[inert]") && !(panel && panel.contains(opener))
      ? opener
      : document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(shown?.id ?? "")}"]`);
    target?.focus({ preventScroll: true });
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
          agent={shown} root={root} agentKey={bodyKey(shown, root)} rootKey={root?.gitCollisions} request={request} sheet={sheet} prefs={prefs} savePrefs={savePrefs}
          width={width} room={room} win={win} panelRef={panelRef as MutableRefObject<HTMLElement | null>}
          pane={pane} setPane={setPane} actions={bodyActions} onClose={onClose}
          onResized={reframeNow}
        />
      </section>, document.body)}
      {markers.length > 0 && canvasRef.current && createPortal(
        <EdgeMarkers markers={markers} right={cover + 12} now={now} onGo={onSelectAgent} />,
        canvasRef.current,
      )}
    </>
  );
}

function EdgeMarkers({ markers, right, now, onGo }: { markers: EdgeMarker[]; right: number; now: number; onGo: (id: string) => void }) {
  return (
    <>
      {markers.map(m => {
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
 *  the panel has nothing to redraw. Git facts are compared by identity. */
const factsSeen = new WeakMap<object, number>();
let factsSerial = 0;
function bodyKey(agent: AgentNodeData, root: AgentNodeData | null): string {
  const facts = gitFactsFor(agent, root);
  let n = facts ? factsSeen.get(facts) : 0;
  if (facts && n === undefined) { n = ++factsSerial; factsSeen.set(facts, n); }
  return [agent.id, agent.label, agent.kind, agent.cwd ?? "", root?.label ?? "", n].join("\u0000");
}

/** The branch name, cut by measuring its box: the ticket first and never cut
 *  inside it (git-chip.ts), the whole name in the tooltip. React's own text
 *  node is rewritten, so React keeps owning it. */
function useFittedName(name: string, watch: MutableRefObject<HTMLElement | null>) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    const text = el?.firstChild;
    if (!el || !text || text.nodeType !== 3) return;
    // The name is set in the mono stack, where every character takes one
    // cell, so the full name's own width says what a cell is.
    const fit = () => {
      text.nodeValue = name;
      const room = el.clientWidth;
      const full = el.scrollWidth;
      if (full <= room + 1 || !name.length) return;
      const cell = full / name.length;
      text.nodeValue = fitBranch(name, t => t.length * cell <= room);
    };
    // The first fit waits for the first frame, which paints the CSS ellipsis;
    // the observer then answers every width the panel is given.
    const host = watch.current;
    if (!host || typeof ResizeObserver === "undefined") { const raf = requestAnimationFrame(fit); return () => cancelAnimationFrame(raf); }
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [name]);
  return ref;
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

function GitViewBodyRaw({ agent, root, request, sheet, prefs, savePrefs, width, room, win, panelRef, pane, setPane, actions, onClose, onResized }: BodyProps) {
  const facts = gitFactsFor(agent, root);
  const [widened, setWidened] = useState(false);
  useEffect(() => setWidened(false), [agent.id]);
  const focus = gitFocus(agent, widened);
  const [sel, setSel] = useState<string>(request.sel ?? UNCOMMITTED);
  const [file, setFile] = useState<GitFileRef | null>(request.file ?? null);
  useEffect(() => {
    if (!request.open) return;
    setSel(request.sel ?? UNCOMMITTED);
    setFile(request.file ?? null);
  }, [request.seq, agent.id]);
  const [wrap, setWrap] = useState(prefs.wrap);

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

  const focusPane = useCallback((p: GitViewPane) => {
    const section = panelRef.current?.querySelector<HTMLElement>(`[data-gv-pane="${p}"]`);
    if (!section) return;
    // The pane's selected row, else its one tab stop, else (an empty pane) the
    // panel's first control, so focus never falls back to the page.
    const target = section.querySelector<HTMLElement>('[aria-selected="true"][tabindex]')
      ?? section.querySelector<HTMLElement>('[tabindex="0"], [role="region"][tabindex]')
      ?? panelRef.current?.querySelector<HTMLElement>("button:not([disabled])");
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "nearest" });
    setPane(p);
  }, []);
  actions.current = { focusPane, newest: () => {} };

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
  const detached = facts?.detached === true;
  const branchName = detached ? `detached at ${facts?.sha ?? ""}` : facts?.branch ?? "";
  const nameRef = useFittedName(branchName, headRef);
  const repoName = facts?.name ?? agent.cwdBasename ?? "";
  const repoTitle = facts?.linkedWorktree && facts.mainName && facts.mainName !== facts.name
    ? `worktree ${facts.name} of ${facts.mainName}` : facts?.topLevel ?? repoName;
  const narrow = focus.agentIds != null;
  const who = narrow ? agent : root ?? agent;
  const hue = sessionHue(agent.sessionId);

  return (
    <>
      {!sheet && splitter("edge", "vertical", "Resize the git view", "gv-panel", "gv-edge")}
      <div className="gv-inner" id="gv-panel" onFocus={e => {
        const p = (e.target as HTMLElement).closest?.("[data-gv-pane]")?.getAttribute("data-gv-pane") as GitViewPane | null;
        if (p && p !== pane) setPane(p);
      }}>
        <header className="gv-head" ref={headRef}>
          <button type="button" className="btn gv-back" aria-label="Back to the canvas" onClick={() => onClose("pointer")}>
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
            {facts?.unborn && <span className="gv-fetch gv-fetch-word">no commits yet</span>}
          </div>
          <span
            className={`gv-scope${narrow ? " is-narrow" : ""}`}
            style={{ "--session-hue": hue } as CSSProperties}
            title={narrow ? `Narrowed to ${agent.label}` : `${who.label}${who.kind === "root" ? " and its subagents" : ""}`}
          >
            <i className="gv-swatch" aria-hidden="true" />
            <span className="gv-scope-who">{narrow ? `↳ ${agent.label}` : who.label}</span>
            {narrow && (
              <button type="button" className="gv-scope-x" aria-label={`Show the whole session, ${root?.label ?? "its main agent"} and its subagents`}
                title="Show the whole session" onClick={() => { setWidened(true); requestAnimationFrame(() => focusPane("graph")); }}>
                <GvIcon name="close" />
              </button>
            )}
          </span>
          <div className="gv-head-end">
            <GitHandoffs
              sessionId={agent.sessionId} agentId={agent.git ? subagentKey(agent) : null}
              branch={detached ? null : facts?.branch ?? null} sha={detached ? facts?.sha ?? null : null}
              path={agent.cwd ?? null} compact
            />
            <span className="gv-head-rule" aria-hidden="true" />
            <button type="button" className="glyph-btn gv-close" title="Close the git view (Esc)" aria-label="Close the git view" onClick={() => onClose("pointer")}>
              <GvIcon name="close" />
            </button>
          </div>
        </header>
        <div className="gv-panes" ref={panesRef}>
          <section className="gv-graph" id="gv-graph" aria-label="History" data-gv-pane="graph" ref={graphRef}>
            <GitGraph
              repoKey={facts?.topLevel ?? agent.sessionId} commits={[]} head={null}
              uncommitted={{ files: 0, byFocus: 0, label: who.label }} focus={focus} selected={sel}
              onSelect={id => { setSel(id); setFile(null); }} onOpen={() => focusPane("files")}
              onAgentCard={() => {}} liveInsert={null}
            />
          </section>
          {splitter("graph", "horizontal", "Resize the history and the files", "gv-graph", "gv-split-h")}
          <div className="gv-bottom" ref={bottomRef}>
            <section className="gv-files" id="gv-files" aria-label="Files" data-gv-pane="files" ref={filesRef}>
              <GitFiles
                entries={[]} mode={sel === UNCOMMITTED ? "uncommitted" : "commit"} edits={[]} focus={focus}
                selected={file} onSelect={setFile} onOpen={() => focusPane("diff")} collisions={[]}
                name={who.label} sha={sel === UNCOMMITTED ? null : sel}
              />
            </section>
            {splitter("files", "vertical", "Resize the files and the diff", "gv-files", "gv-split-v")}
            <section className="gv-diffpane" aria-label="Diff" data-gv-pane="diff">
              <GitDiff
                file={file} diff={null} loading={false} stale={false} onShowLatest={() => {}}
                wrap={wrap} onToggleWrap={() => { setWrap(!wrap); savePrefs({ ...prefs, wrap: !wrap }); }} collision={null}
              />
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
