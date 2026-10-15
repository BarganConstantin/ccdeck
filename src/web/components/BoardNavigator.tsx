import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore, type ReactFlowState } from "reactflow";
import { sessionHue } from "../session-hue";
import { SEP } from "../cluster-header";
import { clusterBounds, shallowEqualClusters, type Cluster } from "../cluster-bounds";
import { agentAriaLabel, stateLabel } from "../agent-copy";
import { isAlarming } from "../ambient-counts";
import { elapsed } from "../duration";
import { stateMarkKind, type FaceSignal } from "../node-face";
import { useNow } from "../use-now";
import {
  FACE_H, ROW_H, TILE_PAD, navigatorClusters, navigatorFrame, navigatorSessions, navSignal, neighbourTile,
  railClock, sameSessions, sessionCount, type NavAgent, type NavDensity, type NavSession, type NavTile,
} from "../board-navigator";
import {
  applyFlipFrame, clearFlip, planFlip, readTileRects, runFlip,
  type FlipFrame, type FlipRect, type FoldDirection, type Running, type TileParts,
} from "../navigator-flip";
import { AlertMark, StateMark } from "./StateMark";

/**
 * THE BOARD, GATHERED TO THE LEFT WHILE A SESSION HAS THE STAGE.
 *
 * Screen-space HTML at 1:1, drawn in the canvas's place while React Flow stays
 * mounted underneath, hidden, with its camera and its state (DESIGN-UI decision
 * 1). Every session is a tile in the board's own column and order — see
 * board-navigator.ts for why that order is never re-decided — with the face a
 * card shows at a distance, its task on the rim, and every subagent alive on a
 * line of its own. The session on the stage is the SOCKET: its face's skin has
 * gone to the stage header, and what stays is the outline in its hue and a
 * chevron pointing at the stage, so the board says which node the stage is
 * without a line drawn across the gap.
 *
 * The words are the board's: the face reads faceSignal through the same words
 * the card's NodeFace hands it, the clock is the card's elapsed(), the mark is
 * the card's StateMark, the hue is sessionHue, the name and task come off the
 * same cluster header the board's pills are built from. Nothing on a tile is
 * worded here.
 *
 * The default export reads React Flow's store for the clusters and their cards,
 * exactly as SessionClusters does, so it has to be rendered inside the deck's
 * ReactFlowProvider; NavigatorView is the same component fed directly.
 */

/** What the integrator holds to run the fold and to move the keyboard. */
export interface BoardNavigatorHandle {
  /** Every tile's rect on the page, by session id: the Last of the FLIP. */
  tileRects(): Map<string, FlipRect>;
  /**
   * Plays the fold from the board's cluster rects (`open`) or back to them
   * (`close`), resolving true when it ran to the end. `onFrame` gets every
   * frame, for the board's own opacity (`frame.board`). After an open the
   * tiles are left exactly as the sheet draws them; after a close the last
   * frame stays on them until the navigator is unmounted, so nothing snaps
   * back between the fold's end and the board's return.
   */
  fold(
    direction: FoldDirection,
    board: ReadonlyMap<string, FlipRect>,
    opts?: { reduced?: boolean; onFrame?: (frame: FlipFrame) => void },
  ): Promise<boolean>;
  /** Puts the keyboard on a tile, as the arrows do. */
  focusTile(sessionId: string): void;
}

export interface BoardNavigatorProps {
  /** The navigator's width in px — stage-geometry.ts's navW. */
  width: number;
  density: NavDensity;
  /** The session on the stage: its tile is drawn as the socket. */
  attachedId: string | null;
  /** A tile was pressed (not shift-pressed): put this session on the stage.
   *  `keyboard`: Enter or Space did it, not a pointer (a click's detail is 0
   *  then) — on the tile already on the stage, that is "type here". */
  onOpen: (sessionId: string, how: { keyboard: boolean }) => void;
  /** "+ New session" was pressed; the anchor is the button, for the popover. */
  onNewSession?: (anchor: HTMLElement) => void;
}

export interface NavigatorViewProps extends BoardNavigatorProps {
  /** The board's cluster boxes, in layout units (cluster-bounds.ts). */
  clusters: readonly Cluster[];
  /** The cards behind them (board-navigator.ts navigatorSessions). */
  sessions: Map<string, NavSession>;
}

const selectClusters = (s: ReactFlowState): Cluster[] => clusterBounds(s.nodeInternals.values());
const selectSessions = (s: ReactFlowState): Map<string, NavSession> => navigatorSessions(s.nodeInternals.values());

/** Where the trunk runs down a tile, and how far each branch reaches right to
 *  its row. The rows start at 22px, and the branch stops a gap short of them. */
const TRUNK_X = 14;
const BRANCH_W = 9;

/** How long the socket's inset glow is kept on a tile it has just moved to. A
 *  little over the sheet's 260ms, so the attribute outlives the animation. */
const FLASH_MS = 300;

/** A layout effect in the browser, and nothing on the server, where the suite
 *  draws components to markup and a layout effect only warns — the same
 *  answer use-count-up.ts gives. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The id "+ New session" carries, so the popover it opens can hang off it
 *  (AnchoredPopover finds its anchor by id at every placement). */
export const NAV_NEW_SESSION_ID = "nav-new-session";

const ARROWS: Record<string, "left" | "right" | "up" | "down"> = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
};

export const NavigatorView = memo(forwardRef<BoardNavigatorHandle, NavigatorViewProps>(function NavigatorView(
  { clusters, sessions, width, density, attachedId, onOpen, onNewSession },
  ref,
) {
  const frame = useMemo(
    () => navigatorFrame(navigatorClusters(clusters, sessions), width, density),
    [clusters, sessions, width, density],
  );
  const byId = useMemo(() => new Map(clusters.map(c => [c.sessionId, c])), [clusters]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const tileEls = useRef(new Map<string, HTMLDivElement>());
  const running = useRef<Running | null>(null);
  useEffect(() => () => running.current?.cancel(), []);

  // ONE TAB STOP for the whole navigator, and the arrows walk it: fifty tiles
  // are fifty Tab presses otherwise, between the stage and anything after it.
  // The stop is the tile last focused, else the socket, else the first tile.
  const [focusId, setFocusId] = useState<string | null>(null);
  const has = (id: string | null) => id != null && frame.tiles.some(t => t.sessionId === id);
  const tabStop = has(focusId) ? focusId : has(attachedId) ? attachedId : frame.tiles[0]?.sessionId ?? null;

  const focusTile = useCallback((id: string) => {
    tileEls.current.get(id)?.querySelector<HTMLButtonElement>(".nav-open")?.focus();
    setFocusId(id);
  }, []);

  // The socket's tile is scrolled into view whenever it changes, mount
  // included, and when it MOVES — a press here, j/k on the board, the next
  // ask — it flashes once. Not on the first attach: that is the fold, which has
  // motion of its own. A layout effect, so the scroll lands before paint and
  // before a fold started from the parent's own layout effect (which runs after
  // this one) reads where the tiles are.
  const [flashId, setFlashId] = useState<string | null>(null);
  const lastAttached = useRef<string | null | undefined>(undefined);
  useBeforePaint(() => {
    const had = lastAttached.current;
    lastAttached.current = attachedId;
    if (!attachedId) { setFlashId(null); return; }
    if (had === attachedId) return;
    setFocusId(attachedId);
    tileEls.current.get(attachedId)?.scrollIntoView?.({ block: "nearest" });
    if (had == null) return;
    setFlashId(attachedId);
    const timer = window.setTimeout(() => setFlashId(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [attachedId]);

  useImperativeHandle(ref, () => ({
    tileRects: () => readTileRects(rootRef.current),
    fold(direction, board, opts = {}) {
      const root = rootRef.current;
      if (!root) return Promise.resolve(false);
      running.current?.cancel();
      const parts = new Map<string, TileParts>();
      for (const [id, el] of tileEls.current) {
        parts.set(id, { rim: el.querySelector<HTMLElement>(".nav-rim"), body: el.querySelector<HTMLElement>(".nav-body") });
      }
      clearFlip(root, parts);
      const plan = planFlip({ board, nav: readTileRects(root), direction, reduced: opts.reduced });
      // The scroller clips nothing while tiles fly in from where the board
      // drew them, which is mostly outside the navigator's own box.
      root.setAttribute("data-folding", "");
      const run = runFlip(plan, f => {
        applyFlipFrame(f, root, parts);
        opts.onFrame?.(f);
      });
      running.current = run;
      return run.finished.then(ran => {
        if (running.current !== run) return ran;
        running.current = null;
        if (direction === "open" || !ran) {
          clearFlip(root, parts);
          root.removeAttribute("data-folding");
        }
        return ran;
      });
    },
    focusTile,
  }), [focusTile]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const dir = ARROWS[e.key];
    if (!dir || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const from = (e.target as HTMLElement).closest?.("[data-nav-session]")?.getAttribute("data-nav-session");
    if (!from) return;
    // The arrow is the navigator's even at an edge: past here it would reach
    // the deck's own keys for a canvas nobody can see.
    e.preventDefault();
    e.stopPropagation();
    const to = neighbourTile(frame, from, dir);
    if (to) focusTile(to);
  };

  return (
    <div
      ref={rootRef}
      className="board-nav"
      role="group"
      aria-label="Sessions"
      data-density={density}
      onKeyDown={onKeyDown}
    >
      <div className="nav-head">
        {onNewSession && (
          <button
            type="button"
            id={NAV_NEW_SESSION_ID}
            className="btn nav-new"
            aria-haspopup="dialog"
            aria-label="New session"
            title="Start Claude or Codex in a project"
            onClick={e => onNewSession(e.currentTarget)}
          >
            <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
              <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            </svg>
            <span className="nav-new-word">New session</span>
          </button>
        )}
        <span className="nav-count">{sessionCount(frame.tiles.length)}</span>
      </div>
      <div className="nav-scroll">
        <div className="nav-tiles" style={{ height: frame.height }}>
          {frame.tiles.map(tile => {
            const cluster = byId.get(tile.sessionId);
            if (!cluster) return null;
            const id = tile.sessionId;
            return (
              <Tile
                key={id}
                tile={tile}
                cluster={cluster}
                session={sessions.get(id) ?? null}
                density={frame.density}
                attached={id === attachedId}
                flash={id === flashId}
                tabbable={id === tabStop}
                onFocus={setFocusId}
                onOpen={onOpen}
                tileRef={el => { if (el) tileEls.current.set(id, el); else tileEls.current.delete(id); }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}));

/**
 * The board's navigator, fed from React Flow's store: the same cluster boxes
 * SessionClusters draws and the same cards they are drawn round. Each reading
 * keeps its identity while nothing on the board changed (shallowEqualClusters,
 * sameSessions), so the deck's 250ms tick does not re-render it; the clocks on
 * the faces tick on their own one-second beat, as the cards' do.
 */
const BoardNavigator = forwardRef<BoardNavigatorHandle, BoardNavigatorProps>(function BoardNavigator(props, ref) {
  const clusters = useStore(selectClusters, shallowEqualClusters);
  const sessions = useStore(selectSessions, sameSessions);
  return <NavigatorView ref={ref} clusters={clusters} sessions={sessions} {...props} />;
});

export default memo(BoardNavigator);

function Tile({ tile, cluster, session, density, attached, flash, tabbable, onFocus, onOpen, tileRef }: {
  tile: NavTile;
  cluster: Cluster;
  session: NavSession | null;
  density: NavDensity;
  attached: boolean;
  flash: boolean;
  tabbable: boolean;
  onFocus: (id: string) => void;
  onOpen: (id: string, how: { keyboard: boolean }) => void;
  tileRef: (el: HTMLDivElement | null) => void;
}) {
  const id = tile.sessionId;
  const root = session?.root ?? null;
  const subs = session?.subs ?? [];
  const alarm = root != null && isAlarming(root.waiting);
  // A shift-press widens the board's selection there; here there is no
  // selection to widen, so it does nothing rather than something else.
  // Enter or Space on the focused button arrives as a click whose detail is 0.
  const press = (e: React.MouseEvent) => {
    if (e.shiftKey) return;
    onOpen(id, { keyboard: e.detail === 0 });
  };
  return (
    <div
      ref={tileRef}
      className="nav-tile"
      data-nav-session={id}
      data-attached={attached ? "" : undefined}
      data-flash={flash ? "" : undefined}
      style={{ left: tile.x, top: tile.y, width: tile.w, height: tile.h, "--session-hue": sessionHue(id) } as React.CSSProperties}
      onClick={press}
    >
      <span className="nav-rim" aria-hidden="true" />
      <div className="nav-body">
        {/* The task, on the rim's top edge. The face already says the name,
            so the pill carries only what the face cannot fit — the name the
            board's own pill gives the session, cut where that pill cuts it.
            Absent when the session has none yet, as on the board. */}
        {cluster.name ? <span className="nav-pill" data-alarm={alarm ? "" : undefined} aria-hidden="true">{cluster.name}</span> : null}
        {/* The press target is a plain button and the face a span inside it:
            the face's edge says the session's state, as a card's does, and is
            not a control's boundary — the button draws nothing of its own but
            the deck's one focus ring. */}
        <button
          type="button"
          className="nav-open"
          aria-current={attached ? "true" : undefined}
          aria-label={faceLabel(cluster, root, attached)}
          title={cluster.fullLabel}
          tabIndex={tabbable ? 0 : -1}
          onFocus={() => onFocus(id)}
        >
          <span className="nav-face" data-state={root?.state} data-alarm={alarm ? "" : undefined}>
            <span className="nav-id">
              {root ? <StateMark kind={stateMarkKind(root.state)} /> : null}
              <span className="nav-name">
                {cluster.label}
                {cluster.shortId ? <span className="nav-sid">{SEP + cluster.shortId}</span> : null}
              </span>
              <span className="nav-right">
                {alarm
                  ? <AlertMark />
                  : root
                    ? <span className="nav-el">{root.synthetic ? "≥ " : ""}<Elapsed start={root.startedAt} end={root.endedAt} coarse={density === "rail"} /></span>
                    : null}
              </span>
            </span>
            {root ? <SignalLine root={root} signal={navSignal(root)} alarm={alarm} /> : null}
            {attached && (
              <span className="nav-socket" aria-hidden="true">
                <svg viewBox="0 0 12 12" width="12" height="12" focusable="false">
                  <path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              </span>
            )}
          </span>
        </button>
        {density === "tiles" && tile.rows.length > 0 && (
          <svg className="nav-trunk" width={tile.w} height={tile.h} aria-hidden="true" focusable="false">
            {/* The board's own edge classes: a live subagent's branch flows,
                a settled one is a solid line, in the session's hue. */}
            {tile.rows.map((top, i) => subs[i] && (
              <path
                key={subs[i].id}
                className={subs[i].state === "active" ? "sess-edge sess-live" : "sess-edge sess-idle"}
                d={`M${TRUNK_X},${TILE_PAD + FACE_H} V${top + ROW_H / 2} H${TRUNK_X + BRANCH_W}`}
              />
            ))}
          </svg>
        )}
        {density === "tiles" && tile.rows.map((top, i) => subs[i] && <SubRow key={subs[i].id} sub={subs[i]} top={top} />)}
      </div>
    </div>
  );
}

/** One subagent, on one line: its mark, its name, and what its face would say. */
function SubRow({ sub, top }: { sub: NavAgent; top: number }) {
  const said = navSignal(sub);
  return (
    <div className="nav-row" data-state={sub.state} style={{ top }}>
      <StateMark kind={stateMarkKind(sub.state)} />
      <span className="nav-row-name">{sub.label}</span>
      {said ? <span className="nav-row-said" data-tone={said.tone}>{said.long}</span> : null}
    </div>
  );
}

/**
 * The face's second line: the board face's signal; for a session stopped on a
 * human, "waiting" and for how long first — the deck's one word for that state,
 * the topbar's and the stage header's — then the face's own sentence; for a
 * session the board has nothing to interrupt about, its state in the card's
 * word.
 */
function SignalLine({ root, signal, alarm }: { root: NavAgent; signal: FaceSignal | null; alarm: boolean }) {
  if (alarm && root.waiting) {
    return (
      <span className="nav-signal" data-tone="warn">
        waiting <b><Waited since={root.waiting.since} /></b>{signal ? SEP + signal.long : null}
      </span>
    );
  }
  if (signal) return <span className="nav-signal" data-tone={signal.tone}>{signal.long}</span>;
  return <span className="nav-signal">{stateLabel(root.state)}</span>;
}

/** The face's accessible name: the card's own (agentAriaLabel), the task the
 *  pill shows, and whether this is the session on the stage. */
function faceLabel(cluster: Cluster, root: NavAgent | null, attached: boolean): string {
  return [
    root ? agentAriaLabel(root) : cluster.fullLabel,
    cluster.name,
    attached ? "on the stage" : null,
  ].filter(Boolean).join(", ");
}

/** The card's clock, on its own one-second beat (#873); the rail's, coarse. */
function Elapsed({ start, end, coarse = false }: { start: number; end?: number; coarse?: boolean }) {
  const now = useNow(1000);
  const text = elapsed(start, end, now);
  return <>{coarse ? railClock(text) : text}</>;
}

/** How long a block has waited, on the same beat as the card's waiting row. */
function Waited({ since }: { since: number }) {
  const now = useNow(1000);
  return <>{elapsed(since, undefined, now)}</>;
}

