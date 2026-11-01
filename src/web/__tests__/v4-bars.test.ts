// V4's top bar and Panel bar (its Figma Shell: Top bar, Panel bar,
// and the chips on them). Phase 1 moves nothing: every control stays on the bar
// or stripe it is on, so this file pins only how they LOOK: the fills, the
// boxes, the type, the borders by state, the rule between two groups, an open
// door as a fill, and the chip entrance. Tokens only; no hex or rgba here.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetParts, sheetText } from "./sheet-source";

interface Rule { media: string; selectors: string[]; decls: Record<string, string> }

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** The sheet as a flat list of rules in source order, each with the @media
 *  prelude it sits in ("" at the top level). Keyframes are kept apart. */
function parse(text: string): { rules: Rule[]; frames: Record<string, string> } {
  const rules: Rule[] = [];
  const frames: Record<string, string> = {};
  const block = (from: number): number => {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    throw new Error("unbalanced braces");
  };
  const walk = (start: number, end: number, media: string) => {
    let i = start;
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open < 0 || open >= end) return;
      const prelude = text.slice(i, open).trim().replace(/\s+/g, " ");
      const close = block(open);
      const inner = text.slice(open + 1, close);
      if (prelude.startsWith("@keyframes")) frames[prelude.slice("@keyframes".length).trim()] = inner;
      else if (prelude.startsWith("@")) walk(open + 1, close, prelude.startsWith("@media") ? prelude.slice(6).trim() : media);
      else {
        const decls: Record<string, string> = {};
        for (const m of inner.matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) decls[m[1]] = m[2].replace(/\s+/g, " ");
        // Split at the commas outside parentheses: `:is(.a, .b)` is one selector.
        const selectors = prelude.split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, " "));
        rules.push({ media, selectors, decls });
      }
      i = close + 1;
    }
  };
  walk(0, text.length, "");
  return { rules, frames };
}
const { rules, frames } = parse(css);

/** The value the cascade would give `prop` on exactly this selector (the last
 *  rule that names it, outside any @media unless `media` says one). */
function decl(selector: string, prop: string, media = ""): string | undefined {
  let found: string | undefined;
  for (const r of rules) if (r.media === media && r.selectors.includes(selector) && prop in r.decls) found = r.decls[prop];
  return found;
}
const has = (selector: string, media = "") => rules.some(r => r.media === media && r.selectors.includes(selector));
const REDUCED = "(prefers-reduced-motion: reduce)";
const INC = (px: number) => `calc(${px}px + var(--ui-text-increase, 0px))`;

describe("V4's top bar", () => {
  it("fills with --panel, flat, over a --line rule", () => {
    expect(decl(".topbar", "background")).toBe("var(--panel)");
    expect(decl(".topbar", "border-bottom")).toBe("1px solid var(--line)");
  });
  it("keeps the pixel on top and pads 12 start, 8 end (12 both sides on a phone)", () => {
    expect(decl(".topbar", "padding")).toBe("1px 8px 0 12px");
    expect(decl(".topbar", "padding", "(max-width: 640px)")).toBe("1px 12px 0");
  });
  it("is as tall as the grid's first row, which is the height token", () => {
    expect(css).toMatch(/grid-template-rows:\s*var\(--topbar-h\)\s+auto\s+1fr/);
  });
  it("keeps 24 between roles, 12 between the readouts of the start group", () => {
    expect(decl(".topbar", "gap")).toBe("24px");
    expect(decl(".topbar .readout", "gap")).toBe("12px");
  });
  it("sets the brand at 14 on 20, Semibold, 6 from the mark; the mark stays 16 tall", () => {
    expect(decl(".topbar .brand", "font-size")).toBe(INC(14));
    expect(decl(".topbar .brand", "line-height")).toBe("20px");
    expect(decl(".topbar .brand", "font-weight")).toBe("600");
    expect(decl(".topbar .brand", "gap")).toBe("6px");
    expect(decl(".topbar .brand .logo", "height")).toBe("16px");
  });
  it("has no gradient token left, in the sheet or in any theme", () => {
    expect(css).not.toContain("--topbar-grad");
    const dir = fileURLToPath(new URL("../themes/", import.meta.url));
    for (const f of readdirSync(dir).filter(n => n.endsWith(".json"))) {
      expect(readFileSync(dir + f, "utf8"), f).not.toContain("topbar-grad");
    }
  });
  it("reads --line-soft in every theme block, which the stripes' rule needs", () => {
    const themes = sheetParts().find(([p]) => p === "styles/themes.css")![1];
    const blocks = themes.match(/:root\[data-theme="[\w-]+"\]\s*\{/g) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(11);
    expect((themes.match(/--line-soft:/g) ?? []).length).toBeGreaterThanOrEqual(blocks.length);
  });
});

describe("V4's chips: 24 tall, 12 on 16", () => {
  const stat = ".topbar .waiting-stat";
  it("the waiting count is a --warn pill, padded 0 8 0 6, 4 apart, the figure in mono 600", () => {
    expect(decl(stat, "height")).toBe("24px");
    expect(decl(stat, "box-sizing")).toBe("border-box");
    expect(decl(stat, "border-radius")).toBe("var(--r-pill)");
    expect(decl(stat, "border")).toBe("1px solid var(--warn)");
    expect(decl(stat, "color")).toBe("var(--warn)");
    expect(decl(stat, "padding")).toBe("0 8px 0 6px");
    expect(decl(stat, "gap")).toBe("4px");
    expect(decl(stat, "font-size")).toBe(INC(12));
    expect(decl(stat, "line-height")).toBe("16px");
    expect(decl(stat, "font-weight")).toBe("400");
    const b = `${stat} b`;
    expect(decl(b, "font-family")).toBe("var(--font-mono)");
    expect(decl(b, "font-size")).toBe(INC(12));
    expect(decl(b, "line-height")).toBe("16px");
    expect(decl(b, "font-weight")).toBe("600");
    expect(decl(b, "font-variant-numeric")).toBe("tabular-nums");
  });

  const pill = ".topbar .status .pill";
  it("the stream chip is an outline pill: no fill, --text, padding 0 8, 6 apart, a 6px dot", () => {
    expect(decl(pill, "height")).toBe("24px");
    expect(decl(pill, "box-sizing")).toBe("border-box");
    expect(decl(pill, "border-radius")).toBe("var(--r-pill)");
    expect(decl(pill, "background")).toBe("transparent");
    expect(decl(pill, "color")).toBe("var(--text)");
    expect(decl(pill, "padding-block")).toBe("0");
    expect(decl(pill, "padding-inline")).toBe("8px");
    expect(decl(pill, "gap")).toBe("6px");
    expect(decl(pill, "font-size")).toBe(INC(12));
    expect(decl(pill, "line-height")).toBe("16px");
    expect(decl(pill, "font-weight")).toBe("400");
    // Live has no chip (V4 decision 19): only the two states the bar draws.
    expect(decl(`${pill}.live`, "border-color"), "no rule dresses a live chip").toBeUndefined();
    for (const [state, token] of [["paused", "--warn"], ["dead", "--err"]] as const) {
      expect(decl(`${pill}.${state}`, "border-color"), state).toBe(`var(${token})`);
      expect(decl(`${pill}.${state}`, "background"), state).toBeUndefined();
      expect(decl(`${pill}.${state}::before`, "width"), state).toBe("6px");
      expect(decl(`${pill}.${state}::before`, "height"), state).toBe("6px");
      expect(decl(`${pill}.${state}::before`, "background"), state).toBe(`var(${token})`);
      expect(decl(`${pill}.${state}::before`, "box-shadow"), state).toBeUndefined();
    }
  });
  it("keeps the stream chip's ghost cell: the widest label is reserved, invisibly", () => {
    expect(decl(`${pill} .pill-box`, "display")).toBe("inline-grid");
    expect(decl(`${pill} .pill-widest`, "visibility")).toBe("hidden");
  });
  it("has no live dot to pulse, and the paused and lost dots stand still (V4 decision 19)", () => {
    expect(decl(`${pill}.live::before`, "animation")).toBeUndefined();
    expect(decl(`${pill}.paused::before`, "animation")).toBeUndefined();
    expect(decl(`${pill}.dead::before`, "animation")).toBeUndefined();
  });

  const inc = ".topbar .provider-incident";
  it("an incident is a --warn pill, padded 0 8 0 6, 4 apart, --text", () => {
    expect(decl(inc, "height")).toBe("24px");
    expect(decl(inc, "box-sizing")).toBe("border-box");
    expect(decl(inc, "border-radius")).toBe("var(--r-pill)");
    expect(decl(inc, "border")).toBe("1px solid var(--warn)");
    expect(decl(inc, "padding")).toBe("0 8px 0 6px");
    expect(decl(inc, "gap")).toBe("4px");
    expect(decl(inc, "color")).toBe("var(--text)");
    expect(decl(inc, "font-size")).toBe(INC(12));
    expect(decl(inc, "line-height")).toBe("16px");
    expect(decl(inc, "background")).toBeUndefined();
  });
  it("a major outage is --err, maintenance --line, a stale answer stays dashed", () => {
    expect(decl(`${inc}[data-state="major_outage"]`, "border-color")).toBe("var(--err)");
    expect(decl(`${inc}[data-state="maintenance"]`, "border-color")).toBe("var(--line)");
    expect(decl(`${inc}-stale`, "border-style")).toBe("dashed");
  });

  const ver = ".topbar .brand button.v";
  it("the version chip is 24 tall at 12 on 16, padded 0 6, 4 apart", () => {
    expect(decl(ver, "height")).toBe("24px");
    expect(decl(ver, "box-sizing")).toBe("border-box");
    expect(decl(ver, "padding")).toBe("0 6px");
    expect(decl(ver, "gap")).toBe("4px");
    expect(decl(ver, "font-size")).toBe(INC(12));
    expect(decl(ver, "line-height")).toBe("16px");
    expect(decl(ver, "border-radius")).toBe("var(--r-ctl)");
  });
  it("a newer version, a ready update and the press are the --accent-16 wash with no edge", () => {
    const sel = `${ver}:is(.stale, .ready, .v-update)`;
    expect(decl(sel, "background")).toBe("var(--accent-16)");
    expect(decl(sel, "border-color")).toBe("transparent");
    expect(decl(sel, "color")).toBe("var(--text)");
    expect(decl(sel, "font-weight")).toBe("400");
    expect(decl(`${sel}:hover`, "background")).toBe("color-mix(in srgb, var(--accent) 24%, transparent)");
  });
  it("has no amber: the chip's rules name no --warn, and its dot is the accent, unglowed", () => {
    const own = rules.filter(r => r.selectors.some(s => s.startsWith(ver)));
    expect(own.length).toBeGreaterThan(5);
    for (const r of own) expect(JSON.stringify(r.decls), r.selectors.join(", ")).not.toContain("--warn");
    expect(decl(`${ver} .v-dot`, "background")).toBe("var(--accent)");
    expect(decl(`${ver} .v-dot`, "box-shadow")).toBeUndefined();
    // A still dot (V4 decision 19): nothing on the top bar pulses at rest, so
    // there is no animation for reduced motion to take away either.
    expect(decl(`${ver} .v-dot`, "animation")).toBeUndefined();
    expect(decl(`${ver} .v-dot`, "animation", REDUCED)).toBeUndefined();
  });
  it("the current version stays visible and quiet", () => {
    expect(decl(`${ver}:not(.stale):not(.ready)`, "color")).toBe("var(--muted)");
    expect(decl(`${ver}:not(.stale):not(.ready)`, "display")).toBeUndefined();
  });
});

describe("V4's chip entrance: opacity and 4px of x over --dur-base", () => {
  it("is one keyframe, from transparent and 4px back", () => {
    expect(frames["chip-in"]).toBeDefined();
    expect(frames["chip-in"]).toMatch(/from\s*\{\s*opacity:\s*0;\s*transform:\s*translateX\(-4px\);\s*\}/);
    expect(frames["pulse"]).toMatch(/opacity/);
    expect(frames["pulse"]).not.toMatch(/transform/);
  });
  it("is worn by the stream chip, the count, an incident and a newer or ready version", () => {
    const chip = "chip-in var(--dur-base) var(--ease) both";
    for (const s of [".topbar .status .pill", ".topbar .waiting-stat", ".topbar .provider-incident", ".topbar .brand button.v:is(.stale, .ready)"]) {
      expect(decl(s, "animation"), s).toBe(chip);
    }
  });
  it("answers reduced motion with none, on each of them", () => {
    for (const s of [".topbar .status .pill", ".topbar .waiting-stat", ".topbar .provider-incident", ".topbar .brand button.v:is(.stale, .ready)"]) {
      expect(decl(s, "animation", REDUCED), s).toBe("none");
    }
    // The queue's own entrance is a separate, older rule and keeps its answer.
    expect(frames["wait-in"]).toBeDefined();
    expect(decl(".topbar .wait-list li[data-fresh]", "animation", REDUCED)).toBe("none");
  });
});

describe("V4's Panel bar (the stripes)", () => {
  it("fills with --panel, 6px at the top and foot, 2px between every child", () => {
    expect(decl(".edge-rail", "background")).toBe("var(--panel)");
    expect(decl(".edge-rail", "padding")).toBe("6px 0");
    expect(decl(".edge-rail", "gap")).toBe("2px");
    expect(decl(".rail-group", "gap")).toBe("2px");
  });
  it("keeps its --line edge on the inner side, at --edge-w", () => {
    expect(decl(".edge-rail-left", "border-right")).toBe("1px solid var(--line)");
    expect(decl(".edge-rail-right", "border-left")).toBe("1px solid var(--line)");
    expect(decl(".edge-rail", "width")).toBe("var(--edge-w)");
  });
  it("draws between two groups a 16x1 --line-soft rule as the next group's first flex item", () => {
    const sel = ".edge-rail .rail-group + .rail-group::before";
    expect(decl(sel, "content")).toBe('""');
    expect(decl(sel, "flex")).toBe("none");
    expect(decl(sel, "width")).toBe("16px");
    expect(decl(sel, "height")).toBe("1px");
    expect(decl(sel, "background")).toBe("var(--line-soft)");
    // No second rule: the old padding and border-top are gone, the Explore group's too.
    expect(decl(".edge-rail .rail-group + .rail-group", "border-top")).toBeUndefined();
    expect(decl(".edge-rail .rail-group + .rail-group", "padding-top")).toBeUndefined();
    const explore = '.edge-rail-left .rail-group[data-rail-group="explore"]';
    expect(decl(explore, "margin-top")).toBe("auto");
    expect(decl(explore, "border-top")).toBeUndefined();
    expect(decl(explore, "padding-top")).toBeUndefined();
  });
  it("makes a door 28x28 with a 14px glyph and the control corner", () => {
    expect(decl(".rail-btn-stripe", "width")).toBe("28px");
    expect(decl(".rail-btn-stripe", "height")).toBe("28px");
    expect(decl(".rail-btn-stripe", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".rail-btn-stripe .glyph", "width")).toBe("14px");
    expect(decl(".rail-btn-stripe .glyph", "height")).toBe("14px");
  });
  it("rests --muted, and under a real pointer goes --text on a 5% wash in --dur-fast, lighter than open", () => {
    // V4's --ctl-fill (Alpha/Text 8) over --panel is the very colour of
    // --selected, so a door under the pointer would read as open; its hover is
    // the lighter 5% wash instead (toggle-state.test.ts ranks the three).
    expect(decl(".rail-btn", "color")).toBe("var(--muted)");
    expect(decl(".rail-btn", "background")).toBe("transparent");
    const media = "(hover: hover) and (pointer: fine)";
    expect(decl(".rail-btn:hover", "color", media)).toBe("var(--text)");
    expect(decl(".rail-btn:hover", "background", media)).toBe("color-mix(in srgb, var(--text) 5%, transparent)");
    expect(decl(".rail-btn:hover", "transition", media)).toContain("background-color var(--dur-fast) var(--ease)");
    // And no hover rule outside that media, so a touch screen never sticks.
    expect(has(".rail-btn:hover")).toBe(false);
  });
  it("draws an open door as the --selected fill with its line on the inner edge, both at once", () => {
    const open = '.rail-btn[aria-expanded="true"]';
    expect(decl(open, "background")).toBe("var(--selected)");
    expect(decl(open, "color")).toBe("var(--text)");
    expect(decl(open, "transition")).toBeUndefined();
    expect(decl(open, "border")).toBeUndefined();
    expect(decl(open, "outline")).toBeUndefined();
    // The line carries the 3:1 the fill cannot (#370), and no longer grows in:
    // V4's motion says a selected door goes selected at once.
    expect(decl(".rail-btn-stripe::before", "background")).toBe("var(--text)");
    expect(decl(".rail-btn-stripe::before", "width")).toBe("2px");
    expect(decl(".rail-btn-stripe::before", "opacity")).toBe("0");
    expect(decl(".rail-btn-stripe::before", "transition")).toBeUndefined();
    expect(decl(".rail-btn-stripe::before", "transform")).toBeUndefined();
    expect(decl('.rail-btn-stripe[aria-expanded="true"]::before', "opacity")).toBe("1");
    expect(decl(`${open}:hover`, "background", "(hover: hover) and (pointer: fine)"))
      .toBe("color-mix(in srgb, var(--text) 6%, var(--selected))");
  });
  it("presses a door as V4's Icon button, 0.94, where the labelled controls keep 0.97; none under reduced motion", () => {
    expect(decl(".rail-btn-stripe:active", "transform")).toBe("scale(0.94)");
    expect(decl(".rail-btn:active", "transform")).toBe("scale(0.97)");
    expect(decl(".rail-btn-stripe:active", "transform", REDUCED)).toBe("none");
    expect(decl(".rail-btn:active", "transform", REDUCED)).toBe("none");
  });
  it("sits the dot on the glyph's corner and the badge a little past it", () => {
    expect(decl(".rail-btn-stripe .rail-dot", "top")).toBe("4px");
    expect(decl(".rail-btn-stripe .rail-dot", "right")).toBe("4px");
    expect(decl(".rail-btn-stripe .rail-badge", "top")).toBe("-3px");
    expect(decl(".rail-btn-stripe .rail-badge", "right")).toBe("-3px");
  });
  it("keeps the bar's own buttons (Search, Settings, Feedback) with their words, at --ctl-h", () => {
    expect(decl(".rail-btn-bar", "height")).toBe("var(--ctl-h)");
    expect(decl(".rail-btn-bar", "padding")).toBe("0 8px");
    expect(decl(".rail-btn-bar", "gap")).toBe("6px");
    expect(decl(".rail-btn-bar .glyph", "width")).toBe("14px");
  });
});

describe("V4's phone dock", () => {
  const phone = "(max-width: 640px)";
  it("fills with --panel and keeps its 56px height and 48px targets", () => {
    expect(decl(".edge-dock", "background", phone)).toBe("var(--panel)");
    expect(decl(".edge-dock", "height", phone)).toBe("calc(var(--dock-h) + env(safe-area-inset-bottom))");
    expect(decl(".rail-btn-dock", "height", phone)).toBe("48px");
  });
  it("opens as the same --selected fill, with the same line on its top edge, at once", () => {
    expect(decl('.rail-btn[aria-expanded="true"]', "background")).toBe("var(--selected)");
    expect(decl(".rail-btn-dock::before", "background", phone)).toBe("var(--text)");
    expect(decl(".rail-btn-dock::before", "transition", phone)).toBeUndefined();
    expect(decl('.rail-btn-dock[aria-expanded="true"]::before', "opacity", phone)).toBe("1");
  });
});

describe("tokens only", () => {
  it("the bars' own rules name no hex or rgba colour", () => {
    const own = rules.filter(r => r.selectors.some(s =>
      /^\.(?:topbar|edge-rail|edge-dock|rail-btn|rail-group)\b/.test(s) || s.startsWith(".edge-rail")));
    expect(own.length).toBeGreaterThan(40);
    for (const r of own) {
      for (const [p, v] of Object.entries(r.decls)) {
        expect(v, `${r.selectors.join(", ")} { ${p} }`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
      }
    }
  });
});
