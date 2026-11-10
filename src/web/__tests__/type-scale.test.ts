// The owner's critique of 2026-11-10, point 6: five type sizes, 11 · 12 · 13 ·
// 16 · 22, and 11 the floor anywhere. The sheet had eleven, with 8 to 10px
// text too small to read and 14, 18 and 26 close enough to a neighbour to read
// as drift rather than rank. This suite reads every stylesheet the deck ships
// (styles.css's parts and the two sheets loaded on demand), every font-size
// and font shorthand in them, and the --fs-* roles, and fails on any size off
// the scale. What it lets off the scale is named below, each with its reason.
// type-ladder.test.ts holds the same five steps over the joined sheet.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sheetParts } from "./sheet-source";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const SCALE = [11, 12, 13, 16, 22];

/** Icon glyphs set as text characters, by file and selector: a glyph's size is
 *  an icon's, sized to its button, not a step of the type. */
const GLYPHS: Record<string, string> = {
  "styles/dialogs.css :where(.modal-head, .modal-actions) .glyph-btn":
    "a dialog's close and step buttons draw ×, ‹ and › as text; 14 is the glyph's size in its 28px button",
  "styles/forge-detail.css .fd-jump-arrow":
    "the → at the end of a jump row is an icon, kept at 14 so it reads as the row's affordance, not a word",
  "styles/integrations.css .ig-close":
    "the integrations panel's × is an icon in a 28px button, at 18 like the icons beside it",
  "styles/radio.css .radio-map-tools .radio-map-button":
    "the map's + and − zoom buttons are icons in a 34px square, at 18",
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

/** The pixel size a value spells: a literal, or a literal plus the reader's
 *  text increase (with or without a clamp). null for anything else. */
function px(value: string): number | null {
  const m = /^(?:(\d+(?:\.\d+)?)px|calc\((\d+(?:\.\d+)?)px \+ (?:max\(-?\d+px, )?var\(--ui-text-increase, 0px\)\)?\))$/.exec(value);
  return m ? +(m[1] ?? m[2]) : null;
}

/** The size a font shorthand sets: its first length, which is never the line
 *  height after the slash. null for `font: inherit`, which sets none. */
function shorthandSize(value: string): string | null {
  const m = /(?:^|\s)(calc\(|\d+(?:\.\d+)?px)/.exec(value);
  if (!m) return null;
  const start = m.index + m[0].length - m[1].length;
  if (m[1] !== "calc(") return m[1];
  for (let i = start, depth = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")" && --depth === 0) return value.slice(start, i + 1);
  }
  return null;
}

/** [where, size spelling] for every font-size and font shorthand that sets one. */
const SIZES = DECLS.flatMap(d => {
  if (d.prop === "font-size") return [{ ...d, size: d.value }];
  if (d.prop === "font") { const s = shorthandSize(d.value); return s ? [{ ...d, size: s }] : []; }
  return [];
});
const isGlyph = (d: Decl) => `${d.where} ${d.selector}` in GLYPHS;

describe("the type scale: 11 · 12 · 13 · 16 · 22 (owner, 2026-11-10)", () => {
  it("reads the sheets it means to: all of styles.css's parts and the two lazy ones", () => {
    expect(SHEETS.length).toBeGreaterThan(60);
    expect(SIZES.length).toBeGreaterThan(1000);
  });

  it("sets every font-size and font shorthand on the scale, 11 or more", () => {
    const off = SIZES.filter(d => !isGlyph(d))
      .filter(d => d.size !== "inherit" && !/^\d+(?:\.\d+)?(?:em|%)$/.test(d.size) && !/^var\(--fs-[a-z-]+\)$/.test(d.size))
      .filter(d => { const n = px(d.size); return n === null || !SCALE.includes(n); })
      .map(d => `${d.where} ${d.selector} { ${d.prop}: ${d.value} }`);
    expect(off).toEqual([]);
  });

  it("lets off the scale only the named glyphs, and each of them is still there", () => {
    const seen = SIZES.filter(isGlyph).map(d => `${d.where} ${d.selector}`);
    expect([...new Set(seen)].sort()).toEqual(Object.keys(GLYPHS).sort());
    for (const d of SIZES.filter(isGlyph)) expect(px(d.size), `${d.where} ${d.selector}`).not.toBeNull();
  });

  it("uses all five steps and no others", () => {
    const used = [...new Set(SIZES.filter(d => !isGlyph(d)).map(d => px(d.size)).filter(n => n !== null))].sort((a, b) => a! - b!);
    expect(used).toEqual(SCALE);
  });

  it("puts every --fs-* role on the scale", () => {
    const defs = DECLS.filter(d => d.prop.startsWith("--fs-"));
    const first = new Map(defs.slice().reverse().map(d => [d.prop, d.value]));
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) {
      const alias = /^var\((--fs-[a-z-]+)\)$/.exec(d.value)?.[1];
      const size = px(alias ? first.get(alias) ?? "" : d.value);
      expect(size !== null && SCALE.includes(size), `${d.where} ${d.prop}: ${d.value}`).toBe(true);
    }
  });

  // The terminal's face (use-terminal-session.ts) is xterm's own and is not
  // read here: it is sized in its own unit, for its cell grid. A fontSize the
  // markup sets is the sheet's business all the same.
  it("sets no font size under 11 from the markup either", () => {
    const files: string[] = [];
    (function walk(dir: string) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(p); }
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    })(WEB);
    const small: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/fontSize\s*[=:]\s*\{?\s*["'`]?(?:calc\()?(\d+(?:\.\d+)?)/g)) {
        if (+m[1] < 11) small.push(`${f.slice(WEB.length)}: ${m[0]}`);
      }
    }
    expect(small).toEqual([]);
  });
});
