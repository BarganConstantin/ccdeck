// The Machine panel of `ccdeck tui`: what the machine is doing, drawn as live
// charts, for somebody who reached it over SSH and wants to know before
// anything else whether it is pegged, swapping or cooking.
//
// The readings are the deck's (/api/system, src/server/system-metrics.mjs), the
// numbers its Machine panel shows and the series its history charts draw, under
// the same names: All cores, Busiest core, Physical RAM, Swap, Queued work, the
// temperatures and Throttling. The deck samples on its own timer, so the screen
// asks it every three seconds and keeps what it is told, newest last; a chart
// is the last of them, one dot column a reading. The deck's own minute of CPU
// history seeds All cores, so the first frame already has a line in it.
//
// Drawn in braille where the terminal has Unicode — two dot columns and four
// dot rows a cell, the way btop draws — an area under a line: the cell the line
// passes through in the series' colour, the cells under it the same colour
// faint, so it reads as a line with a fill. The colour is the reading's own
// band, column by column: a temperature past its warning is yellow where it
// was past it and blue where it was not. A band is drawn as a dashed rule. No
// chart library: there is none without dependencies that keeps Node 18, and a
// braille cell is eight bits.
//
// ASCII consoles get a column chart in `#`, `.` and `-`; NO_COLOR gets the same
// shapes with no escape at all. Pure: readings in, rows out.
import { fitPainted, oneLine, textWidth } from "./cli-lines.mjs";
import { sinceLabel } from "./term.mjs";

/** How many readings are kept: at three seconds each, 24 minutes, which is a
 *  wider chart than a 200-column terminal draws. */
export const MACHINE_SAMPLES = 480;

/** The spelling the deck's thermal chart uses for its throttling row
 *  (thermal-sampler.mjs THROTTLE_LABEL). */
const THROTTLING = "Throttling";

/** An empty ring, before the deck has said anything. */
export function emptyMachine() {
  return { order: [], series: {}, count: 0, cores: null, platform: null, uptimeSec: null, intervalMs: 3_000, readAt: null };
}

/**
 * What one /api/system answer says, as readings: `{ key, label, unit, warnAt,
 * critAt, restsAtZero, v }`. A reading the deck could not take is left out
 * rather than drawn as a zero — the deck's own rule (#789).
 */
export function readingsOf(snap) {
  if (!snap || typeof snap !== "object" || snap.ok === false) return [];
  const out = [];
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const add = (key, label, unit, v, extra = {}) => {
    if (v != null) out.push({ key, label, unit, v, warnAt: null, critAt: null, restsAtZero: false, ...extra });
  };
  add("cpu:all", "All cores", "%", num(snap.cpu));
  const per = Array.isArray(snap.perCore) ? snap.perCore.map(num).filter(v => v != null) : [];
  add("cpu:busiest", "Busiest core", "%", per.length ? Math.max(...per) : null);
  add("mem:physical", "Physical RAM", "%", num(snap.memory?.usedPct), { warnAt: 90 });
  const swapTotal = num(snap.swap?.total);
  const swapUsed = num(snap.swap?.used);
  add("mem:swap", snap.platform === "win32" ? "Commit" : "Swap", "%",
    swapTotal && swapUsed != null ? Math.round((swapUsed / swapTotal) * 1000) / 10 : null, { warnAt: 90 });
  const cores = num(snap.cores);
  add("load:1m", "Queued work", "", Array.isArray(snap.loadavg) ? num(snap.loadavg[0]) : null, { warnAt: cores });
  for (const r of Array.isArray(snap.thermal?.celsius) ? snap.thermal.celsius : []) {
    const label = oneLine(r?.label);
    if (!label) continue;
    add(`thermal:${label}`, /temp/i.test(label) ? label : `${label} temp`, "°", num(r.celsius), {
      warnAt: num(r.warnAt), critAt: num(r.critAt),
    });
  }
  add(`thermal:${THROTTLING}`, THROTTLING, "%", num(snap.thermal?.throttle?.timeHeld), { restsAtZero: true });
  return out;
}

/**
 * The ring with one more answer in it. Every series gets a point for every
 * answer — null where this one did not carry it — so the charts stay in step
 * with each other and a gap is drawn as a gap. The first answer seeds All
 * cores with the deck's own last minute.
 */
export function withReading(machine, snap, now) {
  const m = machine ?? emptyMachine();
  const readings = readingsOf(snap);
  if (!readings.length) return m;
  const seed = m.count === 0 && Array.isArray(snap.cpuHistory)
    ? snap.cpuHistory.filter(v => typeof v === "number" && Number.isFinite(v)).slice(0, -1)
    : [];
  const count = Math.min(MACHINE_SAMPLES, m.count + seed.length + 1);
  const order = m.order.slice();
  const series = {};
  const byKey = new Map(readings.map(r => [r.key, r]));
  for (const r of readings) if (!order.includes(r.key)) order.push(r.key);
  for (const key of order) {
    const before = m.series[key];
    const r = byKey.get(key);
    const head = before ? before.points : [];
    const lead = key === "cpu:all" ? seed : seed.map(() => null);
    const pad = Array.from({ length: Math.max(0, m.count - head.length) }, () => null);
    const points = [...pad, ...head, ...lead, r ? r.v : null].slice(-count);
    const { v: _v, ...meta } = r ?? before ?? { key };
    series[key] = { ...meta, points };
  }
  return {
    order, series, count,
    cores: typeof snap.cores === "number" ? snap.cores : m.cores,
    platform: snap.platform ?? m.platform,
    uptimeSec: typeof snap.uptimeSec === "number" ? snap.uptimeSec : m.uptimeSec,
    intervalMs: typeof snap.intervalMs === "number" && snap.intervalMs > 0 ? snap.intervalMs : m.intervalMs,
    readAt: now,
  };
}

/** The groups /api/system/history answers, one request each. */
export const HISTORY_GROUPS = Object.freeze(["cores", "memory", "load", "thermal"]);

/** The deck's history names for what the live panel calls otherwise. */
const HISTORY_LABELS = Object.freeze({ "mem:physical": "Physical RAM" });

/**
 * The deck's minute history (/api/system/history, one answer a group) as a
 * ring like the live one: a point a minute, oldest first, up to `now`, a
 * minute nothing was recorded in a gap. The names and the bands are the live
 * ring's where it has the series, so the two views read alike.
 */
export function historyMachine(answers, live, now) {
  const step = 60_000;
  const series = {};
  const order = [];
  let oldest = Infinity;
  for (const a of answers ?? []) {
    for (const s of Array.isArray(a?.series) ? a.series : []) {
      if (!s?.key || !Array.isArray(s.points) || !s.points.length) continue;
      if (s.key.startsWith("net:")) continue;
      order.push(s.key);
      series[s.key] = s;
      for (const p of s.points) if (typeof p?.t === "number") oldest = Math.min(oldest, p.t);
    }
  }
  if (!order.length) return null;
  const end = Math.floor(now / step) * step;
  const count = Math.min(1440, Math.max(1, Math.round((end - Math.floor(oldest / step) * step) / step) + 1));
  const start = end - (count - 1) * step;
  const out = {};
  for (const key of order) {
    const s = series[key];
    const points = new Array(count).fill(null);
    for (const p of s.points) {
      const i = Math.round((Math.floor(p.t / step) * step - start) / step);
      if (i >= 0 && i < count && typeof p.v === "number") points[i] = p.v;
    }
    const mine = live?.series?.[key];
    out[key] = {
      key,
      label: mine?.label ?? HISTORY_LABELS[key] ?? (key.startsWith("thermal:") && s.unit === "C" ? `${s.label} temp` : s.label),
      unit: mine?.unit ?? (s.unit === "C" ? "°" : s.unit),
      warnAt: mine ? mine.warnAt : s.warnAt ?? null,
      critAt: mine ? mine.critAt : s.critAt ?? null,
      restsAtZero: Boolean(s.restsAtZero),
      points,
    };
  }
  return {
    order, series: out, count,
    cores: live?.cores ?? null, platform: live?.platform ?? null, uptimeSec: live?.uptimeSec ?? null,
    intervalMs: step, readAt: now,
  };
}

/** The order the charts are read in, the deck's own: the cores, the memory,
 *  the queue, the heat. */
const READ_ORDER = ["cpu:all", "cpu:busiest", "mem:physical", "mem:swap", "load:1m"];
/** Which charts stay when not all of them fit, most wanted first. */
const KEEP_ORDER = ["cpu:all", "mem:physical", "load:1m", "thermal", "cpu:busiest", "mem:swap", `thermal:${THROTTLING}`];

const rank = (key, list) => {
  const i = list.indexOf(key);
  if (i !== -1) return i;
  if (key === `thermal:${THROTTLING}`) return list.length + 1;
  return key.startsWith("thermal:") ? (list.includes("thermal") ? list.indexOf("thermal") : list.length) : list.length + 2;
};

/**
 * The series with something to draw, in reading order. The busiest core is
 * drawn on the cores' chart rather than beside it — dots over the area where
 * one core runs hotter than the machine — since the two read together: all
 * cores at 20 with the busiest at 100 is ONE core pinned (system-metrics.mjs
 * coreSeries), and a chart of its own would be a second full box saying 100%.
 */
export function shownSeries(machine) {
  if (!machine) return [];
  const list = machine.order
    .map(key => ({ key, ...machine.series[key] }))
    .filter(s => s.points?.some(v => v != null))
    .sort((a, b) => rank(a.key, READ_ORDER) - rank(b.key, READ_ORDER) || machine.order.indexOf(a.key) - machine.order.indexOf(b.key));
  const all = list.find(s => s.key === "cpu:all");
  const busiest = list.find(s => s.key === "cpu:busiest");
  if (!all || !busiest) return list;
  all.peak = busiest.points;
  return list.filter(s => s !== busiest);
}

/** A scale a person would choose for the queue, the deck's loadTop: just above
 *  the peak, never under one and a half times the cores. */
function loadTop(points, cores) {
  const peak = points.reduce((a, v) => (v == null ? a : Math.max(a, v)), 0);
  const floor = Math.max(4, Math.ceil((cores ?? 1) * 1.5));
  const want = Math.max(floor, peak * 1.15);
  const step = want <= 20 ? 5 : want <= 100 ? 10 : 50;
  return Math.ceil(want / step) * step;
}

/** The value as the panel says it: 54%, 54.24, 90°. */
export function valueText(s, v, unicode = true) {
  if (v == null) return "—";
  if (s.unit === "%") return `${Math.round(v)}%`;
  if (s.unit === "°") return `${Math.round(v)}${unicode ? "°" : "C"}`;
  return v >= 100 ? String(Math.round(v)) : v.toFixed(2);
}

/** The tone a value is drawn in: its band, or the chart's own blue. */
function bandTone(s, v, tone) {
  if (v == null) return tone.accent;
  if (s.critAt != null && v >= s.critAt) return tone.err;
  if (s.warnAt != null && v >= s.warnAt) return tone.warn;
  return tone.accent;
}

// Braille: the bit of each dot, by dot row (top first) and dot column.
const DOT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

/**
 * A chart `width` cells by `height` rows of the newest of `points`, as painted
 * rows. `top` is the scale's top; the bands are the series' own.
 */
export function chartRows(s, points, { width, height, top, unicode, tone }) {
  if (width < 1 || height < 1) return [];
  const per = unicode ? 2 : 1;
  const vals = points.slice(-width * per);
  const lead = width * per - vals.length;
  const at = (x) => (x < lead ? null : vals[x - lead]);
  // The peak drawn over the area, lined up with it by its newest end.
  const peaks = Array.isArray(s.peak) ? s.peak.slice(-width * per) : [];
  const peakLead = width * per - peaks.length;
  const peakAt = (x) => (x < peakLead ? null : peaks[x - peakLead]);
  const scale = top > 0 ? top : 100;
  const faint = tone.dim ?? "";
  const bands = [[s.warnAt, tone.warn], [s.critAt, tone.err]].filter(([b]) => b != null && b > 0 && b < scale);

  // Each cell: its character, and whether it is the line, the fill, a band or nothing.
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: " ", kind: "none", tone: "" })));
  const colTone = (cc) => {
    let v = null;
    for (let i = 0; i < per; i++) {
      const p = at(cc * per + i);
      if (p != null) v = v == null ? p : Math.max(v, p);
    }
    return bandTone(s, v, tone);
  };

  if (unicode) {
    // The line is the top two dots of each column, drawn whole; under it the
    // area is every other dot, so the fill reads as a tint and the line as
    // the line — the deck's chart, a line over a translucent area.
    const dotsH = height * 4;
    const bits = Array.from({ length: height }, () => new Array(width).fill(0));
    const lineCell = Array.from({ length: height }, () => new Array(width).fill(false));
    for (let x = 0; x < width * 2; x++) {
      const v = at(x);
      if (v == null) continue;
      let n = Math.round((Math.min(scale, Math.max(0, v)) / scale) * dotsH);
      if (n === 0 && v > 0) n = 1;
      if (n === 0) continue;
      const cc = Math.floor(x / 2);
      const crest = dotsH - n;
      for (let R = crest; R < dotsH; R++) {
        const onLine = R <= crest + 1;
        if (!onLine && (x + R) % 2 !== 0) continue;
        const cr = Math.floor(R / 4);
        bits[cr][cc] |= DOT[R % 4][x % 2];
        if (onLine) lineCell[cr][cc] = true;
      }
    }
    const peakBits = Array.from({ length: height }, () => new Array(width).fill(0));
    for (let x = 0; x < width * 2; x++) {
      const p = peakAt(x);
      const v = at(x);
      if (p == null || p <= (v ?? 0)) continue;
      const n = Math.max(1, Math.round((Math.min(scale, p) / scale) * dotsH));
      const R = dotsH - n;
      const crest = v == null ? dotsH : dotsH - Math.round((Math.min(scale, Math.max(0, v)) / scale) * dotsH);
      if (R >= crest - 1) continue;
      peakBits[Math.floor(R / 4)][Math.floor(x / 2)] |= DOT[R % 4][x % 2];
    }
    for (let r = 0; r < height; r++) {
      for (let cc = 0; cc < width; cc++) {
        if (peakBits[r][cc] && !bits[r][cc]) grid[r][cc] = { ch: String.fromCodePoint(0x2800 + peakBits[r][cc]), kind: "peak", tone: tone.muted };
      }
    }
    for (const [b, bt] of bands) {
      const R = Math.min(dotsH - 1, Math.max(0, dotsH - Math.round((b / scale) * dotsH)));
      const row = Math.floor(R / 4);
      for (let cc = 0; cc < width; cc += 2) {
        if (bits[row][cc] === 0 && grid[row][cc].kind === "none") {
          grid[row][cc] = { ch: String.fromCodePoint(0x2800 + DOT[R % 4][0] + DOT[R % 4][1]), kind: "band", tone: bt };
        }
      }
    }
    for (let r = 0; r < height; r++) {
      for (let cc = 0; cc < width; cc++) {
        if (!bits[r][cc]) continue;
        grid[r][cc] = { ch: String.fromCodePoint(0x2800 + bits[r][cc]), kind: lineCell[r][cc] ? "line" : "fill", tone: colTone(cc) };
      }
    }
  } else {
    for (let cc = 0; cc < width; cc++) {
      const v = at(cc);
      if (v == null) continue;
      const level = (Math.min(scale, Math.max(0, v)) / scale) * height;
      for (let r = 0; r < height; r++) {
        const fill = level - (height - 1 - r);
        let ch = fill >= 0.75 ? "#" : fill >= 0.25 ? "." : " ";
        if (r === height - 1 && ch === " " && v > 0) ch = ".";
        if (ch !== " ") grid[r][cc] = { ch, kind: fill >= 1 ? "fill" : "line", tone: colTone(cc) };
      }
    }
    for (let cc = 0; cc < width; cc++) {
      const p = peakAt(cc);
      const v = at(cc);
      if (p == null || p <= (v ?? 0)) continue;
      const row = Math.min(height - 1, Math.max(0, height - Math.ceil((Math.min(scale, p) / scale) * height)));
      if (grid[row][cc].kind === "none") grid[row][cc] = { ch: "'", kind: "peak", tone: tone.muted };
    }
    for (const [b, bt] of bands) {
      const row = Math.min(height - 1, Math.max(0, height - 1 - Math.floor((b / scale) * height)));
      for (let cc = 0; cc < width; cc += 2) if (grid[row][cc].kind === "none") grid[row][cc] = { ch: "-", kind: "band", tone: bt };
    }
  }

  // One escape per run of cells drawn alike.
  return grid.map(cellsOf => {
    let out = "";
    let open = null;
    for (const c of cellsOf) {
      const code = c.kind === "none" ? "" : c.kind === "line" || c.kind === "peak" ? c.tone : `${faint}${c.tone}`;
      if (code !== open) {
        if (open) out += tone.reset;
        if (code) out += code;
        open = code || null;
      }
      out += c.ch;
    }
    return open ? out + tone.reset : out;
  });
}

/** Under this a chart column is too narrow to read, and the grid takes fewer. */
const MIN_COLUMN = 28;
const GAP = 3;
/** Taller than this a chart says nothing more; the panel keeps the rest. */
const MAX_CHART_ROWS = 12;

/**
 * How the charts are laid out in `width` by `height`: how many columns, how
 * many charts, and how tall — the most charts first, then the most chart.
 * A chart is a header (its name, its value) over its rows when it has three
 * rows or more to itself, and one row with its name beside it when it does not.
 */
export function machineLayout(count, width, height) {
  let best = null;
  for (let c = 1; c <= 3; c++) {
    const colW = Math.floor((width - GAP * (c - 1)) / c);
    if (c > 1 && colW < MIN_COLUMN) break;
    let n = count;
    while (n > 0 && Math.ceil(n / c) > height) n--;
    if (!n) continue;
    const rows = Math.ceil(n / c);
    const per = Math.floor(height / rows);
    const header = per >= 3;
    const chartH = Math.min(MAX_CHART_ROWS, header ? per - 1 : per);
    const score = n * 10_000 + chartH * colW * Math.min(c, n);
    if (!best || score > best.score) best = { columns: Math.min(c, n), colW, shown: n, rows, per, header, chartH, score };
  }
  return best;
}

/**
 * The panel's inside: `height` rows `width` wide, and what its borders say.
 * `working` is how many sessions are working, for the foot; `fresh` says the
 * deck answered recently enough to call the charts live.
 */
export function machinePanel(live, { width, height, look, working = 0, deck = true, starting = false, view = "live", history = null }) {
  const { tone, g, unicode } = look;
  const title = `${tone.bold}Machine${tone.reset}`;
  const footLeft = working ? `${tone.muted}${working} session${working === 1 ? "" : "s"} working${tone.reset}` : "";
  const blank = (said) => ({ title, footLeft, lines: [`${tone.muted}${said}${tone.reset}`] });
  if (!deck) return blank(starting ? `starting the deck${g.ellipsis}` : `the machine's readings come from the deck ${g.dash} d starts one`);
  // The hours draw the deck's minutes; the numbers are always the live ones.
  const hours = view === "hours" && Boolean(history);
  const machine = hours ? history : live;
  const all = shownSeries(machine);
  if (!all.length) return blank(`reading the machine${g.ellipsis}`);
  const plan = machineLayout(all.length, width, height);
  if (!plan) return { title, lines: [] };
  // What stays when not every chart fits, read in the order the deck reads them.
  const keep = new Set(all.slice().sort((a, b) => rank(a.key, KEEP_ORDER) - rank(b.key, KEEP_ORDER)).slice(0, plan.shown).map(s => s.key));
  const shown = all.filter(s => keep.has(s.key));

  const newest = (points) => {
    for (let i = points.length - 1; i >= 0; i--) if (points[i] != null) return points[i];
    return null;
  };
  const latest = (s) => newest(live?.series?.[s.key]?.points ?? s.points);
  const values = shown.map(s => valueText(s, latest(s), unicode));
  const valueW = Math.max(...values.map(v => textWidth(v)));
  const labelW = Math.min(14, Math.max(...shown.map(s => textWidth(oneLine(s.label)))));
  const per = unicode ? 2 : 1;

  const block = (s, i, chartH) => {
    const v = latest(s);
    const vt = bandTone(s, v, tone);
    const value = `${tone.bold}${vt === tone.accent ? "" : vt}${values[i]}${tone.reset}`;
    const visible = s.points.slice(-plan.colW * per);
    const top = s.unit === "" ? loadTop(visible, machine.cores) : 100;
    const label = oneLine(s.label);
    if (plan.header) {
      const rows = chartRows(s, s.points, { width: plan.colW, height: chartH, top, unicode, tone });
      // The busiest core beside the name, where there is room for it.
      const peak = s.peak ? newest(live?.series?.["cpu:busiest"]?.points ?? s.peak) : null;
      const said = peak != null ? `  ${g.bullet} busiest ${valueText(s, peak, unicode)}` : "";
      const head = textWidth(label) + textWidth(said) + 1 + textWidth(values[i]) <= plan.colW ? said : "";
      const gap = Math.max(1, plan.colW - textWidth(label) - textWidth(head) - textWidth(values[i]));
      return [`${tone.muted}${label}${tone.reset}${tone.muted}${head}${tone.reset}${" ".repeat(gap)}${value}`, ...rows];
    }
    const chartW = Math.max(1, plan.colW - labelW - valueW - 2);
    const rows = chartRows(s, s.points, { width: chartW, height: chartH, top, unicode, tone });
    return rows.map((row, r) => {
      const name = r === 0 ? fitPainted(`${tone.muted}${label}${tone.reset}`, labelW, g.ellipsis) : "";
      const said = r === 0 ? value : "";
      return `${name}${" ".repeat(Math.max(0, labelW - textWidth(name)))} ${row} ${" ".repeat(Math.max(0, valueW - textWidth(said)))}${said}`;
    });
  };

  // Row by row of the grid, the columns side by side. The rows the grid does
  // not need go to the charts, from the top, so they reach the foot.
  const lines = [];
  const spare = height - plan.rows * plan.per;
  for (let r = 0; r < plan.rows; r++) {
    const chartH = Math.min(MAX_CHART_ROWS, plan.chartH + (r < spare ? 1 : 0));
    const row = shown.slice(r * plan.columns, (r + 1) * plan.columns).map((s, k) => block(s, r * plan.columns + k, chartH));
    const tall = Math.max(...row.map(b => b.length));
    for (let i = 0; i < tall; i++) {
      lines.push(row.map(b => {
        const l = b[i] ?? "";
        return l + " ".repeat(Math.max(0, plan.colW - textWidth(l)));
      }).join(" ".repeat(GAP)));
    }
    const room = plan.per + (r < spare ? 1 : 0) - tall;
    for (let i = 0; i < room; i++) lines.push("");
  }

  const span = Math.min(machine.count, plan.header ? plan.colW * per : Math.max(1, plan.colW - labelW - valueW - 2) * per);
  const spanMs = span * (machine.intervalMs ?? 3_000);
  const facts = [
    live?.cores ? `${live.cores} cores` : "",
    live?.uptimeSec != null ? `up ${sinceLabel(live.uptimeSec * 1000)}` : "",
  ].filter(Boolean);
  const sep = ` ${g.bullet} `;
  // How far back the charts reach, and the key that reaches the other way.
  const reach = spanMs > 0 ? `last ${sinceLabel(spanMs)}` : "";
  const other = `${tone.reset}${tone.bold}t${tone.reset}${tone.muted} ${hours ? "live" : "hours"}`;
  // Asked for the hours and not read yet: the live charts stay meanwhile.
  const said = view === "hours" && !history ? `reading the hours${g.ellipsis}`
    : (hours ? [reach, "by the minute"] : ["live", reach]).filter(Boolean).join(sep);
  return {
    title,
    note: facts.length ? [`${tone.muted}${facts.join(sep)}${tone.reset}`, `${tone.muted}${facts[0]}${tone.reset}`] : "",
    footLeft,
    footRight: [
      `${tone.muted}${said}${sep}${other}${tone.reset}`,
      `${tone.muted}${said}${tone.reset}`,
      `${tone.muted}${hours ? "by the minute" : "live"}${tone.reset}`,
    ],
    lines: lines.slice(0, height),
  };
}
