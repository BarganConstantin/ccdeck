// #1288: the chrome's three radius steps were tokens and the canvas's two were
// literals — `.agent-node` and `.recap-note` at 10px, `.cluster-card` at 16px —
// so the difference between a canvas object and a panel was true and nowhere
// written, and a reader of the three chrome tokens would have brought the node
// down to 8px. Both tiers are named in the geometry block now.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

const css = sheetText()
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** The one bare :root block that declares the chrome's radius steps. */
const geometry = /:root\s*\{([^}]*--r-panel[^}]*)\}/.exec(css)![1];
const px = (name: string) => {
  const m = new RegExp(`${name}\\s*:\\s*(\\d+)px\\s*;`).exec(geometry);
  if (!m) throw new Error(`the geometry block declares no ${name}`);
  return +m[1];
};
/** The border-radius of the first rule written for exactly this selector. */
const radiusOf = (selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  return /(?:^|[;\s])border-radius\s*:\s*([^;]+)/.exec(body)?.[1].trim() ?? null;
};

const CANVAS = { ".agent-node": "--r-node", ".recap-note": "--r-node", ".cluster-card": "--r-cluster" };

describe("the canvas's radius tier is named beside the chrome's (#1288)", () => {
  it("declares both tiers in the one geometry block, at the values the sheet drew", () => {
    expect([px("--r-tag"), px("--r-ctl"), px("--r-panel")]).toEqual([4, 6, 8]);
    expect([px("--r-node"), px("--r-cluster")]).toEqual([10, 16]);
  });

  it("keeps the canvas rounder than the chrome, which is the whole of the distinction", () => {
    expect(px("--r-node")).toBeGreaterThan(px("--r-panel"));
    expect(px("--r-cluster")).toBeGreaterThan(px("--r-node"));
  });

  it("draws every canvas object from its tier rather than a literal", () => {
    for (const [sel, token] of Object.entries(CANVAS)) expect(radiusOf(sel), sel).toBe(`var(${token})`);
  });

  it("lets nothing outside the canvas read the canvas tier", () => {
    const readers = [...css.matchAll(/([^{}]+)\{([^{}]*var\(--r-(?:node|cluster)\)[^{}]*)\}/g)].map(m => m[1].trim());
    expect(readers.sort()).toEqual(Object.keys(CANVAS).sort());
  });
});
