// "detail-panel" is reported for the days the detail panel was on screen, not
// for every load of a tab that once had it open.
//
// The panel's open flag is kept in the browser (use-right-panels.ts) and the
// selection is not, so after a reload the flag is on and nothing is selected —
// and the panel draws only with both (App.tsx mounts DetailAside on
// `detailOpen && selected`). The flag was what said the feature was used, so
// any deck that had once shown a card's details reported the panel every day it
// loaded, an unattended desktop start included.
//
// The hooks are run on a React of two — state and an effect — against a
// stubbed store and beacon, plus the external-store read a component makes of
// the single-key switch.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "react";

const hooks = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  interface Effect { deps: Deps; cleanup: void | (() => void) }
  let current: { slots: unknown[]; effects: Effect[]; cursor: number; pending: Array<() => void> } | null = null;
  const same = (a: Deps, b: Deps) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const react = {
    useState<T>(init: T | (() => T)) {
      const inst = current!;
      const i = inst.cursor++;
      if (!(i in inst.slots)) inst.slots[i] = typeof init === "function" ? (init as () => T)() : init;
      return [inst.slots[i] as T, (v: T) => { inst.slots[i] = v; }] as const;
    },
    // DetailAside reads Settings › General's single-key switch through one,
    // for the tooltip it hands Detail; a store read once is all this needs.
    useSyncExternalStore<T>(_subscribe: unknown, getSnapshot: () => T) {
      return getSnapshot();
    },
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
  function mount<R>(hook: () => R) {
    const inst = { slots: [] as unknown[], effects: [] as Effect[], cursor: 0, pending: [] as Array<() => void> };
    current = inst;
    let result: R;
    try { result = hook(); } finally { current = null; }
    for (const run of inst.pending.splice(0)) run();
    return {
      result,
      unmount: () => { for (const e of inst.effects) if (typeof e?.cleanup === "function") e.cleanup(); },
    };
  }
  return { react, mount };
});

vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<object>()), ...hooks.react }));

let sent: string[] = [];
let stored: Record<string, string> = {};

beforeEach(() => {
  sent = [];
  stored = {};
  vi.stubGlobal("navigator", { sendBeacon: (_url: string, body: string) => { sent.push(JSON.parse(body).name); return true; } });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => { stored[k] = v; },
    },
  });
  // A fresh tab: nothing said yet today.
  vi.resetModules();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("the detail panel's feature", () => {
  it("is not said on a load with the flag stored open and nothing selected", async () => {
    stored["agent-dag.detailOpen"] = "1";
    const { useRightPanels } = await import("../use-right-panels");
    const deck = hooks.mount(() => useRightPanels());

    expect(deck.result.detailOpen).toBe(true);
    expect(sent).not.toContain("detail-panel");
    // The panels that ARE drawn from their flag alone are still said.
    expect(sent).toEqual(expect.arrayContaining(["usage-panel", "machine-panel"]));
    deck.unmount();
  });

  it("is said when the panel is drawn", async () => {
    const { default: DetailAside } = await import("../components/DetailAside");
    const props = {
      selected: { id: "A", label: "agent" }, now: 0,
      openTool: () => {}, setSummaryFor: () => {}, setDetailOpen: () => {},
      stateRef: { current: {} }, removeSelectedNode: () => {},
    } as unknown as ComponentProps<typeof DetailAside>;
    const panel = hooks.mount(() => DetailAside(props));

    expect(sent).toEqual(["detail-panel"]);
    panel.unmount();
  });
});
