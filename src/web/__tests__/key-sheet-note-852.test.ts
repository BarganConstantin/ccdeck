// #852: the keyboard sheet opened with a paragraph about when a focused control
// owns the keys, which put a limitation ahead of the reference the reader came
// for. #851 removed most of the cause (a control the pointer just pressed no
// longer keeps the letter keys); what is left is one line under the keys.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KEY_HELP, KEY_HELP_NOTE } from "../key-help";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const sheet = read("../components/KeyboardHelp.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the keyboard sheet's note (#852)", () => {
  it("is the one thing to do, not how focus works", () => {
    expect(KEY_HELP_NOTE).toBe("Press Esc first if a key does nothing.");
    expect(KEY_HELP_NOTE).not.toMatch(/focus/i);
  });

  it("names a key the sheet itself lists", () => {
    const caps = KEY_HELP.flatMap(g => g.rows.map(r => r.cap));
    expect(caps).toContain("Esc");
  });

  it("comes after the keys and before the end of the body", () => {
    const grid = sheet.indexOf('<div className="shortcuts">');
    const note = sheet.indexOf("<p className=\"kh-foot\">{KEY_HELP_NOTE}</p>");
    const end = sheet.indexOf("</section>");
    expect(grid).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(grid);
    expect(note).toBeLessThan(end);
    expect(sheet.match(/\{KEY_HELP_NOTE\}/g)).toHaveLength(1);
  });

  it("reads as a footnote — no box of its own", () => {
    const rule = /(?:^|\n)\.kh-foot\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/font-size:\s*11px/);
    expect(rule).not.toMatch(/border|background/);
  });
});
