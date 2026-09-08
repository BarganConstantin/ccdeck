// The whole candidate list, because the panel's eight rows leave one question
// unanswerable.
//
// #739 made the panel's eight rows sortable and drew a line: a QUANTITY ranks —
// clicking `mem` changed which processes appeared, because the true heaviest is
// in the payload by construction — while a NAME only ordered the eight the last
// quantity had chosen. That was the right call for a 280px panel, and it left a
// gap: "is my vitest still running" cannot be answered by re-ordering eight
// rows that vitest is not in.
//
// This is that gap and nothing else. Same reading, same ordering rules, every
// candidate row instead of eight, and the pid and the untruncated name that the
// panel had no width for.
//
// THE PANEL'S EIGHT ROWS ARE GONE and this is what they became: the section
// there is one control that opens this. Which is why the process read lives
// here now — the ordering rules and the poll came with the rows they were
// about, and a panel with this dialog closed reads no process list at all.
//
// DELIBERATELY NOT A TASK MANAGER. No kill, no priority, no tree — macOS has
// Activity Monitor and Windows has Task Manager, they are better at it, and
// ending a process is not an action this deck should own. The header says "55
// of 531" for the same reason: this is the busiest slice, and a list that let
// you believe it was the whole machine would be lying about what it can answer.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useModalDismiss } from "./use-modal-dismiss";
import MachineStrip from "./MachineStrip";
import type { LiveSource } from "../machine-live";

/** `cpu` is null on a Windows first reading: a percentage needs two samples and
 *  there has only been one. Never a zero, which would rank it as idle. */
export interface Proc {
  pid: number;
  cpu: number | null;
  mem: number;
  name: string;
  /** The four the modal asks for with `detail=1`, and the panel never does.
   *  Optional because each is a reading that can be absent rather than zero: a
   *  `ps -M` that lost a race with an exit, a Windows process this session may
   *  not open, a platform with no user column. Every column that reads one
   *  prints a dash when it is missing. */
  rssBytes?: number;
  threads?: number;
  uptimeSec?: number;
  user?: string;
  /** The argument vector with the executable and any secret-shaped value taken
   *  off it, capped at 180 characters — see redactCommand in system-metrics. */
  cmd?: string;
}

export type SortKey = "cpu" | "mem" | "name" | "rss" | "threads" | "uptime" | "user";

export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

/** CPU descending, which is what "busiest" means until somebody says
 *  otherwise. */
export const SORT_DEFAULT: Sort = { key: "cpu", dir: "desc" };

/**
 * What a click on a column header does.
 *
 * A column you are not on arrives pointing the way that column is read: biggest
 * first for a quantity, A to Z for a name. The column you are already on flips.
 * Nothing else moves.
 *
 * A `rank` field used to ride along here, naming which quantity had CHOSEN the
 * rows — the panel drew eight of the payload's fifty-odd, so ordering by name
 * had to leave that choice alone or the eight would change under a sort that
 * was only asked to reorder them. This dialog draws every candidate it is sent,
 * so there is no choice left to remember: a sort orders the list, full stop.
 */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key === key) return { ...current, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "name" || key === "user" ? "asc" : "desc" };
}

/**
 * One ordering, applied the same way whichever column asked for it.
 *
 * Two rules the table would be wrong without.
 *
 * A null CPU goes last in BOTH directions. It is the Windows first reading,
 * where a percentage does not exist yet because it takes two samples to make
 * one, and the cell prints a dash for it. Ranking it as zero would call it idle;
 * ranking it above everything would call it the busiest thing on the machine.
 * The reading supports neither.
 *
 * Ties fall through to a fixed chain — CPU, then memory, then pid — that does
 * NOT flip with the direction. `mem` reads 0.2 for half the list, so with no
 * second key those rows would come back in whatever order the sort happened to
 * leave them in and the table would visibly reshuffle every four seconds while
 * nothing at all had changed.
 */
export function sortProcs(procs: Proc[], sort: Sort): Proc[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  // The three optional quantities join CPU under the null rule rather than
  // getting one of their own: a row whose thread count did not come back is not
  // a row with no threads, and a dash sorts to the end whichever way the arrow
  // points — same as the Windows first reading has always done.
  const quantity = (p: Proc): number | null | undefined =>
    sort.key === "cpu" ? p.cpu
      : sort.key === "mem" ? p.mem
        : sort.key === "rss" ? p.rssBytes
          : sort.key === "threads" ? p.threads
            : p.uptimeSec;
  const primary = (a: Proc, b: Proc): number => {
    // Case-insensitive and locale-aware. ASCII files every capital ahead of
    // every lowercase letter, which would put WindowServer and ccusage in
    // different halves of a list being read as one.
    if (sort.key === "name") return sign * a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (sort.key === "user") {
      const au = a.user ?? "", bu = b.user ?? "";
      if (!au || !bu) return au === bu ? 0 : (au ? -1 : 1);
      return sign * au.localeCompare(bu, undefined, { sensitivity: "base" });
    }
    const av = quantity(a);
    const bv = quantity(b);
    if (av == null || bv == null) return av == null ? (bv == null ? 0 : 1) : -1;
    return sign * (av - bv);
  };
  return [...procs].sort((a, b) =>
    primary(a, b)
    || (b.cpu ?? -1) - (a.cpu ?? -1)
    || b.mem - a.mem
    || a.pid - b.pid);
}

/** aria-sort's own vocabulary, which also decides the arrow and the active
 *  colour — the state is said once, in the place assistive technology reads. */
export function ariaSort(sort: Sort, key: SortKey): "ascending" | "descending" | "none" {
  if (sort.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

/** The process list costs a subprocess on every platform, so it refreshes more
 *  slowly than the readings beside it. */
const PROC_POLL_MS = 4_000;

/**
 * The process list, fetched for as long as this dialog is on screen and not one
 * tick longer.
 *
 * It used to be the panel's, polling from the moment the panel opened so that
 * eight rows could move in a 280px box, and asking for the four expensive
 * columns only once the dialog was raised — the `detail` flag #807 added, which
 * measured 141ms and 7 KB against 251ms and 13 KB. The eight rows are gone, so
 * the cheap half has no reader at all and the flag has one caller that always
 * wants the columns. A deck sitting with the panel open now runs `ps` never.
 */
function useProcesses(): { procs: Proc[]; total: number } | null {
  const [procs, setProcs] = useState<{ procs: Proc[]; total: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/system/processes?detail=1");
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data?.ok) setProcs({ procs: data.procs ?? [], total: data.total ?? 0 });
      } catch { /* leave the previous list up rather than blanking it */ }
    };
    load();
    const iv = window.setInterval(load, PROC_POLL_MS);
    return () => { alive = false; window.clearInterval(iv); };
  }, []);
  return procs;
}

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

export default function ProcessListModal({ sys, onClose }: {
  /** The panel's own snapshot, for the readings beside the list. It is passed
   *  down rather than polled again here: the panel behind this dialog is
   *  already holding one, and two independent three-second polls of the same
   *  endpoint would put two readings of one machine on screen that disagree by
   *  a tick. The PROCESS read is this dialog's own — see useProcesses. */
  sys: LiveSource;
  onClose: () => void;
}) {
  const dialogRef = useModalDismiss(onClose);
  const [sort, setSort] = useState<Sort>(SORT_DEFAULT);
  const read = useProcesses();

  // Every candidate the server sent, in the order asked for. Null until the
  // first read lands, which is a different thing from an empty list and says
  // so below.
  const rows = read ? sortProcs(read.procs, sort) : null;

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
          {/* Silent until there is something to count. "0 of 0 running" for
              the first half-second is a claim about a machine nobody has asked
              yet, and the heading already says what this is. */}
          {read && (
            <span className="pl-count">
              {rows!.length} of {read.total} running
            </span>
          )}
          <button type="button" className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
        </div>

        {/* THE TABLE AND THE MACHINE, in one box so a media query can decide
            whether they stack or sit side by side. See .pl-split: below 1200px
            of viewport nothing changes at all — the band stays under the list,
            at the width it was measured on. */}
        <div className="pl-split">
        <div className="pl-body">
          {rows == null ? (
            // Not the sentence below it. A read that has not come back yet and
            // a platform that cannot answer look identical in the data and are
            // opposite things to tell somebody, and this dialog now opens
            // before its first read rather than inheriting the panel's.
            <p className="pl-empty">Reading the process list…</p>
          ) : rows.length === 0 ? (
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
                  <SortHead
                    col="rss"
                    label="memory"
                    note="Resident set size, which is what ps and Task Manager report; macOS Activity Monitor shows a different figure."
                    sort={sort}
                    onSort={setSort}
                  />
                  <SortHead col="threads" label="threads" sort={sort} onSort={setSort} />
                  <SortHead col="uptime" label="up" sort={sort} onSort={setSort} />
                  <SortHead col="user" label="user" sort={sort} onSort={setSort} />
                  {/* Not sortable. A pid is an identifier the machine handed
                      out, so ordering by it orders by nothing a reader cares
                      about — it is here to be COPIED, which is why it is a
                      column at all and not a tooltip like it is in the panel. */}
                  <th scope="col" className="pl-pid-h">pid</th>
                  <SortHead
                    col="name"
                    label="process"
                    note="Command lines have anything secret-shaped removed, which is a filter and not a guarantee."
                    sort={sort}
                    onSort={setSort}
                  />
                </tr>
              </thead>
              <tbody>
                {rows!.map(p => (
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

        {/* THE PANEL THIS DIALOG IS COVERING, in the room a footer has. See
            MachineStrip: opening the list hides the readings that are the
            reason for opening it. */}
        <MachineStrip sys={sys} />
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
        {/* NO FOOTNOTE BAND. It said three things and only two of them were
            worth a permanent 72px under a list nobody scrolls to the end of:
            what the memory column measures, and that the redaction is a filter
            rather than a promise. Both are now on the header of the column they
            are about, which is where somebody wondering about a column actually
            looks — findable from the thing, instead of from a paragraph at the
            other end of the dialog.

            The third said the list is the busiest by processor and memory and
            refreshed every four seconds. The heading says "Busiest processes",
            the count beside it says how many of how many, and the numbers move
            while you watch: it was a caption describing what the reader could
            already see. */}

      </div>
    </div>,
    document.body,
  );
}

/** One column header: the word, the direction it is pointing, and the press
 *  that changes it. */
export function SortHead({ col, label, note, sort, onSort }: {
  col: SortKey;
  label: string;
  /** What this column means, where the meaning is not the label. It rides on
   *  the header's own tooltip, under the sort action, because a caveat about a
   *  column belongs to the column: it is findable from the thing it is about
   *  rather than from a footnote at the other end of the dialog. */
  note?: string;
  sort: Sort;
  onSort: (next: Sort) => void;
}) {
  const state = ariaSort(sort, col);
  return (
    <th scope="col" aria-sort={state}>
      <button
        type="button"
        className="sd-sort"
        title={note ? `Sort by ${label}\n\n${note}` : `Sort by ${label}`}
        onClick={() => onSort(nextSort(sort, col))}
      >
        {label}
        {/* aria-sort has already said this to a screen reader, so the glyph is
            for the eye alone. Its slot is held open on every column, sorted or
            not, so that re-sorting moves the rows and never the headers. */}
        <span className="sd-sort-dir" aria-hidden>
          {state === "none" ? "" : state === "ascending" ? "\u2191" : "\u2193"}
        </span>
      </button>
    </th>
  );
}

