// #1286: the mono stack is the strongest carrier of this deck's character —
// every value is set in it — and it was sixty-two copies of one literal,
// `ui-monospace, SFMono-Regular, Menlo, monospace`. It is one token now, and
// this file holds the sheet to it: a sixty-third copy is the one that gets
// missed the day the stack changes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

/** Comments quote the stack while explaining it; strip before reading. */
const css = sheetText()
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `font-family` and `font` value in the sheet, in source order. */
const families = [...css.matchAll(/(?:^|[;{\s])(font-family|font)\s*:\s*([^;}]+)/g)]
  .map(m => ({ prop: m[1], value: m[2].trim() }));

/** The token's value, from the one block that declares it. */
const declared = [...css.matchAll(/--font-mono\s*:\s*([^;]+);/g)].map(m => m[1].trim());
const STACK = declared[0] ?? "";
/** The stack as a list of family names, quotes dropped. */
const names = STACK.split(",").map(n => n.trim().replace(/^"|"$/g, ""));

describe("the mono stack, written once (#1286)", () => {
  it("is declared exactly once, outside both theme blocks", () => {
    expect(declared).toHaveLength(1);
    // A font is the same on white as on black: the declaring block is a bare
    // :root, not :root[data-theme=…].
    const block = /(:root[^{]*)\{[^}]*--font-mono\s*:/.exec(css)![1].trim();
    expect(block).toBe(":root");
  });

  it("is what every monospaced declaration reads — no copy of the stack anywhere else", () => {
    const literal = families.filter(f => /monospace/.test(f.value) && f.value !== "var(--font-mono)");
    expect(literal).toEqual([]);
    // Sixty-two when the token went in; a floor rather than a count, so a rule
    // deleted later is not a failure — only a sweep over nothing would be.
    expect(families.filter(f => f.value === "var(--font-mono)").length).toBeGreaterThan(50);
  });

  it("ends in the generic family, so the browser always has somewhere to land", () => {
    expect(names[names.length - 1]).toBe("monospace");
  });
});

/** What each peer platform ships, by the family name a stack has to spell. */
const SHIPPED: Record<string, string[]> = {
  macOS: ["ui-monospace", "SFMono-Regular", "Menlo"],
  Windows: ["Cascadia Mono", "Consolas"],
  Linux: ["DejaVu Sans Mono", "Liberation Mono"],
};

describe("the mono stack names a font on every peer platform (#1286)", () => {
  const named = names.slice(0, -1);

  it("names one font each platform ships, ahead of the generic", () => {
    // The defect: the stack stopped at Menlo, so on Windows and Linux the
    // deck's type was the browser's pick of `monospace`, not ours.
    for (const [platform, fonts] of Object.entries(SHIPPED)) {
      expect(named.filter(n => fonts.includes(n)), platform).not.toEqual([]);
    }
  });

  it("keeps the macOS three first and in order, so nothing moves on a Mac", () => {
    // A developer's Mac often has Cascadia installed; Menlo ahead of it is
    // what keeps that machine drawing what it drew before.
    expect(names.slice(0, 3)).toEqual(SHIPPED.macOS);
  });

  it("names nothing a platform does not ship, so the list stays a list of fallbacks", () => {
    const known = Object.values(SHIPPED).flat();
    expect(named.filter(n => !known.includes(n))).toEqual([]);
  });
});
