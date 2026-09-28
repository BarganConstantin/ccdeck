// #1287: `var(--shadow-1|2)` were the deck's only named elevations, and a third
// lived as a literal in both themes — `0 1px 2px rgba(0,0,0,0.30), 0 14px 34px
// rgba(0,0,0,0.34)` on the topbar's two menus, repeated in slate by a light rule
// for each. The three anchored popovers wrote the same contact line over
// --shadow-2, with a light rule each to repeat it. Five rules existed only to
// say a shadow a second time. They are --shadow-3 and --shadow-contact now, and
// this file keeps a named shadow from being written out again — and does the
// same for the gradients two rules shared or a theme retuned, further down.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Comments quote the literals they replaced; strip before reading. */
const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const DARK_HEAD = /:root,\s*\n:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/;
const LIGHT_HEAD = /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/;
const blocks = { dark: DARK_HEAD.exec(css)![1], light: LIGHT_HEAD.exec(css)![1] };
/** The sheet with both theme blocks cut out: everywhere a rule could copy a token. */
const rules = css.replace(DARK_HEAD, "").replace(LIGHT_HEAD, "");

function tokens(block: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (name.startsWith(prefix)) out[name] = value.trim();
  }
  return out;
}

/** A shadow's layers, commas inside rgba() left alone, whitespace dropped so two
 *  spellings of one layer compare equal. */
const layers = (v: string) => v.split(/,(?![^(]*\))/).map(l => l.replace(/\s+/g, "")).filter(Boolean);

/** Every `box-shadow` value a rule outside the theme blocks declares, with its selector. */
const DECLS = [...rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(m =>
  [...m[2].matchAll(/(?:^|[;\s])box-shadow\s*:\s*([^;]+)/g)].map(d => ({ sel: m[1].trim(), value: d[1].trim() })));

describe("the deck's elevations are tokens, in both themes (#1287)", () => {
  const SHADOWS = { dark: tokens(blocks.dark, "--shadow-"), light: tokens(blocks.light, "--shadow-") };

  it("names the third elevation and the contact line in both theme blocks", () => {
    for (const theme of ["dark", "light"] as const) {
      expect(Object.keys(SHADOWS[theme]).sort(), theme)
        .toEqual(["--shadow-1", "--shadow-2", "--shadow-3", "--shadow-contact"]);
    }
    // One family: the third elevation IS the contact line over a lift of its own.
    for (const theme of ["dark", "light"] as const) {
      expect(layers(SHADOWS[theme]["--shadow-3"])[0], theme).toBe(layers(SHADOWS[theme]["--shadow-contact"])[0]);
    }
  });

  it("writes no layer of a named shadow out as a literal anywhere else in the sheet", () => {
    // The shape that was there: a menu or a popover spelling the token's value
    // itself, once per theme. A layer carrying its own colour (a ring, a halo)
    // is a different job and is not what this reads.
    const named = new Set(Object.values(SHADOWS).flatMap(t => Object.values(t).flatMap(layers)));
    const copies = DECLS.flatMap(d => layers(d.value).filter(l => named.has(l)).map(l => `${d.sel}: ${l}`));
    expect(copies).toEqual([]);
  });

  it("re-tunes no reader of a named shadow per theme — the token already did", () => {
    const LIGHT = ':root[data-theme="light"] ';
    const readers = new Set(DECLS.filter(d => /var\(--shadow-/.test(d.value)).flatMap(d => d.sel.split(",").map(s => s.trim())));
    const overrides = DECLS.filter(d => d.sel.startsWith(LIGHT) && readers.has(d.sel.slice(LIGHT.length)) && /var\(--shadow-/.test(d.value) === false);
    expect(overrides.map(d => d.sel)).toEqual([]);
  });

  it("puts the menus on --shadow-3 and the popovers on the contact line over --shadow-2", () => {
    const shadowOf = (sel: string) => DECLS.find(d => d.sel === sel)?.value;
    for (const menu of [".sound-menu", ".appearance-menu"]) expect(shadowOf(menu), menu).toBe("var(--shadow-3)");
    for (const pop of [".anchored-popover", ".appearance-source-list", ".ap-peek"]) {
      expect(shadowOf(pop), pop).toBe("var(--shadow-contact), var(--shadow-2)");
    }
  });
});

// ── gradients ────────────────────────────────────────────────────────────────
//
// Twenty-seven gradient calls, two of them tokens. Most of the rest are one
// rule's own drawing — a glint, a rope, a slider track — and belong in that
// rule. Two kinds did not: a gradient two rules drew, written out twice (the
// meter fill, the dashed wire), and a gradient a theme retuned, written once in
// the rule and again in a light rule beside it (the disconnected banner's wash,
// the running bubble's wash, the empty-canvas orb). Those are tokens now, and
// these two sweeps keep them so.

/** Every gradient a rule outside the theme blocks declares, with its selector,
 *  whitespace collapsed so two spellings of one value compare equal. */
const GRADIENTS = [...rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(m =>
  [...m[2].matchAll(/(?:^|[;\s])background(?:-image)?\s*:\s*([^;]+)/g)]
    .filter(d => /gradient\(/.test(d[1]))
    .map(d => ({ sel: m[1].trim().replace(/\s+/g, " "), value: d[1].replace(/\s+/g, " ").trim() })));

describe("a gradient two rules share, or a theme retunes, is a token (#1287)", () => {
  it("finds the gradients the rules still draw, so the sweeps are over something", () => {
    expect(GRADIENTS.length).toBeGreaterThan(10);
  });

  it("writes no gradient out in two rules", () => {
    const seen = new Map<string, string[]>();
    for (const g of GRADIENTS) seen.set(g.value, [...(seen.get(g.value) ?? []), g.sel]);
    const twice = [...seen].filter(([, sels]) => sels.length > 1).map(([value, sels]) => `${value} — ${sels.join(" | ")}`);
    expect(twice).toEqual([]);
  });

  it("retunes no rule's gradient in a light rule — the theme block does that", () => {
    const LIGHT = ':root[data-theme="light"] ';
    const drawn = new Set(GRADIENTS.filter(g => !g.sel.startsWith(LIGHT)).map(g => g.sel));
    const retuned = GRADIENTS.filter(g => g.sel.startsWith(LIGHT) && drawn.has(g.sel.slice(LIGHT.length)));
    expect(retuned.map(g => g.sel)).toEqual([]);
  });

  it("declares every themed gradient in both theme blocks, and the shared ones once for both", () => {
    // The node and topbar gradients are themed too; ./gradient-stops and the
    // sweeps that read it hold those two, so this names only the three #1287 made.
    const themed = ["--conn-wash", "--burst-live-wash", "--hero-core"];
    for (const t of themed) {
      expect(tokens(blocks.dark, t)[t], `dark ${t}`).toMatch(/gradient\(/);
      expect(tokens(blocks.light, t)[t], `light ${t}`).toMatch(/gradient\(/);
    }
    // --meter-grad was the other shared one until #1649 made both its fills flat.
    for (const t of ["--wire-dashed"]) {
      const declared = [...css.matchAll(new RegExp(`${t}\\s*:\\s*([^;]+);`, "g"))];
      expect(declared, t).toHaveLength(1);
      expect(/(:root[^{]*)\{[^}]*$/.exec(css.slice(0, declared[0].index))![1].trim(), t).toBe(":root");
    }
  });
});
