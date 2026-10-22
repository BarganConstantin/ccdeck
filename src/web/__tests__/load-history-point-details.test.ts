// The load chart, read after the fact.
//
// The panel's note says how many times over the cores the queue is — "4.5×
// more work queued than cores to run it" — for the load right now, and only
// then. A spike that reached 400 on ten cores at 00:23 was a 400 on the chart
// and nothing else: the reading under the pointer gave the load but not what it
// meant, and it was gone the moment the pointer left, so reading a spike meant
// holding the mouse over it. These check that the reading says it, that a click
// keeps it, and that the peak figure takes you to its own minute.
//
// Run, not read: the dialog is drawn on fake-react.ts's React with a fetch that
// answers its history request, and its chart is drawn from the props the
// dialog gave it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));

const { default: SectionHistoryModal, coreMultiple } = await import("../components/SectionHistoryModal");

const MIN = 60_000;
const T0 = new Date(2026, 9, 5, 0, 0).getTime();
/** The chart's width before anything measures it, and the plot inside it. */
const W = 560;
const PLOT = { l: 30, r: 6 };

/** An hour of a busy machine on ten cores, one minute of it buried. */
const loads = (from = 0, to = 60) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ t: T0 + (from + i) * MIN, v: from + i === 23 ? 400.79 : 46.18 }));
const loadSeries = (points = loads()) => ({
  key: "load:1m", label: "Queued work", unit: "", top: 500, warnAt: 10, critAt: null, restsAtZero: false, cores: 10, points,
});

let history: unknown;
beforeEach(() => {
  history = { ok: true, sinceMs: T0, stepMs: MIN, series: [loadSeries()] };
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    setInterval: () => 0,
    clearInterval: () => {},
  }));
  vi.stubGlobal("document", { activeElement: null, body: {} });
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => history }));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The dialog's one chart, drawn from the props the dialog gave it. */
async function chart(group: "load" | "thermal" = "load") {
  const dialog = mount(SectionHistoryModal, { group, title: "Load history", onClose: () => {} });
  await flush();
  dialog.rerender();
  const el = one(dialog.tree, d => typeof d.type === "function" && "series" in d.props) as Drawn;
  const Chart = el.type as (p: Record<string, unknown>) => unknown;
  const view = mount(Chart, el.props);
  return { view, Chart, props: el.props };
}

const svg = (tree: unknown) => one(tree, el => el.type === "svg") as Drawn;
/** A pointer event over the chart at minute `m` of the hour. */
const at = (m: number) => ({
  clientX: PLOT.l + ((W - PLOT.l - PLOT.r) * m) / 60,
  currentTarget: { getBoundingClientRect: () => ({ left: 0, width: W }) },
});
const call = (el: Drawn, handler: string, ev?: unknown) => (el.props[handler] as (e?: unknown) => void)(ev);
const reading = (tree: unknown) => textOf(one(tree, el => el.props.className === "hist-at"));
const axis = (tree: unknown) => textOf(one(tree, el => el.props.className === "hist-axis"));
const button = (tree: unknown, className: string) =>
  one(tree, el => el.type === "button" && String(el.props.className).split(" ").includes(className));

describe("the multiple of the cores", () => {
  it("is said for any load, under the cores as well as over them", () => {
    expect(coreMultiple(400.79, 10)).toBe("40.1× the core count");
    expect(coreMultiple(46.18, 10)).toBe("4.6× the core count");
    // 0.4× is as much an answer to "how busy was it" as 40× is.
    expect(coreMultiple(4, 10)).toBe("0.4× the core count");
  });

  it("says nothing it cannot measure", () => {
    // Every chart but the load chart has no cores to divide by.
    expect(coreMultiple(61, undefined)).toBeNull();
    for (const cores of [0, -1, NaN, Infinity]) expect(coreMultiple(40, cores)).toBeNull();
    for (const load of [NaN, Infinity, -1]) expect(coreMultiple(load, 10)).toBeNull();
  });
});

describe("the reading under the load chart", () => {
  it("says how many times over the cores the minute under the pointer was", async () => {
    const { view } = await chart();
    call(svg(view.tree), "onPointerMove", at(23));
    expect(reading(view.tree)).toBe("00:23 — 400.79 · 40.1× the core count");
  });

  it("is gone with the pointer unless the minute was clicked", async () => {
    const { view } = await chart();
    call(svg(view.tree), "onPointerMove", at(23));
    call(svg(view.tree), "onPointerLeave");
    expect(axis(view.tree)).toBe("00:0001:00");
  });

  it("stays on a clicked minute after the pointer leaves", async () => {
    // On a touch screen, lifting the finger IS the pointer leaving: without
    // this a reading could not be kept there at all.
    const { view } = await chart();
    call(svg(view.tree), "onPointerMove", at(23));
    call(svg(view.tree), "onClick", at(23));
    call(svg(view.tree), "onPointerLeave");
    expect(reading(view.tree)).toBe("00:23 — 400.79 · 40.1× the core count");
  });

  it("still follows the pointer while a minute is kept, and returns to it", async () => {
    const { view } = await chart();
    call(svg(view.tree), "onClick", at(23));
    call(svg(view.tree), "onPointerMove", at(50));
    expect(reading(view.tree)).toBe("00:50 — 46.18 · 4.6× the core count");
    call(svg(view.tree), "onPointerLeave");
    expect(reading(view.tree)).toMatch(/^00:23 — /);
  });

  it("lets the minute go when it is clicked again, or from its ×", async () => {
    const { view } = await chart();
    call(svg(view.tree), "onClick", at(23));
    call(svg(view.tree), "onClick", at(23));
    expect(axis(view.tree)).toBe("00:0001:00");

    call(svg(view.tree), "onClick", at(23));
    const release = button(view.tree, "hist-unpin") as Drawn;
    expect(release.props["aria-label"]).toBe("Stop showing this reading");
    call(release, "onClick");
    expect(axis(view.tree)).toBe("00:0001:00");
    expect(button(view.tree, "hist-unpin")).toBeNull();
  });

  it("keeps the minute, not the position, across a refresh", async () => {
    // The history is fetched again every twenty seconds and the ring drops its
    // oldest minute. A kept index would slide onto 00:24.
    const { view, props } = await chart();
    call(svg(view.tree), "onClick", at(23));
    view.rerender({ ...props, series: loadSeries(loads(1, 61)), domain: [T0 + MIN, T0 + 61 * MIN] });
    expect(reading(view.tree)).toBe("00:23 — 400.79 · 40.1× the core count");
  });
});

describe("the peak figure", () => {
  it("takes you to the minute it was reached", async () => {
    const { view } = await chart();
    const peak = button(view.tree, "hist-peak") as Drawn;
    expect(textOf(peak)).toBe("400.79 peak");
    call(peak, "onClick");
    expect(reading(view.tree)).toBe("00:23 — 400.79 · 40.1× the core count");
  });

  it("is in the chart's name too, for a reader who cannot point at it", async () => {
    const { view } = await chart();
    expect(svg(view.tree).props["aria-label"]).toBe(
      "Queued work: 46.18 now, peak 400.79 at 00:23 (40.1× the core count), over 1h",
    );
  });

  it("is only a figure on a chart of one point, which has no line to read along", async () => {
    history = { ok: true, sinceMs: T0, stepMs: MIN, series: [loadSeries(loads(0, 0))] };
    const { view } = await chart();
    expect(button(view.tree, "hist-peak")).toBeNull();
  });
});

describe("the other charts", () => {
  it("keep a clicked minute too, with no multiple they have nothing to divide by", async () => {
    history = {
      ok: true, sinceMs: T0, stepMs: MIN,
      series: [{ ...loadSeries(), key: "thermal:GPU", label: "GPU", unit: "C", top: 100, cores: undefined }],
    };
    const { view } = await chart("thermal");
    call(svg(view.tree), "onClick", at(23));
    expect(reading(view.tree)).toBe("00:23 — 400.79°C");
  });
});
