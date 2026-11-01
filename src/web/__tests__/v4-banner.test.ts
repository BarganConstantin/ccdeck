// V4's banner (its Figma kit, Banner): the strip under the top bar. One
// frame for every tone (--panel fill, a bottom --line rule, no corner, 32px
// high with the rule, 12px start and 4px end padding, an 8px gap); only the dot at the start
// changes colour. The action is plain accent text, the dismiss a 24px icon
// button with the control corner.
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

describe("V4's banner frame", () => {
  for (const f of [".conn-banner", ".ver-banner"]) {
    describe(f, () => {
      it("fills with --panel, no wash", () => expect(decl(f, "background")).toBe("var(--panel)"));
      it("draws a --line rule on the bottom and no other border", () => {
        expect(decl(f, "border-bottom")).toBe("1px solid var(--line)");
        expect(body(f)).not.toMatch(/(?:^|[;\s])border(?:-top|-left|-right|-radius)?\s*:/);
      });
      it("is 32px high at Compact with its rule, padded 4px 4px 3px 12px, 8px apart", () => {
        // 4 + the 24px dismiss + 3 + the 1px rule = 32, the kit's frame.
        expect(decl(f, "min-height")).toBe("var(--ctl-h-lg)");
        expect(decl(f, "padding")).toBe("4px 4px 3px 12px");
        expect(decl(f, "gap")).toBe("8px");
      });
      it("sets the message at 13px plus the increase on the body line, 400, --text", () => {
        expect(decl(f, "font-size")).toBe("calc(13px + var(--ui-text-increase, 0px))");
        expect(decl(f, "line-height")).toBe("var(--lh-body)");
        expect(decl(f, "font-weight")).toBe("400");
        expect(decl(f, "color")).toBe("var(--text)");
      });
      it("keeps its grid row", () => expect(decl(f, "grid-row")).toBe("2"));
    });
  }
  it("keeps each second clause's own tier at 400", () => {
    // The outage's sentence is what to do about it, so it stays --text (#510);
    // the version notice's consequence steps down from its headline to
    // --muted, 4.70:1 or more on the flat --panel.
    expect(decl(".conn-banner .conn-sub", "color")).toBe("var(--text)");
    expect(decl(".conn-banner .conn-sub", "font-weight")).toBe("400");
    expect(decl(".ver-banner .ver-sub", "color")).toBe("var(--muted)");
    expect(decl(".ver-banner .ver-sub", "font-weight")).toBe("400");
  });
});

describe("V4's banner tone mark", () => {
  it("is a 14px slot: a 7px dot with 3.5px either side, not shrinking", () => {
    for (const d of [".conn-banner .conn-dot", ".ver-banner .ver-dot"]) {
      expect(decl(d, "flex")).toBe("0 0 auto");
      expect(decl(d, "margin")).toBe("0 3.5px");
      expect(decl(d, "width")).toBe("7px");
    }
  });
  it("takes the tone's colour: Error --err, Waiting --warn, Done --ok, Info --muted", () => {
    expect(decl(".conn-banner .conn-dot", "background")).toBe("var(--err)");
    expect(decl(".ver-banner .ver-dot", "background")).toBe("var(--warn)");
    expect(decl(".ver-banner.done .ver-dot", "background")).toBe("var(--ok)");
    expect(decl(".ver-banner.note .ver-dot", "background")).toBe("var(--muted)");
  });
});

describe("V4's banner action and dismiss", () => {
  const act = ".ver-banner .ver-act";
  it("the action is accent text: no fill, no border, 12px plus the increase on 16, 500", () => {
    expect(decl(act, "background")).toBe("none");
    expect(decl(act, "border")).toBe("0");
    expect(decl(act, "border-radius")).toBe("var(--r-ctl)");
    expect(decl(act, "color")).toBe("var(--accent)");
    expect(decl(act, "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(act, "line-height")).toBe("16px");
    expect(decl(act, "font-weight")).toBe("500");
    expect(decl(act, "min-height")).toBe("24px");
    expect(decl(act, "padding")).toBe("0 4px");
  });
  it("hovers to an underline, no colour change", () => {
    const h = body(".ver-banner .ver-act:hover:not(:disabled)");
    expect(h).toMatch(/text-decoration:\s*underline/);
    expect(h).not.toMatch(/color|background|border/);
  });
  it("the dismiss is 24px with the control corner and a --muted glyph", () => {
    const c = ".ver-banner .ver-close";
    expect(decl(c, "width")).toBe("24px");
    expect(decl(c, "height")).toBe("24px");
    expect(decl(c, "border-radius")).toBe("var(--r-ctl)");
    expect(decl(c, "color")).toBe("var(--muted)");
    expect(decl(c, "background")).toBe("none");
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
  const on = (token: string) => ratio(over(c(`var(${token})`), panel), panel);
  return {
    text: on("--text"), accent: on("--accent"), muted: on("--muted"),
    dotMuted: on("--muted"), dotWarn: on("--warn"), dotErr: on("--err"), dotOk: on("--ok"),
  };
}

describe("the banner's ink clears its floors on --panel in every theme", () => {
  it("finds the twelve themes in themes.css", () => expect(themes).toHaveLength(12));
  it("holds the margins measured (text 6.21, action 5.58, glyph 4.70, dots 5.08 / 5.42 / 5.61)", () => {
    const all = themes.map(measure);
    const min = (k: keyof ReturnType<typeof measure>) => Math.min(...all.map(m => m[k]));
    expect(min("text")).toBeGreaterThanOrEqual(6.2);
    expect(min("accent")).toBeGreaterThanOrEqual(5.57);
    expect(min("muted")).toBeGreaterThanOrEqual(4.69);
    expect(min("dotErr")).toBeGreaterThanOrEqual(5.07);
    expect(min("dotOk")).toBeGreaterThanOrEqual(5.41);
    expect(min("dotWarn")).toBeGreaterThanOrEqual(5.6);
  });
  for (const theme of themes) {
    it(`${theme}: text, action and close glyph 4.5; each tone dot 3`, () => {
      const m = measure(theme);
      expect(m.text, "--text").toBeGreaterThanOrEqual(4.5);
      expect(m.accent, "--accent (the action)").toBeGreaterThanOrEqual(4.5);
      expect(m.muted, "--muted (the close glyph)").toBeGreaterThanOrEqual(4.5);
      expect(m.dotMuted, "Info dot").toBeGreaterThanOrEqual(3);
      expect(m.dotWarn, "Waiting dot").toBeGreaterThanOrEqual(3);
      expect(m.dotErr, "Error dot").toBeGreaterThanOrEqual(3);
      expect(m.dotOk, "Done dot").toBeGreaterThanOrEqual(3);
    });
  }
});
