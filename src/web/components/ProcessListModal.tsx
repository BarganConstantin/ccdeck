// The whole candidate list, because the panel's eight rows leave one question
// unanswerable.
//
// #739 made the panel's columns sortable and drew a line: a QUANTITY ranks —
// clicking `mem` changes which processes appear, because the true heaviest is
// in the payload by construction — while a NAME only orders the eight rows the
// last quantity chose. That was the right call for a 280px panel, and it left a
// gap: "is my vitest still running" cannot be answered by re-ordering eight
// rows that vitest is not in.
//
// This is that gap and nothing else. Same reading, same ordering rules, every
// candidate row instead of eight, and the pid and the untruncated name that the
// panel has no width for.
//
// DELIBERATELY NOT A TASK MANAGER. No kill, no priority, no tree — macOS has
// Activity Monitor and Windows has Task Manager, they are better at it, and
// ending a process is not an action this deck should own. The header says "55
// of 531" for the same reason: this is the busiest slice, and a list that let
// you believe it was the whole machine would be lying about what it can answer.
import { useState } from "react";
import { createPortal } from "react-dom";
import { useModalDismiss } from "./use-modal-dismiss";
import {
  ariaSort, nextSort, sortProcs, SortHead, SORT_DEFAULT,
  type Proc, type Sort,
} from "./SystemMeter";

export default function ProcessListModal({ procs, total, onClose }: {
  procs: Proc[];
  /** How many the machine is running, against however many were sent. */
  total: number;
  onClose: () => void;
}) {
  const dialogRef = useModalDismiss(onClose);
  // Its own sort, not the panel's. They are two readings of one list and a
  // shared one would re-order the panel behind the scrim while you worked here.
  const [sort, setSort] = useState<Sort>(SORT_DEFAULT);

  // Every candidate, not a slice of them: the whole point is that the row you
  // are looking for is not in the panel's eight.
  const rows = sortProcs(procs, sort);

  return createPortal(
    // Portalled for the reason SectionHistoryModal is: this opens from inside
    // `.sysdetail`, which is `position: fixed` and animates a transform, and a
    // transformed ancestor becomes the containing block for a fixed descendant.
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal pl-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pl-modal-title"
      >
        <div className="modal-head">
          <span className="modal-title" id="pl-modal-title">Busiest processes</span>
          <span className="pl-count">
            {rows.length} of {total} running
          </span>
          <button type="button" className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
        </div>

        <div className="pl-body">
          {rows.length === 0 ? (
            <p className="pl-empty">Could not read the process list on this platform.</p>
          ) : (
            <table className="sd-procs pl-table">
              <thead>
                <tr>
                  <SortHead col="cpu" label="cpu" sort={sort} onSort={setSort} />
                  <SortHead col="mem" label="mem" sort={sort} onSort={setSort} />
                  {/* Not sortable. A pid is an identifier the machine handed
                      out, so ordering by it orders by nothing a reader cares
                      about — it is here to be COPIED, which is why it is a
                      column at all and not a tooltip like it is in the panel. */}
                  <th scope="col" className="pl-pid-h">pid</th>
                  <SortHead col="name" label="process" sort={sort} onSort={setSort} />
                </tr>
              </thead>
              <tbody>
                {rows.map(p => (
                  <tr key={p.pid}>
                    {/* Per core on every platform, so a process can exceed
                        100%: that is it using more than one core. Null is the
                        Windows first reading — a dash, never a zero, which
                        would rank it as idle. */}
                    <td className="sd-num">{p.cpu == null ? "—" : p.cpu.toFixed(0)}</td>
                    <td className="sd-num sd-dim">{p.mem.toFixed(1)}</td>
                    <td className="sd-num sd-dim pl-pid">{p.pid}</td>
                    {/* Untruncated. The panel ellipsises at 164px and the
                        longest name measured on this machine is 91 characters;
                        here there is room, and "which of these is mine" is a
                        question the tail of the name answers. */}
                    <td className="pl-name">{p.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="pl-foot">
          The busiest by processor and by memory, refreshed every four seconds.
          Not every process on the machine.
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Kept beside the component that owns the sort, so a reader of either finds
 *  the other. `ariaSort` and `nextSort` are SystemMeter's; nothing here
 *  re-implements them. */
export { ariaSort, nextSort };
