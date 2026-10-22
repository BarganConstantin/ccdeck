// A selected row in an integration panel's list (#2178, #2179) is one rule for
// Jira and the forges, declared by the host in integrations.css: a quiet
// accent fill (--ig-sel-fill), distinct from the neutral fill a hover lifts a
// row with, and every word on it in --text.
//
// Two panels used to disagree: Jira filled a selected row with --accent-dim
// and left its keys, estimates and versions in --muted on it, 3.76:1 in Rider
// Black; the forges filled it with --ctl-fill, the hover's own fill, so a
// selected row and the row under the pointer looked the same. A wash over a
// panel lowers the contrast of everything on it, and how much depends on the
// theme, so this measures every palette the deck ships: the fill composited
// over --panel, the words on it at 4.5:1, a status mark at 3:1, and the fill
// far enough from the hover's, in OKLab, to be told apart. The values are read
// from the stylesheet itself, theme overrides included, so a palette edit or a
// change to the rule that walks a theme under the floor fails here.
import { describe, expect, it } from "vitest";
import { THEMES, apart, color, contrast, css, declarations, host, over, palette, panelOf, scopeOf, type Rgba } from "./integrations-palette";

function measure(theme: string) {
  const scope = scopeOf(theme);
  const panel = panelOf(scope);
  const fill = over(color("var(--ig-sel-fill)", scope), panel);
  const hover = over(color("var(--ig-hover-fill)", scope), panel);
  const on = (ink: string, ground: Rgba) => Math.round(contrast(over(color(`var(--${ink})`, scope), ground), ground) * 100) / 100;
  return { fill, hover, panel, on };
}

const r2 = (n: number) => Math.round(n * 1000) / 1000;

describe("the selected row in an integration panel", () => {
  it("reads every shipped theme, so a pass covers all of them", () => {
    expect(THEMES.length).toBe(12);
    for (const theme of THEMES) expect(palette(theme).panel, theme).toBeTruthy();
  });

  it("declares one fill, one hover fill and one ink for every word, on the host's modal", () => {
    const props = declarations(host, ".ig-modal");
    expect(props["ig-sel-fill"]).toBe("var(--accent-dim)");
    expect(props["ig-hover-fill"]).toBe("var(--ctl-fill)");
    expect(props["ig-sel-ink"]).toBe("var(--text)");
    expect(props["ig-sel-muted"]).toBe("var(--text)");
  });

  it("leaves the app-wide --accent-dim alone and overrides only the palettes it fails in", () => {
    const overridden = THEMES.filter(t => "ig-sel-fill" in declarations(host, `:root[data-theme="${t}"] .ig-modal`));
    expect(overridden.sort()).toEqual(["gruvbox-dark", "gruvbox-material"]);
    expect(host).not.toMatch(/--accent-dim\s*:/);
  });

  for (const theme of THEMES) {
    it(`keeps every word at 4.5:1 and every status mark at 3:1 on the fill in ${theme}`, () => {
      const m = measure(theme);
      expect(m.on("ig-sel-ink", m.fill), `${theme} --ig-sel-ink`).toBeGreaterThanOrEqual(4.5);
      expect(m.on("ig-sel-muted", m.fill), `${theme} --ig-sel-muted`).toBeGreaterThanOrEqual(4.5);
      for (const mark of ["ok", "warn", "err", "accent"]) {
        expect(m.on(mark, m.fill), `${theme} --${mark} mark`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`is a fill of its own in ${theme}, not the hover's and not the panel's`, () => {
      const m = measure(theme);
      expect(r2(apart(m.fill, m.hover)), `${theme}: selected vs hovered`).toBeGreaterThanOrEqual(0.03);
      expect(apart(m.fill, m.panel), `${theme}: selected vs resting`).toBeGreaterThan(apart(m.hover, m.panel));
    });

    it(`keeps a hovered row's quiet words at 4.5:1 in ${theme}`, () => {
      const m = measure(theme);
      // The hover re-points --muted and --text-dim at --text-secondary.
      expect(m.on("text-secondary", m.hover), `${theme} --text-secondary on hover`).toBeGreaterThanOrEqual(4.5);
      expect(m.on("text", m.hover), `${theme} --text on hover`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("re-points the quiet tiers inside a selected row, so no rule has to name its own", () => {
    const rule = /\.ig-row\[data-selected\]\s*\{([^}]*)\}/.exec(host)?.[1] ?? "";
    for (const tier of ["--text-secondary", "--muted", "--text-dim"]) {
      expect(rule, tier).toMatch(new RegExp(`${tier}\\s*:\\s*var\\(--ig-sel-muted\\)`));
    }
    expect(rule).toMatch(/background\s*:\s*var\(--ig-sel-fill\)/);
    expect(rule).toMatch(/(^|[;\s])color\s*:\s*var\(--ig-sel-ink\)/);
    // No coloured edge on a selected row: the selection rule in
    // .impeccable/surfaces/tool-audit.md.
    expect(rule).not.toMatch(/border-(left|inline-start)|box-shadow\s*:\s*inset\s+\d/);
    const hover = /\.ig-row:hover\s*\{([^}]*)\}/.exec(host)?.[1] ?? "";
    expect(hover).toMatch(/--muted\s*:\s*var\(--text-secondary\)/);
  });

  it("drops a pill's fill inside a selected row, so its word sits on the selection", () => {
    expect(host).toMatch(/\.ig-row\[data-selected\] \.ig-chip\s*\{[^}]*background:\s*transparent[^}]*color:\s*var\(--ig-sel-ink\)/);
  });

  it("lets the hover lift only rows that are not chosen, and keeps the choice visible in forced colours", () => {
    const hoverAt = host.indexOf(".ig-row:hover {");
    const selectedAt = host.indexOf(".ig-row[data-selected] {");
    expect(hoverAt).toBeGreaterThan(-1);
    // Equal specificity: the selection is written later, so a hovered selected row keeps its fill.
    expect(selectedAt).toBeGreaterThan(hoverAt);
    // The deck answers forced colours in one block (forced-colors-871.test.ts).
    const forced = css.slice(css.indexOf("@media (forced-colors: active) {"));
    expect(forced).toMatch(/\n\s*\.ig-row\[data-selected\]\s*\{\s*outline:\s*2px solid Highlight/);
    expect(host).toMatch(/@media \(hover: none\)\s*\{[^}]*\.ig-row:hover:not\(\[data-selected\]\)/);
  });
});
