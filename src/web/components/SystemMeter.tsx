// The machine's own state, in the topbar, so the answer to "is this box coping"
// does not require another window.
//
// TWO METRICS, TWO FORMS, and that is the whole idea of the resting state. CPU
// spikes — a build can saturate every core for four seconds and be gone before
// you look — so its history is the information and it draws as a 60-second
// sparkline. Memory moves on the scale of minutes, so its history is twenty
// copies of the same number and only the level matters; it draws as a bar. Form
// follows the dynamics of the data, which is the same reason the two are
// sampled at different rates server-side.
//
// NO COLOUR THRESHOLD ON CPU, deliberately, and it is the most load-bearing "no"
// here. QuotaBar turns amber at 70 and red at 90 because a quota at 90% means
// you are about to be cut off. A CPU at 90% means the machine is doing the work
// you asked for. Colouring it would make this red through every build and every
// parallel subagent run — precisely the sessions this deck exists to watch — and
// an indicator that alarms during the normal case teaches you to stop reading
// it. Memory and swap keep a warning, because near-exhaustion there is real.
//
// THE PANEL IS WHERE THE ABSOLUTE NUMBERS LIVE. A percentage answers "how full",
// which is the ambient question; it cannot answer "how much of how much", which
// is the question you open a panel to ask. Everything below the fold is in bytes
// and cores, not ratios.
import React, { useEffect, useRef, useState } from "react";
import { readStored } from "../storage";
import SectionHistoryModal from "./SectionHistoryModal";
import ProcessListModal from "./ProcessListModal";

/** Matches the server's CPU cadence, so the meter advances one bucket per poll
 *  rather than redrawing the same frame or skipping one. */
const POLL_MS = 3_000;
/** The process list costs a subprocess on every platform, so it refreshes more
 *  slowly than the meter and only while the panel is open. */
const PROC_POLL_MS = 4_000;
/** Server keeps 20 samples; the sparkline is sized to hold exactly that. */
const BUCKETS = 20;

const W = 36;
const SPARK_H = 8;

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

/** How many process rows the panel draws. Enough to see what is eating the
 *  machine, few enough that the panel never becomes a scroll. The server sends
 *  a wider set than this on purpose — system-metrics.mjs's CANDIDATE_N says
 *  why, and visibleProcs below is what spends it. */
const ROWS = 8;

export type SortKey = "cpu" | "mem" | "name" | "rss" | "threads" | "uptime" | "user";

export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
  /** The last column that RANKED the list. A name sort orders rows; it does not
   *  choose them, so it leaves this where it was — see visibleProcs. */
  rank: "cpu" | "mem";
}

/** CPU descending, which is what the section meant before it could be asked
 *  anything else. */
export const SORT_DEFAULT: Sort = { key: "cpu", dir: "desc", rank: "cpu" };

/**
 * What a click on a column header does.
 *
 * A column you are not on arrives pointing the way that column is read: biggest
 * first for a quantity, A to Z for a name. The column you are already on flips.
 * Nothing else moves — in particular `rank` stays put when the name is clicked,
 * because sorting by name is a request to reorder these rows, not a request for
 * a different eight.
 */
/** Which of the two rankings the server actually sends a column can stand on.
 *  `rss` and `mem` are one quantity read two ways, so memory ranks as memory;
 *  the rest order the rows they were given without choosing them, exactly as
 *  the name always has. */
const RANKS: Partial<Record<SortKey, "cpu" | "mem">> = { cpu: "cpu", mem: "mem", rss: "mem" };

export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key === key) return { ...current, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "name" || key === "user" ? "asc" : "desc", rank: RANKS[key] ?? current.rank };
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

/**
 * The rows drawn, which is a different question from the order they are in.
 *
 * The section is headed "Busiest processes", so its rows are always the busiest
 * — by whichever quantity is currently ranking them. Clicking `mem` therefore
 * changes WHICH processes appear, and that is what the wider payload buys: the
 * machine's heaviest consumer is in the candidate set by construction, so the
 * memory ranking is the machine's and not the CPU top eight's.
 *
 * Clicking `process` changes nothing about membership. Alphabetical is an
 * ordering and not a ranking, and the alphabetically-first eight of a candidate
 * set is a list nobody asked for; so the name sort reorders whichever eight the
 * last quantity chose.
 *
 * Direction does not change membership either. Ascending by CPU is "the eight
 * busiest, quietest first" — not "the eight quietest", which would be a
 * different section under a different heading.
 */
export function visibleProcs(procs: Proc[], sort: Sort, rows = ROWS): Proc[] {
  const busiest = sortProcs(procs, { key: sort.rank, dir: "desc", rank: sort.rank });
  return sortProcs(busiest.slice(0, rows), sort);
}

/** aria-sort's own vocabulary, which also decides the arrow and the active
 *  colour — the state is said once, in the place assistive technology reads. */
export function ariaSort(sort: Sort, key: SortKey): "ascending" | "descending" | "none" {
  if (sort.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

/** How a bar is painted. `calm` is the resting appearance and carries no class
 *  of its own, which is what keeps the memory rows drawing exactly as before. */
type Tone = "calm" | "warn" | "hot";

/**
 * Which band a temperature falls in.
 *
 * The numbers are the sensor's own wherever the platform publishes them — Linux
 * hwmon carries `temp*_max` and `temp*_crit` per sensor — because one scale for
 * every source would be a threshold this app invented. 75 and 90 are the
 * fallback for the platforms that publish none.
 */
export function thermalTone(celsius: number, warnAt: number, critAt: number): Tone {
  if (celsius >= critAt) return "hot";
  if (celsius >= warnAt) return "warn";
  return "calm";
}

/**
 * Throttling, stated as the share of the CPU's speed that has been TAKEN AWAY.
 *
 * `pmset -g therm` reports the share still allowed, and the obvious rendering
 * — "Thermal headroom 100%", a full bar — would put a full bar meaning "all is
 * well" directly beneath a memory bar where a full bar means "nearly out". Two
 * opposite conventions in one panel is a panel that has to be read twice. So it
 * is inverted here: every bar in this section fills with the problem, and an
 * empty track means nothing is wrong on every row and every platform.
 *
 * The note is the sentence somebody actually needs. A speed limit is already
 * the consequence a temperature has to be interpreted into, so it is worth
 * saying in words rather than leaving as a number.
 */
export function throttleRow(
  speedLimit: number,
  /** What the history says has already happened. A desktop reads 0% forever —
   *  measured: ninety seconds of AES-NI on twelve cores never moved this — and
   *  a row that only ever says 0% reads as a readout that does not work. It was
   *  reported that way twice. The current value is still the value; the note is
   *  where "and it did happen, at 12:21" belongs. */
  past?: { peak: number; lastMs: number } | null,
  now = Date.now(),
): { pct: number; value: string; tone: Tone; note: string } {
  const held = Math.max(0, Math.min(100, 100 - speedLimit));
  return {
    pct: held,
    // A number, never the word "none", and that was a bug report: a healthy
    // machine read as though the check had not run. Every other reading in this
    // panel is a figure on a scale — "20.5 GB of 32.0 GB", "84.49", "63 °C" —
    // so a word where a number goes is the one token that looks like an absent
    // value rather than a measured one. A speedometer at rest reads 0; it does
    // not read "none". And 0% sits on the same scale as the 9% that appears
    // under load, which is what makes it legible as a reading.
    value: `${held}%`,
    // Any throttling at all is worth a colour: it means the machine is slower
    // than the one you think you are running on. A third of the clock gone is
    // where that stops being a detail.
    tone: held === 0 ? "calm" : held >= 30 ? "hot" : "warn",
    // Short enough to sit on one line in a 280px panel: the longer phrasings
    // wrapped and orphaned their last word.
    note: held > 0
      ? `CPU held to ${speedLimit}% of full speed to cool down`
      : past
        ? `at full speed · held to ${100 - past.peak}% ${sinceLabel(past.lastMs, now)}`
        : "running at full speed, and never held back",
  };
}

/**
 * How long ago something happened, in the fewest words that stay true.
 *
 * Coarse on purpose. The buckets are a minute wide, so "42 seconds ago" would
 * be a precision the reading does not have, and the question this answers is
 * "recently, or this morning" rather than "exactly when".
 */
function sinceLabel(atMs: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - atMs) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.floor(mins / 60);
  return h === 1 ? "an hour ago" : `${h} hours ago`;
}

/** In the `agent-dag.*` namespace like every other key here; brand.ts explains
 *  why the rename stops at the storage layer. */
const OPEN_KEY = "agent-dag.systemPanelOpen";

/**
 * Whether the panel was open when this tab was last looked at.
 *
 * Read through storage.ts rather than window.localStorage directly: this runs
 * inside a useState initialiser, and the property read throws outright on a
 * browser that blocks site data, which would take the whole topbar with it.
 *
 * Defaults to CLOSED, unlike the usage panel's default. Usage is the panel you
 * keep up; this one answers a question you asked once, and a machine readout
 * that reopens itself on every refresh would be occupying the rail on behalf of
 * a decision nobody made.
 */
function loadOpen(): boolean {
  return readStored(OPEN_KEY) === "1";
}
function saveOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch {}
}

interface Memory { total: number; available: number; usedPct: number }
interface Swap { total: number; used: number }
/** `warnAt`/`critAt` come from the chip itself where the platform publishes
 *  them — Linux hwmon does — because a laptop package sensor and an NVMe drive
 *  do not share a comfortable range. Elsewhere the server fills in 75/90. */
interface ThermalReading { label: string; celsius: number; warnAt: number; critAt: number }
/** Two fields, not one list: degrees and a throttle percentage are different
 *  readings, and a shape that could hold either under one label is how a
 *  percentage ends up printed under a °C heading. */
interface Thermal {
  celsius: ThermalReading[];
  throttle: { speedLimit: number } | null;
  /** Whether the machine has been held back at all since the deck started, and
   *  when it last was. Null on one that never has. */
  heldBack?: { peak: number; lastMs: number } | null;
}
interface Snapshot {
  ok: boolean;
  cpu: number | null;
  cpuHistory: number[];
  cores: number;
  memory: Memory | null;
  swap: Swap | null;
  perCore: number[] | null;
  uptimeSec: number;
  platform: string;
  loadavg: number[] | null;
  /** Null on a machine that publishes nothing, and then no section is drawn at
   *  all — not 0°C, not a dash, not an empty bar. */
  thermal: Thermal | null;
  intervalMs: number;
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Poll /api/system on our own timer, and stop while the tab is hidden.
 *
 * A background tab has nobody looking at it, and browsers throttle its timers
 * to once a minute anyway — which would leave the sparkline full of holes on
 * return. Dropping the poll and refetching on the way back gives a clean read
 * instead of a ragged one.
 */
function useSystem(): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/system");
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data?.ok) setSnap(data);
      } catch { /* the deck is down; the connection pill already says so */ }
    };
    const start = () => {
      if (timer.current != null) return;
      load();
      timer.current = window.setInterval(load, POLL_MS);
    };
    const stop = () => {
      if (timer.current == null) return;
      window.clearInterval(timer.current);
      timer.current = null;
    };
    // Coming back deserves a reading now, not on the next tick. `start()` is a
    // no-op while the interval is alive, so without this explicit load a tab
    // that regained focus showed its last pre-hidden value for up to POLL_MS.
    const onVis = () => {
      if (document.visibilityState === "hidden") { stop(); return; }
      start();
      load();
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return snap;
}

/** The process list, fetched only while `on` is true — and asked for its four
 *  extra columns only while `detail` is, which is only while the modal that
 *  draws them is open. That gate is why a deck whose modal is never opened
 *  never reads an argument vector at all. */
function useProcesses(on: boolean, detail = false): { procs: Proc[]; total: number } | null {
  const [procs, setProcs] = useState<{ procs: Proc[]; total: number } | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch(`/api/system/processes${detail ? "?detail=1" : ""}`);
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data?.ok) setProcs({ procs: data.procs ?? [], total: data.total ?? 0 });
      } catch { /* leave the previous list up rather than blanking it */ }
    };
    load();
    const iv = window.setInterval(load, PROC_POLL_MS);
    return () => { alive = false; window.clearInterval(iv); };
  }, [on, detail]);
  return on ? procs : null;
}

export default function SystemMeter({ usageOpen = false }: { usageOpen?: boolean }) {
  const sys = useSystem();
  const [open, setOpen] = useState<boolean>(loadOpen);
  useEffect(() => { saveOpen(open); }, [open]);
  const btnRef = useRef<HTMLButtonElement>(null);

  // THE PANEL ANSWERS NO KEY, and its × no longer claims one.
  //
  // It claimed Esc from the day it shipped while nothing listened, so the press
  // fell through App.tsx's handler to its last case and cleared the canvas
  // selection: the panel stayed up and the arrangement built one shift-click at
  // a time was gone. #545 closed that by making the key true. It is closed the
  // other way now — a control that names a key it does not answer stops naming
  // it — because Escape over a docked panel is the canvas's press, not the
  // panel's: this thing covers nothing, and closing your instruments is not
  // what you meant by it.
  //
  // So the two ways out are the two ways in: the × here, and the topbar meter
  // that disclosed it, which is a toggle. That is the idiom the session list
  // and the usage and accounts panels already follow.

  // Before the first reading the meter holds its slot and draws its two empty
  // tracks. Two separate rules are at work and they pull in opposite
  // directions: never print a number we have not measured, and never reflow a
  // strip that is already too full. An empty track satisfies both — it asserts
  // no value, and it stops the surrounding stats from jumping sideways when the
  // first sample lands a few seconds after paint.
  if (!sys || sys.cpu == null || !sys.memory) {
    return (
      <span className="sysmeter idle" title="Sampling this machine…">
        <span className="sm-box" aria-hidden>
          <span className="sm-graphic">
            <svg className="sm-spark" width={W} height={SPARK_H} viewBox={`0 0 ${W} ${SPARK_H}`} />
            <span className="sm-ram" />
          </span>
        </span>
      </span>
    );
  }

  const { cpu, cpuHistory, cores, memory, loadavg } = sys;
  const ramWarn = memory.usedPct >= 90;

  // Oldest-left, newest-right, padded so a fresh server draws a short trace at
  // the right edge instead of stretching two samples across the full width.
  const bars = cpuHistory.slice(-BUCKETS);
  const pad = BUCKETS - bars.length;
  const barW = W / BUCKETS;

  const tip = [
    `CPU ${cpu.toFixed(0)}% of ${cores} cores`,
    loadavg ? `load ${loadavg[0]} · ${loadavg[1]} · ${loadavg[2]}  (1m · 5m · 15m)` : null,
    `Memory ${bytes(memory.total - memory.available)} of ${bytes(memory.total)} used`,
    "",
    "Click for detail. This machine, not this session.",
  ].filter(v => v !== null).join("\n");

  return (
    <span className="sysmeter-wrap">
      <button
        type="button"
        ref={btnRef}
        className="sysmeter"
        title={tip}
        aria-label="Toggle machine detail"
        aria-expanded={open}
        aria-controls={open ? "system-panel" : undefined}
        onClick={() => setOpen(o => !o)}
      >
        <span className="sm-box" aria-hidden>
          <span className="sm-graphic">
            <svg className="sm-spark" width={W} height={SPARK_H} viewBox={`0 0 ${W} ${SPARK_H}`}>
              {bars.map((v, i) => {
                const idx = pad + i;
                const h = Math.max(1, (v / 100) * SPARK_H);
                // Opacity ramps toward the newest sample so the trace reads
                // left-to-right as time without needing an axis.
                const o = 0.32 + 0.68 * ((i + 1) / bars.length);
                return (
                  <rect
                    key={idx}
                    x={idx * barW}
                    y={SPARK_H - h}
                    width={Math.max(0.8, barW - 0.7)}
                    height={h}
                    rx={0.5}
                    fill="var(--accent)"
                    opacity={o}
                  />
                );
              })}
            </svg>
            <span className="sm-ram">
              {/* A floor of 2%, so a machine reporting almost nothing in use
                  still shows a sliver rather than an empty track that reads as
                  "no data". */}
              <span
                className={`sm-ram-fill${ramWarn ? " warn" : ""}`}
                style={{ transform: `scaleX(${Math.max(2, memory.usedPct) / 100})` }}
              />
            </span>
          </span>
          {/* A middle dot, not a slash. Two independent percentages joined by "/"
              read as one fraction — "47 of 64" — which is a quantity this meter
              never reports. The dot separates without implying arithmetic. */}
          <span className="sm-read">
            <b>{cpu.toFixed(0)}</b>
            <i>·</i>
            <b>{memory.usedPct.toFixed(0)}</b>
          </span>
        </span>
        {/* The bars are decoration; this is the reading. Not a live region — it
            would announce every three seconds and make the strip unusable. */}
        <span className="sm-sr">
          CPU {cpu.toFixed(0)} percent, memory {memory.usedPct.toFixed(0)} percent used
        </span>
      </button>
      {open && <SystemPanel sys={sys} usageOpen={usageOpen} onClose={() => { setOpen(false); btnRef.current?.focus(); }} />}
    </span>
  );
}

/**
 * The detail, docked in the right rail beside the usage panel.
 *
 * NOT a dialog and not a popover, and the distinction is behavioural rather
 * than cosmetic. This is the same kind of thing the usage panel is: a region
 * you open, read alongside the canvas, and leave open while you work. So it
 * follows that idiom exactly — disclosure semantics on the button, no scrim, no
 * focus trap, and no dismissal when you click somewhere else, because clicking
 * the canvas while watching a build is not a request to close your instruments.
 *
 * It also means the two panels queue rather than overlap: with usage open this
 * sits to its left, and with usage closed it takes the slot usage would have
 * had. One rail, read right to left, nothing stacked on top of anything.
 *
 * Escape follows that idiom too. The usage panel advertises U on its close
 * button and this one has no letter to advertise, so its × named Esc from the
 * day it shipped and #545 made that true — but a panel is not a dialog, and the
 * press it was taking belonged to the canvas behind it. The × says "Close" now,
 * and the meter above closes it as readily as it opens it.
 */
function SystemPanel({ sys, usageOpen, onClose }: {
  sys: Snapshot;
  usageOpen: boolean;
  onClose: () => void;
}) {
  // `all` lives here rather than in Processes, because it is what decides
  // whether the poll asks for the detail columns at all — see useProcesses.
  const [allProcs, setAllProcs] = useState(false);
  const procs = useProcesses(true, allProcs);

  const { memory, swap, perCore, loadavg, cores, uptimeSec, platform, thermal } = sys;
  const used = memory ? memory.total - memory.available : 0;
  // Windows has no swap file in the Unix sense; what the same query reports
  // there is commit charge, so it is named for what it is.
  const swapLabel = platform === "win32" ? "Commit" : "Swap";
  const swapPct = swap && swap.total > 0 ? (swap.used / swap.total) * 100 : 0;

  return (
    <aside className={`sysdetail${usageOpen ? " shifted" : ""}`} id="system-panel" aria-label="Machine detail">
      <div className="sd-head">
        <span className="sd-title">This machine</span>
        <span className="sd-sub">up {uptime(uptimeSec)} · {cores} cores</span>
        <button type="button" className="glyph-btn sd-close" onClick={onClose} aria-label="Close" title="Close">×</button>
      </div>

      {perCore && perCore.length > 0 && (
        <div className="sd-section" role="group" aria-label="Cores">
          <OpensHistory group="cores" title="Core history" action="Show core history" label="Cores">
          {/* One column per core. The aggregate in the topbar cannot tell a
              saturated machine from one hot single-threaded job; this can. */}
          <div className="sd-cores" style={{ "--n": perCore.length } as React.CSSProperties}>
            {perCore.map((v, i) => (
              <span key={i} className="sd-core" title={`core ${i + 1}: ${v}%`}>
                {/* A fraction of a full-height column, not a height (#505).
                    One element per core, restyled every 3 seconds while this
                    panel is open, so the difference between a composited
                    transform and a relayout is multiplied by the core count.
                    The 2% floor is unchanged and means the same thing it always
                    did: an idle core still draws a sliver, so an empty column
                    reads as "nothing running" rather than "no data". */}
                <span className="sd-core-fill" style={{ transform: `scaleY(${Math.max(2, v) / 100})` }} />
              </span>
            ))}
          </div>
          </OpensHistory>
        </div>
      )}

      <div className="sd-section" role="group" aria-label="Memory">
        <OpensHistory group="memory" title="Memory history" action="Show memory history" label="Memory">
        {memory && (
          <Row
            label="Physical"
            value={<><b>{bytes(used)}</b> of {bytes(memory.total)}</>}
            pct={memory.usedPct}
            tone={memory.usedPct >= 90 ? "warn" : "calm"}
            note={`${bytes(memory.available)} available`}
          />
        )}
        {swap && swap.total > 0 && (
          <Row
            label={swapLabel}
            value={<><b>{bytes(swap.used)}</b> of {bytes(swap.total)}</>}
            pct={swapPct}
            tone={swapPct >= 90 ? "warn" : "calm"}
            note={swapPct >= 50 ? "paging to disk" : undefined}
          />
        )}
        </OpensHistory>
      </div>

      {loadavg && (
        <div className="sd-section" role="group" aria-label="Load average">
          <OpensHistory group="load" title="Load history" action="Show load history" label="Load average">
          <div className="sd-load">
            {loadavg.map((v, i) => (
              <span key={i} className={`sd-load-item${v > cores ? " over" : ""}`}>
                <b>{v.toFixed(2)}</b>
                <span>{["1m", "5m", "15m"][i]}</span>
              </span>
            ))}
          </div>
          {/* The one number the topbar bar cannot express: past 100% it
              saturates, and this says by how much. */}
          <div className="sd-note">
            {loadavg[0] > cores
              ? `${(loadavg[0] / cores).toFixed(1)}× more work queued than cores to run it`
              : `within ${cores} cores`}
          </div>
          </OpensHistory>
        </div>
      )}

      <ThermalSection thermal={thermal} />

      <Processes read={procs} all={allProcs} setAll={setAllProcs} sys={sys} />
    </aside>
  );
}

/**
 * Is this machine getting hot, and is it being held back for it.
 *
 * The question the four sections above cannot answer. A saturated machine that
 * is cool is a machine doing work; a saturated machine that is thermally
 * limited is one where the next agent you launch makes everything slower, and
 * a load average of 67 reads identically in both cases.
 *
 * Headed "Thermal" rather than "Temperature", and that is a decision rather
 * than a hedge: on macOS the honest reading is not degrees at all — no CPU
 * sensor is readable without root, and what IS readable is how much of the
 * CPU's speed the thermal manager is currently allowing. A "Temperature"
 * heading over that would be a heading that lies on every Apple Silicon
 * install. "Thermal" holds degrees where the machine has them and the
 * consequence where it does not, and every row still says what it measured.
 *
 * Nothing is drawn when the machine publishes nothing. Not a zero, not a dash,
 * not an empty bar — the same refusal that keeps `cpu` null until two samples
 * exist. On a platform with no sensor this section has never existed.
 */
/**
 * A section of this panel that keeps a history, wrapped in the one control that
 * opens it.
 *
 * ONE control per section, never one per row. It was one per row first, and
 * that was a mistake with a tell: every row of a section opens the SAME dialog
 * showing EVERY series in it, so the second button did nothing the first had
 * not. Two controls for one action made a section read as a list of separately
 * operable things when it is one reading of one machine.
 *
 * The heading goes inside the button so the whole block lights as one, and
 * keeps its `aria-hidden`: the group is already named, and the button carries
 * its own name, so the word a third time is noise.
 */
function OpensHistory({ group, title, action, label, children }: {
  group: "thermal" | "cores" | "memory" | "load";
  /** What the dialog calls itself. A name for a thing. */
  title: string;
  /** What the BUTTON calls itself, which is not the same string: a control is
   *  named for what pressing it does. "Core history" announces as a label and
   *  reads as one; "Show core history" is the action. Spelled out per section
   *  rather than derived, because deriving it produced "Show cores history". */
  action: string;
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="sd-open"
        onClick={() => setOpen(true)}
        title={action}
        aria-label={action}
      >
        <div className="sd-h" aria-hidden>{label} <i className="sd-row-more">›</i></div>
        {children}
      </button>
      {open && <SectionHistoryModal group={group} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}

function ThermalSection({ thermal }: { thermal: Thermal | null }) {
  if (!thermal) return null;
  const held = thermal.throttle ? throttleRow(thermal.throttle.speedLimit, thermal.heldBack) : null;
  return (
    <div className="sd-section" role="group" aria-label="Thermal">
      <OpensHistory group="thermal" title="Thermal history" action="Show thermal history" label="Thermal">
        {thermal.celsius.map(r => (
          <Row
            key={r.label}
            label={r.label}
            value={<><b>{r.celsius}</b> °C</>}
            // The track is 0 to 100°C, which is the range silicon lives in, so
            // the fill is the reading itself rather than a ratio of a number
            // nobody would recognise.
            pct={r.celsius}
            tone={thermalTone(r.celsius, r.warnAt, r.critAt)}
          />
        ))}
        {held && (
          <Row label="Throttling" value={held.value} pct={held.pct} tone={held.tone} note={held.note} />
        )}
      </OpensHistory>
    </div>
  );
}

/**
 * The process table, and the one part of this panel you can operate.
 *
 * A table header is where you click to sort in every other table anybody has
 * used, and this one was three inert cells for four releases (#739). So the
 * cells are real controls now: a <th scope="col"> carrying aria-sort, with a
 * <button> inside it that Tab reaches and Enter presses.
 *
 * The sort lives here rather than in storage.ts. It resets when the panel
 * closes, which is what a reader would expect of a table they re-sorted while
 * looking at something; a preference nobody would remember setting is not worth
 * a key that outlives the question.
 */
function Processes({ read, all, setAll, sys }: {
  read: { procs: Proc[]; total: number } | null;
  all: boolean;
  setAll: (open: boolean) => void;
  /** Threaded through rather than re-polled inside the dialog — see
   *  ProcessListModal's `sys` prop for why two polls of one endpoint is the
   *  wrong shape here. */
  sys: Snapshot;
}) {
  const [sort, setSort] = useState<Sort>(SORT_DEFAULT);
  const procs = read?.procs ?? null;
  const openable = read != null && procs != null && procs.length > 0;

  return (
    // THE WHOLE BLOCK OPENS THE LIST, not just the word `more`. Eight rows of
    // processes read as something you can look further into, and the only thing
    // that said so was a 10px word in the corner.
    //
    // ONE HANDLER ON THE SECTION, and it steps aside for anything that is
    // already a control: the column headers sort, and `more` opens this same
    // dialog through its own onClick. Without the `closest("button")` guard a
    // press on `cpu` would sort the list AND open the modal over it, and `more`
    // would fire twice.
    //
    // NOT a role="button" with a tabindex, which was the obvious next step and
    // is wrong twice over: it would put a second tab stop on the keyboard for
    // an action `more` already offers with a real name, and it would make a
    // focusable container out of an element that CONTAINS the sort buttons.
    // The mouse gets a shortcut; the keyboard and a screen reader keep the
    // button, which is the control.
    <div
      className={`sd-section${openable ? " sd-openable" : ""}`}
      role="group"
      aria-label="Busiest processes"
      onClick={openable ? e => {
        if ((e.target as HTMLElement).closest("button")) return;
        setAll(true);
      } : undefined}
    >
      {/* The one section that is NOT wrapped in a single control, and it is the
          markup that decides: its column headers are already buttons, and a
          button cannot contain a button. So the affordance is its own small
          control in the heading — which turns out to be the honest shape
          anyway, since what it opens is more of this list rather than what this
          list did over time. */}
      <div className="sd-hrow">
        <div className="sd-h" aria-hidden>Busiest processes</div>
        {procs != null && procs.length > 0 && (
          <button
            type="button"
            className="sd-all"
            onClick={() => setAll(true)}
            title="Show every process the deck is watching"
            aria-label="Show every process the deck is watching"
          >
            more <i className="sd-row-more" aria-hidden>›</i>
          </button>
        )}
      </div>
      {all && read && (
        <ProcessListModal procs={read.procs} total={read.total} sys={sys} onClose={() => setAll(false)} />
      )}
      {procs == null ? (
        <div className="sd-note">reading…</div>
      ) : procs.length === 0 ? (
        <div className="sd-note">Could not read the process list on this platform.</div>
      ) : (
        <table className="sd-procs">
          <thead>
            <tr>
              <SortHead col="cpu" label="cpu" sort={sort} onSort={setSort} />
              <SortHead col="mem" label="mem" sort={sort} onSort={setSort} />
              <SortHead col="name" label="process" sort={sort} onSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {visibleProcs(procs, sort).map(p => (
              <tr key={p.pid}>
                {/* Per core on every platform, so a process can exceed 100%:
                    that is it using more than one core, which is information
                    rather than an error. Windows used to divide this by the
                    core count and cap it at 100, which made the same build
                    read ~cores× smaller there (#493).
                    Null is the Windows first reading, where a percentage does
                    not exist yet because it takes two samples to make one —
                    a dash, never a zero, which would rank it as idle. */}
                <td className="sd-num">{p.cpu == null ? "—" : p.cpu.toFixed(0)}</td>
                <td className="sd-num sd-dim">{p.mem.toFixed(1)}</td>
                <td className="sd-proc-name" title={`pid ${p.pid}`}>{p.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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

/**
 * A label, a reading, a track and an optional sentence.
 *
 * `value` is a node rather than a byte pair because this row draws three
 * different kinds of reading now — "20.5 GB of 32.0 GB", "58 °C", "none" — and
 * the memory formatting belongs to the memory section rather than to the
 * component every section shares. `tone` for the same reason: `pct >= 90` is
 * the memory rule and it was never the thermal one.
 */
function Row({ label, value, pct, tone = "calm", note }: {
  label: string; value: React.ReactNode; pct: number; tone?: Tone; note?: string;
}) {
  return (
    <div className="sd-row">
      <div className="sd-row-head">
        <span className="sd-row-label">{label}</span>
        {/* "How much of how much" — the question a percentage cannot answer and
            the reason this panel exists. */}
        <span className="sd-row-val">{value}</span>
      </div>
      <span className="sd-track">
        {/* A floor of 1%, so a reading that is present but tiny still draws a
            sliver rather than reading as "no data" — but only ABOVE zero. Zero
            draws nothing, because on the thermal rows an empty track is the
            answer: "Throttling — none" beside a bar with a mark in it says two
            different things, and the section's whole convention is that a bar
            fills with the problem. Nothing is not a small amount of something.
            Memory never reaches zero, so it is unaffected either way. */}
        <span
          className={`sd-fill${tone === "calm" ? "" : ` ${tone}`}`}
          style={{ transform: `scaleX(${pct <= 0 ? 0 : Math.max(1, Math.min(100, pct)) / 100})` }}
        />
      </span>
      {note && <div className="sd-note">{note}</div>}
    </div>
  );
}
