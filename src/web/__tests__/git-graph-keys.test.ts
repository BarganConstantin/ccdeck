// What a key means on the git view's history list. How a branch on one of its
// ref chips is cut is git-ref-chips.test.ts's.
import { describe, expect, it } from "vitest";
import { dismissesCard, historyKey } from "../git-graph-keys";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("a showing hover card", () => {
  it("goes on Escape before the view hears it, and on nothing else", () => {
    expect(dismissesCard(key("Escape"))).toBe(true);
    expect(dismissesCard(key("Escape", { ctrlKey: true }))).toBe(false);
    for (const k of ["ArrowDown", "Enter", "i", "g", "n"]) expect(dismissesCard(key(k)), k).toBe(false);
  });
});

describe("the keys the history list owns", () => {
  it("moves with the arrows, Home and End and the page keys, never past either end", () => {
    expect(historyKey(key("ArrowDown"), 3, 10, 5)).toEqual({ kind: "select", index: 4 });
    expect(historyKey(key("ArrowDown"), 9, 10, 5)).toEqual({ kind: "select", index: 9 });
    expect(historyKey(key("ArrowUp"), 0, 10, 5)).toEqual({ kind: "select", index: 0 });
    expect(historyKey(key("Home"), 6, 10, 5)).toEqual({ kind: "select", index: 0 });
    expect(historyKey(key("End"), 2, 10, 5)).toEqual({ kind: "select", index: 9 });
    expect(historyKey(key("PageDown"), 2, 10, 5)).toEqual({ kind: "select", index: 7 });
    expect(historyKey(key("PageDown"), 8, 10, 5)).toEqual({ kind: "select", index: 9 });
    expect(historyKey(key("PageUp"), 3, 10, 5)).toEqual({ kind: "select", index: 0 });
  });

  it("starts at the top when nothing is selected", () => {
    expect(historyKey(key("ArrowDown"), -1, 10, 5)).toEqual({ kind: "select", index: 0 });
    expect(historyKey(key("Enter"), -1, 10, 5)).toEqual({ kind: "pass" });
  });

  it("goes into the files with Enter or →, and opens the agent card with i", () => {
    expect(historyKey(key("Enter"), 2, 10, 5)).toEqual({ kind: "open" });
    expect(historyKey(key("ArrowRight"), 2, 10, 5)).toEqual({ kind: "open" });
    expect(historyKey(key("i"), 2, 10, 5)).toEqual({ kind: "card" });
  });

  it("leaves Tab, Escape, the view's own letters and every browser chord alone", () => {
    for (const k of ["Tab", "Escape", "g", "n", "r", "ArrowLeft", " "]) expect(historyKey(key(k), 2, 10, 5), k).toEqual({ kind: "pass" });
    expect(historyKey(key("ArrowDown", { ctrlKey: true }), 2, 10, 5)).toEqual({ kind: "pass" });
    expect(historyKey(key("i", { metaKey: true }), 2, 10, 5)).toEqual({ kind: "pass" });
    expect(historyKey(key("End", { altKey: true }), 2, 10, 5)).toEqual({ kind: "pass" });
  });
});
