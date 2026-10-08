// The accounts panel's Account capacity report (#1707, reworked in #1713): how
// many Claude accounts are ready now, what the 5-hour and the 7-day windows
// have left across them, and each account's own reading and state.
//
// What counts, how it is averaged, why a reading is left out and what a row's
// state is are accounts-usage-report.ts's. This file draws it, in the order a
// glance needs: the accounts ready, then the two windows' capacity, then the
// rows, then — folded away — how it is worked out. It keeps the Projects
// report's dialog shell — the same × that takes focus on open, the same portal
// out of the panel — so the two reports opened from this panel read as one
// family.
//
// NOTHING HERE FETCHES. The rows are the panel's own roster, handed in on
// every poll, and the countdowns run on the panel's clock, so an open report
// moves with the panel and a second polling loop never starts. Its rows keep
// the order the panel had when it was opened — a poll does not move them under
// the reader, the rule #1579 gave the panel's own list — and an account that
// arrives after that goes at the end. A column header orders them once, when
// it is pressed, and that order is held the same way until the next press. A
// poll that fails keeps the last roster on screen and says so, and so does one
// that comes back empty, rather than the report emptying under the reader (the
// Projects report's #1412).
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { Account } from "../claude-accounts";
import { resetCountdown } from "../relative-time";
import { holdOrder } from "../other-accounts-order";
import {
  freshness, heldNote, nextReportSort, REPORT_WINDOWS, shownUsed, sortReportRows, usageReport, usedAndAvailable,
  type Cell, type ReportRow, type ReportSort, type Status, type WindowTotal,
} from "../accounts-usage-report";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { SortHead } from "./SortHead";
import { useCountUp } from "../use-count-up";

/** How full a reading is, in the inks the panel's rows use: the warning past
 *  70% used and the error past 90%. A warning, never a state — see statusOf. */
function level(pct: number): "mid" | "hi" | undefined {
  return pct >= 90 ? "hi" : pct >= 70 ? "mid" : undefined;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Whose reset the card's countdown is, and what else comes back with it —
 *  on hover, since the card says only when (#1713). */
function soonest(next: NonNullable<WindowTotal["nextReset"]>): string {
  const more = next.more > 0 ? `, and ${plural(next.more, "more account", "more accounts")} in the same minute` : "";
  return `First: ${next.name} (${shownUsed(next.pct)}% used)${more}`;
}

/**
 * One window's capacity. REMAINING, because a card is read for how much is
 * left; the rows below keep what each account has USED, as the panel does,
 * and both say which in words. The bar is the same remaining, continuous and
 * quiet, and takes the warning ink only once the window runs low. It is an
 * average, and an average can hide five spent accounts behind five fresh ones,
 * which is why it sits under the count of accounts ready rather than above it.
 */
function WindowSum({ w, nowSec }: { w: WindowTotal; nowSec: number }) {
  const id = `ap-report-${w.id}`;
  // Only the one exclusion there is: an account never read, which has no
  // number to count. A stale one counts at its last reading and its row says
  // so, so the card does not say it again.
  const never = w.total - w.included;
  const basis = never > 0 && <p className="ap-report-basis">{never} never read</p>;
  const { used, available } = usedAndAvailable(w.used ?? 0);
  // Counted in on opening, and on from where it is when a poll moves it.
  const shownLeft = Math.round(useCountUp(available, { countIn: true }));
  if (w.used == null) {
    return (
      <section className="ap-report-sum" aria-labelledby={id}>
        <h3 className="ap-report-win" id={id}>{w.long} window</h3>
        <p className="ap-report-none">No account has a {w.long} reading yet.</p>
        {basis}
      </section>
    );
  }
  const reset = w.nextReset ? resetCountdown(w.nextReset.at, nowSec) : null;
  return (
    <section className="ap-report-sum" aria-labelledby={id}>
      <h3 className="ap-report-win" id={id}>{w.long} window</h3>
      <p className="ap-report-left"><b>{shownLeft}%</b> remaining</p>
      {/* A transform, not a width, as the Usage panel's quota bars are: a new
          reading moves it on the compositor, and it grows in from the left
          when the dialog opens (see the sheet). */}
      <div className="ap-report-meter" data-level={level(used)} aria-hidden>
        {/* The fraction as a variable the sheet scales by, not an inline
            transform: an inline one outranks the sheet's starting style, and
            the bar would stand at its reading from the first frame. */}
        <i style={{ "--left": available / 100 } as CSSProperties} />
      </div>
      {reset && w.nextReset && (
        // WHOSE, ON THE LINE. Each account keeps its own window and its own
        // clock, so this is one account's reset, not the window's: "Resets in
        // 25m" under 88% read as all of it coming back then. The name is the
        // one part that may be cut; the rest stays whole.
        <p className="ap-report-reset" title={soonest(w.nextReset)}>
          <span>Next reset in <span className="ap-report-num">{reset}</span></span>
          <span aria-hidden>·</span>
          <span className="ap-report-who">{w.nextReset.name}</span>
          {w.nextReset.more > 0 && <span className="ap-report-more">+{w.nextReset.more}</span>}
          {/* The rest of it, for the reader a hover never reaches. */}
          <span className="vis-hidden">. {soonest(w.nextReset)}</span>
        </p>
      )}
      {basis}
    </section>
  );
}

/** One account's use of one window, and when it resets — or, for a reading
 *  that is not current, the last number dimmed, never a zero it was not given,
 *  and what the totals above do with it. Why it is not current is the row's
 *  state to say, once. */
function UsedCell({ cell, nowSec }: { cell: Cell; nowSec: number }) {
  if (!cell.counted && cell.reset) {
    // RESET, NOT THE OLD NUMBER. The cards take this window as unused, so a
    // row printing the last reading added up to a different total from the
    // one above it. Not "0%" either: nobody has read this window since it
    // came back. When and at what it was read are on hover, and said.
    return (
      <td className="ap-report-cell" data-uncounted="" title={cell.reset}>
        <span className="ap-report-pct"><span aria-hidden>reset</span><span className="vis-hidden">{cell.reset}</span></span>
      </td>
    );
  }
  if (!cell.counted) {
    // WHAT THE TOTAL DOES WITH IT, said. Since #1713 a window's total takes
    // every number there is — an old reading, and one behind a login no
    // switch gets past, at its last value — and leaves out only a window never
    // read. Every one of these cells used to end ", not counted", which told a
    // screen reader the card's average left out a number it had added in.
    const said = cell.estimate == null ? ", not counted" : ", last reading, counted as is";
    return (
      <td className="ap-report-cell" data-uncounted="">
        <span className="ap-report-pct">
          {cell.last == null ? <><span aria-hidden>—</span><span className="vis-hidden">no reading</span></> : `${shownUsed(cell.last)}%`}
        </span>
        <span className="vis-hidden">{said}</span>
      </td>
    );
  }
  const reset = cell.resetAt != null ? resetCountdown(cell.resetAt, nowSec) : null;
  return (
    <td className="ap-report-cell">
      <span className="ap-report-pct" data-level={level(cell.pct)}>{shownUsed(cell.pct)}%</span>
      {reset && <span className="ap-report-in"><span className="vis-hidden">resets in </span>{reset}</span>}
    </td>
  );
}

const STATE_WORD: Record<Status, string> = {
  ready: "Ready",
  limited: "Limited",
  exhausted: "Exhausted",
  stale: "Stale",
};

/** What the row can do now, as a mark and a word, on one line. */
function StateCell({ row }: { row: ReportRow }) {
  return (
    <td className="ap-report-state" data-status={row.status}>
      <span className="ap-report-state-word"><i aria-hidden />{STATE_WORD[row.status]}</span>
    </td>
  );
}

/** How current the row's numbers are: "now", an age, or why there are none. */
function UpdatedCell({ row, nowSec }: { row: ReportRow; nowSec: number }) {
  const f = freshness(row, nowSec);
  return <td className="ap-report-upd" data-old={f.old ? "" : undefined}>{f.text}</td>;
}

/** The disclosure's mark: drawn, in the stroke the deck's other glyphs use. */
function InfoMark() {
  return (
    <svg className="ap-report-how-mark" viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7.2v4.1M8 4.8v.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * What the dialog holds: the accounts ready, the two windows' capacity, the
 * rows, and how they add up. Its own component so the suite can draw it — a
 * portal has no server render.
 */
export function UsageReportBody({ accounts, nowSec, held, sort = null, onSort = () => {} }: {
  /** The rows, in the order to draw them. */
  accounts: readonly Account[];
  nowSec: number;
  /** Why these are the last readings rather than this poll's, or null. */
  held: string | null;
  /** The column the rows were last ordered by, or null for the panel's order. */
  sort?: ReportSort | null;
  onSort?: (next: ReportSort) => void;
}) {
  const report = usageReport(accounts, nowSec);
  const total = report.rows.length;
  const shownReady = Math.round(useCountUp(report.roomInBoth, { countIn: true }));
  return (
    // A scroll region with a name: with ten accounts at a phone's width, or
    // twenty-five anywhere, it scrolls, and the browsers that make a scroller a
    // Tab stop of their own read out whatever it is called. No tabIndex of the
    // deck's own — it invents no tab stops (canvas-keyboard.test.ts).
    <div className="ap-proj-body ap-report-body" role="region" aria-label="Report">
      {held && <p className="ap-report-held">{held}</p>}
      {/* The question a reader brings, answered first and loudest: how many
          accounts can be worked on now. The same count as the rows that say
          Ready, by construction. */}
      <p className="ap-report-lead">
        <b>{shownReady}</b> of {plural(total, "Claude account", "Claude accounts")} ready
      </p>
      <div className="ap-report-sums">
        {report.windows.map(w => <WindowSum key={w.id} w={w} nowSec={nowSec} />)}
      </div>

      <table className="ap-report-table">
        <caption className="vis-hidden">Each account's use of each window, and what it can do now</caption>
        <colgroup>
          <col />
          {REPORT_WINDOWS.map(w => <col key={w.id} className="ap-report-col-win" />)}
          <col className="ap-report-col-state" />
          <col className="ap-report-col-upd" />
        </colgroup>
        <thead>
          <tr>
            <SortHead col="account" label="Account" sort={sort} next={nextReportSort} onSort={onSort} />
            {REPORT_WINDOWS.map(w => (
              <SortHead key={w.id} col={w.id} label={`${w.label} used`} sort={sort} next={nextReportSort} onSort={onSort} />
            ))}
            <SortHead col="status" label="Status" sort={sort} next={nextReportSort} onSort={onSort} />
            <SortHead col="updated" label="Updated" className="ap-report-upd-h" sort={sort} next={nextReportSort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {report.rows.map((r, i) => (
            // Its place in the list, for the sheet's stagger as the rows come in.
            <tr key={r.num} data-active={r.active ? "" : undefined} style={{ "--row": i } as CSSProperties}>
              <th scope="row" className="ap-report-acct">
                <span className="ap-report-acct-in">
                  <span className="ap-report-name" title={r.name}>{r.name}</span>
                  {r.active && <span className="ap-report-current">Current</span>}
                  {r.heldOut && <span className="ap-report-tag">held out</span>}
                </span>
              </th>
              {REPORT_WINDOWS.map(w => <UsedCell key={w.id} cell={r.cells[w.id]} nowSec={nowSec} />)}
              <StateCell row={r} />
              <UpdatedCell row={r} nowSec={nowSec} />
            </tr>
          ))}
        </tbody>
      </table>

      <details className="ap-report-how">
        <summary><InfoMark />How usage is calculated</summary>
        <div className="ap-report-how-body">
          <p>
            Every account here, at its last reading: <b>used</b> is their average, and <b>remaining</b> is
            the rest. A window that has reset since its last reading counts as unused, and its row
            says <b>reset</b>.
          </p>
          <p>
            <b>Ready</b> has room in both windows. <b>Limited</b> is at the limit of one, and <b>Exhausted</b> of
            both. <b>Stale</b> was never read, or is signed out.
          </p>
        </div>
      </details>
    </div>
  );
}

export default function AccountsUsageReport({ accounts, order, failed, nowSec, onClose }: {
  /** The panel's roster, or null while a poll could not read it. */
  accounts: readonly Account[] | null;
  /** The panel's order when the report opened, by laneKey. */
  order: readonly string[];
  /** The line the panel's failed reload says, or null. */
  failed: string | null;
  /** The panel's clock, in seconds. */
  nowSec: number;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  const scrimPress = useScrimDismiss(onClose);
  // The last roster that had anyone in it — see the header. Keyed on the
  // roster the panel holds, which changes once a poll and not once a render.
  const [shown, setShown] = useState<readonly Account[]>(accounts ?? []);
  useEffect(() => { if (accounts && accounts.length > 0) setShown(accounts); }, [accounts]);
  const held = heldNote(failed, !accounts || accounts.length === 0, shown.length > 0);
  // A pressed column's order, taken when it was pressed and held like the
  // panel's: the rows do not move under the reader between presses. Worked out
  // from the panel's order each time, so ties land the same way whichever
  // column was pressed before.
  const [sorted, setSorted] = useState<{ sort: ReportSort; order: string[] } | null>(null);
  const rows = holdOrder(shown, sorted?.order ?? order);
  const sortBy = (next: ReportSort) => {
    const byPanel = usageReport(holdOrder(shown, order), nowSec).rows;
    setSorted({ sort: next, order: sortReportRows(byPanel, next).map(r => r.key) });
  };

  // Portalled to <body>: opened from inside AccountsPanel, and a dialog left in
  // the panel's subtree is laid out by it (panel-modal-portal).
  return createPortal(
    <div className="modal-backdrop" {...scrimPress} role="presentation">
      <div ref={dialogRef} className="modal ap-report-modal" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="ap-report-title">
        <header className="ap-proj-head">
          {/* No subtitle: the count it carried is the lead's, one line down, and
              "Claude" moved into the lead with it (#1713). */}
          <div className="ap-proj-titlewrap">
            <h2 className="ap-proj-title" id="ap-report-title">Account capacity</h2>
          </div>
          <button ref={closeRef} type="button" className="glyph-btn ap-proj-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        {/* Mounted with the dialog and only its words changing, so a reading
            held back is announced: a live region that arrives with its text is
            the one screen readers drop. */}
        <div className="vis-hidden" role="status" aria-atomic="true">{held ?? ""}</div>
        <UsageReportBody accounts={rows} nowSec={nowSec} held={held} sort={sorted?.sort ?? null} onSort={sortBy} />
      </div>
    </div>,
    document.body,
  );
}
