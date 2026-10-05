// The stacked charts in one history dialog, drawn against one time axis.
//
// Each chart stretched across its own first and last point. On a deck that
// could not reach Claude for its first stretch, the Network dialog drew three
// hours of Download over the whole width and, under it, the forty minutes of
// latency it had over the same width — so 14:00 sat at two different places on
// two charts the dialog stacks so they can be read one against the other. A
// thermal sensor that turned up late, or stopped answering, was stretched the
// same way. Every chart is now drawn against the span the whole dialog covers,
// and a series that starts late or ends early leaves its part of it empty.
//
// Run, not read: the dialog is drawn on fake-react.ts's React with a fetch that
// answers its history request, and each chart it draws is drawn in turn from
// the props the dialog gave it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));

const { default: SectionHistoryModal, linePath, areaPath } = await import("../components/SectionHistoryModal");

const MIN = 60_000;
const T0 = new Date(2026, 9, 5, 12, 0).getTime();

/** One reading a minute from `fromMin` to `toMin` after T0. */
const minutes = (fromMin: number, toMin: number, v = 50) =>
  Array.from({ length: toMin - fromMin + 1 }, (_, i) => ({ t: T0 + (fromMin + i) * MIN, v }));

const series = (key: string, label: string, unit: string, points: Array<{ t: number; v: number }>) => ({
  key, label, unit, top: 100, warnAt: null, critAt: null, restsAtZero: false, points,
});

/** Download for three hours; the latency probe only answered for the last
 *  forty minutes of them. */
const HISTORY = {
  ok: true,
  sinceMs: T0,
  stepMs: MIN,
  series: [
    series("net:down", "Download", "B/s", minutes(0, 180)),
    series("net:api", "Claude", "ms", minutes(140, 180)),
  ],
};

beforeEach(() => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    setInterval: () => 0,
    clearInterval: () => {},
  }));
  vi.stubGlobal("document", { activeElement: null, body: {} });
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => HISTORY }));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The dialog, open on the network section, with its history in. */
async function dialog() {
  const view = mount(SectionHistoryModal, { group: "network", title: "Network", onClose: () => {} });
  await flush();
  view.rerender();
  return view;
}

/** Each chart the dialog stacks, drawn. */
async function charts() {
  const view = await dialog();
  const els = all(view.tree, el => typeof el.type === "function" && "series" in el.props);
  expect(els.map(el => (el.props.series as { label: string }).label)).toEqual(["Download", "Claude"]);
  return els.map(el => mount(el.type as (p: unknown) => unknown, el.props).tree);
}

/** The x of every point on a chart's line, in order. */
function xs(tree: unknown): number[] {
  const line = one(tree, el => el.type === "path" && el.props.className === "hist-line") as Drawn;
  return [...String(line.props.d).matchAll(/[ML]([\d.]+) /g)].map(m => Number(m[1]));
}

describe("the charts in one dialog", () => {
  it("draw the same minute at the same x", async () => {
    const [down, api] = await charts();
    const downX = xs(down);
    const apiX = xs(api);
    // Minute 140 is the latency series' first point and the Download series'
    // 141st.
    expect(apiX[0], "the late series was stretched back to the left edge").toBeCloseTo(downX[140], 0);
    // And both end at the right edge, together.
    expect(apiX.at(-1)).toBeCloseTo(downX.at(-1)!, 0);
  });

  it("leave the part of the span a series was not measured in empty", async () => {
    const [down, api] = await charts();
    expect(xs(api)[0]).toBeGreaterThan(xs(down)[0] + 100);
  });

  it("print the dialog's span under every chart", async () => {
    const [down, api] = await charts();
    const axis = (tree: unknown) => textOf(one(tree, el => el.props.className === "hist-axis"));
    expect(axis(api)).toBe(axis(down));
    expect(axis(api)).toBe("12:0015:00");
  });
});

describe("the shapes on their own", () => {
  it("still span their own points when no axis is shared — the footer's sparklines", () => {
    const d = linePath(minutes(140, 180), 560, MIN);
    expect(d.startsWith("M30.0 ")).toBe(true);
  });

  it("place a point by the axis they are handed", () => {
    const shared: [number, number] = [T0, T0 + 180 * MIN];
    const line = linePath(minutes(140, 180), 560, MIN, 100, 104, undefined, shared);
    const area = areaPath(minutes(140, 180), 560, MIN, 100, 104, undefined, shared);
    // 140 of 180 minutes along a 524px plot that starts at 30.
    const at140 = (30 + (524 * 140) / 180).toFixed(1);
    expect(line.startsWith(`M${at140} `)).toBe(true);
    expect(area.startsWith(`M${at140} `)).toBe(true);
  });
});
