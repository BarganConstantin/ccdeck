// The usage panel's period strip — today, month, all — and the sentence it
// speaks while a slower period is read.
//
// Lifted out of UsagePanel.tsx unchanged. The strip is one tab stop with arrows,
// Home and End across it and Enter or Space to commit (see role="toolbar"
// below), so the refs its arrows move focus through are its own now. The period
// itself, and whether a read for it is out, stay the panel's: they decide which
// figures are drawn, and the strip shows both and changes only the period.
import { useRef } from "react";
import { nounFor, PERIODS, periodFocusMove, type PeriodKey } from "../usage-from-ccusage";

export default function UsagePeriodStrip({ period, rangePending, setPeriod }: {
  /** The pressed period: the reader's intent, which is not always the one shown yet. */
  period: PeriodKey;
  /** A read for the pressed period is out, and what is on screen is not it. */
  rangePending: boolean;
  setPeriod: (period: PeriodKey) => void;
}) {
  // One tab stop for the strip, not three. `role="toolbar"` is what pays for
  // that — see the markup — and moving the ring needs the buttons themselves.
  const periodRefs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <>
      {/* `.uh-range` rather than a new set of chips: it is the same control
          the history modal's presets use, it already carries #583's
          luminance inversion for the selected chip, and toggle-state
          coverage is written against that selector. Reusing it is also the
          honest signal to a reader — these two surfaces read the same
          ccusage data over the same kind of range. */}
      {/* role="toolbar", not role="group", and the difference is a bill this
          strip now pays. #381 deleted role="tablist" from the history
          modal's range strip because a tablist promises one tab stop, arrows
          between the members and a tabpanel each, and that strip could
          honour none of the three. The third clause is still false here —
          these words select a range, they do not reveal a region — so
          tablist stays wrong. But the first two are exactly what a toolbar
          promises and nothing more, and three of the Usage panel's five tab
          stops going to one three-way choice is the defect they fix. So:
          one stop, arrows and Home/End across it, Enter or Space to commit.
          tablist-contract.test.ts holds any file that says "tab" to the
          whole model; this one says "toolbar" and carries the whole of that.

          The stop is the SELECTED segment rather than the last-focused one.
          The strip has three members and no scroll, so there is no long walk
          to resume, and re-entering on the period actually being shown is
          the more useful place to land than wherever the ring was left. */}
      <div
        className="uh-range up-period"
        role="toolbar"
        aria-orientation="horizontal"
        aria-label="Period"
        aria-busy={rangePending || undefined}
        onKeyDown={e => {
          // From where the RING is, not from where the selection is. Arrows
          // that reckon off `period` walk one step from the selected segment
          // every time and then stop: press Right three times from `today`
          // and you get `month`, `month`, `month`. The origin has to be the
          // segment the key was pressed on, which is what bubbled the event.
          const from = periodRefs.current.indexOf(e.target as HTMLButtonElement);
          if (from < 0) return;
          const to = periodFocusMove(e.key, from);
          if (to === null) return;
          e.preventDefault();
          periodRefs.current[to]?.focus();
        }}
      >
        {PERIODS.map((p, i) => (
          <button
            key={p.key}
            type="button"
            ref={el => { periodRefs.current[i] = el; }}
            tabIndex={period === p.key ? 0 : -1}
            aria-pressed={period === p.key}
            // Only ever on the pressed one, which is what lets the CSS key the
            // pulse on this attribute alone: a rule that also named
            // `[aria-pressed="true"]` would join the set of scoped state rules
            // usage-series-contrast.test.ts holds to exactly three, and this
            // is a temporary activity rather than a fourth way of being
            // selected.
            data-pending={period === p.key && rangePending ? "" : undefined}
            // While it reads, the tooltip says what it is reading. The wait is
            // the deck walking transcripts on this disk, and a reader who
            // knows that reads two and a half seconds as work rather than as a
            // request that may not come back.
            title={period === p.key && rangePending ? `Reading ${p.noun} from the transcripts on this machine…` : p.hint}
            className="uh-range-btn"
            onClick={() => setPeriod(p.key)}
          >{p.label}</button>
        ))}
      </div>
      {/* WHAT THE WAIT SOUNDS LIKE, since until now it made no sound at all: a
          reader who cannot see the strip pressed `all`, and for two and a half
          seconds nothing was announced, nothing was disabled, and the figures
          they could read were the previous period's.
          Always mounted with only its text moving — App.tsx's blocked-session
          region carries the whole argument, and the half that matters here is
          that a live region registers when it ENTERS the tree, so text arriving
          in the same tick as the region is routinely never spoken. Rendering
          this only while pending would put the region and its one sentence on
          screen together, which is the delivery screen readers are least
          reliable about, and would take it away again before it could say the
          wait was over.
          Polite, because a figure that is two seconds late costs nothing and
          talking over the reader costs a sentence. `aria-atomic` because half
          of this only means the wrong thing. */}
      <div className="vis-hidden" role="status" aria-atomic="true">
        {rangePending ? `Reading ${nounFor(period, period)}…` : ""}
      </div>
    </>
  );
}
