// The Account capacity report (#1707, reworked in #1713): how many Claude
// accounts are ready now, what the 5-hour and the 7-day windows have left
// across them, and each account's own reading and state. And its Reset
// calendar: when those windows come back. Each is its own door on the left
// stripe and opens alone, titled for itself (AccountCapacityDialog.tsx).
//
// What counts, how it is averaged, why a reading is left out and what a row's
// state is are accounts-usage-report.ts's. This file draws it, in the order a
// glance needs: the accounts ready, then the two windows' capacity, then the
// rows, then — folded away — how it is worked out. It keeps the Projects
// report's dialog shell — the same × that takes focus on open, the same portal
// to <body> — so the two account reports read as one family.
//
// NOTHING HERE FETCHES. The rows are a roster handed in on every poll, and the
// countdowns run on the caller's clock — AccountCapacityDialog reads both the
// way the accounts panel does. Its rows keep the panel's order at opening — a
// poll does not move them under the reader, the rule #1579 gave the panel's
// own list — and an account that arrives after that goes at the end. A column header orders them once, when
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
  heldNote, nextReportSort, REPORT_WINDOWS, shownUsed, sortReportRows, updatedLine, usageReport, usedAndAvailable,
  type Cell, type ReportRow, type ReportSort, type Status, type WindowTotal,
} from "../accounts-usage-report";
import { Dialog } from "./Dialog";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { SortHead } from "./SortHead";
import { useCountUp } from "../use-count-up";
import AccountResetCalendar, { type ResetScope } from "./AccountResetCalendar";
import { currentLanguage, useT, type TFunction } from "../i18n";
import { Rich, tNodes } from "../accounts-rich";

/** How full a reading is, in the inks the panel's rows use: the warning past
 *  70% used and the error past 90%. A warning, never a state — see statusOf. */
function level(pct: number): "mid" | "hi" | undefined {
  return pct >= 90 ? "hi" : pct >= 70 ? "mid" : undefined;
}

/** Whose reset the card's countdown is, and what else comes back with it —
 *  on hover, since the card says only when (#1713). */
function soonest(next: NonNullable<WindowTotal["nextReset"]>, t: TFunction): string {
  const pct = shownUsed(next.pct);
  return next.more > 0
    ? t("accounts.rep.firstMore", { name: next.name, pct, count: next.more })
    : t("accounts.rep.first", { name: next.name, pct });
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
  const t = useT();
  const win = t(`accounts.win.${w.id}`);
  const id = `ap-report-${w.id}`;
  // Only the one exclusion there is: an account never read, which has no
  // number to count. A stale one counts at its last reading and its row says
  // so, so the card does not say it again.
  const never = w.total - w.included;
  const basis = never > 0 && <p className="ap-report-basis">{t("accounts.rep.neverReadN", { n: never })}</p>;
  const { used, available } = usedAndAvailable(w.used ?? 0);
  // Counted in on opening, and on from where it is when a poll moves it.
  const shownLeft = Math.round(useCountUp(available, { countIn: true }));
  if (w.used == null) {
    return (
      <section className="ap-report-sum" aria-labelledby={id}>
        <h3 className="ap-report-win" id={id}>{t("accounts.rep.winTitle", { win })}</h3>
        <p className="ap-report-none">{t("accounts.rep.noWinReading", { win })}</p>
        {basis}
      </section>
    );
  }
  const reset = w.nextReset ? resetCountdown(w.nextReset.at, nowSec) : null;
  return (
    <section className="ap-report-sum" aria-labelledby={id}>
      <h3 className="ap-report-win" id={id}>{t("accounts.rep.winTitle", { win })}</h3>
      <p className="ap-report-left"><Rich text={t("accounts.rep.avgLeft", { left: shownLeft })} bold="b" /></p>
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
        <p className="ap-report-reset" title={soonest(w.nextReset, t)}>
          <span>{tNodes(t, "accounts.rep.nextReset", { time: <span className="ap-report-num">{reset}</span> })}</span>
          <span aria-hidden>·</span>
          <span className="ap-report-who">{w.nextReset.name}</span>
          {w.nextReset.more > 0 && <span className="ap-report-more">+{w.nextReset.more}</span>}
          {/* The rest of it, for the reader a hover never reaches. */}
          <span className="vis-hidden">. {soonest(w.nextReset, t)}</span>
        </p>
      )}
      {basis}
    </section>
  );
}

/** The line under a window's figure: when that account's window resets. A
 *  recorded reset has its line even when the usage reading is old or the login
 *  has expired. The exact time stays on the line, for the eye on hover and for a
 *  screen reader; a passed reset never reads as a future one, and a window
 *  with no recorded reset has no line, only the words for a screen reader. */
function ResetLine({ at, nowSec }: { at: number | null; nowSec: number }) {
  const t = useT();
  if (at == null) return <span className="vis-hidden" data-sub="">{t("accounts.rep.noResetSr")}</span>;
  const when = new Date(at * 1000);
  const countdown = resetCountdown(at, nowSec);
  const whenText = when.toLocaleString(currentLanguage());
  return (
    <span className="ap-report-win-sub" data-sub="" title={t("accounts.rep.recorded", { when: whenText })}>
      <time dateTime={when.toISOString()}>{countdown ? t("accounts.row.resetsIn", { time: countdown }) : t("accounts.rep.dueAwaiting")}</time>
      <span className="vis-hidden">{t("accounts.rep.recordedSr", { when: whenText })}</span>
    </span>
  );
}

/** The window's bar: how much of it is used, 140 wide and 2 tall, drawn with
 *  the sums' own meter. Muted until 70%, the text ink to 89%, the error ink
 *  from 90%. A reading that is not current wears the ink of its last number
 *  too: the bar says how full the window was, the dimmed percentage and the
 *  state's line say it is not current. */
function UsedBar({ pct, lvl }: { pct: number; lvl?: "mid" | "hi" }) {
  return <span className="ap-report-meter" data-level={lvl} aria-hidden><i style={{ "--left": shownUsed(pct) / 100 } as CSSProperties} /></span>;
}

/** One account's use of one window — or, for a reading
 *  that is not current, the last number dimmed, never a zero it was not given,
 *  and what the totals above do with it. Why it is not current is the row's
 *  state to say, once. Then, under the figure, when that window resets. */
function WindowCell({ cell, at, nowSec, win }: { cell: Cell; at: number | null; nowSec: number; win: string }) {
  const t = useT();
  const label = <span className="ap-report-mobile-label" aria-hidden="true">{t("accounts.rep.winTitle", { win })}</span>;
  if (!cell.counted) {
    // WHAT THE TOTAL DOES WITH IT, said. Since #1713 a window's total takes
    // every number there is — an old reading, and one behind a login no
    // switch gets past, at its last value — and leaves out only a window never
    // read. Every one of these cells used to end ", not counted", which told a
    // screen reader the card's average left out a number it had added in.
    const said = cell.estimate == null ? t("accounts.rep.notCounted") : t("accounts.rep.lastCounted");
    return (
      <td className="ap-report-cell" data-uncounted="" title={cell.reset ?? undefined}>{label}
        <span className="ap-report-fig">
          {cell.last != null && <UsedBar pct={cell.last} lvl={level(cell.last)} />}
          <span className="ap-report-pct">
            {cell.last == null ? <><span aria-hidden>—</span><span className="vis-hidden">{t("accounts.rep.noReadingSr")}</span></> : `${shownUsed(cell.last)}%`}
          </span>
        </span>
        <span className="vis-hidden">{cell.reset ? t("accounts.rep.awaiting", { reset: cell.reset, said }) : said}</span>
        <ResetLine at={at} nowSec={nowSec} />
      </td>
    );
  }
  const lvl = level(cell.pct);
  return (
    <td className="ap-report-cell">{label}
      <span className="ap-report-fig">
        <UsedBar pct={cell.pct} lvl={lvl} />
        <span className="ap-report-pct" data-level={lvl}>{shownUsed(cell.pct)}%</span>
      </span>
      <ResetLine at={at} nowSec={nowSec} />
    </td>
  );
}

/** What the row can do now, in a word, and how current the numbers it was
 *  judged on are: "Updated now", "Updated 4m ago", or why there are none. */
function StateCell({ row, nowSec }: { row: ReportRow; nowSec: number }) {
  const t = useT();
  const f = updatedLine(row, nowSec, t);
  return (
    <td className="ap-report-state" data-status={row.status}><span className="ap-report-mobile-label" aria-hidden="true">{t("accounts.rep.colStatus")}</span>
      <span className="ap-report-state-word">{t(`accounts.rep.state.${row.status}`)}</span>
      <span className="ap-report-win-sub" data-old={f.old ? "" : undefined}>{f.text}</span>
    </td>
  );
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
  const t = useT();
  const report = usageReport(accounts, nowSec, t);
  const total = report.rows.length;
  const shownReady = Math.round(useCountUp(report.roomInBoth, { countIn: true }));
  return (
    // A scroll region with a name: with ten accounts at a phone's width, or
    // twenty-five anywhere, it scrolls, and the browsers that make a scroller a
    // Tab stop of their own read out whatever it is called. No tabIndex of the
    // deck's own — it invents no tab stops (canvas-keyboard.test.ts).
    <div className="ap-proj-body ap-report-body" role="region" aria-label={t("accounts.rep.regionLabel")}>
      {held && <p className="ap-report-held">{held}</p>}
      {/* The question a reader brings, answered first and loudest: how many
          accounts can be worked on now. The same count as the rows that say
          Ready, by construction. */}
      <div className="ap-report-overview"><p className="ap-report-lead">
        <Rich text={t("accounts.rep.lead", { ready: shownReady, count: total })} bold="b" />
      </p><p className="ap-report-confidence">{t("accounts.rep.basedOn")}{report.rows.some(row => Object.values(row.cells).some(cell => !cell.counted && cell.reset)) && t("accounts.rep.elapsedNeedFresh")}{report.rows.some(row => row.heldOut) && t("accounts.rep.heldN", { n: report.rows.filter(row => row.heldOut).length })}</p></div>
      <div className="ap-report-sums">
        {report.windows.map(w => <WindowSum key={w.id} w={w} nowSec={nowSec} />)}
      </div>

      <div className="ap-report-table-scroll" role="region" aria-label={t("accounts.rep.tableLabel")}>
      <table className="ap-report-table">
        <caption className="vis-hidden">{t("accounts.rep.caption")}</caption>
        <colgroup>
          <col className="ap-report-col-acct" />
          <col className="ap-report-col-state" />
          {REPORT_WINDOWS.map(w => <col key={w.id} className="ap-report-col-win" />)}
        </colgroup>
        <thead>
          <tr>
            <SortHead col="account" label={t("accounts.rep.colAccount")} sort={sort} next={nextReportSort} onSort={onSort} />
            <SortHead col="status" label={t("accounts.rep.colStatus")} sort={sort} next={nextReportSort} onSort={onSort} />
            {REPORT_WINDOWS.map(w => <SortHead key={w.id} col={w.id} label={t("accounts.rep.winTitle", { win: t(`accounts.win.${w.id}`) })} sort={sort} next={nextReportSort} onSort={onSort} />)}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((r, i) => (
            // Its place in the list, for the sheet's stagger as the rows come in.
            <tr key={r.num} data-active={r.active ? "" : undefined} style={{ "--row": i } as CSSProperties}>
              <th scope="row" className="ap-report-acct">
                <span className="ap-report-acct-in">
                  <span className="ap-report-name" title={r.name}>{r.name}</span>
                  {r.active && <span className="ap-report-current">{t("accounts.current")}</span>}
                  {r.heldOut && <span className="ap-report-tag">{t("accounts.heldOut")}</span>}
                </span>
              </th>
              <StateCell row={r} nowSec={nowSec} />
              {REPORT_WINDOWS.map(w => <WindowCell key={w.id} cell={r.cells[w.id]} at={r.resets[w.id]} nowSec={nowSec} win={t(`accounts.win.${w.id}`)} />)}
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <details className="ap-report-how">
        <summary><InfoMark />{t("accounts.rep.how")}</summary>
        <div className="ap-report-how-body">
          <p><Rich text={t("accounts.rep.howOne")} bold="b" /></p>
          <p><Rich text={t("accounts.rep.howTwo")} bold="b" /></p>
        </div>
      </details>
    </div>
  );
}

/** The dialog's two views: the accounts' rows, or when their windows reset. */
export type CapacityView = "accounts" | "calendar";

/** Each view's title (accounts.rep.viewAccounts / viewCalendar). One view per
 *  opening, from its own door on the stripe: no tabs between them. */
const VIEW_TITLE_KEY: Record<CapacityView, string> = { accounts: "accounts.rep.viewAccounts", calendar: "accounts.rep.viewCalendar" };

export default function AccountsUsageReport({ accounts, order, failed, nowSec, onClose, view }: {
  /** The panel's roster, or null while a poll could not read it. */
  accounts: readonly Account[] | null;
  /** The panel's order when the report opened, by laneKey. */
  order: readonly string[];
  /** The line the panel's failed reload says, or null. */
  failed: string | null;
  /** The panel's clock, in seconds. */
  nowSec: number;
  onClose: () => void;
  /** Which of the left stripe's two doors opened it. */
  view: CapacityView;
}) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  const scrimPress = useScrimDismiss(onClose);
  const [resetScope, setResetScope] = useState<ResetScope>("upcoming");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // Retain a missing/failed snapshot, but accept an authoritative empty roster. Keyed on the
  // roster the panel holds, which changes once a poll and not once a render.
  const [shown, setShown] = useState<readonly Account[]>(accounts ?? []);
  useEffect(() => { if (accounts != null) setShown(accounts); }, [accounts]);
  const held = heldNote(failed, accounts == null, shown.length > 0, t);
  // A pressed column's order, taken when it was pressed and held like the
  // panel's: the rows do not move under the reader between presses. Worked out
  // from the panel's order each time, so ties land the same way whichever
  // column was pressed before.
  const [sorted, setSorted] = useState<{ sort: ReportSort; order: string[] } | null>(null);
  const rows = holdOrder(shown, sorted?.order ?? order);
  const sortBy = (next: ReportSort) => {
    const byPanel = usageReport(holdOrder(shown, order), nowSec, t).rows;
    setSorted({ sort: next, order: sortReportRows(byPanel, next).map(r => r.key) });
  };

  // Portalled to <body>, like the panel's other reports (panel-modal-portal).
  return createPortal(
    <Dialog scrim={scrimPress} dialogRef={dialogRef} className="ap-report-modal" data-view={view} labelledBy="ap-report-title">
        <header className="modal-head ap-proj-head">
          {/* No subtitle: the count it carried is the lead's, one line down, and
              "Claude" moved into the lead with it (#1713). */}
          <div className="ap-proj-titlewrap">
            <h2 id="ap-report-title">{t(VIEW_TITLE_KEY[view])}</h2>
          </div>
          <button ref={closeRef} type="button" className="glyph-btn ap-proj-close" onClick={onClose} aria-label={t("accounts.rep.close")}>×</button>
        </header>
        {/* Mounted with the dialog and only its words changing, so a reading
            held back is announced: a live region that arrives with its text is
            the one screen readers drop. */}
        <div className="vis-hidden" role="status" aria-atomic="true">{held ?? ""}</div>
        {view === "accounts"
          ? <UsageReportBody accounts={rows} nowSec={nowSec} held={held} sort={sorted?.sort ?? null} onSort={sortBy} />
          : <AccountResetCalendar accounts={rows} nowSec={nowSec} held={held} selectedDate={selectedDate} onSelect={setSelectedDate} scope={resetScope} onScope={setResetScope} />}
    </Dialog>,
    document.body,
  );
}
