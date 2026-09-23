// #1174: a side panel stays on screen for exactly the length of its exit.
//
// The accounts, usage and machine panels mount on `isMounted(phase)`, so the
// phase is what decides whether a closed panel still holds its grid column.
// Nothing ran it: a pin found `nextPhase` by name and two others accepted the
// text `isMounted(usagePhase)`. Three regressions ship green that way. A reopen
// mid-exit that lands on `entering` replays the slide for a panel that never
// left. A timer that is not cleared on that reopen closes the panel under the
// user's cursor a moment later. And an `exitMs` that drifts from the CSS either
// cuts the animation off partway or leaves an invisible panel holding 288px
// beside a narrowed canvas.
//
// The table is a pure function and is called directly. The timer lives in the
// hook, so the hook is run on a React of three hooks below — render, then the
// effects whose deps moved, then render again while any of them set state — and
// every render's result is kept, so a phase that lasts one render is visible.
// The durations are read out of App.tsx and styles.css and compared.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const hooks = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  interface Effect { deps: Deps; cleanup: void | (() => void) }
  interface Instance {
    slots: unknown[];
    effects: Effect[];
    queued: Array<{ index: number; run: () => void | (() => void); deps: Deps }>;
    cursor: number;
    effectCursor: number;
    dirty: boolean;
    flushing: boolean;
    flush(): void;
  }
  let current: Instance | null = null;

  const react = {
    useState<T>(init: T | (() => T)) {
      const inst = current!;
      const i = inst.cursor++;
      if (!(i in inst.slots)) inst.slots[i] = typeof init === "function" ? (init as () => T)() : init;
      const set = (next: T | ((prev: T) => T)) => {
        const prev = inst.slots[i] as T;
        const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        if (Object.is(prev, value)) return;
        inst.slots[i] = value;
        inst.dirty = true;
        // A set from outside a render — a timer firing — renders now, the way
        // act() would.
        if (!inst.flushing) inst.flush();
      };
      return [inst.slots[i] as T, set] as const;
    },
    useRef<T>(init: T) {
      const inst = current!;
      const i = inst.cursor++;
      if (!(i in inst.slots)) inst.slots[i] = { current: init };
      return inst.slots[i] as { current: T };
    },
    useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
      const inst = current!;
      const index = inst.effectCursor++;
      const prev = inst.effects[index];
      const moved = !prev || !deps || !prev.deps || deps.some((d, k) => !Object.is(d, prev.deps![k]));
      if (moved) inst.queued.push({ index, run, deps });
    },
  };

  /** Renders `hook` with `props`, and keeps every result it returns. */
  function mount<P, R>(hook: (props: P) => R, props: P) {
    const renders: R[] = [];
    let latest = props;
    const inst: Instance = {
      slots: [], effects: [], queued: [], cursor: 0, effectCursor: 0, dirty: false, flushing: false,
      flush() {
        inst.flushing = true;
        try {
          let passes = 0;
          do {
            if (++passes > 50) throw new Error("the hook never settled");
            inst.dirty = false;
            inst.cursor = 0;
            inst.effectCursor = 0;
            inst.queued = [];
            current = inst;
            try { renders.push(hook(latest)); } finally { current = null; }
            // Every cleanup of an effect that moved, then every effect: React's
            // order, which is what lets a reopen clear the exit's timer.
            for (const q of inst.queued) {
              const cleanup = inst.effects[q.index]?.cleanup;
              if (typeof cleanup === "function") cleanup();
            }
            for (const q of inst.queued) inst.effects[q.index] = { deps: q.deps, cleanup: q.run() };
          } while (inst.dirty);
        } finally { inst.flushing = false; }
      },
    };
    inst.flush();
    return {
      renders,
      get now() { return renders[renders.length - 1]; },
      rerender(next: P) { latest = next; inst.flush(); },
    };
  }

  return { react, mount };
});

vi.mock("react", () => hooks.react);

import { isMounted, nextPhase, usePanelPresence, type PanelPhase } from "../panel-exit";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("nextPhase — where a panel goes from where it is", () => {
  const TABLE: Array<[open: boolean, from: PanelPhase, to: PanelPhase]> = [
    [true, "gone", "entering"],
    // The case the module names: a panel reopened inside its own exit comes
    // straight back. It never went anywhere, so an entrance would animate a
    // movement that did not happen.
    [true, "leaving", "here"],
    [true, "here", "here"],
    [true, "entering", "entering"],
    [false, "here", "leaving"],
    [false, "entering", "leaving"],
    [false, "leaving", "leaving"],
    [false, "gone", "gone"],
  ];

  it.each(TABLE)("open=%s from %s goes to %s", (open, from, to) => {
    expect(nextPhase(open, from)).toBe(to);
  });

  it("keeps the panel in the DOM in every phase but gone", () => {
    expect(isMounted("gone")).toBe(false);
    for (const phase of ["entering", "here", "leaving"] as const) expect(isMounted(phase), phase).toBe(true);
  });
});

describe("usePanelPresence — the hook, rendered", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const presence = (open: boolean, exitMs = 200) =>
    hooks.mount(({ open }: { open: boolean }) => usePanelPresence(open, exitMs), { open });

  it("mounts where the flag already is, with no entrance and no exit", () => {
    // A panel restored open on load is simply there; animating it in would be
    // a movement nobody asked for.
    const open = presence(true);
    const closed = presence(false);
    vi.advanceTimersByTime(1_000);
    expect(open.renders).toEqual(["here"]);
    expect(closed.renders).toEqual(["gone"]);
  });

  it("enters for one render when opened, then settles", () => {
    const p = presence(false);
    p.rerender({ open: true });
    expect(p.renders).toEqual(["gone", "gone", "entering", "here"]);
  });

  it.each([200, 130])("stays mounted and leaving for exactly exitMs=%i after a close", exitMs => {
    // 200 and 130 are what App.tsx hands the accounts panel and the rail's two.
    const p = presence(true, exitMs);
    p.rerender({ open: false });
    expect(p.now).toBe("leaving");
    vi.advanceTimersByTime(exitMs - 1);
    expect(p.now).toBe("leaving");
    vi.advanceTimersByTime(1);
    expect(p.now).toBe("gone");
    expect(isMounted(p.now)).toBe(false);
  });

  it("comes straight back when reopened mid-exit, and the exit's timer never lands", () => {
    const p = presence(true);
    p.rerender({ open: false });
    vi.advanceTimersByTime(50);
    const before = p.renders.length;
    p.rerender({ open: true });
    expect(p.now).toBe("here");
    expect(p.renders.slice(before)).not.toContain("entering");
    // Uncleared, the close's timer would take the panel away under the cursor
    // 150ms after it came back.
    vi.advanceTimersByTime(1_000);
    expect(p.now).toBe("here");
  });

  it("leaves again in full after a reopen, counting from the new close", () => {
    const p = presence(true);
    p.rerender({ open: false });
    vi.advanceTimersByTime(150);
    p.rerender({ open: true });
    p.rerender({ open: false });
    vi.advanceTimersByTime(199);
    expect(p.now).toBe("leaving");
    vi.advanceTimersByTime(1);
    expect(p.now).toBe("gone");
  });
});

describe("each panel is held for as long as its exit animation runs", () => {
  const app = read("../App.tsx");
  const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

  /** The `exitMs` App.tsx passes for one open flag. */
  const held = (flag: string) => {
    const m = new RegExp(`usePanelPresence\\(${flag}, (\\d+)\\)`).exec(app);
    expect(m, `App.tsx no longer holds ${flag}'s panel with a literal exitMs`).not.toBeNull();
    return Number(m![1]);
  };

  /** A custom property's value in ms — every declaration of it, which must agree. */
  const cssMs = (name: string) => {
    const values = [...css.matchAll(new RegExp(`${name}:\\s*(\\d+)ms`, "g"))].map(m => Number(m[1]));
    expect(values.length, `${name} is not declared in styles.css`).toBeGreaterThan(0);
    expect(new Set(values).size, `${name} is declared with different values`).toBe(1);
    return values[0];
  };

  /** The animation of every rule that styles a panel's `.leaving` state,
   *  reduced motion's included. Each has to be timed by the same property. */
  const leaving = (selector: string) =>
    [...css.matchAll(new RegExp(`${selector.replace(/[.]/g, "\\.")}\\.leaving\\b[^{]*\\{([^}]*)\\}`, "g"))]
      .map(m => /animation:\s*([^;]+)/.exec(m[1])?.[1] ?? "");

  it("holds the accounts panel for --side-exit", () => {
    const rules = leaving(".accounts-panel");
    expect(rules.length).toBeGreaterThan(0);
    for (const animation of rules) expect(animation).toContain("var(--side-exit)");
    expect(held("accountsPanelOpen")).toBe(cssMs("--side-exit"));
  });

  it("holds the usage and machine panels for --rail-exit", () => {
    // The machine panel renders as .sysdetail, and shares the usage panel's rule.
    for (const selector of [".usage-panel", ".sysdetail"]) {
      const rules = leaving(selector);
      expect(rules.length, selector).toBeGreaterThan(0);
      for (const animation of rules) expect(animation, selector).toContain("var(--rail-exit)");
    }
    expect(held("usagePanelOpen")).toBe(cssMs("--rail-exit"));
    expect(held("machinePanelOpen")).toBe(cssMs("--rail-exit"));
  });
});
