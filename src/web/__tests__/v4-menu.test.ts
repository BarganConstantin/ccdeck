// V4's menu item (its Figma kit, Menu / Item): a row at the table-row height,
// padding 0 8px, gap 8, corner 4, 13/20 Regular, --selected on hover and focus,
// --muted-dim when disabled. The rule is shared by the account row menu, the
// dock's More menu, the forge scope menu and What's new's options.
import { describe, it, expect } from "vitest";
import { sheetParts, sheetText } from "./sheet-source";
import { cascade, el, selects } from "./sheet-cascade";

const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block of the top-level rule whose selector list is exactly `selector`. */
function body(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(sheet);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}
const decl = (selector: string, prop: string): string | undefined => {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(body(selector));
  return m?.[1].replace(/\s+/g, " ");
};

describe("V4's menu item", () => {
  it("stands at the table-row height with 0 8px padding and an 8px gap", () => {
    expect(decl(".ap-menu-item", "min-height")).toBe("var(--row-table)");
    expect(decl(".ap-menu-item", "padding")).toBe("0 8px");
    expect(decl(".ap-menu-item", "gap")).toBe("8px");
  });
  it("draws the corner at 4 and a 13px Regular label on the body line", () => {
    expect(decl(".ap-menu-item", "border-radius")).toBe("var(--r-tag)");
    expect(decl(".ap-menu-item", "font-size")).toBe("calc(13px + var(--ui-text-increase, 0px))");
    expect(decl(".ap-menu-item", "line-height")).toBe("var(--lh-body)");
    expect(decl(".ap-menu-item", "font-weight")).toBe("400");
  });
  it("fills with --selected under the pointer and the keyboard, with the ring inset", () => {
    // One rule for both: its selector list is hover, then focus-visible.
    expect(decl(".ap-menu-item:hover:not(:disabled), .ap-menu-item:focus-visible", "background")).toBe("var(--selected)");
    expect(sheet).toMatch(/\.ap-menu-item:focus-visible \{ outline-offset: -2px; \}/);
  });
  it("keeps a disabled row on the shared --dim-off opacity, not the kit's --muted-dim", () => {
    // The kit draws a disabled label in --muted-dim, but contrast-floors.test.ts
    // allows no rule to set `color: var(--muted-dim)` (it is under 4.5:1 on
    // --panel in every theme), so the old value stays and danger inherits it.
    expect(decl(".ap-menu-item:disabled", "opacity")).toBe("var(--dim-off)");
    expect(decl(".ap-menu-item:disabled", "cursor")).toBe("default");
    expect(decl(".ap-menu-item:disabled", "color")).toBeUndefined();
  });
  it("keeps the popover 200px wide and the touch row at 40px", () => {
    expect(decl(".ap-pop", "width")).toBe("200px");
    expect(sheet).toMatch(/@media \(pointer: coarse\) \{[^@]*\.ap-menu-item \{ min-height: 40px; \}/);
  });
  it("leaves What's new's options menu no gap of its own", () => {
    expect(sheet).not.toMatch(/\.rn-options-menu \.ap-menu-item \{ gap/);
  });
});

// Contrast over every theme, resolved from the sheet.
type Rgba = [number, number, number, number];
const themesCss = sheetParts().find(([path]) => path.endsWith("themes.css"))![1];
const themes = [...themesCss.matchAll(/^:root\[data-theme="([\w-]+)"\]\s*\{/gm)].map(m => m[1]);

function resolver(theme: string) {
  const root = el("html", [], { attrs: { "data-theme": theme }, states: ["root"] });
  const prop = (name: string): string | null => cascade(s => selects(s, [root]), name, 1920);
  const resolve = (value: string): string => {
    const v = /var\((--[\w-]+)(?:,\s*((?:[^()]|\([^()]*\))*))?\)/.exec(value);
    if (!v) return value.trim();
    const have = prop(v[1]) ?? v[2];
    if (have == null) throw new Error(`${v[1]} is not set in ${theme}`);
    return resolve(value.replace(v[0], have.trim()));
  };
  const color = (raw: string): Rgba => {
    const value = resolve(raw);
    if (value === "transparent") return [0, 0, 0, 0];
    const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
    if (hex) {
      const h = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join("") : hex[1];
      return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(1) as Rgba;
    }
    const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
    if (rgb) {
      const p = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    }
    const mix = /^color-mix\(in srgb, (.+) ([\d.]+)%, (.+)\)$/.exec(value);
    if (mix) {
      const a = color(mix[1]), b = color(mix[3]), w = Number(mix[2]) / 100;
      const alpha = a[3] * w + b[3] * (1 - w);
      return [0, 1, 2].map(i => alpha ? (a[i] * a[3] * w + b[i] * b[3] * (1 - w)) / alpha : 0).concat(alpha) as Rgba;
    }
    throw new Error(`Unsupported colour in ${theme}: ${value}`);
  };
  return { color };
}
const over = (ink: Rgba, bed: Rgba): Rgba => [0, 1, 2].map(i => ink[i] * ink[3] + bed[i] * (1 - ink[3])).concat(1) as Rgba;
const lum = (c: Rgba): number => {
  const l = c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return l[0] * .2126 + l[1] * .7152 + l[2] * .0722;
};
const ratio = (a: Rgba, b: Rgba): number => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);

describe("every menu label clears 4.5:1, in all twelve themes", () => {
  it("finds the twelve themes in themes.css", () => {
    expect(themes).toHaveLength(12);
  });
  for (const theme of themes) {
    it(`${theme}: --text on the --selected hover fill, and the --err word on --panel`, () => {
      const r = resolver(theme);
      const panel = r.color("var(--panel)");
      const selected = over(r.color("var(--selected)"), panel);
      expect(ratio(over(r.color("var(--text)"), selected), selected), "text on selected").toBeGreaterThanOrEqual(4.5);
      expect(ratio(over(r.color("var(--err)"), panel), panel), "danger word on panel").toBeGreaterThanOrEqual(4.5);
    });
  }
});
