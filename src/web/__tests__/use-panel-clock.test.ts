// usePanelClock — the thirty-second clock the accounts panel and the usage
// panel each wrote out for themselves.
//
// Run, not read: React is replaced by the two hooks this one calls, kept by
// hand — the state's initial value, the setter the interval calls and the
// effect with its cleanup — and the timers are vitest's, so the tick is
// measured to the millisecond. The suite has no DOM to mount a panel in; what
// the panels draw over a clock advance was compared in a browser, both builds.
// Then the two panels are read, to check each asks this hook and neither kept
// its copy, and that the accounts panel still registers the interval after the
// roster's own poll.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { WEB_DIR, clientPairs } from "./client-source";
import { withoutComments } from "./tsx-scan";

/** What the hook handed React, as the fake below records it. */
const react = vi.hoisted(() => ({
  initial: undefined as unknown,
  set: [] as unknown[],
  effects: [] as Array<{ run: () => void | (() => void); deps: unknown[] | undefined }>,
}));

vi.mock("react", () => ({
  useState: (init: unknown) => {
    react.initial = typeof init === "function" ? (init as () => unknown)() : init;
    return [react.initial, (v: unknown) => { react.set.push(v); }];
  },
  useEffect: (run: () => void | (() => void), deps?: unknown[]) => { react.effects.push({ run, deps }); },
}));

const { usePanelClock } = await import("../use-panel-clock");

const T0 = 1_790_550_000_123;

beforeEach(() => {
  react.initial = undefined;
  react.set = [];
  react.effects = [];
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  // The hook asks `window` for its timers, which a browser has and node does
  // not: point it at the faked globals.
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePanelClock", () => {
  it("answers whole seconds, read when the panel mounts", () => {
    expect(usePanelClock()).toBe(Math.floor(T0 / 1000));
    expect(react.initial).toBe(1_790_550_000);
  });

  it("starts one interval, once, when its effect runs — not before", () => {
    usePanelClock();
    expect(react.effects).toHaveLength(1);
    expect(react.effects[0].deps).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    react.effects[0].run();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("reads the clock again every thirty seconds, to the millisecond", () => {
    usePanelClock();
    react.effects[0].run();
    vi.advanceTimersByTime(29_999);
    expect(react.set).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(react.set).toEqual([Math.floor((T0 + 30_000) / 1000)]);
    vi.advanceTimersByTime(30_000);
    expect(react.set).toEqual([Math.floor((T0 + 30_000) / 1000), Math.floor((T0 + 60_000) / 1000)]);
  });

  it("measures from when the panel mounted, not from any other clock", () => {
    vi.advanceTimersByTime(12_345);
    usePanelClock();
    react.effects[0].run();
    vi.advanceTimersByTime(29_999);
    expect(react.set).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(react.set).toEqual([Math.floor((T0 + 12_345 + 30_000) / 1000)]);
  });

  it("stops for good when the panel unmounts", () => {
    usePanelClock();
    const cleanup = react.effects[0].run();
    expect(cleanup).toBeTypeOf("function");
    vi.advanceTimersByTime(30_000);
    (cleanup as () => void)();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(react.set).toHaveLength(1);
  });
});

describe("the two panels", () => {
  const panel = (rel: string) => withoutComments(readFileSync(`${WEB_DIR}${rel}`, "utf8"));

  it("each ask it for the clock their countdowns read", () => {
    for (const rel of ["components/AccountsPanel.tsx", "components/UsagePanel.tsx"]) {
      const text = panel(rel);
      expect(text, rel).toMatch(/^import \{ usePanelClock \} from "\.\.\/use-panel-clock";$/m);
      expect(text.match(/\bconst nowSec = usePanelClock\(\);/g), rel).toHaveLength(1);
      expect(text, rel).not.toMatch(/\bsetNowSec\b/);
    }
  });

  it("keep no thirty-second clock of their own anywhere in the client", () => {
    const owners = clientPairs()
      .filter(([, text]) => /setNowSec\(Math\.floor\(Date\.now\(\) \/ 1000\)\), (?:30_000|TICK_MS)\)/.test(text))
      .map(([rel]) => rel);
    expect(owners).toEqual(["use-panel-clock.ts"]);
  });

  it("start the accounts panel's interval after the roster's poll, as it always did", () => {
    // Effects run in the order their hooks are called, and two intervals due
    // at the same moment fire in the order they were set. The tick used to be
    // an effect written after every hook below; the call keeps that place.
    const text = panel("components/AccountsPanel.tsx");
    const at = text.indexOf("const nowSec = usePanelClock();");
    for (const before of ["useAccountRoster(", "useAccountMenu(", "useAccountSwitching(", "useThresholdDraft("]) {
      expect(text.indexOf(before), before).toBeGreaterThan(-1);
      expect(text.indexOf(before), before).toBeLessThan(at);
    }
    expect(text.indexOf("useEffect(")).toBeGreaterThan(at);
  });
});
