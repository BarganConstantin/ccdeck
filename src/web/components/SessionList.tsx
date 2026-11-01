// The attention rail: the left column's list of every session on the canvas,
// grouped by what each one wants of you — Needs you, Working, Done · unseen,
// Idle — in V4's Board window. Click a row to fit-view to that session and
// select its root agent. Toggle visibility with the L key (see App.tsx). The
// topbar's ☰ used to open it too and has been removed; L is the way in, and
// the × below and L itself are the two ways out.
//
// The order is held while you aim at it: nothing moves under a pointer that is
// over the rail or a focus that is inside it, and every row travels once to
// its new place when both have left (rail-model.ts holdOrder, rail-motion.ts).
import { useEffect, useMemo, useReducer, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { isAlarming } from "../ambient-counts";
import { t as translate, useT } from "../i18n";
import { agentCost } from "../usage-models";
import type { GraphState } from "../reducer";
import type { BackgroundJob, SessionRecap, WaitingBlock } from "../types";
import { sessionNoteShown, type SessionNote } from "../session-note";
import { drawnState } from "../node-face";
import { isAgentVisible } from "../visibility";
import { withKey } from "../single-key-shortcuts";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { planSummary, planTitle, type PlanSummary } from "../agent-plan";
import { isUnseen, turnEndedAt, useSessionsSeenVersion } from "../session-seen";
import {
  RAIL_GROUPS, foldMotion, foldPlan, heldLine, holdOrder, joinMotion, nobodyWaitingText, railHeld,
  type RailGroup, type Slot,
} from "../rail-model";
import { leaveHoldMs, useRailFlip, useRailMembership } from "../rail-motion";
import { prefersReducedMotion } from "../viewport-motion";
import { runningTool } from "../rail-row-copy";
import { PauseGlyph } from "./rail-glyphs";
import { CloseGlyph, FoldBody, GroupHead, MoreLine, RailGlyph, RailRow, type FoldMode } from "./RailParts";

export interface Row {
  sessionId: string;
  label: string;
  cwdBasename?: string;
  state: "active" | "done" | "err";
  waiting?: WaitingBlock | null;
  /** Claude Code's recap when it is what the session's note says — the rule is
   *  session-note.ts's, the same one the card and its note ask. Null on every
   *  other row, which keeps exactly the shape it had. */
  recap?: SessionRecap | null;
  /** The note when it says anything else: what the session is doing or did
   *  last, or a background job's question, headline or failure. Same rule;
   *  null whenever the recap speaks instead, or nothing has been said. */
  status?: SessionNote | null;
  modelId?: string;
  /** The effort the session reported, shown after the model (#2155). */
  effort?: string;
  toolCount: number;
  cost: number;
  startedAt: number;
  lastActivity: number;
  /** The session's plan as one line, or null when it keeps none (#2157). */
  plan: PlanSummary | null;
  /** Every step, for the line's tooltip. */
  planTitle: string;
  /** When the latest turn ended (session-seen.ts), null while one runs. The
   *  fields below are all optional so a bare row, as the rank suite builds
   *  them, keeps the shape it had. */
  turnEndedAt?: number | null;
  /** That turn ended after the last time you looked at the session. */
  unseen?: boolean;
  /** Claude Code's own line, on a background session. */
  job?: BackgroundJob | null;
  /** A session that has started and not been given a prompt. */
  neverPrompted?: boolean;
  /** When the current turn began: the newest prompt. */
  turnStartedAt?: number;
  /** The call in flight right now, for a working row's second line. */
  tool?: { name: string; preview: string } | null;
}

/** Where a row sorts, as the rail's four groups, before activity is looked at:
 *  0 Needs you, a session blocked on a permission prompt or a question; 1
 *  Working, a turn running or a background job still going; 2 Done · unseen,
 *  a turn that ended since you last looked; 3 Idle, everything else.
 *
 *  A blocked session is the only row on this list that is asking for something,
 *  so it is first. "Your turn" is a different thing from a decision you are
 *  stalled on: V4 puts it below Working, and once you have seen it, in Idle.
 *  Waiting is not the row's `state`: an idle_prompt sits on a session that is
 *  legitimately done and still reads `done` two columns to the left.
 *
 *  Exported for the suite, along with buildRows below (#378). Both were
 *  module-private, which meant a bare-node suite could not call either and the
 *  only thing standing over this ordering was a regex matching the literal text
 *  of the expression somewhere in this file. Neither function renders anything —
 *  they are a rule about what the sidebar puts at the top, and a rule that
 *  cannot be called is a rule nothing can check. */
export function rank(r: Row): RailGroup {
  if (isAlarming(r.waiting)) return 0;
  // A job still going wears the Working mark even though its turn has ended.
  if (r.job && (r.job.state === "working" || r.job.state === "blocked")) return 1;
  const turnEnded = r.state !== "active" || r.waiting?.kind === "idle";
  if (!turnEnded) return r.neverPrompted ? 3 : 1;
  return r.unseen ? 2 : 3;
}

/** The newest call still running on an active agent. The reducer appends, so
 *  the last open one; scanning from the end stops at the first open call. */
function inFlightCall(a: GraphState["agents"] extends Map<string, infer A> ? A : never): { name: string; preview: string } | null {
  if (a.state !== "active") return null;
  for (let i = a.tools.length - 1; i >= 0; i--) {
    const t = a.tools[i];
    if (t.endedAt == null) return runningTool(t);
  }
  return null;
}

/** `watching` are the sessions you are looking at (selected, or open on the
 *  stage): their finished turn is seen as it ends, so they never pass through
 *  Done · unseen on the way to the effect that writes the marker. */
export function buildRows(state: GraphState, now: number, watching?: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  for (const a of state.agents.values()) {
    if (a.kind !== "root") continue;
    // `toolCount`, not `tools.length` — the reducer keeps only a bounded
    // window of recent calls, but the counter tracks every call ever made.
    let toolCount = a.toolCount;
    let cost = agentCost(a).total;
    let lastActivity = a.endedAt ?? a.startedAt;
    // Roll up subagents' tools + costs + activity into the row.
    for (const sub of state.agents.values()) {
      if (sub.sessionId !== a.sessionId || sub.kind === "root") continue;
      toolCount += sub.toolCount;
      cost += agentCost(sub).total;
      const last = sub.endedAt ?? sub.startedAt;
      if (last > lastActivity) lastActivity = last;
    }
    // The session's note, the one its card ties to it on the canvas: a recap
    // draws as one, anything else as a tagged line.
    const note = sessionNoteShown(a);
    const recap = note?.kind === "recap" ? { text: note.text, at: note.at } : null;
    const status = note && note.kind !== "recap" ? note : null;
    const ended = turnEndedAt(a);
    rows.push({
      sessionId: a.sessionId,
      label: a.label || a.cwdBasename || translate("board.kind.session"),
      cwdBasename: a.cwdBasename,
      // A turn that stopped on an error is drawn as a failure here as on its
      // card (#2185); it sorts with the ended ones either way.
      state: drawnState(a),
      waiting: a.waiting,
      recap,
      status,
      modelId: a.model,
      effort: a.effort,
      // The ROOT's plan: the Task tools' list is the session's, shared with its
      // subagents, and a row is a session (agent-plan.ts).
      plan: planSummary(a.plan),
      planTitle: planTitle(a.plan?.items ?? []),
      toolCount,
      cost,
      startedAt: a.startedAt,
      lastActivity,
      turnEndedAt: ended,
      unseen: ended != null && !watching?.has(a.sessionId) && isUnseen(a.sessionId, ended),
      job: a.job ?? null,
      neverPrompted: a.state === "active" && a.prompts.length === 0 && a.toolCount === 0 && !a.waiting && !a.job,
      turnStartedAt: a.prompts.at(-1)?.at ?? a.startedAt,
      tool: inFlightCall(a),
    });
  }
  // Sort: by group, then, among the blocked rows, the LONGEST-blocked first —
  // the opposite of the most-recent ordering everything else uses, because on
  // this list the number that decides whether you go look is how long the
  // session has been stuck. Working goes by when the current turn began
  // (the newest prompt), newest first, then by id: the one key that does not
  // move during a turn, where lastActivity moves on every tool call and would
  // reshuffle the group under your eyes. Done · unseen goes by the turn's end,
  // newest first; Idle by the latest activity.
  rows.sort((x, y) => {
    const rx = rank(x), ry = rank(y);
    if (rx !== ry) return rx - ry;
    if (x.waiting && y.waiting && rx === 0) return x.waiting.since - y.waiting.since;
    if (rx === 1) return (y.turnStartedAt ?? y.startedAt) - (x.turnStartedAt ?? x.startedAt) || (x.sessionId < y.sessionId ? -1 : x.sessionId > y.sessionId ? 1 : 0);
    if (rx === 2) return (y.turnEndedAt ?? 0) - (x.turnEndedAt ?? 0);
    return y.lastActivity - x.lastActivity;
  });
  return rows;
}

// Quick open and the topbar import it from here; it lives in its own module so
// rail-row-copy.ts need not import this file back.
export { elapsedShort } from "../elapsed-short";

/** Whether the focused element shows a focus ring (a key put it there, not a
 *  press). A browser without the selector answers no. */
function focusIsVisible(el: Element | null): boolean {
  try { return !!el && el.matches(":focus-visible"); } catch { return false; }
}

interface Props {
  state: GraphState;
  now: number;
  selectedIds: Set<string>;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  /** Agents "Remove from board" has taken off the canvas. A removed session
   *  keeps its row — the session is still running or still on disk — and the
   *  row is how it comes back: `onSelect` restores it as it focuses it. */
  removedIds?: ReadonlySet<string>;
  /** Brings back everything removed, subagent cards included, which have no
   *  row of their own to be brought back from. */
  onBringBackAll?: () => void;
  /** On its way out of the left column: still drawn, fading or sliding with
   *  the column's edge, for the length of its exit (LeftColumn.tsx). */
  leaving?: boolean;
  /** The session the last jump went to (N, W, a notification, ⌘K), with a
   *  count so the same session twice is two jumps. Its row scrolls into view
   *  and says "here" once. Never set by a press on the rail itself. */
  landed?: { id: string; nonce: number } | null;
  /** The sessions you are looking at: selected, or open on the stage. Their
   *  finished turns count as seen in the rows themselves. */
  watching?: ReadonlySet<string>;
  /** WORKSPACE: Enter on a row opens the session in the pane with the keys in
   *  it (a click leaves them here). Absent on the Board. */
  onOpenKeys?: (sessionId: string) => void;
}

/** A row that has left the list, kept drawn until its fade and its closing space are done. */
interface Ghost { row: Row; group: RailGroup; after: string | null; until: number }
interface Entry { id: string; row: Row; ghost: boolean }

export default function SessionList({ state, now, selectedIds, onSelect, onClose, removedIds, onBringBackAll, leaving = false, landed = null, watching, onOpenKeys }: Props) {
  const t = useT();
  const singleKeys = useSingleKeyShortcuts();
  // `state.revision`, not `state.lastSeq`: the prop is `stateRef.current` and
  // the reducer mutates it in place, so identity never moves and the rest of the
  // list is the whole of what decides whether this rebuilds. `lastSeq` moves
  // only when an envelope lands; the periodic sweeps that settle a dead session
  // and evict a finished one move only `revision`.
  //
  // `now` is here on its own merits — every row prints an elapsed time — and it
  // ticks every 250ms, so this list was never visibly stale the way the usage
  // panel's was (#575). That is luck, not correctness: the accident that saved
  // it was a clock with nothing to do with whether the state changed, and the
  // day someone gives these rows a cheaper refresh rule the bug arrives with no
  // edit to this line to explain it. The seen version is the other input: a
  // session looked at moves out of Done · unseen.
  const seenVersion = useSessionsSeenVersion();
  const watchKey = watching ? [...watching].sort().join("\n") : "";
  const rows = useMemo(() => buildRows(state, now, watching), [state, state.revision, now, seenVersion, watchKey]);
  const byId = new Map(rows.map(r => [r.sessionId, r]));
  const fresh: Slot[] = rows.map(r => ({ id: r.sessionId, group: rank(r) }));

  // THE ORDER HELD. While the pointer is over the rail, or keyboard focus is in
  // it, the drawn order is the one on screen: rows change in place, a session
  // that joins takes the end of its group. Pointer-pressed focus does not count
  // (:focus-visible), or a click would hold the list until the next click away.
  const [pointerIn, setPointerIn] = useState(false);
  const aside = useRef<HTMLElement>(null);
  // Focus is asked when it is needed, not remembered from events: the hold
  // follows document.activeElement on every render (the clock renders this
  // four times a second) and on focusin/focusout, so a focused element that is
  // removed, made inert or unmounted lets the hold go.
  const [, askFocus] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // focusout comes before activeElement has moved: ask once it has.
    const ask = () => { clearTimeout(timer); timer = setTimeout(askFocus, 0); };
    document.addEventListener("focusin", ask);
    document.addEventListener("focusout", ask);
    return () => { clearTimeout(timer); document.removeEventListener("focusin", ask); document.removeEventListener("focusout", ask); };
  }, []);
  const active = typeof document === "undefined" ? null : document.activeElement;
  const focusInside = !!active && !!aside.current?.contains(active) && !active.closest("[inert]");
  const aimed = railHeld({ pointerInside: pointerIn, focusInside, focusVisible: focusInside && focusIsVisible(active) });
  const pointerEnter = () => setPointerIn(true);
  const pointerLeave = () => setPointerIn(false);
  const heldRef = useRef<Slot[] | null>(null);
  const drawnRef = useRef<Slot[]>([]);
  let layout = fresh;
  let moves = 0;
  if (aimed) {
    const held = holdOrder(heldRef.current ?? drawnRef.current, fresh);
    layout = held.order;
    moves = held.moves;
    heldRef.current = layout;
  } else {
    heldRef.current = null;
  }
  drawnRef.current = layout;

  // A ROW THAT LEAVES stays drawn, inert, where it was until its fade and its
  // closing space are done, and is dropped by the clock that already re-renders
  // this list four times a second. Joins and leaves play from rail-motion.ts,
  // by id, for rows that are really new or really gone. Over twenty rows both
  // happen at once.
  const reduced = prefersReducedMotion();
  const ghosts = useRef(new Map<string, Ghost>());
  const prev = useRef<{ slots: Slot[]; rows: Map<string, Row> } | null>(null);
  const clock = Date.now();
  const live = new Set(layout.map(s => s.id));
  if (prev.current && joinMotion({ rows: rows.length, reduced }) !== "instant") {
    prev.current.slots.forEach((s, i) => {
      const row = prev.current!.rows.get(s.id);
      if (!live.has(s.id) && !ghosts.current.has(s.id) && row) {
        ghosts.current.set(s.id, { row, group: s.group, after: i > 0 ? prev.current!.slots[i - 1].id : null, until: clock + leaveHoldMs(reduced) });
      }
    });
  }
  for (const [id, g] of ghosts.current) if (g.until <= clock || live.has(id)) ghosts.current.delete(id);
  prev.current = { slots: layout, rows: byId };

  // THE FOLD, in memory for the page's life.
  const [folds, setFolds] = useState<{ open: ReadonlySet<RailGroup>; mode: Partial<Record<RailGroup, FoldMode>> }>({ open: new Set(), mode: {} });
  const toggleFold = (g: RailGroup, rowsInside: number, byKey: boolean) => setFolds(f => {
    const open = new Set(f.open);
    if (!open.delete(g)) open.add(g);
    return { open, mode: { ...f.mode, [g]: foldMotion({ rowsInside, byKey, reduced: prefersReducedMotion() }) } };
  });
  const onToggle = (g: RailGroup, rowsInside: number) => (e: MouseEvent) => toggleFold(g, rowsInside, e.detail === 0);

  const slotsOf = (g: RailGroup) => layout.filter(s => s.group === g);
  const counts = RAIL_GROUPS.map(g => slotsOf(g).length) as [number, number, number, number];
  const plan = foldPlan(counts);

  /** A group's entries in drawn order, the rows that have just left among them. */
  const entriesOf = (g: RailGroup): Entry[] => {
    const entries: Entry[] = slotsOf(g).map(s => ({ id: s.id, row: byId.get(s.id)!, ghost: false }));
    for (const [id, gh] of ghosts.current) {
      if (gh.group !== g) continue;
      const at = gh.after == null ? -1 : entries.findIndex(e => e.id === gh.after);
      entries.splice(at + 1, 0, { id, row: gh.row, ghost: true });
    }
    return entries;
  };

  const list = useRef<HTMLUListElement>(null);
  useRailFlip(list, layout.map(s => `${s.group}:${s.id}`).join("|"), aimed);
  useRailMembership(list, layout.map(s => s.id));

  // LAND. A jump that arrives while the rail is open scrolls the row into view
  // at once and lights it for a moment; a jump to a row behind a fold opens the
  // fold first. Two things that look like jumps are not: the nonce the rail was
  // opened under, and the press on one of its own rows, which is where you
  // already are. A press is flagged until the render it causes has seen the
  // nonce it made. A landing is handled the moment it is used (the scroll
  // below), so a row drawn again, in a fold body or as a ghost, never replays it.
  const handled = useRef<number | null>(null);
  if (handled.current === null) handled.current = landed?.nonce ?? 0;
  const ownPress = useRef(false);
  const press = (sessionId: string) => {
    ownPress.current = true;
    onSelect(sessionId);
    setTimeout(() => { ownPress.current = false; }, 0);
  };
  let landing: { id: string; nonce: number } | null = null;
  if (landed && landed.nonce !== handled.current) {
    if (ownPress.current) { handled.current = landed.nonce; ownPress.current = false; }
    else landing = landed;
  }
  const folded = new Set<string>();
  for (const g of RAIL_GROUPS) {
    const entries = entriesOf(g).filter(e => !e.ghost);
    if (!folds.open.has(g)) for (const e of entries.slice(plan[g].shown)) folded.add(e.id);
  }
  useEffect(() => {
    if (!landing) return;
    const row = byId.get(landing.id);
    if (!row) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-rail-id="${CSS.escape(landing.id)}"]`);
    if (el) {
      handled.current = landing.nonce;
      el.scrollIntoView({ block: "nearest", behavior: "instant" });
    } else if (folded.has(landing.id)) {
      const g = layout.find(s => s.id === landing.id)!.group;
      setFolds(f => ({ open: new Set(f.open).add(g), mode: { ...f.mode, [g]: "instant" } }));
    }
  }, [landing?.nonce, folds]);

  // A row's words and glyph follow its own state, not the group a held order
  // keeps it in: they change in place while the row waits for its move.
  const renderRow = (e: Entry): ReactNode => (
    <RailRow key={e.id} row={e.row} group={rank(e.row)} now={now} leaving={e.ghost}
      selected={selectedIds.has(e.id)} removed={removedIds?.has(e.id) ?? false}
      landNonce={landing?.id === e.id ? landing.nonce : null} onSelect={press} onOpenKeys={e.ghost ? undefined : onOpenKeys} />
  );

  const nodes: ReactNode[] = [];
  if (rows.length === 0) {
    nodes.push(<li key="empty" className="sl-empty">{t("board.list.empty")}</li>);
  } else if (counts[0] === 0) {
    // Quiet when nothing needs you; the count is the rows at work.
    nodes.push(<li key="nobody" className="sl-nobody"><RailGlyph kind="idle" /><span>{nobodyWaitingText(counts[1])}</span></li>);
  }
  let drawn = false;
  for (const g of RAIL_GROUPS) {
    const entries = entriesOf(g);
    if (entries.length === 0) continue;
    const { shown, rest: restCount } = plan[g];
    const open = folds.open.has(g);
    const mode = folds.mode[g] ?? "animate";
    // Rows up to the cut are drawn; ghosts past it are not worth drawing.
    const visible: Entry[] = [];
    const behind: Entry[] = [];
    let n = 0;
    for (const e of entries) {
      if (e.ghost) { if (behind.length === 0) visible.push(e); }
      else if (n++ < shown) visible.push(e);
      else behind.push(e);
    }
    // A group that can fold wears its header as the button: the whole group
    // folded away, or opened and able to fold again.
    const canFold = restCount > 0 && (shown === 0 || open);
    nodes.push(
      <GroupHead key={`head-${g}`} group={g} count={counts[g]} spaced={drawn}
        fold={canFold ? { open, motion: mode, onToggle: onToggle(g, behind.length) } : undefined} />,
    );
    drawn = true;
    for (const e of visible) nodes.push(renderRow(e));
    if (restCount > 0) {
      if (shown > 0 && !open) nodes.push(<MoreLine key={`more-${g}`} count={restCount} onToggle={onToggle(g, behind.length)} />);
      nodes.push(<FoldBody key={`fold-${g}`} open={open} motion={mode}>{behind.map(renderRow)}</FoldBody>);
    }
  }

  return (
    // The id outlived the aria-controls it was named for: the topbar toggle
    // that pointed at it is gone. It stays because it is the shape #381 pins
    // for all three panels — `className` and `id` the same word, plus the
    // aria-label that makes the rotor's complementary entries tellable apart —
    // and that is now this panel's only announcement, since nothing reports its
    // open state any more.
    <aside className={`session-list${leaving ? " leaving" : ""}`} id="session-list" aria-label={t("board.list.title")}
      ref={aside} onPointerEnter={pointerEnter} onPointerLeave={pointerLeave}>
      {/* Order held: an overlay on the header's own box, so it takes no space in
          the list and never moves a row it is protecting. Not a live region. */}
      {aimed && moves > 0 && <div className="sl-held"><PauseGlyph /><span>{heldLine(moves)}</span></div>}
      <div className="sl-header">
        {/* h2, under the topbar's h1 — the level every panel title sits at
            (#381). This <aside> was already the shape the other two panels
            were given there; only its heading moved. The groups say what the
            waiting and live chips used to. */}
        <h2>{t("board.list.title")} <span className="sl-count">{rows.length}</span></h2>
        <button type="button" className="sl-close" onClick={onClose} title={withKey(t("board.list.hideSidebar"), "L", singleKeys)} aria-label={t("board.list.hide")}><CloseGlyph /></button>
      </div>
      <ul className="sl-rows" ref={list}>
        {nodes}
      </ul>
      {(() => {
        // Counted from what is off the board now, not from the stored ids: a
        // removed session the deck has since forgotten is nothing to bring back.
        // And only what the press would draw again. A removal hides every agent
        // of the session, the previous turns' subagents too — a new prompt
        // retires them with `exitAt` and they stay in the map until the agent
        // cap — and those were off the canvas before the removal and stay off
        // it after this button, so counting them named cards nobody would see.
        let count = 0;
        for (const id of removedIds ?? []) {
          const agent = state.agents.get(id);
          if (agent && isAgentVisible(agent, now)) count++;
        }
        if (count === 0 || !onBringBackAll) return null;
        return (
          <div className="sl-foot">
            <button
              type="button"
              className="btn sl-bring-back"
              onClick={e => {
                const panel = e.currentTarget.closest(".session-list");
                onBringBackAll();
                // The button leaves with the last removal; the list it was the
                // foot of is where focus belongs next.
                requestAnimationFrame(() => panel?.querySelector<HTMLButtonElement>(".sl-row")?.focus());
              }}
            >
              {t("board.list.bringBack", { count })}
            </button>
          </div>
        );
      })()}
    </aside>
  );
}
