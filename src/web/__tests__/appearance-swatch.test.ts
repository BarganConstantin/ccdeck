// The appearance menu's theme previews carry each theme's palette as literal
// values, because a Light preview has to be light while the page is dark and
// the tokens only exist for the theme that is showing. This holds every copied
// value to the token it copies, so a theme that moves cannot leave a preview
// showing the old one.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

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

const THEMES = {
  dark: block(":root,\n:root[data-theme=\"dark\"]"),
  light: block(':root[data-theme="light"]'),
};
/** Which token each preview variable copies. */
const COPIES = {
  "--tp-canvas": "--bg",
  "--tp-surface": "--panel",
  "--tp-rule": "--line",
  "--tp-mark": "--muted-dim",
  "--tp-accent": "--accent",
} as const;

describe("the theme previews are drawn in the themes they preview", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`copies the ${theme} tokens exactly`, () => {
      const swatch = block(`.appearance-preview[data-swatch="${theme}"]`);
      for (const [copy, token] of Object.entries(COPIES)) {
        expect(value(swatch, copy), `${theme} ${copy} is ${token}`).toBe(value(THEMES[theme], token));
      }
    });
  }
});
