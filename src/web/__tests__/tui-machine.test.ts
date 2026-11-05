// The Machine panel of `ccdeck tui` (src/server/tui-machine.mjs): the deck's
// /api/system readings kept as a ring and drawn as charts, for somebody on the
// machine over SSH who wants to know first whether it is pegged, swapping or
// cooking.
//
// What is pinned here, in the order it can go wrong:
//
//   the readings  which /api/system field becomes which series, under the
//                 deck's own names and bands, and that a reading the deck
//                 could not take is left out rather than drawn as a zero;
//   the ring      every series in step with every other, the deck's minute of
//                 CPU seeding the first frame, never more than MACHINE_SAMPLES
//                 kept, and an answer with nothing in it changing nothing;
//   the hours     /api/system/history as a ring of minutes up to now, a minute
//                 nothing was recorded in a gap, the network left out;
//   the chart     exactly the cells asked for, in braille or in ASCII, each
//                 column in its own band's colour, a warning as a dashed rule,
//                 the busiest core as muted dots above the area;
//   the layout    the most charts first, then the most chart, and never a
//                 column too narrow to read;
//   the panel     exactly as tall as asked and never wider, the busiest core
//                 beside All cores rather than a chart of its own, what stays
//                 when not every chart fits, and a foot that says which view
//                 this is and which key reaches the other.
import { describe, it, expect } from "vitest";

// @ts-expect-error — plain .mjs module, no types
const machine = await import("../../server/tui-machine.mjs");
// @ts-expect-error — plain .mjs module, no types
const { textWidth } = await import("../../server/cli-lines.mjs");
// @ts-expect-error — plain .mjs module, no types
const { glyphs, palette, stripAnsi } = await import("../../server/term.mjs");

const {
  readingsOf, withReading, emptyMachine, MACHINE_SAMPLES, historyMachine, HISTORY_GROUPS,
  chartRows, machineLayout, shownSeries, valueText, machinePanel,
} = machine;

type Points = (number | null)[];
type Series = {
  key: string; label?: string; unit?: string; warnAt?: number | null; critAt?: number | null;
  restsAtZero?: boolean; points: Points; peak?: Points;
};
type Ring = {
  order: string[]; series: Record<string, Series>; count: number; cores: number | null; platform: string | null;
  uptimeSec: number | null; intervalMs: number; readAt: number | null;
};
type Reading = { key: string; label: string; unit: string; v: number; warnAt: number | null; critAt: number | null; restsAtZero: boolean };
type Panel = { title: string; note?: string[] | ""; footLeft?: string; footRight?: string[]; lines: string[] };
type Snap = Record<string, unknown>;

/** A whole minute, so the history's buckets fall on round numbers. */
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const plain = palette("none");
const ansi = palette("ansi16");
const truecolor = palette("truecolor");
const look = (unicode = true, profile = "none") => ({ tone: palette(profile), g: glyphs(unicode), unicode });

/** What /api/system answers on a warm 16-core Linux box: one core pinned at
 *  95.4 while the machine idles at 42, the CPU at 90° past its 75° warning,
 *  and the clock held down 12% of the time. */
function snapshot(over: Snap = {}): Snap {
  return {
    ok: true, cpu: 42, cpuHistory: [10, 20, 30, 40, 50, 60, 70, 42], cores: 16, platform: "linux",
    perCore: [10, 95.4, 30, ...Array(13).fill(20)], memory: { usedPct: 61.2 }, swap: { used: 1, total: 3 },
    loadavg: [5.5, 4, 3], uptimeSec: 7_380, intervalMs: 3_000,
    thermal: { celsius: [{ label: "CPU", celsius: 90, warnAt: 75, critAt: 100 }], throttle: { timeHeld: 12 } },
    ...over,
  };
}

/** The ring after `n` answers three seconds apart. */
function ringOf(n: number, snap: (i: number) => Snap = () => snapshot()): Ring {
  let m: Ring = emptyMachine();
  for (let i = 0; i < n; i++) m = withReading(m, snap(i), NOW + i * 3_000);
  return m;
}

const keysOf = (rs: { key: string }[]) => rs.map(r => r.key);
const byKey = (rs: Reading[]) => Object.fromEntries(rs.map(r => [r.key, r]));
const textOf = (p: Panel) => p.lines.map((l: string) => stripAnsi(l) as string);

/** A painted row as its cells, each with the escapes in force where it is drawn. */
function painted(row: string): { ch: string; code: string }[] {
  const out: { ch: string; code: string }[] = [];
  let code = "";
  for (let i = 0; i < row.length;) {
    const esc = /^\x1b\[[0-9;]*m/.exec(row.slice(i));
    if (esc) {
      code = esc[0] === "\x1b[0m" ? "" : code + esc[0];
      i += esc[0].length;
      continue;
    }
    const ch = String.fromCodePoint(row.codePointAt(i)!);
    out.push({ ch, code });
    i += ch.length;
  }
  return out;
}
const cells = (row: string) => painted(row).map(c => c.ch);
/** A braille cell with at least one dot in it. */
const dotted = (ch: string) => /^[⠁-⣿]$/.test(ch);

describe("readingsOf", () => {
  it("reads every field the deck's Machine panel shows, under its names and with its bands", () => {
    expect(readingsOf(snapshot())).toEqual([
      { key: "cpu:all", label: "All cores", unit: "%", v: 42, warnAt: null, critAt: null, restsAtZero: false },
      { key: "cpu:busiest", label: "Busiest core", unit: "%", v: 95.4, warnAt: null, critAt: null, restsAtZero: false },
      { key: "mem:physical", label: "Physical RAM", unit: "%", v: 61.2, warnAt: 90, critAt: null, restsAtZero: false },
      // 1 of 3 used: 33.333…, said to one decimal.
      { key: "mem:swap", label: "Swap", unit: "%", v: 33.3, warnAt: 90, critAt: null, restsAtZero: false },
      // The queue warns where it outgrows the cores there are to run it.
      { key: "load:1m", label: "Queued work", unit: "", v: 5.5, warnAt: 16, critAt: null, restsAtZero: false },
      { key: "thermal:CPU", label: "CPU temp", unit: "°", v: 90, warnAt: 75, critAt: 100, restsAtZero: false },
      { key: "thermal:Throttling", label: "Throttling", unit: "%", v: 12, warnAt: null, critAt: null, restsAtZero: true },
    ]);
  });

  it("takes the busiest core as the highest per-core reading, skipping the cores it could not read", () => {
    const r = byKey(readingsOf(snapshot({ perCore: [null, 30, Number.NaN, 12, "x"] })));
    expect(r["cpu:busiest"].v).toBe(30);
  });

  it("says swap as a share of the total to one decimal, and a swap nobody uses as 0", () => {
    expect(byKey(readingsOf(snapshot({ swap: { used: 2, total: 3 } })))["mem:swap"].v).toBe(66.7);
    expect(byKey(readingsOf(snapshot({ swap: { used: 1, total: 8 } })))["mem:swap"].v).toBe(12.5);
    expect(byKey(readingsOf(snapshot({ swap: { used: 0, total: 8 } })))["mem:swap"].v).toBe(0);
  });

  it("calls swap Commit on Windows, under the same key", () => {
    const r = byKey(readingsOf(snapshot({ platform: "win32" })));
    expect(r["mem:swap"].label).toBe("Commit");
    expect(byKey(readingsOf(snapshot({ platform: "darwin" })))["mem:swap"].label).toBe("Swap");
  });

  it("names each sensor a temperature once, with its own bands, and skips a sensor with no name or no number", () => {
    const r = readingsOf(snapshot({
      thermal: {
        celsius: [
          { label: "GPU", celsius: 60, warnAt: 80, critAt: 95 },
          { label: "x86_pkg_temp", celsius: 55 },
          { label: "", celsius: 40 },
          { label: "NVMe", celsius: "hot" },
        ],
      },
    }));
    expect(keysOf(r)).toEqual(["cpu:all", "cpu:busiest", "mem:physical", "mem:swap", "load:1m", "thermal:GPU", "thermal:x86_pkg_temp"]);
    const t = byKey(r);
    expect(t["thermal:GPU"]).toMatchObject({ label: "GPU temp", unit: "°", v: 60, warnAt: 80, critAt: 95, restsAtZero: false });
    expect(t["thermal:x86_pkg_temp"]).toMatchObject({ label: "x86_pkg_temp", unit: "°", v: 55, warnAt: null, critAt: null });
  });

  it("leaves out a reading the deck could not take rather than drawing it as a zero", () => {
    // What a Windows deck answers in its first seconds: no CPU yet, no load
    // average (three zeros there are not a reading), no page file, no sensors.
    const r = readingsOf({
      ok: true, cpu: null, cpuHistory: [], cores: 8, platform: "win32", perCore: [],
      memory: {}, swap: { used: 0, total: 0 }, thermal: null,
    });
    expect(r).toEqual([]);
    // A measured zero is a reading, and stays.
    const zero = readingsOf({ ok: true, cpu: 0, memory: { usedPct: Number.NaN } });
    expect(zero).toEqual([{ key: "cpu:all", label: "All cores", unit: "%", v: 0, warnAt: null, critAt: null, restsAtZero: false }]);
  });

  it("has no warning on the queue when the deck did not say how many cores there are", () => {
    expect(byKey(readingsOf(snapshot({ cores: undefined })))["load:1m"].warnAt).toBeNull();
  });

  it("reads nothing out of a failed answer or no answer", () => {
    expect(readingsOf({ ok: false, cpu: 50 })).toEqual([]);
    expect(readingsOf(null)).toEqual([]);
    expect(readingsOf(undefined)).toEqual([]);
    expect(readingsOf("busy")).toEqual([]);
  });

  // SUSPECTED BUG. A Mac's /api/system says its throttling as the speed still
  // allowed (`{ speedLimit }`, thermal-metrics.mjs throttleFromPmset), and the
  // deck's own panel reads both shapes (heldShare, src/web/machine-live.ts):
  // 100 - speedLimit. readingsOf reads `timeHeld` alone, so on a Mac the live
  // Throttling chart is never drawn while the deck's panel says 30%.
  it("reads a Mac's throttling, which the deck reports as the speed still allowed", () => {
    const r = byKey(readingsOf(snapshot({ platform: "darwin", thermal: { celsius: [], throttle: { speedLimit: 70 } } })));
    expect(r["thermal:Throttling"]?.v).toBe(30);
  });
});

describe("withReading", () => {
  it("seeds All cores with the deck's last minute on the first answer, the current reading last", () => {
    // cpuHistory ends with the reading `cpu` already is: it is not counted twice.
    const m: Ring = withReading(emptyMachine(), snapshot({ cpuHistory: [10, null, 20, 30, 42] }), NOW);
    expect(m.count).toBe(4);
    expect(m.series["cpu:all"].points).toEqual([10, 20, 30, 42]);
    expect(m.series["mem:physical"].points).toEqual([null, null, null, 61.2]);
    expect(m.series["thermal:CPU"].points).toEqual([null, null, null, 90]);
    for (const key of m.order) expect(m.series[key].points).toHaveLength(m.count);
    expect(m.order).toEqual(["cpu:all", "cpu:busiest", "mem:physical", "mem:swap", "load:1m", "thermal:CPU", "thermal:Throttling"]);
    expect(m).toMatchObject({ cores: 16, platform: "linux", uptimeSec: 7_380, intervalMs: 3_000, readAt: NOW });
    expect(m.series["load:1m"]).toMatchObject({ label: "Queued work", unit: "", warnAt: 16 });
    expect(m.series["load:1m"]).not.toHaveProperty("v");
  });

  it("starts from nothing as well as from an empty ring", () => {
    const m: Ring = withReading(null, snapshot({ cpuHistory: [42] }), NOW);
    expect(m.count).toBe(1);
    expect(m.series["cpu:all"].points).toEqual([42]);
  });

  it("adds one point to every series an answer, null for a series this answer lacks", () => {
    const first: Ring = withReading(emptyMachine(), snapshot({ cpuHistory: [10, 20, 30, 42] }), NOW);
    // The deck's minute again, in a later answer, is not seeded a second time.
    const second: Ring = withReading(first, snapshot({ cpu: 50, cpuHistory: [10, 20, 30, 42, 50], memory: null }), NOW + 3_000);
    expect(second.count).toBe(5);
    expect(second.series["cpu:all"].points).toEqual([10, 20, 30, 42, 50]);
    expect(second.series["mem:physical"].points).toEqual([null, null, null, 61.2, null]);
    expect(second.series["mem:physical"].label).toBe("Physical RAM");
    for (const key of second.order) expect(second.series[key].points).toHaveLength(5);
    expect(second.readAt).toBe(NOW + 3_000);
    // The ring it was handed is not touched.
    expect(first.count).toBe(4);
    expect(first.series["cpu:all"].points).toEqual([10, 20, 30, 42]);
  });

  it("pads a series first seen later with nulls in front, so it lines up with the others", () => {
    let m: Ring = withReading(emptyMachine(), snapshot({ cpuHistory: [10, 20, 30, 42] }), NOW);
    m = withReading(m, snapshot(), NOW + 3_000);
    const gpu = { celsius: [{ label: "CPU", celsius: 88, warnAt: 75, critAt: 100 }, { label: "GPU", celsius: 60, warnAt: 80, critAt: 95 }], throttle: { timeHeld: 0 } };
    m = withReading(m, snapshot({ thermal: gpu }), NOW + 6_000);
    expect(m.count).toBe(6);
    expect(m.order.at(-1)).toBe("thermal:GPU");
    expect(m.series["thermal:GPU"].points).toEqual([null, null, null, null, null, 60]);
    expect(m.series["thermal:GPU"]).toMatchObject({ label: "GPU temp", warnAt: 80, critAt: 95 });
    for (const key of m.order) expect(m.series[key].points).toHaveLength(6);
  });

  it("never keeps more than MACHINE_SAMPLES readings, the newest last", () => {
    const n = MACHINE_SAMPLES + 20;
    const m = ringOf(n, i => snapshot({ cpu: i % 100, cpuHistory: [i % 100] }));
    expect(m.count).toBe(MACHINE_SAMPLES);
    for (const key of m.order) expect(m.series[key].points).toHaveLength(MACHINE_SAMPLES);
    expect(m.series["cpu:all"].points.at(-1)).toBe((n - 1) % 100);
    expect(m.series["cpu:all"].points[0]).toBe((n - MACHINE_SAMPLES) % 100);
    // A series first seen once the ring is full is padded to the ring, no further.
    const late: Ring = withReading(m, snapshot({ cpu: 1, thermal: { celsius: [{ label: "GPU", celsius: 61 }] } }), NOW);
    expect(late.count).toBe(MACHINE_SAMPLES);
    expect(late.series["thermal:GPU"].points).toHaveLength(MACHINE_SAMPLES);
    expect(late.series["thermal:GPU"].points.filter((v: number | null) => v != null)).toEqual([61]);
    expect(late.series["thermal:GPU"].points.at(-1)).toBe(61);
  });

  it("never seeds more than MACHINE_SAMPLES from a long minute of history", () => {
    const history = Array.from({ length: MACHINE_SAMPLES + 120 }, (_, i) => i % 100);
    const m: Ring = withReading(emptyMachine(), snapshot({ cpu: 7, cpuHistory: [...history, 7] }), NOW);
    expect(m.count).toBe(MACHINE_SAMPLES);
    expect(m.series["cpu:all"].points).toHaveLength(MACHINE_SAMPLES);
    expect(m.series["cpu:all"].points.at(-1)).toBe(7);
    expect(m.series["mem:physical"].points.filter((v: number | null) => v != null)).toEqual([61.2]);
  });

  it("returns the very same ring for an answer with no readings in it", () => {
    const m = ringOf(3);
    expect(withReading(m, { ok: false }, NOW + 60_000)).toBe(m);
    expect(withReading(m, null, NOW + 60_000)).toBe(m);
    expect(withReading(m, { ok: true, cpu: null, memory: {} }, NOW + 60_000)).toBe(m);
    expect(m.readAt).toBe(NOW + 6_000);
  });
});

describe("historyMachine", () => {
  const series = (key: string, label: string, unit: string, points: [number, number][], over: Snap = {}) => ({
    key, label, unit, top: 100, warnAt: null, critAt: null, restsAtZero: false,
    points: points.map(([t, v]) => ({ t, v })), ...over,
  });
  // One answer a group, the shape /api/system/history gives.
  const ANSWERS: Record<string, Snap> = {
    cores: {
      ok: true, stepMs: MIN, series: [
        // Recorded 1.2 s into the minute four minutes ago: that minute's bucket.
        series("cpu:all", "All cores", "%", [[NOW - 4 * MIN + 1_234, 10], [NOW - 3 * MIN, 20], [NOW - MIN, 40], [NOW, 50]]),
        series("cpu:busiest", "Busiest core", "%", [[NOW - MIN, 90]]),
      ],
    },
    memory: {
      ok: true, stepMs: MIN, series: [
        series("mem:physical", "Physical", "%", [[NOW - 2 * MIN, 61]], { warnAt: 90 }),
        series("mem:swap", "Swap", "%", [[NOW, 5]], { warnAt: 90 }),
        // Older than everything else: it must not stretch the ring, since it is not drawn.
        series("net:down", "Download", "B/s", [[NOW - 10 * MIN, 1]]),
      ],
    },
    load: { ok: true, stepMs: MIN, series: [series("load:1m", "Queued work", "", [[NOW - MIN, 3.5]], { top: 25, warnAt: 4 })] },
    thermal: {
      ok: true, stepMs: MIN, series: [
        series("thermal:CPU", "CPU", "C", [[NOW - 4 * MIN, 70]], { top: 110, warnAt: 80, critAt: 100 }),
        series("thermal:Throttling", "Throttling", "%", [[NOW, 0]], { restsAtZero: true }),
      ],
    },
  };
  const answers = () => HISTORY_GROUPS.map((g: string) => ANSWERS[g]);

  it("asks the deck for the cores, the memory, the load and the heat", () => {
    expect(HISTORY_GROUPS).toEqual(["cores", "memory", "load", "thermal"]);
  });

  it("makes a ring of a point a minute, from the oldest bucket to now's minute, a missing minute a gap", () => {
    const h: Ring = historyMachine(answers(), null, NOW + 25_000);
    expect(h).toMatchObject({ count: 5, intervalMs: MIN, readAt: NOW + 25_000, cores: null, platform: null, uptimeSec: null });
    expect(h.order).toEqual(["cpu:all", "cpu:busiest", "mem:physical", "mem:swap", "load:1m", "thermal:CPU", "thermal:Throttling"]);
    expect(h.series["cpu:all"].points).toEqual([10, 20, null, 40, 50]);
    expect(h.series["cpu:busiest"].points).toEqual([null, null, null, 90, null]);
    expect(h.series["mem:physical"].points).toEqual([null, null, 61, null, null]);
    expect(h.series["thermal:CPU"].points).toEqual([70, null, null, null, null]);
    for (const key of h.order) expect(h.series[key].points).toHaveLength(5);
  });

  it("names the series the way the live panel does, and leaves the network out", () => {
    const h: Ring = historyMachine(answers(), null, NOW);
    expect(h.series["mem:physical"]).toMatchObject({ label: "Physical RAM", unit: "%", warnAt: 90, critAt: null });
    // The deck's history says Celsius as "C"; the panel says it as a degree.
    expect(h.series["thermal:CPU"]).toMatchObject({ label: "CPU temp", unit: "°", warnAt: 80, critAt: 100, restsAtZero: false });
    expect(h.series["thermal:Throttling"]).toMatchObject({ label: "Throttling", unit: "%", restsAtZero: true });
    expect(h.series["load:1m"]).toMatchObject({ label: "Queued work", unit: "", warnAt: 4 });
    expect(h.series).not.toHaveProperty("net:down");
    expect(h.order.some((k: string) => k.startsWith("net:"))).toBe(false);
  });

  it("takes the names, the bands and the machine's facts from the live ring where it has the series", () => {
    const live = ringOf(3);
    const h: Ring = historyMachine(answers(), live, NOW);
    // The live queue warns at the cores (16), whatever the history said.
    expect(h.series["load:1m"]).toMatchObject({ label: "Queued work", warnAt: 16 });
    expect(h.series["thermal:CPU"]).toMatchObject({ label: "CPU temp", unit: "°", warnAt: 75, critAt: 100 });
    expect(h).toMatchObject({ cores: 16, platform: "linux", uptimeSec: 7_380, intervalMs: MIN });
  });

  it("reaches back a day at most", () => {
    const old = { ok: true, series: [series("cpu:all", "All cores", "%", [[NOW - 3 * 24 * 60 * MIN, 1], [NOW, 9]])] };
    const h: Ring = historyMachine([old], null, NOW);
    expect(h.count).toBe(1_440);
    expect(h.series["cpu:all"].points.at(-1)).toBe(9);
  });

  it("is nothing when no answer has a series to draw", () => {
    expect(historyMachine([], null, NOW)).toBeNull();
    expect(historyMachine(null, null, NOW)).toBeNull();
    expect(historyMachine([{ ok: false }, { ok: true, series: [] }, null], null, NOW)).toBeNull();
    expect(historyMachine([{ ok: true, series: [series("cpu:all", "All cores", "%", [])] }], null, NOW)).toBeNull();
    expect(historyMachine([{ ok: true, series: [series("net:up", "Upload", "B/s", [[NOW, 3]])] }], null, NOW)).toBeNull();
  });
});

describe("chartRows", () => {
  const pct: Series = { key: "cpu:all", unit: "%", warnAt: null, critAt: null, points: [] };

  it("is exactly `height` rows of exactly `width` cells, in braille and in ASCII, coloured or not", () => {
    const shapes: Series[] = [pct, { ...pct, warnAt: 50, critAt: 80 }, { ...pct, peak: [100, 90, 80, 70, 60, 50, 40] }];
    for (const s of shapes) {
      for (const points of [[], [37], [0, 25, 50, 75, 100, null, 12.5], Array.from({ length: 90 }, (_, i) => (i * 7) % 101)]) {
        for (const [width, height] of [[1, 1], [2, 4], [5, 3], [36, 7]]) {
          for (const unicode of [true, false]) {
            for (const tone of [plain, ansi, truecolor]) {
              const rows: string[] = chartRows(s, points, { width, height, top: 100, unicode, tone });
              expect(rows).toHaveLength(height);
              for (const row of rows) expect(textWidth(row)).toBe(width);
              if (tone === plain) for (const row of rows) expect(row).not.toContain("\x1b");
            }
          }
        }
      }
    }
  });

  it("draws nothing for a chart with no room", () => {
    expect(chartRows(pct, [50], { width: 0, height: 4, top: 100, unicode: true, tone: plain })).toEqual([]);
    expect(chartRows(pct, [50], { width: 4, height: 0, top: 100, unicode: true, tone: plain })).toEqual([]);
  });

  it("fills a column at the top of the scale with braille, leaves a zero blank and still dots a tiny reading", () => {
    // Two dot columns a cell: column 0 is 100, column 1 is 0, column 2 is 0.1.
    const rows: string[] = chartRows(pct, [100, 100, 0, 0, 0.1, 0.1], { width: 3, height: 4, top: 100, unicode: true, tone: plain });
    const grid = rows.map(cells);
    for (const r of grid) expect(dotted(r[0])).toBe(true);
    for (const r of grid) expect(r[1]).toBe(" ");
    expect(grid.slice(0, 3).map(r => r[2])).toEqual([" ", " ", " "]);
    expect(dotted(grid[3][2])).toBe(true);
  });

  it("draws the newest reading at the right edge, the columns before it empty", () => {
    const grid = chartRows(pct, [50], { width: 4, height: 2, top: 100, unicode: true, tone: plain }).map(cells);
    for (const r of grid) expect(r.slice(0, 3)).toEqual([" ", " ", " "]);
    // Half the scale: the bottom row of the two.
    expect(grid[0][3]).toBe(" ");
    expect(dotted(grid[1][3])).toBe(true);
  });

  it("draws an ASCII console's chart in #, ., -, ' and spaces alone", () => {
    const s: Series = { ...pct, warnAt: 75, critAt: 90, peak: [0, 95, 95, 95, 0, 0, 0, 0] };
    const rows: string[] = chartRows(s, [0, 10, 40, 60, 80, 100, null, 0.5], { width: 8, height: 5, top: 100, unicode: false, tone: plain });
    for (const row of rows) expect(row).toMatch(/^[#.\-' ]*$/);
    // Column by column: 0 is a zero (bands only), 1-3 have the busiest core
    // above them, 5 is the top of the scale, 6 was not read, 7 is a sliver
    // that still gets a dot. The critical band is the top row, the warning the
    // next, dashed on every other column.
    expect(rows).toEqual([
      "-'''-#- ",
      "- - ##- ",
      "   ###  ",
      "  ####  ",
      " .#### .",
    ]);
  });

  it("colours a column past its warning in the warning's colour and one under it in the chart's blue", () => {
    const rows: string[] = chartRows({ ...pct, warnAt: 75 }, [80, 80, 50, 50], { width: 2, height: 4, top: 100, unicode: true, tone: ansi });
    const grid = rows.map(painted);
    for (const r of grid) if (r[0].ch !== " ") expect(r[0].code).toContain(ansi.warn);
    for (const r of grid) if (r[1].ch !== " ") {
      expect(r[1].code).toContain(ansi.accent);
      expect(r[1].code).not.toContain(ansi.warn);
    }
    expect(grid[3][0].code).toContain(ansi.warn);
    expect(grid[3][1].code).toContain(ansi.accent);
    // Past the critical line it is the error's colour.
    const hot = chartRows({ ...pct, warnAt: 75, critAt: 95 }, [100, 100], { width: 1, height: 2, top: 100, unicode: true, tone: ansi }).map(painted);
    for (const r of hot) expect(r[0].code).toContain(ansi.err);
  });

  it("draws a warning inside the scale as a dashed braille rule where nothing else is drawn", () => {
    // Everything at 10: only the bottom row is the area. The warning at 50 is
    // the third row of four, a dash on every other cell.
    const rows: string[] = chartRows({ ...pct, warnAt: 50 }, Array(12).fill(10), { width: 6, height: 4, top: 100, unicode: true, tone: plain });
    const grid = rows.map(cells);
    expect(grid[0].join("")).toBe("      ");
    expect(grid[1].join("")).toBe("      ");
    grid[2].forEach((ch, i) => (i % 2 === 0 ? expect(dotted(ch)).toBe(true) : expect(ch).toBe(" ")));
    for (const ch of grid[3]) expect(dotted(ch)).toBe(true);
    // In colour, the rule is the warning's.
    const band = painted(chartRows({ ...pct, warnAt: 50 }, Array(12).fill(10), { width: 6, height: 4, top: 100, unicode: true, tone: ansi })[2]);
    expect(band[0].code).toContain(ansi.warn);
    // A band at the top of the scale or past it has no row to be drawn on.
    const atTop = chartRows({ ...pct, warnAt: 100, critAt: 120 }, Array(12).fill(10), { width: 6, height: 4, top: 100, unicode: true, tone: plain });
    expect(atTop.slice(0, 3)).toEqual(["      ", "      ", "      "]);
  });

  it("draws the busiest core above the area as dots in the muted colour, and nothing where it is not above it", () => {
    const rows: string[] = chartRows({ ...pct, peak: [90, 90, 90, 90] }, [10, 10, 10, 10], { width: 2, height: 4, top: 100, unicode: true, tone: truecolor });
    const grid = rows.map(painted);
    for (const c of grid[0]) {
      expect(dotted(c.ch)).toBe(true);
      expect(c.code).toBe(truecolor.muted);
    }
    expect(grid[1].map(c => c.ch).join("")).toBe("  ");
    expect(grid[2].map(c => c.ch).join("")).toBe("  ");
    for (const c of grid[3]) expect(c.code).toContain(truecolor.accent);
    // A peak no higher than the area adds nothing to it.
    const level = chartRows({ ...pct, peak: [10, 10, 10, 10] }, [10, 10, 10, 10], { width: 2, height: 4, top: 100, unicode: true, tone: truecolor });
    expect(level).toEqual(chartRows(pct, [10, 10, 10, 10], { width: 2, height: 4, top: 100, unicode: true, tone: truecolor }));
  });
});

describe("machineLayout", () => {
  it("lays six charts three across and two down in a wide panel, each a header over its rows", () => {
    // Every column count fits all six at 150 by 16; then the most chart wins:
    // 3 columns of 48 by 7 rows beat 2 of 73 by 4 and 1 of 150 by 2.
    const plan = machineLayout(6, 150, 16);
    expect(plan).toMatchObject({ columns: 3, colW: 48, rows: 2, per: 8, shown: 6, header: true, chartH: 7 });
    expect(plan.chartH).toBe(plan.per - 1);
  });

  it("never makes a column narrower than 28 cells", () => {
    // 60 wide: two columns of 28 — three would be 18 each.
    expect(machineLayout(6, 60, 16)).toMatchObject({ columns: 2, colW: 28, rows: 3, per: 5, header: true, chartH: 4, shown: 6 });
    // 58 wide: two would be 27 each, so one.
    expect(machineLayout(6, 58, 16)).toMatchObject({ columns: 1, colW: 58 });
    for (let width = 28; width <= 200; width++) {
      const plan = machineLayout(6, width, 16);
      if (plan.columns > 1) expect(plan.colW).toBeGreaterThanOrEqual(28);
      expect(plan.columns * plan.colW + 3 * (plan.columns - 1)).toBeLessThanOrEqual(width);
    }
  });

  it("fits six charts on a three-line panel as one-line charts, in as many columns as that takes", () => {
    // One column fits three, two and three columns fit all six; of those, two
    // columns of 73 draw more chart (146 cells) than three of 48 (144).
    const plan = machineLayout(6, 150, 3);
    expect(plan).toMatchObject({ columns: 2, colW: 73, rows: 3, per: 1, shown: 6, header: false, chartH: 1 });
    expect(plan.columns * plan.rows).toBeGreaterThanOrEqual(6);
  });

  it("shows fewer charts when they cannot all fit, as many as there are lines", () => {
    // 40 wide is one column; three lines hold three one-line charts.
    const plan = machineLayout(6, 40, 3);
    expect(plan).toMatchObject({ columns: 1, rows: 3, shown: 3, header: false, chartH: 1 });
    expect(plan.shown).toBeLessThan(6);
  });

  it("never draws a chart taller than twelve rows, however tall the panel", () => {
    expect(machineLayout(1, 150, 40)).toMatchObject({ columns: 1, shown: 1, header: true, chartH: 12 });
  });

  it("has no layout for a panel with no lines in it", () => {
    expect(machineLayout(6, 150, 0)).toBeNull();
  });
});

describe("shownSeries", () => {
  const s = (key: string, points: Points) => ({ key, label: key, unit: "%", warnAt: null, critAt: null, restsAtZero: false, points });
  const ring = (list: Series[]) => ({ ...emptyMachine(), order: list.map(x => x.key), series: Object.fromEntries(list.map(x => [x.key, x])), count: 3 });

  it("folds the busiest core into All cores as its peak, reads in the deck's order and skips what has nothing to draw", () => {
    const m = ring([
      s("thermal:Throttling", [0, 0, 5]),
      s("cpu:busiest", [80, null, 99]),
      s("thermal:CPU", [70, 71, 72]),
      s("mem:swap", [1, 1, 1]),
      s("cpu:all", [20, 25, 30]),
      s("load:1m", [1, 2, 3]),
      s("thermal:GPU", [null, null, null]),
      s("mem:physical", [60, 60, 61]),
    ]);
    const shown: Series[] = shownSeries(m);
    expect(keysOf(shown)).toEqual(["cpu:all", "mem:physical", "mem:swap", "load:1m", "thermal:CPU", "thermal:Throttling"]);
    expect(shown[0].peak).toEqual([80, null, 99]);
    expect(shown[0].points).toEqual([20, 25, 30]);
    // The ring is read, not written.
    expect(m.series["cpu:all"]).not.toHaveProperty("peak");
  });

  it("keeps the busiest core as a chart of its own when All cores was not read", () => {
    const shown: Series[] = shownSeries(ring([s("cpu:busiest", [80, 90, 99]), s("mem:physical", [60, 60, 61])]));
    expect(keysOf(shown)).toEqual(["cpu:busiest", "mem:physical"]);
  });

  it("gives All cores no peak when the busiest core has nothing in it", () => {
    const shown: Series[] = shownSeries(ring([s("cpu:all", [20, 25, 30]), s("cpu:busiest", [null, null, null])]));
    expect(keysOf(shown)).toEqual(["cpu:all"]);
    expect(shown[0]).not.toHaveProperty("peak");
  });

  it("shows nothing without a ring", () => {
    expect(shownSeries(null)).toEqual([]);
    expect(shownSeries(emptyMachine())).toEqual([]);
  });
});

describe("valueText", () => {
  it("says a percentage whole, the queue to two places under 100 and whole from there, a temperature in degrees", () => {
    expect(valueText({ unit: "%" }, 54.4)).toBe("54%");
    expect(valueText({ unit: "" }, 54.24)).toBe("54.24");
    expect(valueText({ unit: "" }, 0.5)).toBe("0.50");
    expect(valueText({ unit: "" }, 100.4)).toBe("100");
    expect(valueText({ unit: "°" }, 89.6)).toBe("90°");
    expect(valueText({ unit: "°" }, 90, true)).toBe("90°");
    expect(valueText({ unit: "°" }, 90, false)).toBe("90C");
  });

  it("says a reading nobody took as a dash", () => {
    for (const unit of ["%", "", "°"]) expect(valueText({ unit }, null)).toBe("—");
  });
});

describe("machinePanel", () => {
  const panelOf = (live: Ring | null, over: Snap = {}): Panel =>
    machinePanel(live, { width: 116, height: 16, look: look(), ...over });

  it("says the readings come from the deck, and that d starts one, when there is no deck", () => {
    const p = panelOf(ringOf(3), { deck: false });
    expect(textOf(p)).toEqual(["the machine's readings come from the deck — d starts one"]);
    expect(stripAnsi(p.title)).toBe("Machine");
    expect(textOf(panelOf(null, { deck: false, starting: true }))).toEqual(["starting the deck…"]);
  });

  it("says it is reading the machine before the deck has answered", () => {
    expect(textOf(panelOf(emptyMachine()))).toEqual(["reading the machine…"]);
    expect(textOf(panelOf(null))).toEqual(["reading the machine…"]);
  });

  it("draws the deck's readings at 116 by 16, the busiest core beside All cores", () => {
    const p = panelOf(ringOf(40), { working: 3 });
    const text = textOf(p);
    expect(p.lines).toHaveLength(16);
    for (const l of p.lines) expect(textWidth(l)).toBeLessThanOrEqual(116);
    for (const l of p.lines) expect(l).not.toContain("\x1b");
    const all = text.find(l => l.includes("All cores"));
    expect(all).toContain("busiest 95%");
    expect(all).toContain("42%");
    const joined = text.join("\n");
    expect(joined).not.toContain("Busiest core");
    for (const name of ["Physical RAM", "Swap", "Queued work", "CPU temp", "Throttling"]) expect(joined).toContain(name);
    expect(joined).toContain("90°");
    expect(joined).toContain("5.50");
    // Braille, since the terminal has Unicode.
    expect(joined).toMatch(/[⠁-⣿]/);

    const note = p.note as string[];
    expect(note[0]).toContain("16 cores");
    expect(note[0]).toContain("up 2h 3m");
    expect(p.footLeft).toBe("3 sessions working");
    const foot = (p.footRight as string[])[0];
    expect(foot).toContain("live");
    expect(foot).toContain("t hours");
    // 47 readings (seven seeded, forty asked for) three seconds apart.
    expect(foot).toContain("last 2m");
  });

  it("counts one working session in the singular, and says nothing when none is", () => {
    expect(panelOf(ringOf(5), { working: 1 }).footLeft).toBe("1 session working");
    expect(panelOf(ringOf(5)).footLeft).toBe("");
  });

  it("is exactly as tall as asked and never wider, at every size, in every tier", () => {
    const live = ringOf(40);
    for (const width of [28, 40, 60, 80, 116, 160, 200]) {
      for (const height of [1, 3, 5, 8, 16, 30]) {
        for (const [unicode, profile] of [[true, "truecolor"], [true, "none"], [false, "ansi16"], [false, "none"]] as const) {
          const p = machinePanel(live, { width, height, look: look(unicode, profile) });
          expect(p.lines, `${width}x${height} ${profile}`).toHaveLength(height);
          for (const l of p.lines) expect(textWidth(l), `${width}x${height} ${profile}`).toBeLessThanOrEqual(width);
          if (profile === "none") for (const l of p.lines) expect(l).not.toContain("\x1b");
          if (!unicode) for (const l of p.lines) expect(stripAnsi(l)).toMatch(/^[\x20-\x7e]*$/);
        }
      }
    }
  });

  it("keeps All cores, Physical RAM and Queued work when only three charts fit", () => {
    const joined = textOf(panelOf(ringOf(10), { width: 40, height: 3 })).join("\n");
    for (const name of ["All cores", "Physical RAM", "Queued work"]) expect(joined).toContain(name);
    for (const name of ["Swap", "CPU temp", "Throttling"]) expect(joined).not.toContain(name);
  });

  it("draws the deck's minutes in the hours, with the live numbers, and t goes back to live", () => {
    const live = ringOf(40);
    const point = (t: number, v: number) => ({ t, v });
    const history: Ring = historyMachine([
      { ok: true, stepMs: MIN, series: [
        { key: "cpu:all", label: "All cores", unit: "%", top: 100, warnAt: null, critAt: null, restsAtZero: false, points: [point(NOW - 4 * MIN, 10), point(NOW, 12)] },
      ] },
      { ok: true, stepMs: MIN, series: [
        { key: "load:1m", label: "Queued work", unit: "", top: 25, warnAt: 4, critAt: null, restsAtZero: false, points: [point(NOW - 2 * MIN, 3)] },
      ] },
    ], live, NOW);
    const p = panelOf(live, { view: "hours", history });
    const foot = (p.footRight as string[])[0];
    expect(foot).toContain("by the minute");
    expect(foot).toContain("t live");
    expect(foot).toContain("last 5m");
    const text = textOf(p);
    expect(p.lines).toHaveLength(16);
    // The charts are the hours'; the numbers beside them are what the machine says now.
    expect(text.find(l => l.includes("All cores"))).toContain("42%");
    expect(text.join("\n")).not.toContain("12%");
    expect(text.join("\n")).toContain("5.50");
  });

  it("keeps the live charts while the hours are still being read, and says so", () => {
    const live = ringOf(40);
    const asked = panelOf(live, { view: "hours", history: null });
    const foot = (asked.footRight as string[])[0];
    expect(foot).toContain("reading the hours…");
    expect(foot).toContain("t hours");
    expect(asked.lines).toEqual(panelOf(live).lines);
  });

  // SUSPECTED BUG. A chart's name is not cut to its column in header mode
  // (machinePanel's `block`): a sensor named longer than the column pushes the
  // value — and every column right of it — past the panel's width. A hwmon or
  // Windows zone label can be this long; the panel's contract is `width` wide.
  it("cuts a sensor name too long for its column, so no row is wider than the panel", () => {
    const long = ringOf(10, () => snapshot({
      perCore: [], swap: null, thermal: { celsius: [{ label: "Composite Sensor Package id 0", celsius: 90, warnAt: 75, critAt: 100 }] },
    }));
    const p = panelOf(long, { width: 60 });
    for (const l of p.lines) expect(textWidth(l)).toBeLessThanOrEqual(60);
  });
});
