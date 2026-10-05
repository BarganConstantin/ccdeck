// A panel left open across midnight UTC still counts for the day after
// (feature-use.ts, useFeatureUse).
//
// The usage reports keep the features a page showed per UTC day, and the page
// said a name only when its panel opened. The usage, machine and accounts
// panels stay open for days in a desktop window nobody reloads, and Claude FM
// plays through midnight, so every day after the first reported them unused.
//
// The hook is run on a React of one hook — an effect, re-run when its deps
// move, its cleanup run first — on fake timers, against a stubbed beacon.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hooks = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  interface Effect { deps: Deps; cleanup: void | (() => void) }
  let current: { effects: Effect[]; cursor: number; pending: Array<() => void> } | null = null;
  const same = (a: Deps, b: Deps) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const react = {
    useEffect(run: () => void | (() => void), deps?: Deps) {
      const inst = current!;
      const i = inst.cursor++;
      const prev = inst.effects[i];
      if (prev && same(prev.deps, deps)) return;
      inst.pending.push(() => {
        if (typeof prev?.cleanup === "function") prev.cleanup();
        inst.effects[i] = { deps, cleanup: run() };
      });
    },
  };
  function mount<P>(hook: (p: P) => void, props: P) {
    const inst = { effects: [] as Effect[], cursor: 0, pending: [] as Array<() => void> };
    const render = (p: P) => {
      inst.cursor = 0;
      current = inst;
      try { hook(p); } finally { current = null; }
      for (const run of inst.pending.splice(0)) run();
    };
    render(props);
    return {
      rerender: render,
      unmount: () => { for (const e of inst.effects) if (typeof e?.cleanup === "function") e.cleanup(); },
    };
  }
  return { react, mount };
});

vi.mock("react", () => hooks.react);

type FeatureUse = typeof import("../feature-use");

let sent: string[] = [];
let useFeatureUse: FeatureUse["useFeatureUse"];

beforeEach(async () => {
  vi.useFakeTimers();
  // Ten minutes before midnight UTC.
  vi.setSystemTime(new Date("2026-10-04T23:50:00Z"));
  sent = [];
  vi.stubGlobal("navigator", { sendBeacon: (_url: string, body: string) => { sent.push(JSON.parse(body).name); return true; } });
  // A fresh tab: nothing said yet today.
  vi.resetModules();
  ({ useFeatureUse } = await import("../feature-use"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const HOUR = 60 * 60_000;

describe("a panel open across midnight UTC", () => {
  it("is said again for the new day, and every day after, while it stays open", () => {
    hooks.mount(({ on }) => useFeatureUse("usage-panel", on), { on: true });
    expect(sent).toEqual(["usage-panel"]);

    vi.advanceTimersByTime(HOUR);           // 00:50 on the 5th
    expect(sent).toEqual(["usage-panel", "usage-panel"]);

    vi.advanceTimersByTime(24 * HOUR);      // 00:50 on the 6th
    expect(sent).toEqual(["usage-panel", "usage-panel", "usage-panel"]);
  });

  it("is said once a day, not once a day per hour it stays open", () => {
    hooks.mount(() => useFeatureUse("accounts-panel"), undefined);
    vi.advanceTimersByTime(23 * HOUR);      // 22:50 on the 5th
    expect(sent).toEqual(["accounts-panel", "accounts-panel"]);
  });

  it("is not said for the new day once it has closed, or been taken off the page", () => {
    const shut = hooks.mount(({ on }) => useFeatureUse("claude-fm", on), { on: true });
    shut.rerender({ on: false });
    const gone = hooks.mount(() => useFeatureUse("machine-panel"), undefined);
    gone.unmount();
    vi.advanceTimersByTime(48 * HOUR);
    expect(sent).toEqual(["claude-fm", "machine-panel"]);
  });

  it("is never said for a panel that stayed closed", () => {
    hooks.mount(({ on }) => useFeatureUse("detail-panel", on), { on: false });
    vi.advanceTimersByTime(48 * HOUR);
    expect(sent).toEqual([]);
  });
});
