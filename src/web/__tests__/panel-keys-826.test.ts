// #826: every other topbar panel had a single key (L, U, A, H, T…), and the
// machine panel, Browser Watch and the sound menu had none — pointer-only, and
// missing from the keyboard sheet. S, B and V open them now, each guarded the
// way its button is drawn, and the sheet lists all three.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KEY_HELP } from "../key-help";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const rows = KEY_HELP.flatMap(g => g.rows);

describe("the three pointer-only panels get keys (#826)", () => {
  it("binds S to the machine panel and B to Browser Watch", () => {
    expect(app).toMatch(/if \(e\.key === "s" \|\| e\.key === "S"\) setMachinePanelOpen\(o => !o\);/);
    expect(app).toMatch(/if \(e\.key === "b" \|\| e\.key === "B"\) setBrowserWatchOpen\(o => !o\);/);
  });

  it("binds V to the sound menu, guarded as the speaker is drawn", () => {
    expect(app).toMatch(/if \(e\.key === "v" \|\| e\.key === "V"\) \{\s*if \(providersRef\.current\.claude && soundOnRef\.current !== null\) setSoundMenuOpen\(o => !o\);/);
    // The same guard the speaker button renders under.
    expect(app).toMatch(/\{providers\.claude && soundOn !== null && \(/);
  });

  it("lists all three in the sheet, under panels", () => {
    const panels = KEY_HELP.find(g => g.title === "Panels and dialogs")!.rows.map(r => r.cap);
    for (const cap of ["S", "B", "V"]) expect(panels, cap).toContain(cap);
    expect(rows.find(r => r.cap === "S")!.binds).toEqual(["s", "S"]);
    expect(rows.find(r => r.cap === "B")!.binds).toEqual(["b", "B"]);
    expect(rows.find(r => r.cap === "V")!.binds).toEqual(["v", "V"]);
  });

  it("says the key on the buttons that carry a title of their own", () => {
    expect(app).toMatch(/this machine — cores, memory, temperature \(S\)/);
    expect(app).toMatch(/Browser watch — not watching; reading the browser's history live \(B\)/);
  });
});
