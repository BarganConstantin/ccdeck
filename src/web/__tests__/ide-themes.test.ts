import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sheetText } from "./sheet-source";
import { THEMES, nextTheme, resolveTheme } from "../theme";

const css = sheetText();
const base = css.split("}")[0];
function luminance(hex: string) {
  const channels = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(a: string, b: string) {
  const [lo, hi] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (hi + .05) / (lo + .05);
}
for (const theme of THEMES.filter(id => id !== "light" && id !== "dark")) describe(theme, () => {
  const sheet = css.slice(css.indexOf(`:root[data-theme="${theme}"] {`));
  const tokens = Object.fromEntries([...`${base}\n${sheet.split("}")[0]}`.matchAll(/(--[\w-]+):\s*(#[a-f\d]{6})\s*;/gi)].map(m => [m[1], m[2]]));
  it("cycles each theme and preserves the explicit choice on either OS theme", () => {
    THEMES.forEach((id, index) => expect(nextTheme(id)).toBe(THEMES[(index + 1) % THEMES.length]));
    expect(resolveTheme(theme, true)).toBe(theme);
    expect(resolveTheme(theme, false)).toBe(theme);
  });
  for (const surface of ["--bg", "--bg-soft", "--panel"]) {
    it(`keeps text, statuses and category labels readable on ${surface}`, () => {
      for (const ink of ["--text", "--text-secondary", "--muted", "--text-dim", "--accent", "--ok", "--warn", "--err", "--inflight", "--cat-file", "--cat-shell", "--cat-web", "--cat-agent", "--cat-task", "--cat-plan", "--cat-mcp", "--cat-other"]) {
        expect(contrast(tokens[ink], tokens[surface]), ink).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
  if (theme === "black-contrast" || theme === "white-contrast") {
    for (const surface of ["--bg", "--bg-soft", "--panel"]) {
      it(`provides 7:1 reading contrast and clear control edges on ${surface}`, () => {
        for (const ink of ["--text", "--text-secondary", "--muted", "--text-dim"]) {
          expect(contrast(tokens[ink], tokens[surface]), ink).toBeGreaterThanOrEqual(7);
        }
        for (const edge of ["--ctl-edge", "--sm-edge", "--chrome-edge", "--accent"]) {
          expect(contrast(tokens[edge], tokens[surface]), edge).toBeGreaterThanOrEqual(3);
        }
      });
    }
  }
  it("keeps the selected text and primary action readable", () => {
    const definition = JSON.parse(readFileSync(new URL(`../themes/${theme}.json`, import.meta.url), "utf8"));
    expect(contrast(definition.selection.foreground, definition.selection.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["--bg"], tokens["--accent"])).toBeGreaterThanOrEqual(4.5);
  });
});
