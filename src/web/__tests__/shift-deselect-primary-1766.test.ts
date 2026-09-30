// #1766: the primary selection is always one of the selected cards, or none.
//
// Shift+click toggles a card in and out of the selection, and the card it adds
// becomes the primary: the one the ribbon names, the detail panel shows, and Z,
// D and Delete act on. The set and the primary were two states with two
// updaters, and the primary's never learned whether the click had added the
// card or taken it out, so it named the card either way. Shift+clicking the
// primary out left the ribbon, the panel and Delete on a card with no
// highlight; Shift+clicking a card that was not primary out made it primary.
//
// The decision is `nextSelection`, a pure function, and is called directly.
// The hook is then run on a React of two hooks — state and callback — with
// every set applied at once, the way a click's batch lands, to show it is the
// function the clicks go through.
import { describe, it, expect, vi } from "vitest";

const hooks = vi.hoisted(() => {
  interface Instance { slots: unknown[]; cursor: number }
  let current: Instance | null = null;
  const react = {
    useState<T>(init: T | (() => T)) {
      const inst = current!;
      const i = inst.cursor++;
      if (!(i in inst.slots)) inst.slots[i] = typeof init === "function" ? (init as () => T)() : init;
      const set = (next: T | ((prev: T) => T)) => {
        inst.slots[i] = typeof next === "function" ? (next as (p: T) => T)(inst.slots[i] as T) : next;
      };
      return [inst.slots[i] as T, set] as const;
    },
    useCallback<F>(fn: F) { return fn; },
  };
  function mount<R>(hook: () => R) {
    const inst: Instance = { slots: [], cursor: 0 };
    const render = () => {
      inst.cursor = 0;
      current = inst;
      try { return hook(); } finally { current = null; }
    };
    let latest = render();
    return {
      get now() { return latest; },
      /** Run `act` against the latest render, then render again. */
      act(act: (r: R) => void) { act(latest); latest = render(); },
    };
  }
  return { react, mount };
});

vi.mock("react", () => hooks.react);

import { nextSelection, useSelection, type Selection } from "../use-selection";
import type { GraphState } from "../reducer";

function selection(agents = new Map<string, unknown>([["A", {}], ["B", {}], ["C", {}]])) {
  const stateRef = { current: { agents } as unknown as GraphState };
  return hooks.mount(() => useSelection(stateRef, () => {}));
}

type Step = [id: string, additive: boolean];

/** Runs the clicks, checking after each one that the primary is selected. */
function run(steps: Step[]) {
  const s = selection();
  for (const [id, additive] of steps) {
    s.act(r => r.selectAgent(id, additive));
    const { selectedIds, primarySelectedId } = s.now;
    if (primarySelectedId != null) {
      expect(selectedIds.has(primarySelectedId), `after ${id}${additive ? " (shift)" : ""}: primary ${primarySelectedId} is not in {${[...selectedIds]}}`).toBe(true);
    }
  }
  return s.now;
}

describe("useSelection — Shift+click out of the selection", () => {
  it("falls back to the card still selected when the primary is taken out", () => {
    const end = run([["A", false], ["B", true], ["B", true]]);
    expect([...end.selectedIds]).toEqual(["A"]);
    expect(end.primarySelectedId).toBe("A");
  });

  it("keeps the primary when a card that is not primary is taken out", () => {
    const end = run([["A", false], ["B", true], ["A", true]]);
    expect([...end.selectedIds]).toEqual(["B"]);
    expect(end.primarySelectedId).toBe("B");
  });

  it("has no primary once the only selected card is taken out", () => {
    const end = run([["A", false], ["A", true]]);
    expect(end.selectedIds.size).toBe(0);
    expect(end.primarySelectedId).toBeNull();
  });

  it("falls back to the card added most recently of those left", () => {
    // Three selected, the primary taken out: of A and B, B was added last, and
    // the primary is "the one last clicked into the selection".
    const end = run([["A", false], ["B", true], ["C", true], ["C", true]]);
    expect([...end.selectedIds]).toEqual(["A", "B"]);
    expect(end.primarySelectedId).toBe("B");
  });

  it("still makes an added card primary, and a plain click still replaces the set", () => {
    const added = run([["A", false], ["B", true]]);
    expect([...added.selectedIds]).toEqual(["A", "B"]);
    expect(added.primarySelectedId).toBe("B");
    const plain = run([["A", false], ["B", true], ["C", false]]);
    expect([...plain.selectedIds]).toEqual(["C"]);
    expect(plain.primarySelectedId).toBe("C");
  });

  it("keeps the two together when the board drops the primary", () => {
    // The tick's prune (#576) was already right, and stays so on one state.
    const agents = new Map<string, unknown>([["A", {}], ["B", {}]]);
    const s = selection(agents);
    s.act(r => r.selectAgent("A", false));
    s.act(r => r.selectAgent("B", true));
    agents.delete("B");
    s.act(r => r.pruneSelectionToBoard());
    expect([...s.now.selectedIds]).toEqual(["A"]);
    expect(s.now.primarySelectedId).toBeNull();
    s.act(r => r.clearSelection());
    expect(s.now.selectedIds.size).toBe(0);
    expect(s.now.primarySelectedId).toBeNull();
  });
});

describe("nextSelection — the one decision, called directly", () => {
  const sel = (ids: string[], primary: string | null): Selection => ({ ids: new Set(ids), primary });

  it.each<[string, Selection, string, boolean, string[], string | null]>([
    ["a plain click replaces the set", sel(["A", "B"], "B"), "C", false, ["C"], "C"],
    ["a plain click on a selected card keeps only it", sel(["A", "B"], "B"), "A", false, ["A"], "A"],
    ["Shift adds a card and makes it primary", sel(["A"], "A"), "B", true, ["A", "B"], "B"],
    ["Shift takes the primary out, the last added left takes over", sel(["A", "B", "C"], "C"), "C", true, ["A", "B"], "B"],
    ["Shift takes the primary out of the middle", sel(["A", "B", "C"], "B"), "B", true, ["A", "C"], "C"],
    ["Shift takes another card out, the primary stays", sel(["A", "B"], "B"), "A", true, ["B"], "B"],
    ["Shift takes the last card out, nothing is primary", sel(["A"], "A"), "A", true, [], null],
    ["Shift out with no primary (the board dropped it) stays without one", sel(["A", "B"], null), "A", true, ["B"], null],
  ])("%s", (_, prev, id, additive, ids, primary) => {
    const next = nextSelection(prev, id, additive);
    expect([...next.ids]).toEqual(ids);
    expect(next.primary).toBe(primary);
    if (next.primary != null) expect(next.ids.has(next.primary)).toBe(true);
  });

  it("never changes the selection it was given", () => {
    const prev = sel(["A", "B"], "B");
    nextSelection(prev, "B", true);
    nextSelection(prev, "C", true);
    expect([...prev.ids]).toEqual(["A", "B"]);
    expect(prev.primary).toBe("B");
  });
});
