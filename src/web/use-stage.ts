// The terminal stage, as App holds it: the flag and its switch in Settings, whether the stage is
// open and on what, how wide it is, and every way the deck opens, switches and
// closes it — a click on a card, the waiting chip, the canvas's Terminal
// button, a session list row, the keys, the navigator's tiles.
//
// IN THE FIRST-LOAD CHUNK, SO NOTHING HEAVY. This file is what the deck runs
// whether or not anyone ever turns the terminal on, so it holds state and
// callbacks and no more: the stage, the navigator, the morph and xterm are all
// behind loadStageShell's dynamic import (components/StageSlots.tsx renders
// them through React.lazy), and the rules this hook acts on are pure modules —
// stage-shell.ts for the steps between closed and open, stage-geometry.ts for
// the widths. With the flag off `enabled` stays false, every entry point below
// answers "not mine", no effect touches the page — beyond giving the board back
// its `inert` if the switch went off under a stage — and the deck is the deck
// it was (DESIGN-UI decision 9).
//
// THE STAGE SHARES THE CANVAS'S CELL. It is not a seventh grid template beside
// the canvas: the canvas keeps its size, React Flow stays mounted under the
// stage and the navigator — hidden and inert, its camera and its measurements
// intact — and the stage is laid over the cell's right-hand side at a whole
// number of columns (stage-shell.css). Because the canvas never changes size,
// opening the stage never re-packs the board under it, and the close lands the
// navigator's tiles back on exactly the clusters they flew out of.
//
// THE DETAIL PANEL AND THE STAGE EVICT EACH OTHER (DESIGN-UI decision 8). An
// open evicts the panel; the panel appearing — a double-click, Enter on a
// card, D — closes the stage at once, with no morph, since the column it
// opens is already changing the canvas under it.
//
// SO DOES A RAIL PANEL ASKED FOR. Usage and Machine float over the cell's
// right-hand edge, where the stage's header and its ✕ are. Open when the
// stage arrives, they stand aside under it, their flags kept for when it goes
// (stage-shell.css). Asked for while it is up — the stripe's button, U, S —
// one takes the right of the deck back the way the detail panel does: the
// stage goes at once, and the board comes back with the panel over it, as it
// would have been with no terminal at all (useRailPanel, below). Not a third
// share of the cell: the stage beside a 280px panel, or two, leaves the
// navigator a sliver or nothing, and the session's columns would change under
// it — a redraw of the TUI — for a glance at the quota.
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type Dispatch, type MutableRefObject, type SetStateAction,
} from "react";
import type { BlockedSession } from "./ambient-counts";
import { focusCanvasNode } from "./canvas-node-element";
import type { BoardNavigatorHandle } from "./components/BoardNavigator";
import { hidePeek } from "./components/SessionPeek";
import { DOUBLE_CLICK_MS } from "./focus-hold";
import type { GraphState } from "./reducer";
import {
  ASSUMED_CELL, NARROW_BELOW, STAGE_COLS_KEY, loadStageCols, saveStageCols, stageGeometry,
  type Cell, type StageGeometry,
} from "./stage-geometry";
import {
  STAGE_FIRST_RUN_KEY, boardInert, initialShell, navigatorOrder, navigatorSessionAt, shellReducer,
  stageClaimsKeys, stageSeen, targetSession, terminalButtonTarget, visibleOrigin,
  type ShellAction, type ShellRect, type StageTarget,
} from "./stage-shell";
import { localStore, readStored, removeStored, writeStored } from "./storage";
import type { LaunchOptions, TerminalProvider } from "./terminal-api";
import { heldText, holdKey, isPaneInput, startTypeAhead, typesItself, type TypeAhead } from "./type-ahead";
import { useAsks, type Asks } from "./use-asks";
import type { StageShortcuts } from "./use-deck-shortcuts";
import { useMirroredRef } from "./use-mirrored-ref";

/** The lazy chunk's one door: the navigator, the stage and everything they
 *  pull in, xterm's own further import included, are reached only through
 *  this. Fetched when the flag turns out to be on, so the first click does not
 *  wait for it; never fetched when the flag is off. */
export const loadStageShell = () => import("./components/terminal/StageShell");

/** What is said when the lazy chunk will not load — a tab left open across an
 *  upgrade asks for a file the new build no longer has. */
export const SHELL_UNAVAILABLE = "The terminal could not be loaded. Reload the page to use it.";

const pageRect = (r: DOMRect | { left: number; top: number; width: number; height: number }): ShellRect =>
  ({ x: r.left, y: r.top, w: r.width, h: r.height });

/** A card on the canvas, by id: React Flow's node wrapper. */
function nodeElement(canvas: ParentNode | null | undefined, id: string): Element | null {
  try {
    return canvas?.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`) ?? null;
  } catch {
    return null;
  }
}

/** Where a card prints its name, at the distance it is drawn at: the small
 *  face's name when the face is what shows, else the full card's. */
function nameElement(card: Element): Element | null {
  const face = card.querySelector(".lod-name");
  if (face && face.getBoundingClientRect().width > 0) return face;
  return card.querySelector(".title .label");
}

export interface StageDeps {
  stateRef: MutableRefObject<GraphState>;
  canvasRef: MutableRefObject<HTMLElement | null>;
  /** The stored detail flag, and whether the panel is on screen. */
  detailOpen: boolean;
  detailShown: boolean;
  setDetailOpen: (open: boolean) => void;
  primarySelectedIdRef: { readonly current: string | null };
  /** use-selection.ts's: the stage moving to a session selects it, without
   *  inspecting it — see `follow` below. */
  selectAgent: (id: string, additive: boolean, inspect?: boolean) => void;
}

export function useStage({ stateRef, canvasRef, detailOpen, detailShown, setDetailOpen, primarySelectedIdRef, selectAgent }: StageDeps) {
  // The flag, from the one read of the deck's prefs (use-prefs-read.ts), and
  // whether the launch forced it on, which the switch in Settings says.
  const [enabled, setEnabled] = useState(false);
  const [forced, setForced] = useState(false);
  const enabledRef = useMirroredRef(enabled);
  const loadTerminalPrefs = useCallback((d: TerminalPrefsAnswer) => {
    setEnabled(d.terminalOn === true);
    setForced(d.terminalForced === true);
  }, []);

  // A reducer held in a state rather than useReducer, for the same answer
  // with one hook fewer for the suite's stand-in React to know.
  const [shell, setShell] = useState(initialShell);
  const dispatch = useCallback((action: ShellAction) => setShell(s => shellReducer(s, action)), []);
  const shellRef = useMirroredRef(shell);
  const detailOpenRef = useMirroredRef(detailOpen);
  const open = shell.phase !== "closed";

  // ── how wide ───────────────────────────────────────────────────────────────
  // The cell xterm measured (its assumption until it has drawn), the width the
  // reader chose in columns, ⤢, and the canvas cell the stage shares — exact,
  // from an observer of its own while the stage is up: use-canvas-size.ts's
  // 40px quantum is right for the layout and wrong for a column count.
  //
  // The room is the canvas's, and only means the room because the stage
  // cannot widen the canvas: stage-shell.css says why its width is capped by
  // a percentage, and what reading the stage's own width back as the cell did
  // (a page stuck 24px too wide after a window went from 1440 to 900 in one
  // step). Rounded down: at a browser zoom the cell is a fraction of a pixel
  // wide and clientWidth rounds to the nearest whole one, which a takeover —
  // the stage the whole cell — would then ask half a pixel too much of. The
  // reader's column count is never touched by any of this: a window too small
  // for it gets what fits, and the next window with the room gets it back.
  const [cell, setCell] = useState<Cell>(ASSUMED_CELL);
  const [cols, setCols] = useState<number | null>(() => loadStageCols());
  const [expanded, setExpanded] = useState(false);
  const [box, setBox] = useState<{ w: number; h: number; narrow: boolean } | null>(null);
  const measure = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.floor(Math.min(el.clientWidth, r.width)), h = Math.floor(Math.min(el.clientHeight, r.height));
    const narrow = window.innerWidth < NARROW_BELOW;
    setBox(b => (b && b.w === w && b.h === h && b.narrow === narrow ? b : { w, h, narrow }));
  }, [canvasRef]);
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [open, measure, canvasRef]);
  const geometry: StageGeometry | null = box && open
    ? stageGeometry({ appW: box.w, bodyH: box.h, cellW: cell.w, cellH: cell.h, expanded, narrow: box.narrow, storedCols: cols })
    : null;
  const geometryRef = useMirroredRef(geometry);

  const [firstRun, setFirstRun] = useState(() => readStored(STAGE_FIRST_RUN_KEY) !== "1");
  /** The stage's sentence for the deck's live region (App mounts it). */
  const [said, setSaid] = useState("");

  const navRef = useRef<BoardNavigatorHandle | null>(null);
  const keysRef = useRef<StageShortcuts | null>(null);
  const tokenRef = useRef(0);
  const launchSeqRef = useRef(0);
  const launchedRef = useRef<{ key: string; sessionId: string } | null>(null);
  /** Sessions this tab launched, which the Terminal button may go back to
   *  before the board has heard of them. */
  const launchedIdsRef = useRef(new Set<string>());
  /** Set when the stage goes with the focus in it: the card to give the
   *  focus back to, or null when the stage showed no board session. */
  const returnFocusRef = useRef<{ card: string | null } | null>(null);
  /** The Terminal button, when it opened the stage: where the focus goes
   *  back to from a stage with no session behind it, which has no card. */
  const openerRef = useRef<HTMLElement | null>(null);
  /** What was typed since a press asked for a session's pane, until the pane
   *  can take it (type-ahead.ts): the request it waits on, the session, and
   *  where the press left the focus. */
  const aheadRef = useRef<{ token: number; session: string; from: Element | null; ahead: TypeAhead } | null>(null);

  // ── opening, switching ─────────────────────────────────────────────────────
  /**
   * The one way in. Closed, the stage opens on `target`, growing out of `el`
   * — or out of the target's own card when it is on screen; open, it switches.
   */
  const openOn = useCallback((target: StageTarget, opts: { el?: Element | null; focusPane?: boolean; grace?: boolean } = {}) => {
    if (!enabledRef.current) return;
    const focus = opts.focusPane ? ++tokenRef.current : null;
    if (focus != null) {
      aheadRef.current = target.kind === "session"
        ? { token: focus, session: target.id, from: document.activeElement, ahead: startTypeAhead(Date.now()) }
        : null;
    }
    if (shellRef.current.phase !== "closed") {
      dispatch({ type: "open", target, focus });
      return;
    }
    const canvas = canvasRef.current;
    const from = opts.el ?? (target.kind === "session" ? nodeElement(canvas, target.id) : null);
    const pane = canvas ? pageRect(canvas.getBoundingClientRect()) : null;
    const origin = visibleOrigin(from ? pageRect(from.getBoundingClientRect()) : null, pane);
    // The rider is a card's name; a control the stage grew out of has none.
    const name = origin && from?.classList.contains("react-flow__node") ? nameElement(from) : null;
    measure();
    hidePeek();
    if (detailOpenRef.current) setDetailOpen(false);
    dispatch({
      type: "open",
      target,
      origin,
      originName: name ? pageRect(name.getBoundingClientRect()) : null,
      grace: !!opts.grace,
      focus,
    });
  }, [enabledRef, shellRef, canvasRef, detailOpenRef, measure, setDetailOpen]);

  /** The session on the stage is the selected one. A move that did not come
   *  through a card — a tile, j/k, the next ask, a session list row — selects
   *  the session's root as it goes, so the topbar's ribbon names what the
   *  stage shows and the board, when it comes back, is spotlit on it and
   *  hands it the focus. Never inspecting: the detail panel would evict the
   *  stage. A click on a card has already selected the card it was. */
  const selectRef = useMirroredRef(selectAgent);
  const follow = useCallback((sessionId: string) => {
    if (stateRef.current.agents.has(sessionId)) selectRef.current(sessionId, false, false);
  }, [stateRef, selectRef]);

  /** use-canvas-clicks.ts's: a plain click on a card, true when the stage took
   *  it. The card's session goes on the stage with the keys in its pane, once
   *  there is one; the camera stays where it is. A pointer that picked a
   *  session is about to type to it: left on the board, the first letters
   *  meant for the agent fired the deck's shortcuts instead (u, s, e opened
   *  and closed rail panels in the hands-on run). The keyboard's ways in — a
   *  tile, j/k — still leave the keys on the board. */
  const onNodeClick = useCallback((id: string, el: Element | null): boolean => {
    if (!enabledRef.current) return false;
    const sessionId = stateRef.current.agents.get(id)?.sessionId ?? id;
    openOn({ kind: "session", id: sessionId }, { el, grace: shellRef.current.phase === "closed", focusPane: true });
    return true;
  }, [enabledRef, stateRef, shellRef, openOn]);

  /** A session list row, while the stage is up: the stage follows it rather
   *  than the detail panel opening over it. False when the stage is closed. */
  const followSession = useCallback((sessionId: string): boolean => {
    if (!enabledRef.current || !stageClaimsKeys(shellRef.current.phase)) return false;
    openOn({ kind: "session", id: sessionId });
    follow(sessionId);
    return true;
  }, [enabledRef, shellRef, openOn, follow]);

  /** Put a session on the stage, opening it if need be — the asks run's and
   *  the keys' way in. */
  const switchTo = useCallback((sessionId: string, opts: { focusPane: boolean }) => {
    if (!enabledRef.current) return;
    openOn({ kind: "session", id: sessionId }, { focusPane: opts.focusPane });
    follow(sessionId);
  }, [enabledRef, openOn, follow]);

  /** The canvas's Terminal button: the selected session, else the last one,
   *  else the empty stage. */
  const openFromButton = useCallback((button: Element | null) => {
    const selected = primarySelectedIdRef.current;
    const selectedSession = selected ? stateRef.current.agents.get(selected)?.sessionId ?? null : null;
    const target = terminalButtonTarget(selectedSession, shellRef.current.last,
      id => stateRef.current.agents.has(id) || launchedIdsRef.current.has(id));
    // Out of the session's card when it is on screen, else out of the button.
    const card = target.kind === "session" ? nodeElement(canvasRef.current, target.id) : null;
    const pane = canvasRef.current ? pageRect(canvasRef.current.getBoundingClientRect()) : null;
    const cardShows = card && visibleOrigin(pageRect(card.getBoundingClientRect()), pane);
    // The keys with it, as a card's click gives them: the button is how the
    // reader says "a terminal", and the board it sits on goes inert under the
    // stage. A card instead of a pane puts them on the card's action.
    openOn(target, { el: cardShows ? card : button, focusPane: true });
    openerRef.current = button && typeof (button as HTMLElement).focus === "function" ? button as HTMLElement : null;
  }, [primarySelectedIdRef, stateRef, shellRef, canvasRef, openOn]);

  /**
   * A navigator tile was pressed: that session, keys left on the board.
   *
   * Except Enter (a keyboard press) on the tile that is already on the stage,
   * which is the bar's "↵ type here": the keys go into its pane. That tile is
   * exactly where the release chord leaves the focus, so without this the
   * Enter that should take the keys back re-opened the same session and left
   * them on the board — and the next letters typed for the session landed on
   * the board as its shortcuts. A mouse press on it stays a no-op: pointing at
   * the socket is not asking to type.
   */
  const openTile = useCallback((sessionId: string, how?: { keyboard?: boolean }) => {
    if (how?.keyboard && sessionId === targetSession(shellRef.current.target)) {
      if (stageClaimsKeys(shellRef.current.phase)) dispatch({ type: "focus", token: ++tokenRef.current });
      return;
    }
    openOn({ kind: "session", id: sessionId });
    follow(sessionId);
  }, [shellRef, openOn, follow]);

  const launch = useCallback((agent: TerminalProvider, cwd: string, options?: LaunchOptions) => {
    const key = `launch-${Date.now().toString(36)}-${++launchSeqRef.current}`;
    openOn({ kind: "launch", agent, cwd, key, ...(options ? { options } : {}) }, { focusPane: true });
  }, [openOn]);

  /** The stage reports what a launch became; once the board has heard from
   *  that session, the stage shows it as itself (the effect below). */
  const onLaunched = useCallback((l: { sessionId: string }) => {
    const t = shellRef.current.target;
    if (t?.kind !== "launch") return;
    launchedRef.current = { key: t.key, sessionId: l.sessionId };
    // Reachable again from the Terminal button even before the board knows
    // it: a new Claude in a folder it has not been trusted in asks first, and
    // no hook fires until it is answered, so a stage closed meanwhile would
    // leave the session running with no way back to it.
    if (l.sessionId) {
      launchedIdsRef.current.add(l.sessionId);
      dispatch({ type: "remember", sessionId: l.sessionId });
    }
  }, [shellRef]);
  useEffect(() => {
    const t = shell.target;
    const l = launchedRef.current;
    if (t?.kind !== "launch" || !l || l.key !== t.key || !l.sessionId) return;
    if (stateRef.current.agents.has(l.sessionId)) dispatch({ type: "launched", key: t.key, sessionId: l.sessionId });
  });

  // ── the keys ───────────────────────────────────────────────────────────────
  const focusPane = useCallback(() => {
    if (stageClaimsKeys(shellRef.current.phase)) dispatch({ type: "focus", token: ++tokenRef.current });
  }, [shellRef]);

  /** The keys back to the board: onto the socket's tile, as v3 does — or,
   *  with no navigator beside the stage, onto the stage's own ⌨, and with
   *  no ⌨ either (the session ended, or another view took the pane) onto ✕,
   *  which every stage draws. Moving focus is the whole of it; the pane's
   *  owner follows its textarea's blur. The chord must always land somewhere:
   *  xterm keeps Tab and Escape, so a pane it cannot leave is a keyboard trap
   *  (WCAG 2.1.2). */
  const release = useCallback(() => {
    const id = targetSession(shellRef.current.target);
    const g = geometryRef.current;
    const canvas = canvasRef.current;
    let tile: Element | null = null;
    try {
      tile = id && canvas ? canvas.querySelector(`.board-nav [data-nav-session="${CSS.escape(id)}"]`) : null;
    } catch {}
    if (id && tile && navRef.current && g && !g.takeover) {
      navRef.current.focusTile(id);
      return;
    }
    const head = document.querySelector<HTMLElement>(".stage-dock .ts-head");
    const landing = head?.querySelector<HTMLElement>("button[aria-pressed]") ?? head?.querySelector<HTMLElement>("button[data-stage-close]");
    if (landing) landing.focus();
    else (document.activeElement as HTMLElement | null)?.blur?.();
  }, [shellRef, geometryRef, canvasRef]);

  // ── closing ────────────────────────────────────────────────────────────────
  const close = useCallback(() => dispatch({ type: "close" }), []);

  /** The stage's morph has ended: say so, and give the card back the focus
   *  the stage held — or, for a stage with no session behind it (the empty
   *  stage), the Terminal button that opened it. */
  const closed = useCallback((sentence: string) => {
    const active = document.activeElement;
    const held = !active || active === document.body || !!active.closest?.(".stage-dock, .stage-nav");
    returnFocusRef.current = held ? { card: targetSession(shellRef.current.target) } : null;
    if (sentence) setSaid(sentence);
    dispatch({ type: "closed" });
  }, [shellRef]);

  /**
   * A panel wants the right of the deck: the stage goes at once, with no
   * morph — the detail panel's column is already changing the canvas under
   * it, a rail panel is already drawing where its header was. The focus the
   * stage held, in its pane or on a navigator tile, would fall to <body> with
   * the stage's DOM, so it goes back onto the card, as a close's does (the
   * effect below, once the board is reachable). Focus anywhere else — the
   * stripe button that was pressed, the card a double-click landed on — is
   * where the reader put it, and stays.
   */
  const giveRightBack = useCallback(() => {
    const s = shellRef.current;
    if (s.phase === "closed") return;
    if (document.activeElement?.closest?.(".stage-dock, .stage-nav")) returnFocusRef.current = { card: targetSession(s.target) };
    dispatch({ type: "close", instant: true });
  }, [shellRef]);

  /** The lazy chunk would not load: nothing to show, so nothing stays. */
  const failed = useCallback(() => {
    setSaid(SHELL_UNAVAILABLE);
    dispatch({ type: "close", instant: true });
  }, []);

  const reveal = useCallback(() => dispatch({ type: "reveal" }), []);
  const revealed = useCallback(() => dispatch({ type: "revealed" }), []);
  const announce = useCallback((sentence: string) => setSaid(sentence), []);

  // ── the popover, the divider, ⤢, the first-run line, the cell ──────────────
  const openPopover = useCallback((anchorId: string) => dispatch({ type: "popover", anchor: anchorId }), []);
  const newSessionFrom = useCallback((anchor: HTMLElement) => {
    if (anchor.id) dispatch({ type: "popover", anchor: anchor.id });
  }, []);
  const closePopover = useCallback(() => dispatch({ type: "popover", anchor: null }), []);
  const onCols = useCallback((c: number, settled: boolean) => {
    setCols(c);
    if (settled) saveStageCols(c);
  }, []);
  const onColsReset = useCallback(() => {
    setCols(null);
    removeStored(STAGE_COLS_KEY);
  }, []);
  const toggleExpand = useCallback(() => setExpanded(x => !x), []);
  const firstRunDone = useCallback(() => {
    setFirstRun(false);
    writeStored(STAGE_FIRST_RUN_KEY, "1");
  }, []);
  const onCell = useCallback((c: Cell) => setCell(p => (p.w === c.w && p.h === c.h ? p : c)), []);

  // ── effects on the page ────────────────────────────────────────────────────
  // The chunk on its way as soon as the flag is known to be on.
  useEffect(() => {
    if (enabled) loadStageShell().catch(() => {});
  }, [enabled]);

  // Back on the same session after a reload (ux.md S3). The deck reloads the
  // page by itself after an upgrade, and tmux kept the session running through
  // it, so a stage that came back closed would undo the one thing tmux is
  // there for. Per tab, in sessionStorage: a reload keeps it, another tab does
  // not open on it, and an hour-old tab reopened is not ambushed by a stage.
  // Nothing is written or cleared until the restore has had its turn, or the
  // closed stage of the first render would forget what it is about to restore.
  const restoreRef = useRef<{ id: string; until: number } | "done" | null>(null);
  useEffect(() => {
    if (!enabled || restoreRef.current) return;
    const saved = readOnStage(Date.now());
    restoreRef.current = saved ? { id: saved, until: Date.now() + RESTORE_WAIT_MS } : "done";
  }, [enabled]);
  useEffect(() => {
    const pending = restoreRef.current;
    if (!enabled || !pending || pending === "done") return;
    if (shellRef.current.phase !== "closed" || Date.now() > pending.until) { restoreRef.current = "done"; return; }
    // The board has to know the session first: the page's state arrives a
    // beat after the prefs that turned the flag on.
    if (!stateRef.current.agents.has(pending.id)) return;
    restoreRef.current = "done";
    switchTo(pending.id, { focusPane: false });
  });
  const onStage = shell.phase === "closed" ? null : targetSession(shell.target);
  const restored = restoreRef.current === "done";
  useEffect(() => {
    if (!enabled || restoreRef.current !== "done") return;
    writeOnStage(onStage, Date.now());
    if (!onStage) return;
    // Stamped again as the page goes, so a stage open all afternoon is as
    // fresh at its reload as one opened a minute before.
    const stamp = () => writeOnStage(onStage, Date.now());
    window.addEventListener("pagehide", stamp);
    return () => window.removeEventListener("pagehide", stamp);
  }, [enabled, onStage, restored]);

  // The double-click window an open from a click keeps (stage-shell.ts).
  useEffect(() => {
    if (!shell.grace) return;
    const t = window.setTimeout(() => dispatch({ type: "grace-over" }), DOUBLE_CLICK_MS);
    return () => window.clearTimeout(t);
  }, [shell.grace]);

  // The detail panel appearing takes the right of the deck back.
  useEffect(() => {
    if (detailShown) giveRightBack();
  }, [detailShown, giveRightBack]);

  // React Flow under the stage: inert while the stage covers it, so neither a
  // Tab nor a screen reader's cursor walks a board nobody can see. Set on the
  // element rather than rendered, because React 18 has no `inert` prop.
  // Turned off in Settings while the stage covered the board, the board comes
  // back with it; a deck that never had the terminal on is left untouched.
  const inert = boardInert(shell);
  useEffect(() => {
    const board = canvasRef.current?.querySelector(":scope > .react-flow");
    if (!enabled) {
      if (board?.hasAttribute("inert")) board.removeAttribute("inert");
      return;
    }
    board?.toggleAttribute("inert", inert);
  }, [enabled, inert, canvasRef]);

  // Focus back onto the card once the board is back and reachable — or, when
  // there is no card to land on, onto the Terminal button that opened the
  // stage (the empty stage), else onto the canvas, the skip link's own target,
  // where the deck's keys still answer (a launch the board has not heard of
  // yet, a card taken off the board meanwhile). Never left on <body>, where
  // the next Tab starts the page over.
  useEffect(() => {
    const back = returnFocusRef.current;
    if (open || !back) return;
    returnFocusRef.current = null;
    const opener = openerRef.current;
    openerRef.current = null;
    if (back.card) focusCanvasNode(back.card);
    else if (opener?.isConnected) opener.focus();
    const active = document.activeElement;
    if (!active || active === document.body) canvasRef.current?.focus?.({ preventScroll: true });
  }, [open, canvasRef]);

  // ── what is typed before the pane can take it ─────────────────────────────
  // type-ahead.ts says what is held and why. Ahead of everything else on the
  // page — the window's capture phase — so neither the card that was pressed
  // nor the deck's shortcuts see a key the session is owed. Only while the
  // focus is where the press left it — the card, the Terminal button, the
  // waiting chip — or where the stage's own coming puts it: the body, once
  // the board has gone inert, and the pane's textarea between two sessions.
  // Anywhere else the reader has moved it, with Tab or a press, and is
  // working a control: an Enter there is the control's, a tile's or ✕'s, and
  // held, it would have been typed into the session the reader was leaving.
  // So focus elsewhere, a press anywhere but on the stage, the stage closing
  // or moving to another session, and the flag going off each end the hold,
  // and what it held goes with it.
  useEffect(() => {
    if (!enabled) {
      aheadRef.current = null;
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      const hold = aheadRef.current;
      if (!hold) return;
      const at = e.target as Element | null;
      const where = !at || at === document.body || at === document.documentElement || at === hold.from || isPaneInput(at);
      if (Date.now() > hold.ahead.until || !where) { aheadRef.current = null; return; }
      if (typesItself(at)) return;
      const next = holdKey(hold.ahead, e);
      if (next === "end") aheadRef.current = null;
      if (!next || next === "end") return;
      aheadRef.current = { ...hold, ahead: next.ahead };
      if (!next.swallow) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onPress = (e: PointerEvent) => {
      if (aheadRef.current && !(e.target as Element | null)?.closest?.(".stage-dock")) aheadRef.current = null;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, [enabled]);
  const heldFor = stageClaimsKeys(shell.phase) ? targetSession(shell.target) : null;
  useEffect(() => {
    if (aheadRef.current && aheadRef.current.session !== heldFor) aheadRef.current = null;
  }, [heldFor]);
  /** The stage's, once it has answered a request for the keys: what was typed
   *  for that request, if any. Any answer to it ends the hold; only a pane
   *  that took the keys is handed the text. */
  const takeTypeAhead = useCallback((request: unknown): string => {
    const hold = aheadRef.current;
    if (!hold || hold.token !== request) return "";
    aheadRef.current = null;
    return Date.now() > hold.ahead.until ? "" : heldText(hold.ahead);
  }, []);

  // ── the switch in Settings ─────────────────────────────────────────────────
  // Optimistic, as the deck's other switches are, and corrected by the answer
  // — the latest press's only, since two answers can cross on the way back. A
  // refused or lost write is settled by asking the deck what it holds now,
  // which a write that landed before its answer was lost has already changed.
  // Then the other tabs are told, through storage, to ask the same question:
  // the switch is the deck's, not this tab's.
  const pressRef = useRef(0);
  const askDeck = useCallback((press: number, otherwise: boolean) => {
    fetch("/api/prefs").then(r => (r.ok ? r.json() : null)).then(d => {
      if (press !== pressRef.current) return;
      if (d?.ok) loadTerminalPrefs(d);
      else setEnabled(otherwise);
    }).catch(() => { if (press === pressRef.current) setEnabled(otherwise); });
  }, [loadTerminalPrefs]);
  const toggleTerminal = useCallback(() => {
    const want = !enabledRef.current;
    const press = ++pressRef.current;
    setEnabled(want);
    fetch("/api/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminal: want }),
    }).then(r => (r.ok ? r.json() : null)).then(d => {
      if (d?.ok) {
        if (press === pressRef.current) loadTerminalPrefs(d);
        writeStored(TERMINAL_SWITCHED_KEY, String(Date.now()));
      } else {
        askDeck(press, !want);
      }
    }).catch(() => askDeck(press, !want));
  }, [enabledRef, loadTerminalPrefs, askDeck]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.storageArea !== localStore() || event.key !== TERMINAL_SWITCHED_KEY) return;
      askDeck(++pressRef.current, enabledRef.current);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [askDeck, enabledRef]);

  // Off, however it went off — this tab's switch or another's — takes the
  // stage down at once and without its motion, and forgets the session a
  // reload would have put back: a switch turned on again later opens nothing
  // by itself. Only on the way from on to off, so the closed stage of a first
  // render, before the prefs are read, forgets nothing. Focus the stage held
  // goes back onto the card, as a close's does; focus on the switch itself, in
  // the tab that pressed it, stays there. By the time this runs the stage has
  // already left the page — StageSlots draws nothing once the flag is off —
  // so focus it held is on the body by now, which counts, as it does for
  // `closed`.
  const wasEnabled = useRef(false);
  useEffect(() => {
    const was = wasEnabled.current;
    wasEnabled.current = enabled;
    if (enabled || !was) return;
    if (shellRef.current.phase !== "closed") {
      const active = document.activeElement;
      const held = !active || active === document.body || !!active.closest?.(".stage-dock, .stage-nav");
      if (held) returnFocusRef.current = { card: targetSession(shellRef.current.target) };
    }
    dispatch({ type: "close", instant: true });
    writeOnStage(null, Date.now());
  }, [enabled, shellRef]);

  return {
    enabled, forced, toggleTerminal, loadTerminalPrefs, shell, geometry, cell, expanded, firstRun, said, navRef, keysRef,
    onNodeClick, followSession, switchTo, openFromButton, openTile, launch, onLaunched,
    focusPane, release, takeTypeAhead, close, closed, failed, giveRightBack, reveal, revealed, announce,
    openPopover, newSessionFrom, closePopover, onCols, onColsReset, toggleExpand, firstRunDone, onCell,
  };
}

export type Stage = ReturnType<typeof useStage>;

/** A right-hand rail panel as its stripe button and its key see it. */
export interface RailPanel {
  /** Open and on screen: what the button's aria-expanded reports. */
  shown: boolean;
  /** The panel's setter for its button and its key, answered against what is
   *  on screen, with the stage told when the panel is asked for. */
  set: Dispatch<SetStateAction<boolean>>;
}

/**
 * Usage or Machine, as the stripe's button (or the phone dock's) and the
 * panel's key, U or S, reach it. App calls this once for each, after
 * useStage, and hands both the button and the key the result.
 *
 * A PANEL ASKED FOR TAKES THE RIGHT OF THE DECK BACK — the rule the detail
 * panel keeps (the file's header says why not a share of the cell). Asked for
 * while the stage is anything but closed, opened or brought out from under
 * it, the panel sends the stage away at once through giveRightBack: no morph,
 * and any focus it held back on the card. A stage still waiting unseen for
 * its pane goes too; uncovered a moment later, it would hide the panel just
 * asked for.
 *
 * WHAT IS ON SCREEN DECIDES A PRESS. A panel open when the stage came stands
 * aside under it, its flag kept (stage-shell.css). Left reading open, its
 * button promised a panel nobody could see, and a press — a toggle — closed
 * it: a press for nothing, the button's line gone, and only a second press
 * showed the panel. So while the stage hides it the button says closed, the
 * toggle is answered from there, and the press that opens it is the press
 * that shows it. aria-expanded follows what is drawn, as a disclosure's must;
 * aria-controls goes with it (EdgeRails.tsx), since a hidden region is no
 * region to point at.
 *
 * With no stage up, or no terminal, it is the panel's own setter, called
 * exactly as it was: the deck without the stage is the deck it was.
 * Stable, like the setter it wraps: use-deck-shortcuts.ts registers its
 * listener once and keeps the setters it was first given.
 */
export function useRailPanel(
  stage: Pick<Stage, "enabled" | "shell" | "giveRightBack">,
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
): RailPanel {
  const up = stage.enabled && stage.shell.phase !== "closed";
  const shown = open && !(up && stageSeen(stage.shell.phase));
  const upRef = useMirroredRef(up);
  const shownRef = useMirroredRef(shown);
  const { giveRightBack } = stage;
  const set = useCallback((next: SetStateAction<boolean>) => {
    if (!upRef.current) {
      setOpen(next);
      return;
    }
    const want = typeof next === "function" ? next(shownRef.current) : next;
    if (want) giveRightBack();
    setOpen(want);
  }, [upRef, shownRef, giveRightBack, setOpen]);
  return { shown, set };
}

/** What /api/prefs answers, as far as the stage reads it (prefs-routes.mjs). */
export interface TerminalPrefsAnswer {
  terminalOn?: unknown;
  terminalForced?: unknown;
}

/** Written when this tab's press has changed the switch, so the deck's other
 *  tabs ask the deck again (use-stage.ts toggleTerminal). Its value is only a
 *  time, to make each press a change. */
export const TERMINAL_SWITCHED_KEY = "agent-dag.terminal.switched";

/** The session the stage showed, kept for a reload of the same tab. */
export const STAGE_RESTORE_KEY = "agent-dag.terminal.onStage";
/** A reload comes back in seconds; a tab reopened after this is a new visit. */
export const RESTORE_FRESH_MS = 30 * 60_000;
/** How long a restore waits for the board to hear of the session. */
export const RESTORE_WAIT_MS = 15_000;

/** The session to put back on the stage, or null. */
export function readOnStage(now: number): string | null {
  try {
    const raw = window.sessionStorage.getItem(STAGE_RESTORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (typeof v.id !== "string" || !v.id || typeof v.at !== "number") return null;
    return now - v.at >= 0 && now - v.at < RESTORE_FRESH_MS ? v.id : null;
  } catch {
    return null;
  }
}

/** Keeps the session on the stage, or forgets it once the stage closes. */
export function writeOnStage(id: string | null, now: number): void {
  try {
    if (id) window.sessionStorage.setItem(STAGE_RESTORE_KEY, JSON.stringify({ id, at: now }));
    else window.sessionStorage.removeItem(STAGE_RESTORE_KEY);
  } catch { /* blocked site data: the stage just comes back closed */ }
}

const NO_WAITING: readonly BlockedSession[] = [];

/**
 * The asks run beside the stage (use-asks.ts), and the stage's half of the
 * deck's keys (use-deck-shortcuts.ts StageShortcuts). Its own hook because it
 * needs the waiting list, which App builds after the hooks that already need
 * the stage; the shortcuts read `keysRef` at key time, so filling it here, a
 * few lines later in the same render, is in time.
 */
export function useStageAsks(stage: Stage, waitingSessions: readonly BlockedSession[], canvasRef: MutableRefObject<HTMLElement | null>): Asks {
  const { enabled, shell, switchTo, navRef, focusPane, release, keysRef } = stage;
  // With the flag off the run is given nothing to watch, so it never renders
  // the deck again for a list it has no use for.
  const asks = useAsks({
    waitingSessions: enabled ? waitingSessions : NO_WAITING,
    stageOpen: enabled && stageClaimsKeys(shell.phase),
    currentId: targetSession(shell.target),
    switchTo,
  });
  keysRef.current = enabled
    ? {
      open: stageClaimsKeys(shell.phase),
      current: targetSession(shell.target),
      get order() { return navigatorOrder(canvasRef.current); },
      sessionAt: navigatorSessionAt,
      focusTile: id => navRef.current?.focusTile(id),
      switchTo,
      focusPane,
      nextAsk: asks.nextAsk,
      release,
    }
    : null;
  return asks;
}
