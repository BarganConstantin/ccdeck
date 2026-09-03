// The chart behind a thermal row (#738).
//
// The panel's row answers "is it hot now". This answers "did it get hot while
// that build was running, and was I ever held back for it", and the whole
// reason it is a separate surface is that the second question needs time on the
// x-axis.
//
// Two things carry almost all the risk here and both are pure, so both are
// checked without a DOM. The SERVER must fold ten-second samples into minutes
// without losing a spike, because a mean would hide the one thing somebody
// opens this to find. The CLIENT must turn points into path commands without
// inventing a reading in a gap, because a straight line across a hole is a
// claim about minutes that were never sampled.
import { describe, it, expect, beforeEach } from "vitest";
import {
  sampleThermal, stopSystemMetrics, thermalHistorySnapshot, THROTTLE_LABEL,
} from "../../server/system-metrics.mjs";
import {
  areaPath, band, clock, linePath, spanLabel, summary, throttleNote, yFor,
  type Point,
} from "../components/ThermalHistoryModal";

const MIN = 60_000;
/** Points a minute apart, newest last, as the server emits them. */
const run = (vals: number[], from = 1_800_000_000_000): Point[] =>
  vals.map((v, i) => ({ t: from + i * MIN, v }));

describe("the server's minute buckets", () => {
  beforeEach(() => stopSystemMetrics());

  const reading = (celsius: number, speedLimit = 100) => async () => ({
    celsius: [{ label: "GPU", celsius, warnAt: 75, critAt: 90 }],
    throttle: { speedLimit },
  });

  it("keeps the PEAK of a minute, not its average", async () => {
    // Six samples land in each bucket at the 10s cadence. A machine that
    // touched 94°C for twenty seconds and sat at 60 for the rest of the minute
    // averages to 66 and reads as calm — and the spike is the entire thing the
    // chart exists to find.
    await sampleThermal({ read: reading(60) });
    await sampleThermal({ read: reading(94) });
    await sampleThermal({ read: reading(61) });
    const gpu = thermalHistorySnapshot().series.find(s => s.label === "GPU")!;
    expect(gpu.points.map(p => p.v)).toEqual([94]);
  });

  it("stores throttling the way the panel draws it — the share taken away", async () => {
    // The row says "9%" for a speed limit of 91. If the chart stored the limit
    // instead, the two surfaces would disagree about which direction is bad.
    await sampleThermal({ read: reading(60, 91) });
    const held = thermalHistorySnapshot().series.find(s => s.label === THROTTLE_LABEL)!;
    expect(held.points.map(p => p.v)).toEqual([9]);
  });

  it("gives each series its own unit and its own bands", async () => {
    // Degrees and a percentage share nothing but a range. A shape that could
    // hold either under one label is how a throttle percentage ends up printed
    // under a °C heading.
    await sampleThermal({ read: reading(60, 100) });
    const { series } = thermalHistorySnapshot();
    expect(series.map(s => [s.label, s.unit, s.warnAt])).toEqual([
      ["GPU", "C", 75],
      [THROTTLE_LABEL, "%", null],
    ]);
  });

  it("records nothing at all for a machine that answered nothing", async () => {
    await sampleThermal({ read: async () => null });
    expect(thermalHistorySnapshot().series).toEqual([]);
  });

  it("keys on the row's own label, so a sensor that appears late still charts", async () => {
    // A GPU driver loads, a laptop is docked. The new series simply has no
    // points before it appeared, which is the truth.
    await sampleThermal({ read: reading(60) });
    await sampleThermal({ read: async () => ({
      celsius: [{ label: "GPU", celsius: 61, warnAt: 75, critAt: 90 },
                { label: "CPU", celsius: 44, warnAt: 84, critAt: 100 }],
      throttle: null,
    }) });
    const labels = thermalHistorySnapshot().series.map(s => s.label);
    expect(labels).toContain("CPU");
  });

  it("forgets its history when the sampler stops", async () => {
    // The buckets belong to the run that produced them; a restart must not
    // answer with a chart from before it.
    await sampleThermal({ read: reading(60) });
    expect(thermalHistorySnapshot().series.length).toBeGreaterThan(0);
    stopSystemMetrics();
    expect(thermalHistorySnapshot()).toMatchObject({ sinceMs: 0, series: [] });
  });
});

describe("where a value sits in the box", () => {
  it("puts the floor at the bottom and the ceiling at the top", () => {
    expect(yFor(0)).toBeGreaterThan(yFor(100));
  });

  it("scales against a fixed 0-100, not against the data", () => {
    // A scale fitted to the readings would redraw a calm afternoon as a
    // dramatic climb the moment the numbers moved two degrees — and the panel's
    // own row draws this same number against 0-100, so two pictures of one
    // reading would disagree about how alarming it is.
    const [a, b] = [yFor(50), yFor(60)];
    expect(a - b).toBeCloseTo((yFor(10) - yFor(20)), 5);
  });

  it("clamps a reading that ran off the end rather than drawing outside the box", () => {
    expect(yFor(140)).toBe(yFor(100));
    expect(yFor(-5)).toBe(yFor(0));
  });
});

describe("the line, and the holes in it", () => {
  it("draws one continuous run as one subpath", () => {
    const d = linePath(run([50, 55, 60]), 560, MIN);
    expect((d.match(/M/g) ?? []).length).toBe(1);
    expect((d.match(/L/g) ?? []).length).toBe(2);
  });

  it("breaks rather than drawing through a gap", () => {
    // A bucket exists only for a minute that was sampled. A machine asleep, or
    // a deck paused, leaves a hole — and a straight line across it would invent
    // a reading for every minute inside, which is the one thing this feature
    // refuses to do.
    const points = [...run([50, 55]), { t: 1_800_000_000_000 + 30 * MIN, v: 80 }];
    const d = linePath(points, 560, MIN);
    expect((d.match(/M/g) ?? []).length).toBe(2);
  });

  it("tolerates one missed sample without calling it a gap", () => {
    // A single dropped read is a hiccup, not an absence, and breaking the line
    // for every one of them would make a normal chart look like a barcode.
    const points = [{ t: 0, v: 50 }, { t: 2 * MIN, v: 52 }];
    expect((linePath(points, 560, MIN).match(/M/g) ?? []).length).toBe(1);
  });

  it("draws nothing at all from nothing", () => {
    expect(linePath([], 560, MIN)).toBe("");
  });

  it("puts a single point in the middle rather than dividing by a zero span", () => {
    const d = linePath(run([61]), 560, MIN);
    expect(d).toMatch(/^M/);
    expect(d).not.toContain("NaN");
  });
});

describe("the area under the line", () => {
  it("closes each contiguous run to the floor on its own", () => {
    // Filling across a hole would claim the machine read zero through it.
    // Abandoning the fill because the series has one hole anywhere — which is
    // what this did first — throws away two hours of reading to avoid
    // inventing twelve minutes.
    const points = [...run([50, 55, 60]), { t: 1_800_000_000_000 + 40 * MIN, v: 70 },
                    { t: 1_800_000_000_000 + 41 * MIN, v: 72 }];
    const d = areaPath(points, 560, MIN);
    expect((d.match(/M/g) ?? []).length).toBe(2);
    expect((d.match(/Z/g) ?? []).length).toBe(2);
  });

  it("leaves a lone point unfilled, because two points make an area", () => {
    expect(areaPath(run([61]), 560, MIN)).toBe("");
  });

  it("drops a run of one inside a gappy series rather than closing a sliver", () => {
    const points = [{ t: 0, v: 50 }, { t: 40 * MIN, v: 70 }];
    expect(areaPath(points, 560, MIN)).toBe("");
  });
});

describe("the two numbers above the chart", () => {
  it("reads now from the end and peak from the whole run", () => {
    expect(summary(run([50, 88, 61]))).toEqual({ now: 61, peak: 88 });
  });

  it("says nothing when nothing was measured", () => {
    expect(summary([])).toEqual({ now: null, peak: null });
  });

  it("colours the peak by the sensor's own bands, like the row does", () => {
    expect(band(88, 84, 100)).toBe("warn");
    expect(band(88, 95, 105)).toBe("");
    expect(band(101, 84, 100)).toBe("hot");
  });

  it("colours nothing on a series that has no bands", () => {
    // A throttle percentage has no comfortable range to be inside; the note
    // under it carries the meaning instead.
    expect(band(18, null, null)).toBe("");
  });
});

describe("the sentence under the throttle chart", () => {
  it("says how long and how recently, which the line cannot", () => {
    // A machine held back for one minute an hour ago is a different machine
    // from one held back for forty of the last sixty.
    const points = [{ t: 0, v: 0 }, { t: MIN, v: 9 }, { t: 2 * MIN, v: 11 }, { t: 3 * MIN, v: 0 }];
    expect(throttleNote(points, MIN, () => "12:21"))
      .toBe("held back for 2 minutes, last at 12:21");
  });

  it("counts one minute as one minute", () => {
    expect(throttleNote([{ t: 0, v: 4 }], MIN, () => "09:00"))
      .toBe("held back for 1 minute, last at 09:00");
  });

  it("says so plainly when it never happened", () => {
    // A flat line at zero says "nothing happened" and says nothing about when
    // it did not happen.
    expect(throttleNote(run([0, 0, 0]), MIN)).toBe("never held back");
  });

  it("says nothing before there is anything to say", () => {
    expect(throttleNote([], MIN)).toBeNull();
  });
});

describe("the clock and the span", () => {
  it("is 24-hour, whatever the reader's locale prefers", () => {
    // The panel prints 13:28 elsewhere. A locale that renders 01:28 PM here
    // would put two clocks in one card.
    const afternoon = new Date(2026, 0, 2, 13, 28).getTime();
    expect(clock(afternoon)).toBe("13:28");
    expect(clock(new Date(2026, 0, 2, 9, 5).getTime())).toBe("09:05");
  });

  it("says a span the way a person would", () => {
    expect(spanLabel(0, 30 * MIN)).toBe("30 minutes");
    expect(spanLabel(0, MIN)).toBe("1 minute");
    expect(spanLabel(0, 180 * MIN)).toBe("3h");
    expect(spanLabel(0, 222 * MIN)).toBe("3h 42m");
  });

  it("does not claim a minute it does not have", () => {
    // Thirty seconds after the deck started, which is when somebody first
    // opens this.
    expect(spanLabel(0, 30_000)).toBe("less than a minute");
    expect(spanLabel(1000, 0)).toBe("less than a minute");
  });
});
