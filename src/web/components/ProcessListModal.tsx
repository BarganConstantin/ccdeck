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

/**
 * Bytes as a machine reader wants them: three significant figures and a unit.
 *
 * The panel's column is a percentage of installed memory and stays one — it has
 * 40px. Here there is room for the figure itself, and "6.5 GB" answers "can I
 * close this and get something back" in a way "20.3" never did.
 *
 * Binary units, because that is what `ps` reports and what every process
 * viewer on all three platforms shows.
 */
export function fmtBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/**
 * How long it has been up, at one unit of precision.
 *
 * "2h" and "6d" are the whole of what this column is for — telling the process
 * that started with this morning's build from the one that has been up since
 * you last rebooted. A second unit would double the width to sharpen a figure
 * nobody reads to the minute.
 */
export function fmtUptime(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

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
                  {/* `rss`, not `mem`: the cell prints bytes and the sort has
                      to be the same quantity the cell is showing. They order
                      identically on the Unixes, where both come from RSS, and
                      differently on Windows, where the percentage is private
                      bytes and this figure is the working set Task Manager
                      draws. A column that sorted by one and displayed the
                      other would be right on two platforms out of three. */}
                  <SortHead col="rss" label="memory" sort={sort} onSort={setSort} />
                  <SortHead col="threads" label="threads" sort={sort} onSort={setSort} />
                  <SortHead col="uptime" label="up" sort={sort} onSort={setSort} />
                  <SortHead col="user" label="user" sort={sort} onSort={setSort} />
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
                    <td className="sd-num sd-dim" title={`${p.mem.toFixed(1)}% of installed memory`}>
                      {fmtBytes(p.rssBytes)}
                    </td>
                    <td className="sd-num sd-dim">{p.threads ?? "—"}</td>
                    <td className="sd-num sd-dim">{fmtUptime(p.uptimeSec)}</td>
                    <td className="sd-dim pl-user">{p.user ?? "—"}</td>
                    <td className="sd-num sd-dim pl-pid">{p.pid}</td>
                    {/* The name, and after it whatever of the command line
                        identifies WHICH one this is — `--type=renderer` beside
                        the fourth Google Chrome Helper, `serve admin-portal`
                        beside a node. The executable is off the front because
                        the name already says it, and anything secret-shaped is
                        off before it left the server. */}
                    <td className="pl-name">
                      {p.name}
                      {p.cmd && <span className="pl-cmd" title={p.cmd}> {p.cmd}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* WHAT THE MEMORY COLUMN IS, said here rather than left to be
            discovered. It is resident set size, which is what `ps` and Task
            Manager report and is NOT the figure macOS Activity Monitor prints:
            that one is `phys_footprint`, and on this machine the two disagree
            by up to fourteen times on the same process. No unprivileged
            one-shot command reports the footprint — `top` has it and takes four
            seconds — so the choice was a number that is the same measurement on
            all three platforms, or a different one per platform. This is the
            first. */}
        <div className="pl-foot">
          The busiest by processor and by memory, refreshed every four seconds.
          Not every process on the machine. Memory is resident set size, which
          is what <code>ps</code> and Task Manager report; macOS Activity
          Monitor shows a different figure. Command lines have anything
          secret-shaped removed, which is a filter and not a guarantee.
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
