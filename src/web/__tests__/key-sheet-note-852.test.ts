// #852: the keyboard sheet opened with a paragraph about when a focused control
// owns the keys, which put a limitation ahead of the reference the reader came
// for. #851 removed most of the cause (a control the pointer just pressed no
// longer keeps the letter keys); what is left is one line under the keys.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KEY_HELP, KEY_HELP_NOTE_MSG } from "../key-help";
import { en } from "../i18n/en";

// CHANGED ON PURPOSE (the UI in every language): the note is a key now; the
// words are read through the English catalog.
const KEY_HELP_NOTE = en[KEY_HELP_NOTE_MSG];
import { defaultReadingSheetText as sheetText } from "./sheet-source";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const sheet = read("../components/KeyboardHelp.tsx");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

describe("the keyboard sheet's note (#852)", () => {
  it("is the one thing to do, not how focus works", () => {
    expect(KEY_HELP_NOTE).toBe("Press Esc first if a key does nothing.");
    expect(KEY_HELP_NOTE).not.toMatch(/focus/i);
  });

  it("names a key the sheet itself lists", () => {
    const caps = KEY_HELP.flatMap(g => g.rows.map(r => r.cap));
    expect(caps).toContain("Esc");
  });

  it("comes after the keys, in the footer under them", () => {
    // CHANGED ON PURPOSE (V4's Figma): the note is the footer's left text, under
    // the two columns of keys.
    const grid = sheet.indexOf('<div className="kh-cols">');
    // The footnote's second sentence says where the single-key shortcuts are
    // turned off (WCAG 2.1.4); KEY_HELP_NOTE still opens it, once.
    const note = sheet.indexOf("<p className=\"kh-foot\">{t(\"settings.key.note\")} {t(\"settings.key.switchNote\", { place: t(\"settings.key.place\") })}</p>");
    const end = sheet.indexOf("</footer>");
    expect(grid).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(grid);
    expect(note).toBeLessThan(end);
    expect(sheet.match(/t\("settings\.key\.note"\)/g)).toHaveLength(1);
  });

  it("reads as a footnote — no box of its own", () => {
    const rule = /(?:^|\n)\.kh-foot\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    // CHANGED ON PURPOSE (V4's Figma): the footnote is the Small style, 12/16.
    expect(rule).toMatch(/font-size:\s*12px/);
    expect(rule).not.toMatch(/border|background/);
  });
});
