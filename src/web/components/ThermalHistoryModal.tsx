// What the machine did with its heat while you were building something.
//
// The panel's THERMAL section answers "is it hot now". This answers the
// question you actually have after a long run — "did it get hot while that was
// going, and was I ever held back for it" — and those are different enough that
// one is a row and the other is a chart.
//
// ONE MODAL, EVERY SERIES, ONE TIME AXIS, and that is the whole design
// decision. Heat is *why* throttling happens: the insight is "the GPU climbed
// to 78°C at 14:20 and the CPU was held to 91% two minutes later", and a modal
// per row would put the cause and the effect on two screens that cannot be
// compared. The click still means something — it scrolls the series you pressed
// into view and marks it.
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
  unit: "C" | "%";
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
 * The top of a chart's scale.
 *
 * Fixed at 100 for both units, and deliberately not fitted to the data. A scale
 * that grew with the reading would redraw the same calm afternoon as a dramatic
 * climb the moment the numbers moved two degrees, and the panel's own row draws
 * this reading against 0-100 — two pictures of one number that disagree about
 * how alarming it is would be worse than either alone.
 */
const TOP = 100;

/** Where a value sits, top-down, inside the plot box. */
export function yFor(v: number, height = H): number {
  const inner = height - PAD.t - PAD.b;
  return PAD.t + inner * (1 - Math.max(0, Math.min(TOP, v)) / TOP);
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
export function linePath(points: Point[], width: number, stepMs: number, height = H): string {
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
    d += `${cmd}${x(p.t).toFixed(1)} ${yFor(p.v, height).toFixed(1)}`;
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
export function areaPath(points: Point[], width: number, stepMs: number, height = H): string {
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
      for (const p of run) d += `L${x(p.t).toFixed(1)} ${yFor(p.v, height).toFixed(1)}`;
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

export default function ThermalHistoryModal({ focus, onClose }: {
  /** The row that was pressed. Marked, so a click on one of two rows still
   *  lands somewhere rather than opening an identical dialog twice. */
  focus?: string;
  onClose: () => void;
}) {
  const dialogRef = useModalDismiss(onClose);
  const [hist, setHist] = useState<History | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/system/thermal-history");
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
  }, []);

  const series = hist?.series ?? [];
  const newest = useMemo(
    () => series.reduce((a, s) => Math.max(a, s.points[s.points.length - 1]?.t ?? 0), 0),
    [series],
  );

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
        className="modal th-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="th-modal-title"
      >
        <div className="modal-head">
          <span className="modal-title" id="th-modal-title">Thermal history</span>
          {hist && (
            <span className="th-since">
              since {clock(hist.sinceMs)} · {spanLabel(hist.sinceMs, newest || Date.now())}
            </span>
          )}
          <button type="button" className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
        </div>

        <div className="th-body">
          {hist == null ? (
            <p className="th-empty">Reading…</p>
          ) : series.length === 0 ? (
            // Reachable only if the modal outlives its own section, which can
            // happen: a sensor that stops answering retires its row.
            <p className="th-empty">Nothing has been measured yet.</p>
          ) : (
            series.map(s => (
              <Chart key={s.label} series={s} stepMs={hist.stepMs} focused={s.label === focus} />
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Chart({ series, stepMs, focused }: { series: Series; stepMs: number; focused: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const selfRef = useRef<HTMLElement>(null);
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

  // What the click is FOR, now that it does not paint a rail. With two series
  // both on screen it does nothing, which is correct — there is nothing to
  // scroll to. With four, which is what Linux reports, the series you pressed
  // is the one you wanted and it may be below the fold.
  //
  // `nearest` so a series already in view is not yanked to the top, and no
  // smooth behaviour: this runs on open, where a scroll animation is a surface
  // moving before the reader has looked at it.
  useEffect(() => {
    if (focused) selfRef.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  const { points, unit, warnAt, critAt, label } = series;
  const h = warnAt == null && critAt == null ? H_FLAT : H;
  const { now, peak } = summary(points);
  const suffix = unit === "C" ? "°C" : "%";
  const note = unit === "%" ? throttleNote(points, stepMs) : null;

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
    <section ref={selfRef} className="th-series" aria-label={`${label} history`}>
      <div className="th-head">
        <span className="th-label">{label}</span>
        <span className="th-stats">
          {now != null && <><b>{now}</b><span>{suffix} now</span></>}
          {peak != null && (
            <><b className={band(peak, warnAt, critAt)}>{peak}</b><span>{suffix} peak</span></>
          )}
        </span>
      </div>

      <div className="th-plot" ref={boxRef}>
        <svg
          className="th-chart"
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
            v == null || v > TOP ? null : (
              <g key={kind}>
                <line className={`th-rule ${kind}`} x1={PAD.l} x2={w - PAD.r} y1={yFor(v, h)} y2={yFor(v, h)} />
                <text className={`th-rule-tag ${kind}`} x={2} y={yFor(v, h) + 3}>{v}</text>
              </g>
            ),
          )}
          <line className="th-floor" x1={PAD.l} x2={w - PAD.r} y1={h - PAD.b} y2={h - PAD.b} />

          <path className="th-area" d={areaPath(points, w, stepMs, h)} />
          <path className="th-line" d={linePath(points, w, stepMs, h)} />

          {/* One measured point is a measurement, just not yet a trend — so it
              draws as a dot rather than as nothing or as a fake line. */}
          {points.length === 1 && (
            <circle className="th-dot" cx={xOf(points[0].t)} cy={yFor(points[0].v, h)} r={3} />
          )}

          {at && (
            <g>
              <line className="th-cross" x1={xOf(at.t)} x2={xOf(at.t)} y1={PAD.t} y2={h - PAD.b} />
              <circle className="th-dot" cx={xOf(at.t)} cy={yFor(at.v, h)} r={3} />
            </g>
          )}
        </svg>
      </div>

      <div className="th-axis">
        {/* The reading under the pointer replaces the clock rather than sitting
            beside it: two numbers in one strip, one of which changes as you
            move, is a strip nobody can read. */}
        {at ? (
          <span className="th-at">{clock(at.t)} — <b>{at.v}</b>{suffix}</span>
        ) : (
          <>
            <span>{points.length ? clock(points[0].t) : ""}</span>
            <span>{points.length ? clock(points[points.length - 1].t) : ""}</span>
          </>
        )}
      </div>

      {note && <div className="th-note">{note}</div>}
    </section>
  );
}
