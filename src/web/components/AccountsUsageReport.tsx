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
// moves with the panel and a second polling loop never starts. A poll that
// cannot read the store answers with no roster; the report keeps the last one
// it had and says so, rather than emptying under the reader (the Projects
// report's #1412 did the same for its name).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Account } from "../claude-accounts";
import { resetCountdown } from "../relative-time";
import { usageReport, usedAndAvailable, type Cell, type WindowTotal } from "../accounts-usage-report";
import { useModalDismiss } from "./use-modal-dismiss";

/** How full a reading is, in the inks the panel's rows use: the warning past
 *  70% and the error past 90%. */
function level(pct: number): "mid" | "hi" | undefined {
  return pct >= 90 ? "hi" : pct >= 70 ? "mid" : undefined;
}

function WindowSum({ w, nowSec }: { w: WindowTotal; nowSec: number }) {
  const id = `ap-report-${w.id}`;
  const reset = w.nextReset ? resetCountdown(w.nextReset.at, nowSec) : null;
  if (w.used == null) {
    return (
      <section className="ap-report-sum" aria-labelledby={id}>
        <h3 className="ap-report-win" id={id}>{w.label}</h3>
        <p className="ap-report-none">No account has a current {w.long} reading.</p>
        <p className="ap-report-count">0 of {w.total} accounts reporting</p>
      </section>
    );
  }
  const { used, available } = usedAndAvailable(w.used);
  return (
    <section className="ap-report-sum" aria-labelledby={id}>
      <h3 className="ap-report-win" id={id}>{w.label}</h3>
      <p className="ap-report-figs">
        <span className="ap-report-fig" data-level={level(used)}><b>{used}%</b> used</span>
        <span className="ap-report-fig"><b>{available}%</b> available</span>
      </p>
      {/* The average, as a bar: what the two numbers above say, drawn. */}
      <div className="ap-report-meter" role="img"
        aria-label={`${used}% of the combined ${w.long} quota used, ${available}% available`}>
        <div className="ap-report-fill" data-level={level(used)} style={{ width: `${Math.max(used, 1)}%` }} />
      </div>
      <p className="ap-report-count">
        {w.reporting} of {w.total} {w.total === 1 ? "account" : "accounts"} reporting
      </p>
      {/* The soonest reset, and whose: resets happen per account, so there is
          no one moment the whole quota comes back, and the report does not
          invent one. Each account's own is in its row below. */}
      {reset && w.nextReset && (
        <p className="ap-report-reset" title={w.nextReset.name}>
          Next reset in {reset} · <span className="ap-report-who">{w.nextReset.name}</span>
        </p>
      )}
    </section>
  );
}

/** One account's reading of one window: the percent and when it resets, or
 *  why it is not in the total — never a zero it was not given. */
function ReadingCell({ cell, nowSec }: { cell: Cell; nowSec: number }) {
  if (!cell.counted) {
    return (
      <td className="ap-report-cell" data-uncounted="">
        <span className="ap-report-pct" aria-hidden>—</span>
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
 * What the dialog holds: the two totals, the rows, and how they add up. Its
 * own component so the suite can draw it — a portal has no server render.
 */
export function UsageReportBody({ accounts, nowSec, held }: {
  accounts: readonly Account[];
  nowSec: number;
  /** The store could not be read on the last poll; this is the reading before. */
  held: boolean;
}) {
  const report = usageReport(accounts, nowSec);
  return (
    <div className="ap-proj-body ap-report-body">
      {held && (
        <p className="ap-report-held" role="status">
          The account store could not be read just now. This is the last reading.
        </p>
      )}
      <div className="ap-report-sums">
        {report.windows.map(w => <WindowSum key={w.id} w={w} nowSec={nowSec} />)}
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
          {report.rows.map(r => (
            <tr key={r.num} data-active={r.active ? "" : undefined}>
              <th scope="row" className="ap-report-acct" title={r.name}>
                {r.active && <span className="ap-live" aria-hidden />}
                {r.name}
                {r.active && <span className="vis-hidden"> (active)</span>}
              </th>
              {report.windows.map(w => <ReadingCell key={w.id} cell={r.cells[w.id]} nowSec={nowSec} />)}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="ap-report-note">
        Each account with a current reading counts as one full window, and <b>used</b> is their
        average. The deck is never told an account's limit, so there is no total in tokens or
        dollars. A reading that is missing, old, or from before its window reset is left out of
        that window and marked in its row.
      </p>
    </div>
  );
}

export default function AccountsUsageReport({ accounts, nowSec, onClose }: {
  /** The panel's roster, in the order the panel lists it: live account first. */
  accounts: readonly Account[];
  /** The panel's clock, in seconds. */
  nowSec: number;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  // The last roster that had anyone in it — see the header.
  const [shown, setShown] = useState<readonly Account[]>(accounts);
  useEffect(() => { if (accounts.length > 0) setShown(accounts); }, [accounts]);
  const held = accounts.length === 0 && shown.length > 0;
  const count = shown.length;

  // Portalled to <body>: opened from inside AccountsPanel, and a dialog left in
  // the panel's subtree is laid out by it (panel-modal-portal).
  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal ap-report-modal" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="ap-report-title ap-report-sub">
        <header className="ap-proj-head">
          <div className="ap-proj-titlewrap">
            <div className="ap-proj-title" id="ap-report-title">Usage report</div>
            <div className="ap-proj-sub" id="ap-report-sub">
              {count} Claude {count === 1 ? "account" : "accounts"}
            </div>
          </div>
          <button ref={closeRef} type="button" className="glyph-btn ap-proj-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <UsageReportBody accounts={shown} nowSec={nowSec} held={held} />
      </div>
    </div>,
    document.body,
  );
}
