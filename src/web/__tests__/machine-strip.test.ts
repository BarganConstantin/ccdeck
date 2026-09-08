// The band under the process list.
//
// Three things are asserted here and they are not the same kind of thing.
//
// The FIRST is a mirror. `liveReadings` recomputes, in the browser, quantities
// the server already computes for its ring — and the two have to agree on both
// the name and the arithmetic or a cell shows one machine's number under
// another machine's line. Nothing in either file says the other exists, so the
// join is checked against the server's own source rather than against a copy of
// it written here, which would only prove this file agrees with itself.
//
// The SECOND is a set of refusals: what does NOT get a cell, and why. A reading
// that is always zero, a label that is allowed to wrap, a span that claims an
// hour it has not had.
//
// The THIRD is layout that was wrong when it was written and was fixed from a
// measurement. Those numbers are pinned with the measurement beside them, so
// the next person to change them has to disagree with a number rather than with
// a preference.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fmtReading, liveReadings, THROTTLE_SERIES, type LiveSource } from "../machine-live";
import { worthACell, windowOf, SPARK_W, SPARK_H, WINDOW_BUCKETS, REFRESH_MS, GROUPS } from "../components/MachineStrip";
import { spanLabel, type Series } from "../components/SectionHistoryModal";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const metrics = readFileSync(at("../../server/system-metrics.mjs"), "utf8");
const strip = readFileSync(at("../components/MachineStrip.tsx"), "utf8");
const css = readFileSync(at("../styles.css"), "utf8");

/** A series with everything filled in, so each test states only what it is
 *  about. */
const series = (over: Partial<Series> = {}): Series => ({
  key: "cpu:all",
  label: "All cores",
  unit: "%",
  top: 100,
  warnAt: null,
  critAt: null,
  restsAtZero: false,
  points: [{ t: 0, v: 10 }, { t: 60_000, v: 20 }],
  ...over,
});

/** A machine that answers everything. Individual tests take pieces away. */
const full = (): LiveSource => ({
  cpu: 41.5,
  perCore: [10, 99, 30],
  memory: { total: 34359738368, available: 13146943488, usedPct: 61.7 },
  swap: { total: 13958643712, used: 12329680896 },
  loadavg: [78.89, 53.49, 40.2],
  thermal: { celsius: [{ label: "GPU", celsius: 64 }], throttle: { speedLimit: 82 } },
});

describe("the client's readings and the server's ring agree", () => {
  // Every `record("x", …)` the sampler makes, which is the complete list of
  // names the ring can ever be keyed by, read out of the server itself.
  const recorded = new Set(
    [...metrics.matchAll(/\brecord\(\s*(?:"([^"]+)"|`([^`]+)`)/g)]
      .map(m => m[1] ?? m[2])
      // `thermal:${label}` is one call that produces a key per sensor, and the
      // sensors are whatever the chip publishes. Its dynamic half is covered
      // by its own test below.
      .filter(k => !k.includes("${") || k.startsWith("thermal:")),
  );

  it("asks for nothing the ring does not record", () => {
    const asked = Object.keys(liveReadings(full()));
    const dynamicThermal = [...recorded].some(k => k.startsWith("thermal:"));
    const unknown = asked.filter(k => !recorded.has(k) && !(dynamicThermal && k.startsWith("thermal:")));
    expect(unknown).toEqual([]);
  });

  it("answers every fixed reading the ring records", () => {
    // The other direction, and the one that catches a reading the server learns
    // and the strip silently never shows a live number for: its cell would draw
    // its line and print the last bucket, up to a minute stale, for ever.
    const asked = new Set(Object.keys(liveReadings(full())));
    const fixed = [...recorded].filter(k => !k.includes("${"));
    expect(fixed.filter(k => !asked.has(k))).toEqual([]);
  });

  it("names throttling the way the server spells it", () => {
    expect(metrics).toContain('export const THROTTLE_LABEL = "Throttling"');
    expect(THROTTLE_SERIES).toBe("thermal:Throttling");
    expect(liveReadings(full())[THROTTLE_SERIES]).toBe(18);
  });

  it("computes swap the way the server rounds it, not to full precision", () => {
    // The server stores `Math.round(used / total * 1000) / 10`. Recomputing the
    // ratio here to full precision would put 88.4 in one place and
    // 88.36988... in the other, for the same machine at the same instant.
    const sys = full();
    const mine = liveReadings(sys)["mem:swap"];
    const theirs = Math.round((sys.swap!.used / sys.swap!.total) * 1000) / 10;
    expect(mine).toBe(theirs);
    expect(String(mine).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("takes the busiest core from the per-core list, as `cpu:busiest` is recorded", () => {
    expect(metrics).toContain('record("cpu:busiest", Math.max(...per))');
    expect(liveReadings(full())["cpu:busiest"]).toBe(99);
  });
});

describe("what a machine that cannot answer gets", () => {
  it("omits load on a platform that publishes none, rather than reading zero", () => {
    // Windows. `os.loadavg()` returns zeros there and the server refuses to
    // record them; a strip that printed `0.00` would be inventing calm.
    expect(metrics).toContain('const hasLoad = process.platform !== "win32"');
    const { loadavg, ...rest } = full();
    expect("load:1m" in liveReadings({ ...rest, loadavg: null })).toBe(false);
  });

  it("omits every temperature on a machine with no sensor", () => {
    const sys = { ...full(), thermal: null };
    expect(Object.keys(liveReadings(sys)).filter(k => k.startsWith("thermal:"))).toEqual([]);
  });

  it("omits swap where there is none, which is not the same as swap at zero", () => {
    const sys = { ...full(), swap: { total: 0, used: 0 } };
    expect("mem:swap" in liveReadings(sys)).toBe(false);
  });

  it("omits cpu until two samples exist", () => {
    expect("cpu:all" in liveReadings({ ...full(), cpu: null })).toBe(false);
  });
});

describe("which series is worth a cell", () => {
  it("refuses a reading that rests at zero and has not left it", () => {
    // Throttling on a desktop, essentially always. A cell that says `0%` under
    // a flat line every time it is looked at is read as broken, and then it is
    // not believed on the day it is not zero — which the panel has already
    // learned once, in `heldBackSoFar`.
    const flat = series({ key: THROTTLE_SERIES, restsAtZero: true, points: [{ t: 0, v: 0 }, { t: 60_000, v: 0 }] });
    expect(worthACell(flat)).toBe(false);
  });

  it("keeps that same reading the moment it has been anything else", () => {
    const held = series({ key: THROTTLE_SERIES, restsAtZero: true, points: [{ t: 0, v: 0 }, { t: 60_000, v: 12 }] });
    expect(worthACell(held)).toBe(true);
  });

  it("keeps a reading at zero that does not rest there", () => {
    // An idle CPU is a real answer to a real question, and `restsAtZero` is
    // false for it deliberately. A rule written over "all points are zero"
    // instead of over the flag would have dropped the cell on a quiet machine.
    const idle = series({ points: [{ t: 0, v: 0 }, { t: 60_000, v: 0 }] });
    expect(idle.restsAtZero).toBe(false);
    expect(worthACell(idle)).toBe(true);
  });

  it("refuses a series with no points at all", () => {
    expect(worthACell(series({ points: [] }))).toBe(false);
  });
});

describe("the window, and what it is allowed to claim", () => {
  it("draws at most an hour of buckets", () => {
    const many = series({ points: Array.from({ length: 500 }, (_, i) => ({ t: i * 60_000, v: i % 100 })) });
    expect(windowOf(many).points).toHaveLength(WINDOW_BUCKETS);
    // The TAIL, not the head: the last hour, not the first.
    expect(windowOf(many).points[WINDOW_BUCKETS - 1]).toEqual(many.points[499]);
  });

  it("leaves a shorter series exactly as it is", () => {
    const short = series();
    expect(windowOf(short)).toBe(short);
  });

  it("names the span it actually has instead of saying an hour", () => {
    // The line is stretched to the full width whatever it holds, so four
    // minutes and an hour occupy the same box. Saying "the last hour" over the
    // first would be read as an hour of calm.
    expect(spanLabel(0, 7 * 60_000)).toBe("7 minutes");
    expect(spanLabel(0, 61 * 60_000)).toBe("1h 1m");
    expect(strip).toContain("spanLabel");
    // And nothing in the component hard-codes the claim.
    expect(/last hour/i.test(strip.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""))).toBe(false);
  });

  it("re-reads the ring at the width of a bucket and no faster", () => {
    // Buckets are a minute wide; anything quicker re-fetches a ring that has
    // not changed. The NUMBER is live at the panel's own three seconds.
    expect(REFRESH_MS).toBe(60_000);
    expect(metrics).toContain("const BUCKET_MS = 60_000;");
  });

  it("asks for the four groups the server allows, in the panel's order", () => {
    expect([...GROUPS]).toEqual(["cores", "memory", "load", "thermal"]);
    // Every one of them is a group the endpoint accepts — a typo here is an
    // empty band with no error anywhere.
    const allow = readFileSync(at("../../server/index.mjs"), "utf8")
      .match(/\[("(?:thermal|cores|memory|load)",?\s*)+\]\.includes\(group\)/)?.[0] ?? "";
    for (const g of GROUPS) expect(allow).toContain(`"${g}"`);
  });
});

describe("how a reading is printed in a cell", () => {
  it("keeps a percentage whole and a temperature whole", () => {
    expect(fmtReading(61.66, "%")).toBe("62%");
    expect(fmtReading(64.2, "C")).toBe("64°");
  });

  it("keeps the load average's two decimals, because the panel prints two", () => {
    // A strip reading `78` beside a panel reading `78.89` is two numbers, and
    // the reader has to work out that they are one.
    expect(fmtReading(78.89, "")).toBe("78.89");
    expect(fmtReading(5, "")).toBe("5.00");
  });
});

describe("the layout, pinned to what was measured", () => {
  const rule = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
  };

  it("gives the head one line, because a wrapped label drops its own sparkline", () => {
    // Measured at 13.6px of misalignment on `Queued work`, the one label long
    // enough to break at the first width. Thermal labels come from the chip, so
    // this is not a fact about this machine: a Linux hwmon box publishes
    // `Package id 0` where this one says `GPU`.
    expect(rule(".pl-cell-head")).toContain("white-space: nowrap");
  });

  it("makes the label yield and the number hold", () => {
    const label = rule(".pl-cell-label");
    expect(label).toContain("text-overflow: ellipsis");
    expect(label).toContain("overflow: hidden");
    // Without this the number is what gets squeezed, and the number is the
    // reading.
    expect(rule(".pl-cell-now")).toContain("flex: none");
  });

  it("keeps the head and the sparkline the same width", () => {
    const w = rule(".pl-cell-head").match(/width:\s*(\d+)px/)?.[1];
    expect(Number(w)).toBe(SPARK_W);
  });

  it("is wide enough for the worst head, not for the one on screen", () => {
    // 59.7px for the longest label plus 8px of gap plus about 33px for a
    // three-digit load average.
    expect(SPARK_W).toBeGreaterThanOrEqual(101);
  });

  it("holds its own height before the first bucket exists", () => {
    // Buckets are a minute wide. Without this the band is 12px of border and
    // padding until the first one lands and then jumps to 54 — under a centred
    // dialog, which is the same defect the usage history modal was just fixed
    // for.
    const min = Number(rule(".pl-strip").match(/min-height:\s*(\d+)px/)?.[1]);
    expect(min).toBeGreaterThanOrEqual(SPARK_H + 24);
  });

  it("wraps rather than scrolling sideways", () => {
    // Measured: six cells are one row at 880px and three rows at 420px, with no
    // horizontal overflow at either. A footer is not a place anyone thinks to
    // scroll.
    expect(rule(".pl-strip")).toContain("flex-wrap: wrap");
  });

  it("draws the box as the scale, so a line's height means something", () => {
    // The panel's own grammar for these readings — `.sd-track` holds a
    // `.sd-fill` against the same 0-100. Without a track, 4px and 15px in a
    // 24px box are two positions with nothing to be positions against.
    expect(rule(".pl-spark")).toMatch(/background:\s*var\(--line-soft\)/);
    expect(rule(".sd-track")).toContain("background: var(--line)");
  });

  it("draws the floor before anything stands on it", () => {
    // A series with one bucket has no line — a shape needs two points — and an
    // empty box reads as a broken chart rather than as a young deck.
    expect(strip).toContain("pl-spark-floor");
    expect(rule(".pl-spark-floor")).toContain("stroke: var(--line-soft)");
  });
});

describe("the server publishes a key for every series", () => {
  it("gives one to each, because the label is platform-dependent", () => {
    // `Swap` is `Commit` on Windows, so anything joining a live reading to its
    // history by what the eye reads breaks on exactly the platform nobody
    // re-checks.
    expect(metrics).toContain('const swapLabel = process.platform === "win32" ? "Commit" : "Swap"');
    const body = metrics.slice(metrics.indexOf("function seriesFor"), metrics.indexOf("export function historySnapshot"));
    // Counted over `restsAtZero`, which the Series type requires of every
    // series and which nothing else in the function has. Counting `label`
    // instead was the first version and it counted seven for six: the
    // `new Map((thermal?.celsius ?? []).map(r => [r.label, r]))` above the
    // series is not a series.
    const seriesCount = (body.match(/\brestsAtZero:/g) ?? []).length;
    const keys = (body.match(/\bkey:/g) ?? []).length;
    expect(seriesCount).toBeGreaterThan(0);
    expect(keys).toBe(seriesCount);
  });
});
