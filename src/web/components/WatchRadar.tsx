// The watch, as the thing it actually is.
//
// A log is a transcript, and a transcript answers "what happened" well and "is
// this alive, and over what" badly — a reader has to hold sixteen near-identical
// lines in their head to see the shape. The mechanic underneath is a sweep: the
// deck visits each browser's history on a cycle and reports what it found. That
// is a radar, and drawing it as one is not decoration, it is the same
// information with the reading done for you.
//
// WHAT EVERY MARK MEANS, because a radar that means nothing is a screensaver:
//
//   the sweep      one turn per poll. Moving = the deck is looking. Stopped =
//                  it is not, and that is the honest picture of watch-off.
//   a blip         one watched browser, at a fixed angle so the picture is the
//                  same every time you open it. Its ring is how recently that
//                  profile was actually read. Named in the legend beneath
//                  rather than on the canvas: a label long enough to matter —
//                  "Google Chrome" — is wider than half this column, and
//                  reserving room for it collapsed the disc to a coin. Real
//                  text also themes, wraps and reads to a screen reader, none
//                  of which canvas text does.
//   brightening    the sweep passing over it. The pass is when a read happens,
//                  so the light IS the event rather than an ornament on it.
//   a finding      a ring that expands and fades from the browser it came from.
//                  It outlives the sweep, because it is the one thing here you
//                  are meant to catch.
//
// Canvas rather than SVG: the sweep is a gradient arc redrawn sixty times a
// second, and a DOM node per frame is the wrong shape for that.
import { useEffect, useRef } from "react";
import type { Palette } from "../palette";

/** Whether the ground this is drawn on is a light one, from the palette's own
 *  background token. Relative luminance rather than a theme name: the canvas
 *  cares about the colour behind it, and a caller that hands it a pale palette
 *  under any name is still drawing on pale. */
export function isLight(bg: string | undefined): boolean {
  const hex = /^#?([0-9a-f]{6})$/i.exec((bg ?? "").trim());
  if (!hex) return false;
  const n = parseInt(hex[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] > 0.5;
}

export interface RadarBrowser {
  key: string;
  name: string;
  running: boolean | null;
  lastReadMs: number | null;
}

export interface RadarBlip {
  browser: string | null;
  atMs: number;
}

/** One turn of the sweep, matched to the panel's poll so a rotation is a real
 *  cycle rather than an invented rhythm. */
const SWEEP_MS = 10_000;
/** How long a finding stays on the screen after it lands. Long enough to catch
 *  if you looked away, short enough that it does not become furniture. */
const BLIP_MS = 12_000;

export default function WatchRadar({
  browsers,
  findings,
  watching,
  palette,
  now = () => Date.now(),
}: {
  browsers: RadarBrowser[];
  findings: RadarBlip[];
  watching: boolean;
  /** Read once by App and refreshed when the theme moves. The radar does not
   *  read the stylesheet itself: this draws sixty times a second, and
   *  getComputedStyle on the render path is the thing the deck's palette exists
   *  to have already done. */
  palette: Palette;
  now?: () => number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // Seeded with null and filled on every render, rather than seeded with an
  // object literal that is rebuilt each time and thrown away.
  const state = useRef<{ browsers: RadarBrowser[]; findings: RadarBlip[]; watching: boolean } | null>(null);
  state.current = { browsers, findings, watching };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;


    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let raf = 0;
    let stop = false;

    const draw = () => {
      if (stop) return;
      const held = state.current;
      if (!held) return;
      const { browsers: bs, findings: fs, watching: on } = held;
      const accent = palette["--accent"] || "#7dd3fc";
      const line = palette["--line"] || "#1f2229";
      const dim = palette["--text-dim"] || "#6e727c";
      // THE SAME ALPHAS DO NOT READ ON BOTH GROUNDS. A 26% accent wash over
      // #0b0c10 is a clear beam; over white it is almost nothing, and the disc
      // arrived in light as an empty circle. Alpha is contrast against the
      // ground, so it has to be told which ground it is on — read from the
      // palette rather than from the stylesheet, because this runs sixty times
      // a second and getComputedStyle on that path is what the palette exists
      // to have already done.
      const pale = isLight(palette["--bg"]);
      const sweepMix = pale ? 42 : 26;
      const beamAlpha = pale ? 0.85 : 0.65;
      const t = now();

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const r = Math.min(w, h) / 2 - 6;

      // The rings. Three, because more is a texture and fewer is a circle.
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      // The grid, which is structure rather than data: it may sit under the
      // 3:1 a control needs, but not under visible.
      ctx.globalAlpha = pale ? 1 : 0.9;
      for (const k of [0.4, 0.7, 1]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * k, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // The sweep. Frozen at the top when the watch is off — a still radar is
      // the truthful picture of a watch that is not looking, and a moving one
      // would be the interface telling a lie the whole time it is on screen.
      const phase = on && !reduced ? ((t % SWEEP_MS) / SWEEP_MS) : 0;
      const sweep = phase * Math.PI * 2 - Math.PI / 2;

      if (on) {
        const grad = ctx.createConicGradient?.(sweep - 0.85, cx, cy);
        if (grad) {
          grad.addColorStop(0, "transparent");
          grad.addColorStop(0.85 / (Math.PI * 2), `color-mix(in srgb, ${accent} ${sweepMix}%, transparent)`);
          grad.addColorStop(1, "transparent");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.arc(cx, cy, r, sweep - 0.85, sweep);
          ctx.closePath();
          ctx.fill();
        }
        ctx.strokeStyle = accent;
        ctx.globalAlpha = beamAlpha;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(sweep) * r, cy + Math.sin(sweep) * r);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // One blip per watched browser, at a fixed angle: the picture is the same
      // shape every time you open it, so a change in it is a change in the
      // world rather than in the layout.
      bs.forEach((b, i) => {
        const angle = (i / Math.max(bs.length, 1)) * Math.PI * 2 - Math.PI / 2;
        // Radius carries staleness: a profile read a moment ago sits close in,
        // one the deck has not managed to read drifts out.
        const age = b.lastReadMs === null ? 1 : Math.min(1, (t - b.lastReadMs) / 120_000);
        const rr = r * (0.42 + age * 0.5);
        const x = cx + Math.cos(angle) * rr;
        const y = cy + Math.sin(angle) * rr;

        // Brightening as the sweep goes by — the pass IS the read, so the light
        // is the event and not an ornament laid over it.
        const delta = Math.abs(((sweep - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const lit = on ? Math.max(0, 1 - delta / 0.55) : 0;

        ctx.beginPath();
        ctx.arc(x, y, 3 + lit * 1.6, 0, Math.PI * 2);
        ctx.fillStyle = b.running ? accent : dim;
        ctx.globalAlpha = b.running ? 0.55 + lit * 0.45 : 0.35;
        ctx.fill();
        ctx.globalAlpha = 1;

      });

      // Findings: a ring leaving the browser it came from. It outlives the
      // sweep because it is the one mark here anybody is meant to catch.
      for (const f of fs) {
        const age = (t - f.atMs) / BLIP_MS;
        if (age < 0 || age > 1) continue;
        const i = Math.max(0, bs.findIndex(b => b.key === f.browser));
        const angle = (i / Math.max(bs.length, 1)) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(angle) * r * 0.6;
        const y = cy + Math.sin(angle) * r * 0.6;
        ctx.beginPath();
        ctx.arc(x, y, 4 + age * 22, 0, Math.PI * 2);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = (1 - age) * 0.8;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      raf = requestAnimationFrame(draw);
    };

    draw();
    return () => { stop = true; cancelAnimationFrame(raf); };
  }, [now, palette]);

  return (
    <canvas
      ref={ref}
      className="bw-radar"
      role="img"
      aria-label={watching
        ? `Watching ${browsers.length} browser${browsers.length === 1 ? "" : "s"}`
        : "Not watching"}
    />
  );
}
