import { afterEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ effects: [] as (() => unknown)[], listeners: [] as (() => void)[], nodes: new Map<string, any>(), frames: [] as (() => void)[] }));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, () => {}],
  useCallback: (callback: unknown) => callback,
  useEffect: (callback: () => unknown) => { harness.effects.push(callback); },
}));
vi.mock("reactflow", () => ({ useStoreApi: () => ({ getState: () => ({ nodeInternals: harness.nodes }), subscribe: (fn: () => void) => { harness.listeners.push(fn); return () => {}; } }) }));
import { useNodeMeasurements } from "../use-node-measurements";
afterEach(() => { vi.unstubAllGlobals(); harness.effects.length = harness.listeners.length = harness.frames.length = 0; harness.nodes.clear(); });
it("releases sizes of removed sessions while retaining hidden live sessions", () => {
  vi.stubGlobal("document", { visibilityState: "visible", querySelectorAll: () => [] });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { harness.frames.push(fn); return harness.frames.length; });
  const stateRef = { current: { agents: new Map<string, any>() } };
  const measured = useNodeMeasurements({ current: false }, stateRef);
  for (const effect of harness.effects) effect();
  const flush = () => { for (const frame of harness.frames.splice(0)) frame(); };
  for (let i = 0; i < 200; i++) {
    harness.nodes.clear(); stateRef.current.agents.clear();
    const id = `session-${i}`;
    harness.nodes.set(id, { id, type: "agent", width: 200, height: 100 });
    stateRef.current.agents.set(id, {});
    for (const notify of harness.listeners) notify();
    flush();
  }
  expect(measured.measuredRef.current.size).toBe(1);
  // Filtering a live card out is not deleting the session.
  harness.nodes.clear();
  for (const notify of harness.listeners) notify(); flush();
  expect(measured.measuredRef.current.has("session-199")).toBe(true);
  harness.nodes.set("recap:session-199", { id: "recap:session-199", type: "recapNote", width: 100, height: 50 });
  for (const notify of harness.listeners) notify(); flush();
  harness.nodes.clear();
  for (const notify of harness.listeners) notify(); flush();
  expect(measured.measuredRef.current.has("recap:session-199")).toBe(true);
  stateRef.current.agents.clear();
  for (const notify of harness.listeners) notify(); flush();
  expect(measured.measuredRef.current.size).toBe(0);
});
