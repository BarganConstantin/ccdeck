// V4's button (its Figma kit): Quiet, Primary and Danger, drawn at corner 8,
// a 13px label on a 20px line, and the press, hover and focus of the Motion
// page, all on tokens. This pins the rules that draw them; the contrast of
// every edge and label is held by control-edges.test.ts and contrast-floors.
import { describe, it, expect } from "vitest";
import { sheetParts, sheetText } from "./sheet-source";
import { cascade, el, selects } from "./sheet-cascade";

const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block of the rule whose selector list is exactly `selector`
 *  and which is not inside an at-rule (top level, one brace deep). */
function body(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(sheet);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}
const decl = (selector: string, prop: string): string | undefined => {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(body(selector));
  return m?.[1].replace(/\s+/g, " ");
};

describe("V4's Quiet button", () => {
  it("draws the corner at the ladder's 8, not the icon button's 6", () => {
    expect(decl("button.btn", "border-radius")).toBe("var(--r-panel)");
  });
  it("sets a 13px label (plus the text increase) on the 20px body line at weight 500", () => {
    expect(decl("button.btn", "font-size")).toBe("calc(13px + var(--ui-text-increase, 0px))");
    expect(decl("button.btn", "line-height")).toBe("var(--lh-body)");
    expect(decl("button.btn", "font-weight")).toBe("500");
  });
  it("reads the label in --text-secondary", () => {
    expect(decl("button.btn", "color")).toBe("var(--text-secondary)");
  });
  it("keeps the edge on --ctl-edge: Figma's --line is 1.14:1 Dark / 1.60:1 Light, under WCAG 1.4.11's 3:1", () => {
    expect(decl("button.btn", "border")).toBe("1px solid var(--ctl-edge)");
  });
  it("keeps the 28px floor and the 12px side padding", () => {
    expect(decl("button.btn", "min-height")).toBe("var(--ctl-h)");
    expect(decl("button.btn", "padding")).toBe("0 12px");
  });
  it("eases colour, edge, fill and press on --dur-fast and the one curve", () => {
    const t = decl("button.btn", "transition")!;
    for (const prop of ["border-color", "color", "background", "transform"]) {
      expect(t, prop).toContain(`${prop} var(--dur-fast) var(--ease)`);
    }
    expect(t).not.toMatch(/\d+ms|cubic-bezier/);
  });
  it("presses to --press on a pointer press, and not by keyboard", () => {
    expect(decl("button.btn:active:not(:disabled):not(:focus-visible)", "transform")).toBe("scale(var(--press))");
  });
  it("draws the focus ring 2px outside the button", () => {
    expect(decl("button.btn:focus-visible", "outline-offset")).toBe("2px");
  });
});

describe("V4's Primary button", () => {
  it("is a wash with an --accent edge and label at weight 600; three themes take a lighter wash", () => {
    expect(decl("button.btn.primary", "background")).toBe("var(--btn-primary-wash, var(--accent-16))");
    expect(decl("button.btn.primary", "border-color")).toBe("var(--accent)");
    expect(decl("button.btn.primary", "color")).toBe("var(--accent)");
    expect(decl("button.btn.primary", "font-weight")).toBe("600");
  });
});

describe("V4's Danger button", () => {
  it("is an --err-12 wash at rest with an --err edge and label at weight 600", () => {
    expect(decl("button.btn.danger", "background")).toBe("var(--btn-danger-wash, var(--err-12))");
    expect(decl("button.btn.danger", "border-color")).toBe("var(--err)");
    expect(decl("button.btn.danger", "color")).toBe("var(--err)");
    expect(decl("button.btn.danger", "font-weight")).toBe("600");
  });
  it("deepens the wash to 14% on hover (16% takes Rider Black's label under 4.5:1) and keeps edge and label", () => {
    expect(decl("button.btn.danger:hover", "background"))
      .toBe("var(--btn-danger-wash-hover, color-mix(in srgb, var(--err) 14%, transparent))");
    expect(decl("button.btn.danger:hover", "border-color")).toBe("var(--err)");
    expect(decl("button.btn.danger:hover", "color")).toBe("var(--err)");
  });
});

describe("What's new's Done", () => {
  it("is the standard button: it sets no height, padding, font size or line height of its own", () => {
    const rule = body(".release-notes .rn-footer > .primary");
    for (const prop of ["height", "padding", "font-size", "line-height"]) {
      expect(rule, prop).not.toMatch(new RegExp(`(?:^|[;{\\s])${prop}\\s*:`));
    }
    expect(decl(".release-notes .rn-footer > .primary", "min-width")).toBe("70px");
    expect(decl(".release-notes .rn-footer > .primary", "margin-left")).toBe("auto");
  });
});

// Contrast of every label on its wash, in all twelve themes. The kit's washes
// (16% accent, 12% err, 20% on hover) take a label under 4.5:1 in a few themes,
// so those set lighter --btn-*-wash values on their root. Every number is read
// from the stylesheet and held to the floor.
type Rgba = [number, number, number, number];
const themesCss = sheetParts().find(([path]) => path.endsWith("themes.css"))![1];
const themes = [...themesCss.matchAll(/^:root\[data-theme="([\w-]+)"\]\s*\{/gm)].map(m => m[1]);

/** Resolves values on one theme's root: var() with its fallback, #hex, rgb(),
 *  transparent and color-mix(in srgb, A N%, B). `ignore` pretends those custom
 *  properties are not set, to see what a theme gets without them. */
function resolver(theme: string, ignore: string[] = []) {
  const root = el("html", [], { attrs: { "data-theme": theme }, states: ["root"] });
  const prop = (name: string): string | null =>
    ignore.includes(name) ? null : cascade(s => selects(s, [root]), name, 1920);
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
  /** The value of `p` the cascade gives a button of these classes and states. */
  const on = (classes: string[], p: string, states: string[] = []): string => {
    const chain = [root, el("button", classes, { states })];
    const v = cascade(s => selects(s, chain), p, 1920);
    if (v == null) throw new Error(`${classes.join(".")} has no ${p}`);
    return v;
  };
  return { color, on, prop, panel: color("var(--panel)") };
}
const over = (ink: Rgba, bed: Rgba): Rgba => [0, 1, 2].map(i => ink[i] * ink[3] + bed[i] * (1 - ink[3])).concat(1) as Rgba;
const lum = (c: Rgba): number => {
  const l = c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return l[0] * .2126 + l[1] * .7152 + l[2] * .0722;
};
const ratio = (a: Rgba, b: Rgba): number => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);

/** Label-on-wash contrast over the theme's --panel for the four pairs. */
function pairs(theme: string, ignore: string[] = []) {
  const r = resolver(theme, ignore);
  const measure = (classes: string[], states: string[], wash: string | null) => {
    const bed = wash == null ? r.panel : over(r.color(wash), r.panel);
    return ratio(over(r.color(r.on(classes, "color", states)), bed), bed);
  };
  return {
    primary: measure(["btn", "primary"], [], r.on(["btn", "primary"], "background")),
    dangerRest: measure(["btn", "danger"], [], r.on(["btn", "danger"], "background")),
    dangerHover: measure(["btn", "danger"], ["hover"], r.on(["btn", "danger"], "background", ["hover"])),
    quiet: measure(["btn"], [], null),
  };
}

describe("every button label clears 4.5:1 on its wash, in all twelve themes", () => {
  it("finds the twelve themes in themes.css", () => {
    expect(themes).toHaveLength(12);
  });
  for (const theme of themes) {
    it(`${theme}: Primary, Danger at rest, Danger on hover and Quiet`, () => {
      const m = pairs(theme);
      expect(m.primary, "primary").toBeGreaterThanOrEqual(4.5);
      expect(m.dangerRest, "danger at rest").toBeGreaterThanOrEqual(4.5);
      expect(m.dangerHover, "danger on hover").toBeGreaterThanOrEqual(4.5);
      expect(m.quiet, "quiet").toBeGreaterThanOrEqual(4.5);
    });
  }
  it("measures what the reviewer measured (resolver check)", () => {
    expect(pairs("rider-black").primary).toBeCloseTo(4.51, 1);
    expect(pairs("omarchy").dangerHover).toBeCloseTo(4.58, 1);
    expect(pairs("omarchy").dangerRest).toBeCloseTo(4.89, 1);
    expect(pairs("gruvbox-dark").dangerHover).toBeCloseTo(4.57, 1);
  });
  it("fails if a theme loses its lighter wash: the kit's washes are under 4.5:1 there", () => {
    const wash = ["--btn-primary-wash"], danger = ["--btn-danger-wash", "--btn-danger-wash-hover"];
    for (const theme of ["omarchy", "gruvbox-light", "gruvbox-material"]) {
      expect(pairs(theme, wash).primary, `${theme} primary`).toBeLessThan(4.5);
    }
    for (const theme of ["gruvbox-dark", "gruvbox-material"]) {
      expect(pairs(theme, danger).dangerRest, `${theme} danger`).toBeLessThan(4.5);
    }
    expect(pairs("omarchy", danger).dangerHover, "omarchy danger hover").toBeLessThan(4.5);
  });
});
