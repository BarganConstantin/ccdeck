// Pin a session to the top of the Sessions list, the rules (list-pinned.ts and
// rail-model.ts's Pinned place): what storage holds, the order the pins keep,
// how a pin goes with its session, the key, and where the list puts a pinned
// row. The list that draws them is list-pinned-session-list.test.ts.
import { describe, expect, it } from "vitest";
import {
  LIST_PINNED_CAP, LIST_PINNED_KEY, isPinChord, pinChordLabel, prunedPinned, readListPinned, saveListPinned,
  togglePinned, withPinned, withoutPinned,
} from "../list-pinned";
import {
  RAIL_FOLD_AT, RAIL_PINNED, RAIL_SECTIONS, foldPlan, holdOrder, railSectionLabelMsg, railSlots, type Slot,
} from "../rail-model";
import { en } from "../i18n/en";

function fakeStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
  };
}

describe("what storage holds", () => {
  it("is the ids in the order they were pinned, under its own key, and reads back the same", () => {
    const store = fakeStore();
    let ids = withPinned([], "b");
    ids = withPinned(ids, "a");
    saveListPinned(store, ids);
    expect(LIST_PINNED_KEY).toBe("agent-dag.listPinned");
    expect(JSON.parse(store.data.get(LIST_PINNED_KEY)!)).toEqual(["b", "a"]);
    expect(readListPinned(store)).toEqual(["b", "a"]);
  });

  it("reads a store that is missing, blocked or holds anything else as nothing pinned", () => {
    expect(readListPinned(null)).toEqual([]);
    expect(readListPinned(fakeStore())).toEqual([]);
    expect(readListPinned(fakeStore({ [LIST_PINNED_KEY]: "{not json" }))).toEqual([]);
    expect(readListPinned(fakeStore({ [LIST_PINNED_KEY]: JSON.stringify({ a: 1 }) }))).toEqual([]);
    const throws = { getItem: () => { throw new Error("SecurityError"); } };
    expect(readListPinned(throws)).toEqual([]);
  });

  it("keeps only ids, each once, in its first place", () => {
    const store = fakeStore({ [LIST_PINNED_KEY]: JSON.stringify(["a", 3, "", null, "b", "a", ["c"]]) });
    expect(readListPinned(store)).toEqual(["a", "b"]);
  });

  it("writes nothing where the store refuses, and does not throw", () => {
    expect(() => saveListPinned({ setItem: () => { throw new Error("quota"); } }, ["a"])).not.toThrow();
    expect(() => saveListPinned(null, ["a"])).not.toThrow();
  });

  it("keeps at most the cap, dropping the oldest pin", () => {
    let ids: readonly string[] = [];
    for (let i = 0; i < LIST_PINNED_CAP + 3; i++) ids = withPinned(ids, `s${i}`);
    expect(ids).toHaveLength(LIST_PINNED_CAP);
    expect(ids[0]).toBe("s3");
    expect(ids.at(-1)).toBe(`s${LIST_PINNED_CAP + 2}`);
  });
});

describe("pinning and unpinning", () => {
  it("adds a pin as the newest, and hands back the same array for one already pinned", () => {
    const ids = withPinned(withPinned([], "a"), "b");
    expect(ids).toEqual(["a", "b"]);
    expect(withPinned(ids, "a")).toBe(ids);
  });

  it("takes pins off, and hands back the same array when none of them was pinned", () => {
    const ids = ["a", "b", "c"];
    expect(withoutPinned(ids, ["b"])).toEqual(["a", "c"]);
    expect(withoutPinned(ids, ["x"])).toBe(ids);
    expect(withoutPinned(ids, [])).toBe(ids);
  });

  it("toggles: on at the end, off from wherever it was", () => {
    let ids = togglePinned(["a"], "b");
    expect(ids).toEqual(["a", "b"]);
    ids = togglePinned(ids, "a");
    expect(ids).toEqual(["b"]);
    // Pinned again, it is the newest: the order is when it was pinned.
    expect(togglePinned(ids, "a")).toEqual(["b", "a"]);
  });
});

describe("a pin goes with its session", () => {
  it("is dropped for a session the deck no longer knows, and the rest keep their order", () => {
    expect(prunedPinned(["a", "gone", "b"], id => id !== "gone")).toEqual(["a", "b"]);
  });

  it("hands back the same array when every pinned session is still known", () => {
    const ids = ["a", "b"];
    expect(prunedPinned(ids, () => true)).toBe(ids);
  });
});

describe("the pin key", () => {
  const key = (k: string, extra: Partial<Parameters<typeof isPinChord>[0]> = {}) =>
    ({ key: k, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, ...extra });

  it("is Alt+P, by the letter, whatever its case", () => {
    expect(isPinChord(key("p", { code: "KeyP" }))).toBe(true);
    expect(isPinChord(key("P", { code: "KeyP" }))).toBe(true);
  });

  it("is ⌥P on a Mac, which types π, and the P key on a layout with no Latin letters", () => {
    expect(isPinChord(key("π", { code: "KeyP" }))).toBe(true);
    expect(isPinChord(key("з", { code: "KeyP" }))).toBe(true);
    // A Latin letter is read as itself, wherever its key is.
    expect(isPinChord(key("q", { code: "KeyP" }))).toBe(false);
  });

  it("is not P alone (the deck's peek), nor P with Shift, Ctrl or ⌘, nor a held key", () => {
    expect(isPinChord(key("p", { altKey: false }))).toBe(false);
    expect(isPinChord(key("P", { altKey: false, shiftKey: true }))).toBe(false);
    expect(isPinChord(key("P", { shiftKey: true }))).toBe(false);
    expect(isPinChord(key("p", { ctrlKey: true }))).toBe(false);
    expect(isPinChord(key("p", { metaKey: true }))).toBe(false);
    expect(isPinChord(key("p", { repeat: true }))).toBe(false);
  });

  it("is labelled the way the keyboard in front of the reader is", () => {
    expect(pinChordLabel("MacIntel")).toBe("⌥P");
    expect(pinChordLabel("Win32")).toBe("Alt+P");
    expect(pinChordLabel("Linux x86_64")).toBe("Alt+P");
  });
});

describe("where the list puts a pinned row (rail-model.ts)", () => {
  const rows: Slot[] = [
    { id: "blocked", group: 0 }, { id: "busy", group: 2 }, { id: "d1", group: 3 }, { id: "d2", group: 3 }, { id: "ready", group: 4 },
  ];

  it("Pinned first, in the order the pins were put on, each row once", () => {
    const slots = railSlots(rows, ["d2", "blocked"]);
    expect(slots).toEqual([
      { id: "d2", group: RAIL_PINNED }, { id: "blocked", group: RAIL_PINNED },
      { id: "busy", group: 2 }, { id: "d1", group: 3 }, { id: "ready", group: 4 },
    ]);
    expect(new Set(slots.map(s => s.id)).size).toBe(slots.length);
  });

  it("draws nothing for a pin with no row, and leaves the order alone with no pins", () => {
    expect(railSlots(rows, ["gone"])).toEqual(rows);
    expect(railSlots(rows, [])).toEqual(rows);
  });

  it("is a place above Needs you, named Pinned", () => {
    expect(RAIL_SECTIONS).toEqual([RAIL_PINNED, 0, 1, 2, 3, 4]);
    expect(RAIL_PINNED).toBeLessThan(0);
    expect(en[railSectionLabelMsg(RAIL_PINNED)]).toBe("Pinned");
    expect(en[railSectionLabelMsg(0)]).toBe("Needs you");
  });

  it("is never folded, and takes its room from the budget the groups under it share", () => {
    expect(RAIL_FOLD_AT).toBe(8);
    // Two pinned, two waiting and one working leave three rows for Done.
    expect(foldPlan([2, 0, 1, 5, 0], 2)).toEqual([
      { shown: 2, rest: 0 }, { shown: 0, rest: 0 }, { shown: 1, rest: 0 }, { shown: 3, rest: 2 }, { shown: 0, rest: 0 },
    ]);
    // However many are pinned, Needs you and Working stay whole too.
    expect(foldPlan([1, 1, 1, 1, 1], 12)).toEqual([
      { shown: 1, rest: 0 }, { shown: 0, rest: 1 }, { shown: 1, rest: 0 }, { shown: 0, rest: 1 }, { shown: 0, rest: 1 },
    ]);
    // No pins, the plan it always was.
    expect(foldPlan([2, 4, 4, 4, 0], 0)).toEqual(foldPlan([2, 4, 4, 4, 0]));
  });

  it("going into Pinned or out of it is a group change: held in place, counted as a move", () => {
    const held = railSlots(rows, []);
    const pinned = holdOrder(held, railSlots(rows, ["d1"]));
    expect(pinned.order).toEqual(held);
    expect(pinned.moves).toBe(1);
    const unpinned = holdOrder(railSlots(rows, ["d1"]), railSlots(rows, []));
    expect(unpinned.order.map(s => s.id)).toEqual(["d1", "blocked", "busy", "d2", "ready"]);
    expect(unpinned.moves).toBe(1);
  });

  it("a session pinned while nothing was drawn for it joins Pinned's end, under a held order", () => {
    const held = railSlots(rows, ["d2"]);
    const fresh = railSlots([...rows, { id: "new", group: 3 }], ["d2", "new"]);
    expect(holdOrder(held, fresh).order.map(s => s.id)).toEqual(["d2", "new", "blocked", "busy", "d1", "ready"]);
  });
});
