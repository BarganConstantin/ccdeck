// What a key means on the git view's history list, and how a branch on one of
// its ref chips is cut to the chip's room: the card chip's spellings, measured
// from one character of the chip's own font.
import { describe, expect, it } from "vitest";
import { historyKey } from "../git-graph-keys";
import { fitBranchWidth, monoWidth } from "../git-branch-fit";
import { branchCandidates } from "../git-chip";
import { sourceOf } from "./client-source";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

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

describe("a branch on a ref chip, cut to the chip's room", () => {
  const seven = monoWidth(7);

  it("measures a monospace string as its characters, the ellipsis one of them", () => {
    expect(seven("main")).toBe(28);
    expect(seven("…/VCRM-9090")).toBe(77);
  });

  it("takes the card chip's spellings, longest first, and the longest that fits", () => {
    const name = "feature/bargan/VCRM-9090";
    expect(fitBranchWidth(name, 24 * 7, seven)).toBe(name);
    expect(fitBranchWidth(name, 19 * 7, seven)).toBe("feature/…/VCRM-9090");
    expect(fitBranchWidth(name, 11 * 7, seven)).toBe("…/VCRM-9090");
    expect(fitBranchWidth(name, 9 * 7, seven)).toBe("VCRM-9090");
    expect(branchCandidates(name)).toContain(fitBranchWidth(name, 15 * 7, seven));
  });

  it("never cuts inside a ticket, and ends on the shortest spelling when nothing fits", () => {
    const name = "feature/bargan/VCRM-9142-checkout-split-payment-intents-and-retries";
    for (let room = 40; room < 400; room += 7) {
      const got = fitBranchWidth(name, room, seven);
      expect(got.includes("VCRM-9142"), `${room}px: ${got}`).toBe(true);
    }
    expect(fitBranchWidth(name, 10, seven)).toBe("VCRM-9142…");
  });

  it("is the card's rule, not a second copy of it", () => {
    const src = sourceOf("git-branch-fit.ts");
    expect(src).toMatch(/import \{ branchCandidates \} from "\.\/git-chip";/);
    expect(src).not.toMatch(/TICKET|\[A-Z\]\[A-Z0-9\]/);
  });
});
