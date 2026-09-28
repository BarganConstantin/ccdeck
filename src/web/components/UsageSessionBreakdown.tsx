// The usage panel's per-session breakdown: the one section that shuts, and the
// rows behind it, from ccusage for a period or from the board right now.
//
// Lifted out of UsagePanel.tsx unchanged. It was an inline function called in
// place, so that the heading's title could count the rows it hides; that count
// is the component's first line now. Nothing here holds state: whether the
// section is open is the panel's, remembered across reloads, and every row,
// name and dot is the panel's too, handed in under the names the markup used.
import type { Dispatch, SetStateAction } from "react";
import type { BoardSessionRow } from "../board-usage";
import { fmtCost, UNPRICED_LABEL } from "../pricing";
import { fmtTokens } from "../token-format";
import type { AgentState } from "../types";
import { sessionListNote, type SessionCostRow, type SessionListScale } from "../usage-from-ccusage";
import { stateLabel } from "./AgentNode";

export default function UsageSessionBreakdown({
  fromRange, rangeSessionRows, boardSessionRows, boardStates, sessionsOpen, setSessionsOpen,
  periodNoun, sessionScale, staleCls,
}: {
  /** ccusage answered, so the rows are its sessions for the period. */
  fromRange: boolean;
  /** ccusage's sessions, cut at twelve and named from the board. */
  rangeSessionRows: SessionCostRow[];
  /** The board's sessions, when ccusage has not answered. */
  boardSessionRows: BoardSessionRow[];
  /** What the canvas is doing, by session id, for the dot on a ccusage row. */
  boardStates: ReadonlyMap<string, AgentState>;
  sessionsOpen: boolean;
  setSessionsOpen: Dispatch<SetStateAction<boolean>>;
  /** The words for the period the figures are of — "today", "this month". */
  periodNoun: string;
  /** Every ccusage row summed against the period's cost, for the heading's note. */
  sessionScale: SessionListScale;
  /** " up-stale" while a slower period loads, or "". */
  staleCls: string;
}) {
  const sessionCount = fromRange ? rangeSessionRows.length : boardSessionRows.length;
  return (
    <section className={`up-section${staleCls}`}>
      {/* WHAT A ccusage SESSION ROW IS, said on the heading rather than
          in a tooltip, because the reader can see the arithmetic fail
          without it: rows that add up past the figure above read as a
          bug in the panel until something on screen says otherwise.
          What the panel may NOT do is name the reason, because the
          reason changed under it. Through ccusage 20.0.20 a row carried
          the session's lifetime — `--since` picked WHICH sessions
          appeared and left their figures whole — and 20.0.21 scopes
          them to the window. The deck runs `ccusage@latest` and
          refreshes it daily, so both are live on real machines and
          either sentence is false on half of them.
          So the qualifier is measured: sessionListScale sums every row
          in the range against the period's own cost, and the heading
          speaks only when that sum really is the larger one. */}
      {/* THE ONE SECTION THAT SHUTS, and the chevron is what says so.
          Every other block in this panel is a fixed two or three rows;
          this one is as long as the reader's week and is the reason the
          panel scrolls. Shut, the panel is one screen.
          The <button> is inside the <h3> rather than instead of it —
          the ARIA disclosure pattern, and the one spelling that keeps
          the heading in the document outline while still giving the
          reader a real control. landmark-outline.test.ts reads these
          four headings as headings and would have lost one to a bare
          button. The whole row is the target, 250 x 24, because a
          chevron alone is a 9px hit area for a section-sized decision;
          the chevron is the affordance, not the control.
          The count goes on the title rather than into the row: shut,
          the reader cannot see how much is behind it, and that is the
          one fact the collapse actually takes away. Saying it in ink
          would be a third thing on a line that already carries two. */}
      <h3 className="up-section-title">
        <button
          type="button"
          className="up-disclose"
          aria-expanded={sessionsOpen}
          aria-controls="up-sessions"
          title={sessionsOpen
            ? "Hide the per-session breakdown"
            : `Show the per-session breakdown — ${sessionCount} session${sessionCount === 1 ? "" : "s"}`}
          onClick={() => setSessionsOpen(o => !o)}
        >
          By session
          {fromRange && (
            <span
              className="up-section-age"
              title={sessionListNote(periodNoun, sessionScale, fmtCost)}
            >active {periodNoun}</span>
          )}
          {/* Drawn, not typed. `.bw-chev` swaps two Unicode glyphs and
              is at the mercy of whichever font answers for them on
              Windows and Linux; a path is the same three strokes
              everywhere, and it can turn rather than be replaced. */}
          <svg className="up-chev" width="9" height="9" viewBox="0 0 10 10" fill="none"
               stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden>
            <path d="M2.2 3.6 5 6.4 7.8 3.6" />
          </svg>
        </button>
      </h3>
      {/* `hidden` rather than an unrendered branch: it takes the rows
          out of the accessibility tree and out of the tab order the
          same way, and it leaves `aria-controls` pointing at something
          that exists in both states, which is the whole contract of a
          disclosure. Twelve divs cost nothing to keep. */}
      <div className="up-sessions" id="up-sessions" hidden={!sessionsOpen}>
        {fromRange && rangeSessionRows.map(s => {
          const live = boardStates.get(s.sessionId);
          return (
            <div className="up-session-row" key={s.sessionId}>
              {/* A dot only for a session the canvas is drawing. The
                  rest of this list is history — ccusage remembers every
                  session that ever ran — and a "done" tick on a session
                  from three weeks ago would be reporting a state this
                  deck never observed. The placeholder keeps the label
                  column aligned between the two kinds of row. */}
              {live
                ? <>
                    <span className={`sl-dot state-${live}`} aria-hidden />
                    <span className="vis-hidden">{stateLabel(live)}</span>
                  </>
                : <span className="sl-dot up-dot-past" aria-hidden />}
              {/* ccusage names a session by its uuid, which is not a
                  name. The board's label is used when the board has one
                  — that join is the point of this table — and the first
                  segment of the uuid otherwise, under a title carrying
                  the whole of it. */}
              <span
                className={`up-session-label${s.label ? "" : " up-session-id"}`}
                title={s.label ? `${s.label}\n${s.sessionId}` : s.sessionId}
              >{s.label ?? s.sessionId.slice(0, 8)}</span>
              <span className="up-session-tokens">{fmtTokens(s.tokens)}</span>
              {s.cost > 0
                ? <span className="up-session-cost" title={s.models.join(", ") || undefined}>{fmtCost(s.cost)}</span>
                : <span className="up-session-cost up-unpriced">{UNPRICED_LABEL}</span>}
            </div>
          );
        })}
        {!fromRange && boardSessionRows.map(s => (
          <div className="up-session-row" key={s.sessionId}>
            {/* Same dot and the same hidden word as the session list
                (#373) — this row is a <div>, so its state is read as
                part of the line rather than as a control's name, but it
                was the same silence either way. Two defects here, not
                one: the dot also matched no rule at all, because every
                `.sl-dot` selector was scoped to `.session-list` and
                this panel is that sidebar's sibling. It was drawn as a
                zero-sized empty span, so this list reported the state
                in no channel whatsoever. */}
            <span className={`sl-dot state-${s.state}`} aria-hidden />
            <span className="vis-hidden">{stateLabel(s.state)}</span>
            <span className="up-session-label">{s.label}</span>
            <span className="up-session-tokens">{fmtTokens(s.inputTokens + s.outputTokens)}</span>
            {/* A mixed session keeps its figure and gains a title: the
                dollars are real, they are just not all of them, and a
                floor presented as a total is the one thing this panel
                must not print without saying so. */}
            {s.cost > 0
              ? (
                <span
                  className="up-session-cost"
                  title={s.unpricedTokens > 0
                    ? `${fmtTokens(s.unpricedTokens)} tokens in this session are on an unpriced model, so this is a floor`
                    : undefined}
                >{fmtCost(s.cost)}{s.unpricedTokens > 0 ? "+" : ""}</span>
              )
              : <span className="up-session-cost up-unpriced">{UNPRICED_LABEL}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
