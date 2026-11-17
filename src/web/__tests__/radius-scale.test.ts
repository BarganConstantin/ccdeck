// The owner's critique of 2026-11-10, point 7: three radii. A control (a chip,
// tag, input, small button, menu item or list row) at 4, a panel (a card,
// dialog, popover, sheet or tooltip) at 8, and the pill for whatever is fully
// round, with 0 for an edge that meets another. V4 had grown six steps and the
// sheet a dozen literals beside them (1, 2, 3, 6, 9, 10, 12, 16, 50%, 999px).
// This suite reads every stylesheet the deck ships (styles.css's parts and the
// two sheets loaded on demand) and fails on any corner that is not one of the
// tokens, 0 or inherit, and on any radius token that is not 4, 8 or the pill.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetParts } from "./sheet-source";

const WEB = fileURLToPath(new URL("../", import.meta.url));

/** The radius tokens: the three, and the older names kept as their aliases. */
const TOKENS = ["--r-ctl", "--r-panel", "--r-pill", "--r-tag", "--r-node", "--r-cluster", "--r-overlay", "--tr-radius"];
/** One corner: a token, 0, or the parent's corner. */
const CORNER = new RegExp(`^(?:0|inherit|var\\((?:${TOKENS.join("|")})\\))$`);

/** Corners kept off the set, by file, selector and value, each with its reason. */
const KEPT: Record<string, string> = {
  "styles/integrations.css .ig-frame calc(var(--r-overlay) - 1px)":
    "the frame sits inside the dialog's 1px border, so its corner is the dialog's less that pixel: the two curves stay concentric and the frame's content cannot show past the border's",
};

/** Every stylesheet, as [path relative to src/web, text with comments blanked]. */
const SHEETS: [string, string][] = [
  ...sheetParts(),
  ...["components/chat/chat.css", "components/decision/decision.css"]
    .map(p => [p, readFileSync(`${WEB}${p}`, "utf8")] as [string, string]),
].map(([path, text]) => [path, text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))]);

type Decl = { where: string; selector: string; prop: string; value: string };

/** Every declaration in every innermost block, with its file and selector. */
const DECLS: Decl[] = SHEETS.flatMap(([where, css]) =>
  [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].flatMap(([, sel, body]) =>
    body.split(";").map(d => /^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d)).filter(m => m !== null)
      .map(m => ({ where, selector: sel.replace(/\s+/g, " ").trim(), prop: m![1], value: m![2].replace(/\s+/g, " ") }))));

const RADII = DECLS.filter(d => /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/.test(d.prop));
const kept = (d: Decl) => `${d.where} ${d.selector} ${d.value}` in KEPT;

describe("three radii: 4, 8 and the pill (owner, 2026-11-10)", () => {
  it("reads the sheets it means to: all of styles.css's parts and the two lazy ones", () => {
    expect(SHEETS.length).toBeGreaterThan(60);
    expect(RADII.length).toBeGreaterThan(400);
  });

  it("draws every corner from a token, 0 or inherit, never a literal", () => {
    const off = RADII.filter(d => !kept(d) && !d.value.split(" ").every(c => CORNER.test(c)))
      .map(d => `${d.where} ${d.selector} { ${d.prop}: ${d.value} }`);
    expect(off).toEqual([]);
  });

  it("keeps off the set only the corners named, and each of them is still there", () => {
    expect(RADII.filter(kept).map(d => `${d.where} ${d.selector} ${d.value}`).sort()).toEqual(Object.keys(KEPT).sort());
  });

  it("gives the radius tokens three values, 4, 8 and the pill, the rest as aliases", () => {
    const defs = DECLS.filter(d => /^--(?:r-[a-z]+|[a-z-]*radius)$/.test(d.prop));
    expect([...new Set(defs.map(d => d.prop))].sort()).toEqual([...TOKENS].sort());
    const value = new Map(defs.map(d => [d.prop, d.value]));
    const resolve = (v: string): string => {
      for (let hops = 0; hops < 4; hops++) {
        const alias = /^var\((--[a-z-]+)\)$/.exec(v)?.[1];
        if (!alias) break;
        v = value.get(alias) ?? v;
      }
      return v;
    };
    for (const d of defs) expect(["4px", "8px", "999px"], `${d.where} ${d.prop}: ${d.value}`).toContain(resolve(d.value));
    expect([value.get("--r-ctl"), value.get("--r-panel"), value.get("--r-pill")]).toEqual(["4px", "8px", "999px"]);
    for (const d of defs.filter(d => !["--r-ctl", "--r-panel", "--r-pill"].includes(d.prop))) {
      expect(d.value, `${d.prop} is an alias, so it cannot drift`).toMatch(/^var\(--r-(?:ctl|panel|pill)\)$/);
    }
  });
});
