// The skeleton for a pending read waits before it shows, so a read the server
// answers at once never flashes it. Run, not read: the hook runs in React under
// a root with nothing to draw, and the timers are fake.
//
//   - nothing at 60 ms into the wait;
//   - shown once the delay has passed while the wait goes on;
//   - gone in the same render the answer lands (not one commit later);
//   - the timer is cleared when the component goes away.
import "./web-globals";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useSkeletonDelay } from "../use-skeleton-delay";

const DELAY = 150;
const seen: boolean[] = [];
let root: Root;

function Probe({ pending }: { pending: boolean }) {
  const shown = useSkeletonDelay(pending, DELAY);
  seen.push(shown);
  return null;
}
const last = () => seen[seen.length - 1];
const show = (pending: boolean) => act(async () => root.render(createElement(Probe, { pending })));
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

beforeEach(async () => {
  vi.useFakeTimers();
  seen.length = 0;
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  root = createRoot(container as unknown as Element);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("the skeleton's delay", () => {
  it("shows nothing at 60 ms into the wait", async () => {
    await show(true);
    await wait(60);
    expect(last()).toBe(false);
    expect(seen.includes(true)).toBe(false);
    await act(async () => root.unmount());
  });

  it("shows after the delay while the wait goes on", async () => {
    await show(true);
    await wait(DELAY + 10);
    expect(last()).toBe(true);
    await act(async () => root.unmount());
  });

  it("is gone in the same render the answer lands", async () => {
    await show(true);
    await wait(DELAY + 10);
    expect(last()).toBe(true);
    const before = seen.length;
    await show(false);
    // The first render after the answer must already be false: no render in
    // between keeps the skeleton while the effect catches up.
    expect(seen[before]).toBe(false);
    expect(last()).toBe(false);
    await act(async () => root.unmount());
  });

  it("is cleared on unmount, so a late timer shows nothing", async () => {
    await show(true);
    await wait(60);
    const timers = vi.getTimerCount();
    expect(timers).toBe(1);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
