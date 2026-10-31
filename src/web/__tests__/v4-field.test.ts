// V4's field (its Figma kit): the text field, the search fields and the select,
// on --bg-soft, a 13px value on the 20px body line, the --muted placeholder and
// the --dur-fast / --ease transitions. The edge stays --ctl-edge: the kit's
// --line is 1.14 to 2.25:1, under the 3:1 a field's boundary needs (1.4.11).
import { describe, it, expect } from "vitest";
import { sheetParts, sheetText } from "./sheet-source";
import { cascade, el, selects } from "./sheet-cascade";

const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
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

const FIELDS = [".ap-manage-input", ".settings-filter-field", ".ig-search-input", ".sm-select"];

describe("V4's field", () => {
  for (const f of FIELDS) {
    describe(f, () => {
      it("fills with --bg-soft", () => expect(decl(f, "background")).toBe("var(--bg-soft)"));
      it("keeps the --ctl-edge edge (the kit's --line is under the 3:1 boundary floor)", () => {
        expect(decl(f, "border")).toBe("1px solid var(--ctl-edge)");
      });
      it("takes the corner token, not a literal", () => expect(decl(f, "border-radius")).toBe("var(--r-ctl)"));
      it("sets a 13px value (plus the text increase) on the body line at weight 400 in --text", () => {
        expect(decl(f, "font-size")).toBe("calc(13px + var(--ui-text-increase, 0px))");
        expect(decl(f, "line-height")).toBe("var(--lh-body)");
        expect(decl(f, "font-weight")).toBe("400");
        expect(decl(f, "color")).toBe("var(--text)");
      });
      it("keeps the control height", () => expect(decl(f, "min-height")).toBe("var(--ctl-h)"));
    });
  }
  for (const f of [".ap-manage-input", ".settings-filter-field", ".ig-search-input"]) {
    it(`${f}: --muted placeholder at full opacity, eased on --dur-fast and --ease`, () => {
      expect(decl(`${f}::placeholder`, "color")).toBe("var(--muted)");
      expect(decl(`${f}::placeholder`, "opacity")).toBe("1");
      const t = decl(f, "transition")!;
      for (const p of ["border-color", "background"]) expect(t).toContain(`${p} var(--dur-fast) var(--ease)`);
      expect(t).not.toMatch(/\d+ms|cubic-bezier/);
    });
  }
  it("the select pads 12px at the start and 8px at the end", () => {
    expect(decl(".sm-select", "padding")).toBe("0 8px 0 12px");
  });
  it("the text field pads 12px at the sides", () => {
    expect(decl(".ap-manage-input", "padding")).toBe("0 12px");
  });
  it("the search keeps its glyph room and the field's 10px end padding", () => {
    expect(decl(".settings-filter-field", "padding")).toBe("0 10px");
    expect(decl(".settings-search .settings-search-field", "padding-left")).toBe("32px");
  });
});

type Rgba = [number, number, number, number];
const themesCss = sheetParts().find(([path]) => path.endsWith("themes.css"))![1];
const themes = [...themesCss.matchAll(/^:root\[data-theme="([\w-]+)"\]\s*\{/gm)].map(m => m[1]);

function colours(theme: string) {
  const root = el("html", [], { attrs: { "data-theme": theme }, states: ["root"] });
  const resolve = (value: string): string => {
    const v = /var\((--[\w-]+)(?:,\s*((?:[^()]|\([^()]*\))*))?\)/.exec(value);
    if (!v) return value.trim();
    const have = cascade(s => selects(s, [root]), v[1], 1920) ?? v[2];
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
  return color;
}
const over = (ink: Rgba, bed: Rgba): Rgba => [0, 1, 2].map(i => ink[i] * ink[3] + bed[i] * (1 - ink[3])).concat(1) as Rgba;
const lum = (c: Rgba): number => {
  const l = c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return l[0] * .2126 + l[1] * .7152 + l[2] * .0722;
};
const ratio = (a: Rgba, b: Rgba): number => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);

function measure(theme: string) {
  const c = colours(theme);
  const panel = c("var(--panel)");
  const fill = over(c("var(--bg-soft)"), panel);
  return {
    text: ratio(over(c("var(--text)"), fill), fill),
    placeholder: ratio(over(c("var(--muted)"), fill), fill),
    edgePanel: ratio(over(c("var(--ctl-edge)"), panel), panel),
    edgeFill: ratio(over(c("var(--ctl-edge)"), panel), fill),
  };
}

describe("a field on --bg-soft over --panel clears its floors in all twelve themes", () => {
  it("finds the twelve themes in themes.css", () => expect(themes).toHaveLength(12));
  for (const theme of themes) {
    it(`${theme}: text 4.5, placeholder 4.5, edge 3 against both beds`, () => {
      const m = measure(theme);
      expect(m.text, "text").toBeGreaterThanOrEqual(4.5);
      expect(m.placeholder, "placeholder").toBeGreaterThanOrEqual(4.5);
      expect(m.edgePanel, "edge on panel").toBeGreaterThanOrEqual(3);
      expect(m.edgeFill, "edge on fill").toBeGreaterThanOrEqual(3);
    });
  }
  it("holds the margins the reviewer measured (text 7.04, placeholder 4.91, edge 3.4)", () => {
    const all = themes.map(measure);
    const min = (k: "text" | "placeholder" | "edgePanel") => Math.min(...all.map(m => m[k]));
    expect(min("text")).toBeGreaterThanOrEqual(7.03);
    expect(min("placeholder")).toBeGreaterThanOrEqual(4.90);
    expect(min("edgePanel")).toBeGreaterThanOrEqual(3.39);
  });
});
