// Chat and the Decision card are drawn in tokens: no colour written out, no
// token declared, every token they read already there. And the one place the
// drawn file would have failed the contrast floor, the number key chip, uses a
// pair that passes it in every shipped theme.
//
// THE KEY CHIP. The frame fills the focused chip with --text and writes its
// digit in --muted, which is low contrast. The build keeps the chip one
// way in every state: --text on --ctl-fill (the 8% wash of the text colour,
// over the card's --panel). The ring says where the keys are; the chip does
// not have to.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEMES, color, contrast, over, palette } from "./integrations-palette";
import { sheetText } from "./sheet-source";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const SCREEN_SHEETS = ["components/chat/chat.css", "components/decision/decision.css"] as const;

describe("the screens' sheets", () => {
  for (const path of SCREEN_SHEETS) {
    const css = read(path);

    it(`${path}: writes no hex, rgb(), hsl() or colour name`, () => {
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/i);
      expect(css).not.toMatch(/:\s*(?:white|black|red|green|blue|gray|grey|orange|yellow)\b/i);
    });

    it(`${path}: declares no custom property of its own`, () => {
      expect(css).not.toMatch(/(?:^|[;{\s])--[\w-]+\s*:/m);
    });

    it(`${path}: reads only tokens the deck already declares`, () => {
      const declared = new Set([...sheetText().matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/gm)].map(m => m[1]));
      const used = [...css.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]);
      expect(used.length).toBeGreaterThan(5);
      expect(used.filter(t => !declared.has(t))).toEqual([]);
    });
  }

  it("the card casts the overlay shadow, and the sheets write no other drop shadow", () => {
    const decision = read("components/decision/decision.css");
    expect(decision).toMatch(/\.dc-dq\s*\{[^}]*box-shadow:\s*var\(--shadow-overlay\);/);
    for (const path of SCREEN_SHEETS) {
      const shadows = [...read(path).matchAll(/box-shadow:\s*([^;]+);/g)].map(m => m[1].trim());
      // The ring (a hairline of --accent), the contact shadow of a panel, the card's overlay: nothing blurred and literal.
      for (const s of shadows) expect(s, `${path}: ${s}`).toMatch(/^(?:var\(--shadow-(?:overlay|contact)\)|none|0 0 0 0\.5px var\(--accent\)|inset 0 0 0 1\.5px var\(--accent\))$/);
    }
  });

  it("draws the chip as --text on --ctl-fill, in every state", () => {
    const css = read("components/decision/decision.css");
    const chip = /\.dc-chip\s*\{([^}]*)\}/.exec(css)![1];
    expect(chip).toContain("background: var(--ctl-fill);");
    expect(chip).toContain("color: var(--text);");
    // No rule for the chip in a state recolours it: the frame's --text fill with a --muted digit is not built.
    const chipRules = [...css.matchAll(/([^{}]*\.dc-chip[^{}]*)\{([^}]*)\}/g)];
    expect(chipRules.length).toBeGreaterThan(0);
    for (const [, , body] of chipRules) expect(body).not.toMatch(/--muted|background:\s*var\(--text\)/);
  });
});

describe("the key chip clears the contrast floor in every theme", () => {
  for (const theme of THEMES) {
    it(theme, () => {
      const scope = palette(theme);
      const panel = over(color("var(--panel)", scope), color("var(--bg)", scope));
      const fill = over(color("var(--ctl-fill)", scope), panel);
      const text = over(color("var(--text)", scope), fill);
      expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
