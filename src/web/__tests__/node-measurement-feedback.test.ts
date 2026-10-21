import { afterEach, expect, it, vi } from "vitest";
import { mount } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const source = vi.hoisted(() => ({
  state: { nodeInternals: new Map<string, any>() },
  listeners: new Set<() => void>(),
}));
const api = {
  getState: () => source.state,
  subscribe: (listener: () => void) => {
    source.listeners.add(listener);
    return () => source.listeners.delete(listener);
  },
};
vi.mock("reactflow", () => ({ useStoreApi: () => api }));
const { useNodeMeasurements } = await import("../use-node-measurements");
afterEach(() => { source.listeners.clear(); vi.unstubAllGlobals(); });

function setup({ hidden = false, dragging = false, dom = [] as any[] } = {}) {
  source.state = { nodeInternals: new Map() };
  let id = 0, renders = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  vi.stubGlobal("document", { visibilityState: hidden ? "hidden" : "visible", querySelectorAll: () => dom });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { frames.set(++id, fn); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void) => { timers.set(++id, fn); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const drag = { current: dragging };
  let measurement!: ReturnType<typeof useNodeMeasurements>;
  const view = mount(() => { renders++; measurement = useNodeMeasurements(drag); return null; }, {});
  return {
    frames, timers, view, drag,
    get measurement() { return measurement; },
    get renders() { return renders; },
    write(height: number, type = "agent") {
      source.state = { nodeInternals: new Map([["card", { id: "card", type, width: 200, height }]]) };
      for (const listener of source.listeners) listener();
    },
    flush() { const queue = hidden ? timers : frames; const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach(fn => fn()); },
  };
}

it("coalesces conflicting controlled and observer sizes without synchronous render feedback", () => {
  const harness = setup();
  try {
    for (let i = 0; i < 100; i++) harness.write(i % 2 ? 80 : 120);
    expect(harness.renders).toBe(1);
    expect(harness.frames.size).toBe(1);
    harness.flush();
    expect(harness.measurement.sizeVersion).toBe(1);
    expect(harness.measurement.measuredRef.current.get("card")?.height).toBe(80);
    expect(harness.renders).toBe(2);
    // Identical final dimensions in a later burst owe no new render.
    harness.write(120); harness.write(80); harness.flush();
    expect(harness.renders).toBe(2);
  } finally { harness.view.unmount(); }
  expect(harness.frames.size).toBe(0);
  expect(source.listeners.size).toBe(0);
});

it("does not replace a DOM measurement with an unchanged store measurement", () => {
  const harness = setup();
  try {
    harness.write(80); harness.flush();
    harness.measurement.measuredRef.current.set("card", { width: 200, height: 100 });
    harness.write(80); harness.flush();
    expect(harness.measurement.sizeVersion).toBe(1);
    expect(harness.measurement.measuredRef.current.get("card")?.height).toBe(100);
    harness.write(120); harness.flush();
    expect(harness.measurement.sizeVersion).toBe(2);
    expect(harness.measurement.measuredRef.current.get("card")?.height).toBe(120);
  } finally { harness.view.unmount(); }
});

it("keeps derived session handles out of the card measurement counter", () => {
  const harness = setup();
  try {
    harness.write(300, "sessionGroup"); harness.flush();
    expect(harness.measurement.sizeVersion).toBe(0);
    expect(harness.measurement.measuredRef.current.size).toBe(0);
  } finally { harness.view.unmount(); }
});

it("uses one cancellable timer for hidden pages", () => {
  const harness = setup({ hidden: true });
  try {
    harness.write(80); harness.write(120);
    expect(harness.frames.size).toBe(0);
    expect(harness.timers.size).toBe(1);
    harness.flush();
    expect(harness.measurement.measuredRef.current.get("card")?.height).toBe(120);
  } finally { harness.view.unmount(); }
  expect(harness.timers.size).toBe(0);
});

it("skips forced DOM layout during a drag while retaining store size updates", () => {
  const element = { classList: { contains: () => false }, getAttribute: () => "card", get offsetWidth() { throw new Error("DOM read during drag"); } };
  const harness = setup({ dragging: true, dom: [element] });
  try { harness.write(80); harness.flush(); expect(harness.measurement.sizeVersion).toBe(1); }
  finally { harness.view.unmount(); }
});
