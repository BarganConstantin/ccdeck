// What a section of the machine panel did over time.
//
// Every section there answers "what is it NOW" — 61°C, 22.2 GB of 32, a load of
// 84. None of them can answer "what did it do while that build was running",
// and that is the question you have after a long run rather than during one. So
// each section opens this, and which section you pressed decides what it plots.
//
// ONE MODAL PER SECTION, EVERY SERIES IN IT, ONE TIME AXIS. The series inside a
// section are causally linked and a chart per row would put the cause and the
// effect on two screens that cannot be compared: heat is why throttling
// happens, and "all cores at 20% with the busiest at 100%" is one pinned core
// rather than a busy machine. Neither reading means much without the other.
//
// TWO CHARTS STACKED, NOT TWO AXES ON ONE. Degrees and a percentage share
// nothing but a range; drawing them against a single y-axis would invite a
// reading of one shape against the other that means nothing at all. That both
// happen to run 0-100 is a coincidence of units, and a coincidence is a bad
// reason to overlay two quantities.
//
// SVG, not a library and not the canvas the radar uses. A temperature is
// continuous, so it wants a line rather than the usage chart's bar columns,
// which assert buckets that do not exist. Chart.js would be ~200KB on a bundle
// that already warns at 647KB, for a deck people install through npx and wait
// for — the whole of what it would buy here is a path string.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalDismiss } from "./use-modal-dismiss";

export interface Point { t: number; v: number }
export interface Series {
  label: string;
  /** Empty for a quantity that has no unit — a load average is a count of
   *  queued work, not a percentage of anything. */
  unit: "C" | "%" | "";
  /** The top of this series' scale. 100 wherever the panel draws the same
   *  number against a 0-100 track; fitted for load average, which is unbounded
   *  and whose section draws no track to contradict. */
  top: number;
  /** Null on a series with no bands — a throttle percentage has no comfortable
   *  range to be inside, since any of it at all is the machine being slowed. */
  warnAt: number | null;
  critAt: number | null;
  points: Point[];
}
export interface History { ok: boolean; sinceMs: number; stepMs: number; series: Series[] }

/** The plot box inside the SVG. Room at the left for the axis numbers, at the
 *  bottom for the clock, and one pixel at the top so a reading at the ceiling
 *  is not clipped by its own stroke. */
const PAD = { l: 30, r: 6, t: 6, b: 2 };

/**
 * How tall a chart is, and why the two are not the same.
 *
 * A temperature moves through most of its scale and has bands drawn across it,
 * so it needs the room to keep 75 and 90 apart. A throttle percentage spends
 * nearly all of its life flat at zero and has no bands at all: at the same
 * height, four fifths of its box is empty. Shorter is a better use of the
 * reader's screen and costs nothing, because the SCALE is unchanged — both are
 * still drawn against 0 to 100, so neither picture is exaggerated by being
 * given less space.
 *
 * The two heights never invite a false comparison, because the units already
 * forbid one: degrees and a percentage are two charts, not one with two lines.
 */
const H = 104;
const H_FLAT = 64;

/**
 * Where a value sits, top-down, inside the plot box.
 *
 * `top` comes from the server with the series, and it is fixed at 100 wherever
 * the panel draws the same number against a 0-100 track: a scale that grew with
 * the reading would redraw a calm afternoon as a dramatic climb the moment the
 * numbers moved two degrees, and two pictures of one reading that disagree
 * about how alarming it is are worse than either alone. Load average is the
 * exception — genuinely unbounded, measured at 114 on twelve cores — and its
 * section draws no track for a fitted scale to contradict.
 */
export function yFor(v: number, top = 100, height = H): number {
  const inner = height - PAD.t - PAD.b;
  return PAD.t + inner * (1 - Math.max(0, Math.min(top, v)) / top);
}

/**
 * The line, in path commands, with gaps left as gaps.
 *
 * A bucket exists only for a minute that was sampled, so a machine that slept,
 * or a deck that was paused, leaves a hole. Drawing straight through it would
 * invent a reading for every minute in between — the one thing this whole
 * feature refuses to do. Anything more than two steps apart starts a new
 * subpath instead.
 */
export function linePath(points: Point[], width: number, stepMs: number, top = 100, height = H): string {
  if (!points.length) return "";
  const span = points[points.length - 1].t - points[0].t;
  const x = (t: number) => {
    const inner = width - PAD.l - PAD.r;
    return PAD.l + (span > 0 ? (inner * (t - points[0].t)) / span : inner / 2);
  };
  let d = "";
  let prev: Point | null = null;
  for (const p of points) {
    const cmd = prev && p.t - prev.t <= stepMs * 2 ? "L" : "M";
    d += `${cmd}${x(p.t).toFixed(1)} ${yFor(p.v, top, height).toFixed(1)}`;
    prev = p;
  }
  return d;
}

/**
 * The same shape closed to the floor, so the line reads as a level rather than
 * as a squiggle.
 *
 * One closed shape PER CONTIGUOUS RUN, not one for the series. Filling across a
 * hole would claim the machine read zero through it, which is the invention
 * this whole feature refuses; but abandoning the fill because the series has
 * one hole anywhere — which is what this did first — throws away the reading
 * for the other two hours to avoid inventing twelve minutes. Each run is
 * dropped to the floor on its own and the gap stays empty.
 */
export function areaPath(points: Point[], width: number, stepMs: number, top = 100, height = H): string {
  if (points.length < 2) return "";
  const floor = height - PAD.b;
  const span = points[points.length - 1].t - points[0].t;
  const inner = width - PAD.l - PAD.r;
  const x = (t: number) => PAD.l + (span > 0 ? (inner * (t - points[0].t)) / span : inner / 2);
  let out = "";
  let run: Point[] = [];
  const flush = () => {
    if (run.length >= 2) {
      let d = `M${x(run[0].t).toFixed(1)} ${floor}`;
      for (const p of run) d += `L${x(p.t).toFixed(1)} ${yFor(p.v, top, height).toFixed(1)}`;
      out += `${d}L${x(run[run.length - 1].t).toFixed(1)} ${floor}Z`;
    }
    run = [];
  };
  for (const p of points) {
    if (run.length && p.t - run[run.length - 1].t > stepMs * 2) flush();
    run.push(p);
  }
  flush();
  return out;
}

/** now, peak — the two numbers worth the space. A minimum is not a question
 *  anybody asks of a temperature. */
export function summary(points: Point[]): { now: number | null; peak: number | null } {
  if (!points.length) return { now: null, peak: null };
  return {
    now: points[points.length - 1].v,
    peak: points.reduce((a, p) => Math.max(a, p.v), points[0].v),
  };
}

/** Which band a value is in, for the peak readout's colour. Mirrors the row's
 *  own rule so the chart and the panel cannot disagree. */
export function band(v: number, warnAt: number | null, critAt: number | null): "" | "warn" | "hot" {
  if (critAt != null && v >= critAt) return "hot";
  if (warnAt != null && v >= warnAt) return "warn";
  return "";
}

/**
 * What the throttle series is for: the sentence under it.
 *
 * A chart of a line that is flat at zero says "nothing happened" perfectly well
 * and says nothing about WHEN it did not happen. When it did happen, the two
 * facts worth having are how long and how recently — a machine held back for
 * one minute an hour ago is a different machine from one held back for forty of
 * the last sixty.
 */
export function throttleNote(points: Point[], stepMs: number, at = (t: number) => clock(t)): string | null {
  const held = points.filter(p => p.v > 0);
  if (!points.length) return null;
  if (!held.length) return "never held back";
  const minutes = held.length * (stepMs / 60_000);
  const last = held[held.length - 1];
  return `held back for ${minutes === 1 ? "1 minute" : `${minutes} minutes`}, last at ${at(last.t)}`;
}

/** 24-hour, always, like every other clock in this panel. A locale that prints
 *  01:28 PM beside a 13:28 elsewhere is two clocks in one card. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * How long the chart covers, said the way a person would.
 *
 * Truncated, never rounded. Rounding read thirty seconds as "1 minute", which
 * is the deck claiming a minute it does not have — on the surface whose whole
 * argument is that it never reports what it did not measure. Truncating can
 * only ever understate, and understating an elapsed time costs nothing.
 */
export function spanLabel(fromMs: number, toMs: number): string {
  const mins = Math.max(0, Math.floor((toMs - fromMs) / 60_000));
  if (mins < 1) return "less than a minute";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default function SectionHistoryModal({ group, title, onClose }: {
  /** Which section of the panel was pressed. The server keeps one ring of
   *  minute buckets for all of them and answers one section per request. */
  group: "thermal" | "cores" | "memory" | "load";
  title: string;
  onClose: () => void;
}) {
  const dialogRef = useModalDismiss(onClose);
  const [hist, setHist] = useState<History | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/system/history?group=${group}`);
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data?.ok) setHist(data);
      } catch { /* the deck is down; the connection pill already says so */ }
    };
    load();
    // The buckets are a minute wide, so a faster poll would redraw the same
    // picture; a slower one would let the newest minute sit stale on screen
    // while the row beside it moved.
    const iv = window.setInterval(load, 20_000);
    return () => { alive = false; window.clearInterval(iv); };
  }, [group]);

  const series = hist?.series ?? [];
  /**
   * What the chart actually covers, which is NOT how long the deck has been
   * running.
   *
   * The header read `since <boot> · <time since boot>`, and the ring keeps a
   * day: on a deck up for two, it announced "48h" over a chart holding 24. The
   * span has to come from the oldest point still retained. `sinceMs` is only
   * the answer before the first bucket exists, and it is the smaller of the two
   * exactly then.
   */
  const [oldest, newest] = useMemo(() => {
    let lo = Infinity;
    let hi = 0;
    for (const s of series) {
      if (!s.points.length) continue;
      lo = Math.min(lo, s.points[0].t);
      hi = Math.max(hi, s.points[s.points.length - 1].t);
    }
    return [Number.isFinite(lo) ? Math.max(lo, hist?.sinceMs ?? 0) : (hist?.sinceMs ?? 0), hi];
  }, [series, hist?.sinceMs]);

  // Through a portal, unlike every other modal in this app, and for a reason
  // none of them has: this one is opened from INSIDE the machine panel, which
  // is `position: fixed` with a width of 280px and an animation that transforms
  // it. A transformed ancestor becomes the containing block for a fixed
  // descendant, so the backdrop stopped being the viewport and became the
  // panel — measured at 274px wide, pinned in the right rail, over a scrim that
  // covered nothing. The other ten render from App.tsx at the top of the tree
  // and never meet this.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal hist-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hist-modal-title"
      >
        <div className="modal-head">
          <span className="modal-title" id="hist-modal-title">{title}</span>
          {/* Guarded on a real timestamp, not merely on having a response. A
              zero would render as "since 03:00" — the epoch, in the reader's
              own timezone, printed as an hour this morning. */}
          {hist && oldest > 0 && (
            <span className="hist-since">
              since {clock(oldest)} · {spanLabel(oldest, newest || Date.now())}
            </span>
          )}
          <button type="button" className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
        </div>

        <div className="hist-body">
          {hist == null ? (
            <p className="hist-empty">Reading…</p>
          ) : series.length === 0 ? (
            // Reachable only if the modal outlives its own section, which can
            // happen: a sensor that stops answering retires its row.
            <p className="hist-empty">Nothing has been measured yet.</p>
          ) : (
            series.map(s => (
              <Chart key={s.label} series={s} stepMs={hist.stepMs} />
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Chart({ series, stepMs }: { series: Series; stepMs: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  const [hover, setHover] = useState<number | null>(null);

  // Measured rather than assumed, because the modal is `min(820px, 92vw)` and
  // an SVG drawn at a width it does not have puts every point in the wrong
  // place. ResizeObserver rather than a window listener: the modal can change
  // width without the window doing so.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setW(Math.max(160, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { points, unit, warnAt, critAt, label, top } = series;
  const h = warnAt == null && critAt == null ? H_FLAT : H;
  const { now, peak } = summary(points);
  const suffix = unit === "C" ? "°C" : unit;
  const note = label === "Throttling" ? throttleNote(points, stepMs) : null;

  const at = hover != null ? points[hover] : null;
  const span = points.length > 1 ? points[points.length - 1].t - points[0].t : 0;
  const xOf = (t: number) => {
    const inner = w - PAD.l - PAD.r;
    return PAD.l + (span > 0 ? (inner * (t - points[0].t)) / span : inner / 2);
  };

  const read = (e: React.PointerEvent<SVGSVGElement>) => {
    if (points.length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left - PAD.l) / Math.max(1, rect.width - PAD.l - PAD.r);
    const t = points[0].t + span * Math.max(0, Math.min(1, frac));
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    }
    setHover(best);
  };

  return (
    <section className="hist-series" aria-label={`${label} history`}>
      <div className="hist-head">
        <span className="hist-label">{label}</span>
        <span className="hist-stats">
          {now != null && <><b>{now}</b><span>{suffix} now</span></>}
          {peak != null && (
            <><b className={band(peak, warnAt, critAt)}>{peak}</b><span>{suffix} peak</span></>
          )}
        </span>
      </div>

      <div className="hist-plot" ref={boxRef}>
        <svg
          className="hist-chart"
          width="100%"
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={
            now == null
              ? `${label}: nothing measured yet`
              : `${label}: ${now}${suffix} now, peak ${peak}${suffix}, over ${points.length} minute${points.length === 1 ? "" : "s"}`
          }
          onPointerMove={read}
          onPointerLeave={() => setHover(null)}
        >
          {/* The bands the hardware itself publishes, drawn where they are, so
              severity is read from position instead of from a hover. */}
          {[["warn", warnAt] as const, ["hot", critAt] as const].map(([kind, v]) =>
            v == null || v > top ? null : (
              <g key={kind}>
                <line className={`hist-rule ${kind}`} x1={PAD.l} x2={w - PAD.r} y1={yFor(v, top, h)} y2={yFor(v, top, h)} />
                <text className={`hist-rule-tag ${kind}`} x={2} y={yFor(v, top, h) + 3}>{v}</text>
              </g>
            ),
          )}
          <line className="hist-floor" x1={PAD.l} x2={w - PAD.r} y1={h - PAD.b} y2={h - PAD.b} />

          <path className="hist-area" d={areaPath(points, w, stepMs, top, h)} />
          <path className="hist-line" d={linePath(points, w, stepMs, top, h)} />

          {/* One measured point is a measurement, just not yet a trend — so it
              draws as a dot rather than as nothing or as a fake line. */}
          {points.length === 1 && (
            <circle className="hist-dot" cx={xOf(points[0].t)} cy={yFor(points[0].v, top, h)} r={3} />
          )}

          {at && (
            <g>
              <line className="hist-cross" x1={xOf(at.t)} x2={xOf(at.t)} y1={PAD.t} y2={h - PAD.b} />
              <circle className="hist-dot" cx={xOf(at.t)} cy={yFor(at.v, top, h)} r={3} />
            </g>
          )}
        </svg>
      </div>

      <div className="hist-axis">
        {/* The reading under the pointer replaces the clock rather than sitting
            beside it: two numbers in one strip, one of which changes as you
            move, is a strip nobody can read. */}
        {at ? (
          <span className="hist-at">{clock(at.t)} — <b>{at.v}</b>{suffix}</span>
        ) : (
          <>
            <span>{points.length ? clock(points[0].t) : ""}</span>
            <span>{points.length ? clock(points[points.length - 1].t) : ""}</span>
          </>
        )}
      </div>

      {note && <div className="hist-note">{note}</div>}
    </section>
  );
}
