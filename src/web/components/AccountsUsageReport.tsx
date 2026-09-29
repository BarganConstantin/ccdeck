// The accounts panel's Usage report (#1707): the 5-hour and the 7-day quota
// added up across every Claude account in the panel, and the rows it was
// added up from.
//
// What counts, how it is averaged and why a reading is left out are
// accounts-usage-report.ts's. This file draws it: two totals over a table, in
// the Projects report's dialog shell — the same header, the same × that takes
// focus on open, the same portal out of the panel — so the two reports opened
// from this panel read as one family.
//
// NOTHING HERE FETCHES. The rows are the panel's own roster, handed in on
// every poll, and the countdowns run on the panel's clock, so an open report
// moves with the panel and a second polling loop never starts. Its rows keep
// the order the panel had when it was opened — a poll does not move them under
// the reader, the rule #1579 gave the panel's own list — and an account that
// arrives after that goes at the end. A poll that fails keeps the last roster
// on screen and says so, and so does one that comes back empty, rather than
// the report emptying under the reader (the Projects report's #1412).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Account } from "../claude-accounts";
import { resetCountdown } from "../relative-time";
import { holdOrder } from "../other-accounts-order";
import {
  heldNote, usageReport, usedAndAvailable, type Cell, type ReportRow, type WindowTotal,
} from "../accounts-usage-report";
import { useModalDismiss } from "./use-modal-dismiss";

/** How full a reading is, in the inks the panel's rows use: the warning past
 *  70% and the error past 90%. */
function level(pct: number): "mid" | "hi" | undefined {
  return pct >= 90 ? "hi" : pct >= 70 ? "mid" : undefined;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One window's total. AVAILABLE LEADS, because it is the question — how much
 * is left — and used, the same fact the other way round, follows it smaller,
 * in the rows' warning ink once it is high. Under them, one mark per counted
 * account in its fullness ink rather than a bar of the average: an average of
 * 56% is five empty accounts and five spent ones as readily as ten half-used
 * ones, and only the spread says which.
 */
function WindowSum({ w, rows, nowSec }: { w: WindowTotal; rows: readonly ReportRow[]; nowSec: number }) {
  const id = `ap-report-${w.id}`;
  if (w.used == null) {
    return (
      <section className="ap-report-sum" aria-labelledby={id}>
        <h3 className="ap-report-win" id={id}>{w.label}<span className="vis-hidden"> window</span></h3>
        <p className="ap-report-none">No account has a current {w.long} reading.</p>
        <p className="ap-report-count">0 of {plural(w.total, "account", "accounts")} counted</p>
      </section>
    );
  }
  const { used, available } = usedAndAvailable(w.used);
  const reset = w.nextReset ? resetCountdown(w.nextReset.at, nowSec) : null;
  const marks = rows.flatMap(r => { const c = r.cells[w.id]; return c.counted ? [c.pct] : []; });
  return (
    <section className="ap-report-sum" aria-labelledby={id}>
      <h3 className="ap-report-win" id={id}>{w.label}<span className="vis-hidden"> window</span></h3>
      <p className="ap-report-figs">
        <span className="ap-report-avail"><b>{available}%</b> available</span>
        <span className="ap-report-used" data-level={level(used)}><b>{used}%</b> used</span>
      </p>
      <div className="ap-report-strip" aria-hidden>
        {marks.map((pct, i) => <i key={i} data-level={level(pct)} />)}
      </div>
      <p className="ap-report-count">
        {w.reporting} of {plural(w.total, "account", "accounts")} counted
      </p>
      {/* Room this window shows that the other one has already spent. */}
      {w.capped > 0 && (
        <p className="ap-report-capped">
          {plural(w.capped, "of these is", "of these are")} at the limit of {w.capped === 1 ? "its" : "their"}
          {" "}{w.id === "five_hour" ? "7d" : "5h"} window
        </p>
      )}
      {/* The soonest reset, whose, and what it brings back: resets happen per
          account, so there is no one moment the whole quota returns, and the
          report does not invent one. Each account's own is in its row. */}
      {reset && w.nextReset && (
        <p className="ap-report-reset">
          Next reset in {reset} · <span className="ap-report-who" title={w.nextReset.name}>{w.nextReset.name}</span>
          {" "}({Math.round(w.nextReset.pct)}%){w.nextReset.more > 0 ? ` and ${w.nextReset.more} more` : ""}
        </p>
      )}
    </section>
  );
}

/** One account's reading of one window: the percent and when it resets, or,
 *  for a reading that is not in the total, the last number dimmed and why —
 *  never a zero it was not given. */
function ReadingCell({ cell, nowSec, span }: { cell: Cell; nowSec: number; span?: number }) {
  if (!cell.counted) {
    return (
      <td className="ap-report-cell" data-uncounted="" colSpan={span}>
        <span className="ap-report-pct">{cell.last == null ? <span aria-hidden>—</span> : `${Math.round(cell.last)}%`}</span>
        <span className="ap-report-why">{cell.say}<span className="vis-hidden">, not counted</span></span>
      </td>
    );
  }
  const reset = cell.resetAt != null ? resetCountdown(cell.resetAt, nowSec) : null;
  return (
    <td className="ap-report-cell">
      <span className="ap-report-pct" data-level={level(cell.pct)}>{Math.round(cell.pct)}%</span>
      {reset && <span className="ap-report-in"><span className="vis-hidden">resets in </span>{reset}</span>}
    </td>
  );
}

/**
 * What the dialog holds: the lead, the two totals, the rows, and how they add
 * up. Its own component so the suite can draw it — a portal has no server
 * render.
 */
export function UsageReportBody({ accounts, nowSec, held }: {
  accounts: readonly Account[];
  nowSec: number;
  /** Why these are the last readings rather than this poll's, or null. */
  held: string | null;
}) {
  const report = usageReport(accounts, nowSec);
  const total = report.rows.length;
  return (
    // A scroll region with a name: with ten accounts at a phone's width, or
    // twenty-five anywhere, it scrolls, and the browsers that make a scroller a
    // Tab stop of their own read out whatever it is called. No tabIndex of the
    // deck's own — it invents no tab stops (canvas-keyboard.test.ts).
    <div className="ap-proj-body ap-report-body" role="region" aria-label="Report">
      {held && <p className="ap-report-held">{held}</p>}
      {/* The question a reader brings, answered first: how many accounts can
          be worked on now — room in both windows, the panel's own "free". */}
      <p className="ap-report-lead">
        <b>{report.roomInBoth}</b> of {plural(total, "account", "accounts")} {report.roomInBoth === 1 ? "has" : "have"} room
        in both windows
      </p>
      <div className="ap-report-sums">
        {report.windows.map(w => <WindowSum key={w.id} w={w} rows={report.rows} nowSec={nowSec} />)}
      </div>

      <table className="ap-report-table">
        <caption className="vis-hidden">Each account's reading, which the totals above are the average of</caption>
        <thead>
          <tr>
            <th scope="col" className="ap-report-acct-h">Account</th>
            {report.windows.map(w => <th key={w.id} scope="col">{w.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {report.rows.map(r => {
            const f = r.cells.five_hour, s = r.cells.seven_day;
            // A login that blocks both windows is one fact, said once.
            const oneLogin = !f.counted && !s.counted && f.why === "login" && s.why === "login";
            return (
              <tr key={r.num} data-active={r.active ? "" : undefined}>
                <th scope="row" className="ap-report-acct" title={r.name}>
                  {r.active && <span className="ap-live" aria-hidden />}
                  {r.name}
                  {r.active && <span className="vis-hidden"> (active)</span>}
                  {r.heldOut && <span className="ap-report-tag">held out</span>}
                </th>
                {oneLogin
                  ? <ReadingCell cell={{ ...f, last: null }} nowSec={nowSec} span={2} />
                  : report.windows.map(w => <ReadingCell key={w.id} cell={r.cells[w.id]} nowSec={nowSec} />)}
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="ap-report-note">
        Each counted account is one full window and <b>used</b> is their average — the deck is never
        told a limit, so there is no total in tokens or dollars.
      </p>
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
  // The last roster that had anyone in it — see the header. Keyed on the
  // roster the panel holds, which changes once a poll and not once a render.
  const [shown, setShown] = useState<readonly Account[]>(accounts ?? []);
  useEffect(() => { if (accounts && accounts.length > 0) setShown(accounts); }, [accounts]);
  const held = heldNote(failed, !accounts || accounts.length === 0, shown.length > 0);
  const rows = holdOrder(shown, order);
  const count = rows.length;

  // Portalled to <body>: opened from inside AccountsPanel, and a dialog left in
  // the panel's subtree is laid out by it (panel-modal-portal).
  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal ap-report-modal" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="ap-report-title ap-report-sub">
        <header className="ap-proj-head">
          <div className="ap-proj-titlewrap">
            <h2 className="ap-proj-title" id="ap-report-title">Usage report</h2>
            <div className="ap-proj-sub" id="ap-report-sub">
              {plural(count, "Claude account", "Claude accounts")}
            </div>
          </div>
          <button ref={closeRef} type="button" className="glyph-btn ap-proj-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        {/* Mounted with the dialog and only its words changing, so a reading
            held back is announced: a live region that arrives with its text is
            the one screen readers drop. */}
        <div className="vis-hidden" role="status" aria-atomic="true">{held ?? ""}</div>
        <UsageReportBody accounts={rows} nowSec={nowSec} held={held} />
      </div>
    </div>,
    document.body,
  );
}
