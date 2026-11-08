// The engine card's ready hold: once the engine is ready the card asks the
// stage for the terminal again by itself, after READY_HOLD_MS. Run, not read:
// the hook runs in React under a root with nothing to draw, and the timers are
// fake.
//
// Found in the browser pass: the stage hands a new onRetry with every render
// and the card reads the status every POLL_MS (shorter than the hold), so a
// hold that restarted on a new function never ran out, and the card said
// "Starting your terminal…" forever.
import "./web-globals";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { READY_HOLD_MS } from "../components/terminal/EngineCard";
import { POLL_MS, useHoldThen } from "../use-engine-install";

let root: Root;
let fired: string[] = [];

function Probe({ active, name }: { active: boolean; name: string }) {
  useHoldThen(active, READY_HOLD_MS, () => { fired.push(name); });
  return null;
}
const show = (active: boolean, name: string) => act(async () => root.render(createElement(Probe, { active, name })));
const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    HTMLIFrameElement: class {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  });
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.useFakeTimers();
  fired = [];
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  root = createRoot(container as unknown as Element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("the engine card's ready hold", () => {
  it("is longer than a status read, which is why a new function each render must not restart it", () => {
    expect(POLL_MS).toBeLessThan(READY_HOLD_MS);
  });

  it("runs out while the card is drawn again with a new function every status read", async () => {
    let n = 0;
    await show(true, `fire-${n}`);
    for (let spent = 0; spent < READY_HOLD_MS + POLL_MS; spent += POLL_MS) {
      await wait(POLL_MS);
      n += 1;
      await show(true, `fire-${n}`);
    }
    expect(fired).toHaveLength(1);
    // The function current when the hold ran out, not the first one.
    expect(fired[0]).not.toBe("fire-0");
  });

  it("does nothing before the hold is out", async () => {
    await show(true, "a");
    await wait(READY_HOLD_MS - 50);
    expect(fired).toEqual([]);
  });

  it("is called off when the card stops being ready", async () => {
    await show(true, "a");
    await wait(READY_HOLD_MS - 50);
    await show(false, "a");
    await wait(READY_HOLD_MS * 2);
    expect(fired).toEqual([]);
  });

  it("runs once, not again while it stays on", async () => {
    await show(true, "a");
    await wait(READY_HOLD_MS * 4);
    expect(fired).toEqual(["a"]);
  });
});
