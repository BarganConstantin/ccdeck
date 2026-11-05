// Text that passed through a shell or an editor without UTF-8 comes back with
// "?" where every non-ASCII character was: "this login?s folder", "autentific?rii",
// or a Japanese sentence that is nothing but question marks. 3.81.4 shipped the
// Codex private-login message like that in all ten languages.
//
// FAILS on: a replacement character (U+FFFD), three question marks in a row, or
// a question mark between two letters, in any interface string or release note.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES } from "../i18n/registry";

const LOST = /�|\?\?\?|\p{L}\?\p{L}/u;

const lostIn = (entries: [string, string][]): string[] =>
  entries.filter(([, text]) => LOST.test(text)).map(([key, text]) => `${key}: ${text.slice(0, 80)}`);

describe("no characters lost to a non-UTF-8 round trip", () => {
  for (const language of LANGUAGES) {
    it(`${language.code} catalog`, () => {
      const entries = Object.entries(language.catalog as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string");
      expect(entries.length).toBeGreaterThan(0);
      expect(lostIn(entries)).toEqual([]);
    });
  }

  it("release notes", () => {
    const file = JSON.parse(readFileSync(join(__dirname, "../../../release-notes.json"), "utf8")) as Record<string, unknown>;
    const entries: [string, string][] = [];
    for (const [version, notes] of Object.entries(file)) {
      if (version.startsWith("//") || !Array.isArray(notes)) continue;
      notes.forEach((note: Record<string, unknown>, i) => {
        for (const [field, value] of Object.entries(note)) {
          if (typeof value === "string") entries.push([`${version}[${i}].${field}`, value]);
        }
      });
    }
    expect(entries.length).toBeGreaterThan(0);
    expect(lostIn(entries)).toEqual([]);
  });

  it("catches the 3.81.4 shapes", () => {
    expect(LOST.test("this login?s folder")).toBe(true);
    expect(LOST.test("autentific?rii")).toBe(true);
    expect(LOST.test("????????Codex")).toBe(true);
    expect(LOST.test("What changed? See /status.")).toBe(false);
    expect(LOST.test("¿Qué? Nada.")).toBe(false);
  });
});
