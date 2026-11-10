// #1288: the chrome's three radius steps were tokens and the canvas's two were
// literals — `.agent-node` and `.recap-note` at 10px, `.cluster-card` at 16px —
// so the difference between a canvas object and a panel was true and nowhere
// written, and a reader of the three chrome tokens would have brought the node
// down to 8px. Both tiers are named in the geometry block now.
//
// CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): the
// deck keeps three radii, a control at 4, a panel at 8 and the pill, so the
// canvas's rounder tier is retired: --r-node and --r-cluster are aliases of
// --r-panel, as --r-tag is of --r-ctl. The canvas objects still read their own
// names, so a tier of their own would again be one line in tokens.css.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

const css = sheetText()
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** The one bare :root block that declares the chrome's radius steps. */
const geometry = /:root\s*\{([^}]*--r-panel[^}]*)\}/.exec(css)![1];
const val = (name: string) => {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(geometry);
  if (!m) throw new Error(`the geometry block declares no ${name}`);
  return m[1].trim();
};
/** The border-radius of the first rule written for exactly this selector. */
const radiusOf = (selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  return /(?:^|[;\s])border-radius\s*:\s*([^;]+)/.exec(body)?.[1].trim() ?? null;
};

// CHANGED ON PURPOSE (V4's Figma, Drag trash): the drop target is a canvas
// object at the node's radius, so it joins the canvas tier.
const CANVAS = { ".agent-node": "--r-node", ".recap-note": "--r-node", ".drag-trash-zone": "--r-node", ".cluster-card": "--r-cluster" };

describe("the canvas's radius tier is named beside the chrome's (#1288)", () => {
  // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): the tiers are named, not rounder.
  it("declares both tiers in the one geometry block, the canvas's as the panel's", () => {
    expect([val("--r-ctl"), val("--r-panel")]).toEqual(["4px", "8px"]);
    expect(val("--r-tag")).toBe("var(--r-ctl)");
    expect([val("--r-node"), val("--r-cluster")]).toEqual(["var(--r-panel)", "var(--r-panel)"]);
  });

  it("draws every canvas object from its tier rather than a literal", () => {
    for (const [sel, token] of Object.entries(CANVAS)) expect(radiusOf(sel), sel).toBe(`var(${token})`);
  });

  it("lets nothing outside the canvas read the canvas tier", () => {
    const readers = [...css.matchAll(/([^{}]+)\{([^{}]*var\(--r-(?:node|cluster)\)[^{}]*)\}/g)].map(m => m[1].trim());
    // CHANGED ON PURPOSE: V4's Figma draws the Usage panel's box at --r-node (10), the one
    // chrome surface that reads it; the canvas objects still read the tier from the same token.
    // CHANGED ON PURPOSE: V4's Figma draws Settings' Text & density preview as a
    // sunken box at the same 10, a picture of the board's rows.
    // CHANGED ON PURPOSE (V4's Figma): the Explore integrations rows are cards drawn at
    // --r-node (10), so .explore-provider reads it too.
    // CHANGED ON PURPOSE (V4's Figma): the integrations' failure note and loading skeleton are
    // drawn as 10px notes (the kit's --r-node), so they read the token as the Usage panel does.
    // CHANGED ON PURPOSE (V4's Figma): the This machine panel is drawn at the
    // Usage panel's box, so .sysdetail reads --r-node too.
    expect(readers.sort()).toEqual([...Object.keys(CANVAS), ".usage-panel", ".sysdetail", ".reading-preview", ".explore-provider", ".ig-failure", ".ig-skeleton"].sort());
  });
});
