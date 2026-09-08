// The band under the process list, and the reason it is there.
//
// Busiest processes opens over the machine panel and covers it. That panel is
// where the memory bar, the swap bar, the load average and the temperature
// live — which is to say it is the reason anybody opened the list in the first
// place. You go looking for what is eating the machine, and the act of looking
// hides every reading that told you something was.
//
// So this puts them back, at the size a footer allows: the reading now, and the
// last hour behind it.
//
// BUILT FROM WHAT THE MACHINE ANSWERS, NOT FROM A LIST OF SIX. The cells are
// whatever `/api/system/history` returns for its four groups, in the panel's
// own order. That is not a shortcut — it is the only version that is correct on
// three platforms: Windows publishes no load average and calls swap `Commit`,
// a machine with no sensor publishes no temperature at all, and a fixed list
// would have to guess all of that a second time and go stale the first time the
// server learns a new reading.
//
// A SPARKLINE, NOT A BAR. The panel already draws each of these against a
// 0-100 track, and repeating that here would be the panel at half size for no
// new answer. The question a footer can answer that the panel cannot is "has it
// been like this, or did it just do that" — which is a shape over time, and
// wants a line.
//
// ONE HOUR AT MOST, and the strip says how much of one it actually has. The
// ring holds 24 hours, but an hour of minute buckets is 60 points across 116px
// — about a pixel and a half each, which is the most a shape this size can
// carry before the line becomes a texture. A deck younger than that draws what
// it has and names the span, rather than letting four minutes wear an hour's
// label.
import React, { useEffect, useMemo, useState } from "react";
import { areaPath, band, linePath, spanLabel, yFor, SPARK_PAD, type History, type Series } from "./SectionHistoryModal";
import { fmtReading, fmtThreshold, liveReadings, type LiveSource } from "../machine-live";

/** The panel's own order, so the strip reads as the same machine described in
 *  the same sequence rather than as a second opinion about it. */
export const GROUPS = ["cores", "memory", "load", "thermal"] as const;

export const SPARK_W = 116;
export const SPARK_H = 24;
/** How much of the ring a cell draws. See the header. */
export const WINDOW_BUCKETS = 60;
/** Buckets are a minute wide, so anything faster than this re-fetches a ring
 *  that has not changed. The NUMBER beside the line is live at the panel's
 *  three seconds — this cadence is the line's, and only the line's. */
export const REFRESH_MS = 60_000;

/**
 * Whether a series is worth a cell.
 *
 * A reading whose normal value is zero, and which has not left zero in the
 * window, is a cell that says `0%` under a flat line for as long as anyone
 * looks at it. Throttling is the one such reading today, and the panel already
 * learned this the hard way: a readout that shows the same nothing every time
 * is read as broken, and then it is not believed on the day it is not nothing.
 *
 * Stated over `restsAtZero` rather than over the label, so it is a rule about
 * readings and not a special case named after one of them. A CPU at 0% is NOT
 * covered: cpu has no bands deliberately and an idle machine is a real answer.
 */
export function worthACell(s: Series): boolean {
  if (!s.points.length) return false;
  if (!s.restsAtZero) return true;
  return s.points.some(p => p.v > 0);
}

/**
 * What a cell calls its reading.
 *
 * The server's label is written for a place that has a heading over it: the
 * panel puts `Physical` and `Swap` under a section called Memory, and the
 * history dialog puts them under `Memory history`. The band has no heading —
 * six readings in a row with nothing above them — so each name has to carry its
 * own noun. `Physical 63%` is a number about nothing until you already know.
 *
 * Only the names that failed that test are changed. `All cores` and
 * `Busiest core` explain each other, and `Queued work` is already plainer than
 * "load average"; renaming those would be churn.
 *
 * Two of the three are DERIVED rather than written out, and that is the part
 * that matters beyond this machine:
 *
 *  • anything measured in degrees gets `temp`, so a Linux box publishing
 *    `Package id 0` and `Composite` gets `Package id 0 temp` without this
 *    module having heard of either;
 *  • swap keeps the server's own word for it, because Windows has no swap file
 *    and the server already renames that reading `Commit`. A hardcoded
 *    "Swap memory" would have been wrong on the one platform nobody re-reads.
 */
export function cellLabel(s: Series): string {
  if (s.unit === "C") return `${s.label} temp`;
  if (s.key === "mem:physical") return "Physical RAM";
  if (s.key === "mem:swap") return `${s.label} memory`;
  return s.label;
}

/** The tail of a series, at most WINDOW_BUCKETS long. */
export function windowOf(s: Series, n = WINDOW_BUCKETS): Series {
  return s.points.length <= n ? s : { ...s, points: s.points.slice(-n) };
}

export default function MachineStrip({ sys }: { sys: LiveSource }) {
  const [hist, setHist] = useState<Record<string, History>>({});

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      // All four at once. Each is a read of a ring already in memory — measured
      // at 10ms for the four in parallel — so there is nothing to stagger.
      const got = await Promise.all(GROUPS.map(async g => {
        try {
          const res = await fetch(`/api/system/history?group=${g}`);
          if (!res.ok) return [g, null] as const;
          return [g, (await res.json()) as History] as const;
        } catch {
          return [g, null] as const;
        }
      }));
      if (!alive) return;
      setHist(prev => {
        const next = { ...prev };
        // A group that failed keeps what it had. A strip that blanks on one bad
        // poll flickers under a list that is still updating fine, and the shape
        // it had a minute ago is still true.
        for (const [g, h] of got) if (h?.ok) next[g] = h;
        return next;
      });
    };
    void pull();
    const id = setInterval(() => void pull(), REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const live = useMemo(() => liveReadings(sys), [sys]);

  const cells = useMemo(() => GROUPS.flatMap(g => {
    const h = hist[g];
    if (!h) return [];
    return h.series.filter(worthACell).map(s => ({ series: windowOf(s), stepMs: h.stepMs }));
  }), [hist]);

  // WHAT THE BOX ACTUALLY SPANS, not what it can hold. The line is stretched to
  // the full width whatever it has, so a deck four minutes old draws four
  // minutes across the same 104px an hour would use. Saying "the last hour"
  // over that is the kind of small lie that makes the reading useless on the
  // one occasion somebody leans on it — the shape would be read as an hour of
  // calm when it is four minutes of not-yet-knowing.
  const span = useMemo(() => {
    let from = Infinity, to = -Infinity;
    for (const { series } of cells) {
      const p = series.points;
      if (!p.length) continue;
      from = Math.min(from, p[0].t);
      to = Math.max(to, p[p.length - 1].t);
    }
    return Number.isFinite(from) ? spanLabel(from, to) : "less than a minute";
  }, [cells]);

  // Nothing at all on a machine that publishes nothing — not an empty band, not
  // a border. Everywhere else the band is drawn as soon as there is a live
  // reading, EVEN BEFORE THE FIRST BUCKET EXISTS, and holds its own height
  // while it waits.
  //
  // The buckets are a minute wide, so a deck less than a minute old has no
  // history and this would otherwise appear out of nothing partway through
  // somebody reading the list. The dialog is centred and 82vh tall: with a long
  // list it is already at that ceiling and the arrival would take the room from
  // the scrolling body instead of moving the dialog, but with a short one it
  // moves it. Reserving costs one rule and removes the case.
  if (!Object.keys(live).length) return null;

  return (
    <div className="pl-strip" role="group" aria-label={`This machine, over the last ${span}`}>
      {cells.map(({ series, stepMs }) => (
        <Cell key={series.key} series={series} stepMs={stepMs} now={live[series.key]} span={span} />
      ))}
    </div>
  );
}

function Cell({ series, stepMs, now, span }: { series: Series; stepMs: number; now: number | undefined; span: string }) {
  const { points, top, unit, warnAt, critAt } = series;
  const label = cellLabel(series);
  // The live reading where the snapshot has one, and the last bucket where it
  // does not — a series can outlive its reading by an hour, and a cell with a
  // shape and no number is worse than a slightly old number.
  const value = now ?? points[points.length - 1]?.v;
  const tone = value == null ? "" : band(value, warnAt, critAt);
  const peak = Math.max(...points.map(p => p.v));

  return (
    // The title carries the label in full, because the label is allowed to
    // truncate: thermal labels come from the chip, and a Linux hwmon box
    // publishes `Package id 0` and `Composite` where this machine says `GPU`.
    <div
      className={`pl-cell${tone ? ` ${tone}` : ""}`}
      title={[
        `${label} · peak ${fmtReading(peak, unit)} over the last ${span}`,
        // The dashed line says WHERE the threshold is; this says what it is.
        // The number is not drawn in the box: the tag the full chart prints
        // needs a 30px gutter, and taking that out of a 116px sparkline costs
        // more of the shape than the digits return.
        warnAt != null ? `over ${fmtThreshold(warnAt, unit)} is uncomfortable` : "",
        critAt != null ? `over ${fmtThreshold(critAt, unit)} the machine acts` : "",
      ].filter(Boolean).join(" · ")}
    >
      <div className="pl-cell-head">
        <span className="pl-cell-label">{label}</span>
        <span className="pl-cell-now">{value == null ? "—" : fmtReading(value, unit)}</span>
      </div>
      <svg
        className="pl-spark"
        width={SPARK_W}
        height={SPARK_H}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        {/* The floor, drawn before anything stands on it — the same decision as
            the usage history modal's reserved axis. A cell whose series has one
            bucket has no line to draw yet (a shape needs two points), and an
            empty 24px box reads as a broken chart rather than as a machine the
            deck has only been watching for a minute. */}
        <line className="pl-spark-floor" x1={0} x2={SPARK_W} y1={SPARK_H - SPARK_PAD.b} y2={SPARK_H - SPARK_PAD.b} />
        <path className="pl-spark-area" d={areaPath(points, SPARK_W, stepMs, top, SPARK_H, SPARK_PAD)} />
        {/* THE THRESHOLDS THE SERIES ALREADY CARRIES, so a shape can be read
            against the line it matters to rather than only against itself.
            Four of the seven readings have one: memory and swap at 90, the load
            average at the core count, the GPU at 75 and 90. The two cpu series
            and throttling have none DELIBERATELY — a CPU at 90% is the machine
            doing the work you asked for, and an indicator that alarms during
            the normal case teaches you to stop reading it.

            Drawn over the fill and under the line, which is the order the full
            chart uses: a threshold is a mark on the scale, not another reading.
            Same class as that chart's, so there is one definition of what a
            warn line looks like and not two that can drift. */}
        {warnAt != null && (
          <line className="pl-rule warn" x1={0} x2={SPARK_W}
                y1={yFor(warnAt, top, SPARK_H, SPARK_PAD)} y2={yFor(warnAt, top, SPARK_H, SPARK_PAD)} />
        )}
        {critAt != null && (
          <line className="pl-rule hot" x1={0} x2={SPARK_W}
                y1={yFor(critAt, top, SPARK_H, SPARK_PAD)} y2={yFor(critAt, top, SPARK_H, SPARK_PAD)} />
        )}
        <path className="pl-spark-line" d={linePath(points, SPARK_W, stepMs, top, SPARK_H, SPARK_PAD)} />
      </svg>
      {/* The one number the shape cannot be read off a 24px box, and the one
          worth having under a process list: what it reached while you were not
          looking. Said in words for a screen reader, which gets no shape at
          all. */}
      <span className="vis-hidden">
        peak {fmtReading(peak, unit)} over the last {span}
        {warnAt != null && `, uncomfortable over ${fmtThreshold(warnAt, unit)}`}
        {critAt != null && `, the machine acts over ${fmtThreshold(critAt, unit)}`}
      </span>
    </div>
  );
}
