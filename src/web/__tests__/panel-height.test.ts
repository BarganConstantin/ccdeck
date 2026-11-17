// A rail panel opens at the height it settled at last time (panel-place.ts
// useRememberedHeight): held while its readings arrive, never taller than the
// room it has, released after HEIGHT_HOLD_MS, remembered when it goes. Run as a
// hook under fake-react against a stub of the panel element.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEIGHT_HOLD_MS, PLACE_KEYS, useRememberedHeight } from "../panel-place";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const KEY = "agent-dag.usagePanelHeight";
let store: Map<string, string>;
let observed: (() => void) | null;
let pagehide: (() => void)[];

function element(over: { top: number; height: number }) {
  const style = {
    minHeight: "",
    maxHeight: "",
    removeProperty(name: string) { if (name === "min-height") style.minHeight = ""; if (name === "max-height") style.maxHeight = ""; },
  };
  return { style, offsetTop: over.top, offsetHeight: over.height, offsetLeft: 0, offsetWidth: 320 };
}

beforeEach(() => {
  vi.useFakeTimers();
  store = new Map();
  observed = null;
  pagehide = [];
  const g = globalThis as Record<string, unknown>;
  g.window = {
    innerHeight: 900,
    setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false }),
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    addEventListener: (t: string, f: () => void) => { if (t === "pagehide") pagehide.push(f); },
    removeEventListener: (t: string, f: () => void) => { if (t === "pagehide") pagehide = pagehide.filter(x => x !== f); },
  };
  g.document = {
    querySelector: (sel: string) => (sel === ".statusbar" ? { getBoundingClientRect: () => ({ height: 24 }) } : null),
  };
  g.ResizeObserver = class { constructor(cb: () => void) { observed = cb; } observe() {} disconnect() {} };
});
afterEach(() => {
  vi.useRealTimers();
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.document;
  delete g.ResizeObserver;
});

function Panel({ el }: { el: ReturnType<typeof element> }) {
  useRememberedHeight({ current: el as unknown as HTMLElement }, PLACE_KEYS.usage);
  return null;
}

describe("a panel's remembered height", () => {
  it("is held on open while the readings arrive, and released after HEIGHT_HOLD_MS", () => {
    store.set(KEY, "467");
    const el = element({ top: 48, height: 288 });
    mount(Panel, { el });
    expect(el.style.minHeight, "the final height from the first frame").toBe("467px");
    vi.advanceTimersByTime(HEIGHT_HOLD_MS - 1);
    expect(el.style.minHeight).toBe("467px");
    vi.advanceTimersByTime(1);
    expect(el.style.minHeight, "then it is as tall as its content").toBe("");
  });

  it("holds nothing the first time: there is no height to hold", () => {
    const el = element({ top: 48, height: 288 });
    mount(Panel, { el });
    expect(el.style.minHeight).toBe("");
  });

  it("never holds more than the room from its top to the status bar, not even for a frame", () => {
    // 900 high, a 24px status bar, a panel at 458: 418 to the bar, less the 8 kept from an edge.
    store.set(KEY, "563");
    const el = element({ top: 458, height: 300 });
    mount(Panel, { el });
    expect(parseFloat(el.style.minHeight)).toBe(900 - 24 - 458 - 8);
  });

  it("is never taller than a window that has shrunk since", () => {
    store.set(KEY, "800");
    const el = element({ top: 48, height: 300 });
    mount(Panel, { el });
    expect(parseFloat(el.style.minHeight)).toBeLessThanOrEqual(900 - 140);
  });

  it("remembers the height it has when it goes, and when the page does", () => {
    const el = element({ top: 48, height: 300 });
    const view = mount(Panel, { el });
    el.offsetHeight = 467;
    observed!();
    for (const f of pagehide) f();
    expect(store.get(KEY), "written as the page goes").toBe("467");
    el.offsetHeight = 480;
    observed!();
    view.unmount();
    expect(store.get(KEY), "and when the panel closes").toBe("480");
  });

  it("leaves a phone alone", () => {
    (globalThis as { window: { matchMedia: () => { matches: boolean } } }).window.matchMedia = () => ({ matches: true });
    store.set(KEY, "467");
    const el = element({ top: 48, height: 288 });
    mount(Panel, { el });
    expect(el.style.minHeight).toBe("");
  });
});
