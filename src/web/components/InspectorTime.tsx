// The Inspector's Time tab (Figma 22:15467): where the session's turn went, in
// the three lanes Tool activity shows, and the calls the turn was made of.
//
// The lanes come from the server (inspector-time.ts), the spans from the calls
// the session already holds. No cost anywhere, and no row for the model's
// thinking: the deck has no per-step cost and thinking is not an event.
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import {
  TURN_POLL_MS, TURN_RETRY_MS, axisTicks, barBox, readSessionTurn, spanTable, turnPieces, turnSpan, turnStartOf, waitingShare, withPromptWait,
  type SessionTurn, type SpanRow, type SpanTable,
} from "../inspector-time";
import { sessionRoot } from "../inspector-tree";
import type { AgentNodeData } from "../types";
import { useNow } from "../use-now";
import Loader from "./Loader";

interface Reading { session: string; turn: SessionTurn | null; readAt: number }

/** The session's turn as last read, with when it was read. `undefined` until the
 *  first answer (`failed` says that answer did not come), then the turn or `null`.
 *  While the tab is shown it asks again every 5 s for an open turn of a working
 *  session, and after an answer that was not one at 15 s; it rests while the page
 *  is hidden or the session is not working, and keeps the last good reading. */
function useSessionTurn(session: string, stamp: string, working: boolean): { reading: Reading | undefined; failed: boolean } {
  const [state, setState] = useState<{ reading?: Reading; failedFor?: string }>({});
  useEffect(() => {
    const control = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const later = (ms: number) => { clearTimeout(timer); if (!hidden()) timer = setTimeout(ask, ms); };
    async function ask() {
      clearTimeout(timer);
      try {
        const next = await readSessionTurn(session, control.signal);
        if (control.signal.aborted) return;
        if (next === undefined) {
          // A busy deck, a 409 or an odd body: the last reading stands, and we ask again, slower.
          setState(current => ({ ...current, failedFor: session }));
          later(TURN_RETRY_MS);
          return;
        }
        setState({ reading: { session, turn: next, readAt: Date.now() } });
        // An open turn of a working session is asked for again; a closed one when the
        // session's own prompt or end moves (`stamp`). No turn yet is looked for slowly.
        if (next?.open && working) later(TURN_POLL_MS);
        else if (next === null && working) later(TURN_RETRY_MS);
      } catch {
        if (!control.signal.aborted) { setState(current => ({ ...current, failedFor: session })); later(TURN_RETRY_MS); }
      }
    }
    const visible = () => { if (!hidden()) void ask(); else clearTimeout(timer); };
    document.addEventListener("visibilitychange", visible);
    void ask();
    return () => { control.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [session, stamp, working]);
  // Another session's reading is never shown for this one.
  return { reading: state.reading?.session === session ? state.reading : undefined, failed: state.failedFor === session };
}

export default function InspectorTime({ selected, agents, revision }: {
  selected: AgentNodeData;
  agents: ReadonlyMap<string, AgentNodeData>;
  /** The graph's `revision`: the agents are mutated in place, so it is what says the calls may have changed. */
  revision: number;
}) {
  const root = sessionRoot(agents, selected.sessionId) ?? selected;
  // Codex rollouts name no prompt, so there is no turn to cut and nothing to ask for.
  if (root.provider === "codex") return <p className="insp-note">Time is recorded for Claude Code sessions.</p>;
  return <TimeTab root={root} agents={agents} revision={revision} />;
}

function TimeTab({ root, agents, revision }: { root: AgentNodeData; agents: ReadonlyMap<string, AgentNodeData>; revision: number }) {
  const working = root.state === "active";
  const stamp = `${root.prompts.length}:${root.endedAt ?? ""}`;
  const { reading, failed } = useSessionTurn(root.sessionId, stamp, working);
  // A session that is not working has no turn still running, whatever the last read said.
  const turn = useMemo(() => {
    if (!reading?.turn) return reading?.turn;
    const read = working ? reading.turn : { ...reading.turn, open: false };
    return withPromptWait(read, root.waiting, reading.readAt);
  }, [reading, working, root.waiting]);
  const now = useNow(turn?.open ? 1000 : 30000);
  const readAt = reading?.readAt ?? 0;
  // Built from what the reading and the calls say, not from the clock: an open call's bar
  // is drawn to `now` by barBox, and the axis moves when the next answer comes.
  const table = useMemo(() => {
    if (!turn) return null;
    const start = turnStartOf(root) ?? readAt - turn.totalMs;
    const end = Math.max(start + 1, turn.open ? readAt : start + turn.totalMs);
    return spanTable({ agents, sessionId: root.sessionId, start, end, now: readAt });
    // The agents are mutated in place and keep their identity: the revision says the calls changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn, agents, root.sessionId, revision, readAt]);
  if (turn === undefined) {
    if (failed) return <p className="insp-note" role="status">This turn could not be read. Trying again.</p>;
    return <p className="insp-note insp-time-load" role="status"><Loader size="s" /><span>Reading this turn…</span></p>;
  }
  if (turn === null || !table) return <p className="insp-note">No turn recorded yet.</p>;
  return <TimeBody turn={turn} table={table} now={now} />;
}

/** The tab's body for a turn, drawn from what it is given and nothing else. */
export function TimeBody({ turn, table, now }: { turn: SessionTurn; table: SpanTable; now: number }) {
  const which = turn.open ? "this turn" : "last turn";
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setFolded(current => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const pieces = turnPieces(turn);
  const shown = table.rows.filter(row => !row.under.some(key => folded.has(key)));
  return (
    <>
      <div className="insp-head">
        <span className="insp-title">Where the time went</span>
        <span className="insp-qual">{which}</span>
      </div>
      <dl className="insp-time-stats">
        <Stat label={turn.open ? "This turn" : "Last turn"} value={turnSpan(turn.totalMs)} />
        <Stat label="Waiting on you" value={turnSpan(turn.youMs)} tone="warn" />
        <Stat label="Claude" value={turnSpan(turn.claudeMs)} />
        <Stat label="This machine" value={turnSpan(turn.machineMs)} />
      </dl>
      <div className="insp-time-split">
        <p className="insp-time-share"><b>{waitingShare(turn)}%</b> of {which} was waiting on you</p>
        <div className="insp-time-bar" role="img" aria-label={`Waiting on you ${turnSpan(turn.youMs)}, Claude ${turnSpan(turn.claudeMs)}, this machine ${turnSpan(turn.machineMs)}`}>
          {pieces.map(piece => <i key={piece.lane} data-lane={piece.lane} style={{ flexGrow: piece.ms }} />)}
        </div>
      </div>
      {table.rows.length > 0 && (
        <div className="insp-time-table" role="table" aria-label="Calls in this turn">
          <div className="insp-time-axis" role="row">
            <span role="columnheader">Span</span>
            <span className="insp-time-ticks" aria-hidden="true">{axisTicks(table).map((tick, i) => <span key={i}>{tick}</span>)}</span>
          </div>
          {shown.map(row => <SpanLine key={row.key} row={row} table={table} now={now} folded={folded.has(row.key)} onToggle={toggle} />)}
        </div>
      )}
      <p className="insp-note">Waiting on you is part of the turn. It never counts as Claude or machine time.</p>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="insp-time-stat" data-tone={tone}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SpanLine({ row, table, now, folded, onToggle }: {
  row: SpanRow; table: SpanTable; now: number; folded: boolean; onToggle: (key: string) => void;
}) {
  const box = barBox(row, table, now);
  const took = row.to === null ? null : turnSpan(row.to - row.from);
  return (
    <div className="insp-time-row" role="row" data-group={row.group || undefined} style={{ "--depth": row.depth } as CSSProperties}>
      <span className="insp-time-name" role="cell">
        {row.group ? (
          <button type="button" className="insp-time-fold" aria-expanded={!folded} aria-label={`${folded ? "Show" : "Hide"} the calls of ${row.name}`} onClick={() => onToggle(row.key)}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="m3 4.5 3 3 3-3" />
            </svg>
          </button>
        ) : null}
        <span className="insp-time-op">{row.name}</span>
        {row.arg && <span className="insp-time-arg">{row.arg}</span>}
        {took && <span className="insp-time-took">{took}</span>}
      </span>
      <span className="insp-time-lane" role="cell">
        {row.waitingSince !== null ? (
          <span className="insp-time-wait" style={box.left > 40 ? { right: 0 } : { left: `${box.left}%` }}>waiting on you · {turnSpan(now - row.waitingSince)}</span>
        ) : (
          <i className="insp-time-span" data-group={row.group || undefined} style={{ left: `${box.left}%`, width: `${box.width}%` }} />
        )}
      </span>
    </div>
  );
}
