// Generated previews must carry each theme's own palette even when a different
// theme is active. Verify the output for every catalog entry.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";
import { THEMES } from "../theme";

const css = sheetText();

function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no block for ${selector}`);
  return css.slice(at, css.indexOf("}", at));
}
function value(body: string, prop: string): string {
  const m = new RegExp(`(?:^|[\\s;{])${prop}:\\s*([^;]+);`).exec(body);
  if (!m) throw new Error(`no ${prop}`);
  return m[1].trim().toLowerCase();
}

/** Which token each preview variable copies. */
const COPIES = {
  "--tp-canvas": "--bg",
  "--tp-surface": "--panel",
  "--tp-rule": "--line",
  "--tp-mark": "--muted-dim",
  "--tp-accent": "--accent",
} as const;

describe("the theme previews are drawn in the themes they preview", () => {
  for (const theme of THEMES) {
    it(`copies the ${theme} tokens exactly`, () => {
      const swatch = block(`.appearance-preview[data-swatch="${theme}"]`);
      const palette = block(theme === "dark" ? ":root,\n:root[data-theme=\"dark\"]" : `:root[data-theme="${theme}"]`);
      for (const [copy, token] of Object.entries(COPIES)) {
        expect(value(swatch, copy), `${theme} ${copy} is ${token}`).toBe(value(palette, token));
      }
    });
  }
});
