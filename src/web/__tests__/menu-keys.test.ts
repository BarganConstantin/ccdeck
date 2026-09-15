// The keyboard half of the accounts panel's ⋯ menu (menu-keys.ts): Up and Down
// walk the items and wrap, Home and End are the ends, and everything else is
// left to whoever owns it.
import { describe, it, expect } from "vitest";
import { menuMove } from "../menu-keys";

const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({ key: k, ...mods });

describe("the arrow keys in a menu (menu-keys.ts)", () => {
  it("walks down and wraps from the last item to the first", () => {
    expect(menuMove(key("ArrowDown"), 0, 4)).toEqual({ kind: "focus", index: 1 });
    expect(menuMove(key("ArrowDown"), 3, 4)).toEqual({ kind: "focus", index: 0 });
  });

  it("walks up and wraps from the first item to the last", () => {
    expect(menuMove(key("ArrowUp"), 2, 4)).toEqual({ kind: "focus", index: 1 });
    expect(menuMove(key("ArrowUp"), 0, 4)).toEqual({ kind: "focus", index: 3 });
  });

  it("lands on an end when focus is on the menu rather than an item", () => {
    expect(menuMove(key("ArrowDown"), -1, 4)).toEqual({ kind: "focus", index: 0 });
    expect(menuMove(key("ArrowUp"), -1, 4)).toEqual({ kind: "focus", index: 3 });
  });

  it("goes to the ends on Home and End", () => {
    expect(menuMove(key("Home"), 2, 4)).toEqual({ kind: "focus", index: 0 });
    expect(menuMove(key("End"), 1, 4)).toEqual({ kind: "focus", index: 3 });
  });

  it("leaves every other key alone — Tab and Escape are not the index's to answer", () => {
    for (const k of ["ArrowLeft", "ArrowRight", "Tab", "Escape", "Enter", " ", "r"]) {
      expect(menuMove(key(k), 1, 4), k).toEqual({ kind: "pass" });
    }
  });

  it("stands aside for the browser's chords", () => {
    expect(menuMove(key("ArrowDown", { altKey: true }), 0, 4)).toEqual({ kind: "pass" });
    expect(menuMove(key("Home", { ctrlKey: true }), 2, 4)).toEqual({ kind: "pass" });
  });

  it("has nothing to walk when every item is disabled", () => {
    expect(menuMove(key("ArrowDown"), -1, 0)).toEqual({ kind: "pass" });
  });
});
