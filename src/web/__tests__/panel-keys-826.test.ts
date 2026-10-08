// #826: every other topbar panel had a single key (L, U, A, H, T…), and the
// machine panel, Browser Watch and the sound menu had none — pointer-only, and
// missing from the keyboard sheet. S, B and V open them now, and the sheet
// lists all three. V's popover left the topbar with its speaker (2026-10-07):
// V opens Settings at Sounds, where everything the popover held already was,
// and the sheet lists it with Settings.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KEY_HELP } from "../key-help";

// The keydown handler moved to use-deck-shortcuts.ts; the keys and the rest of the deck are read as one.
// Two of the topbar's action runs moved to components/TopbarRuns.tsx; App.tsx and they are read as one.
const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8")
  + "\n" + readFileSync(fileURLToPath(new URL("../components/TopbarRuns.tsx", import.meta.url)), "utf8")
  + "\n" + readFileSync(fileURLToPath(new URL("../use-deck-shortcuts.ts", import.meta.url)), "utf8");
const rows = KEY_HELP.flatMap(g => g.rows);

describe("the three pointer-only panels get keys (#826)", () => {
  it("binds S to the machine panel and B to Browser Watch", () => {
    expect(app).toMatch(/if \(e\.key === "s" \|\| e\.key === "S"\) setMachinePanelOpen\(o => !o\);/);
    expect(app).toMatch(/if \(e\.key === "b" \|\| e\.key === "B"\) setBrowserWatchOpen\(o => !o\);/);
  });

  it("binds V to Settings at Sounds, on every machine", () => {
    // No Claude Code guard any more: it guarded V the way the speaker was
    // drawn, and Settings › Sounds is drawn everywhere.
    expect(app).toMatch(/if \(e\.key === "v" \|\| e\.key === "V"\) openSettings\("sounds"\);/);
    expect(app).not.toMatch(/setSoundMenuOpen/);
  });

  it("lists all three in the sheet: S and B under panels, V under Settings", () => {
    const panels = KEY_HELP.find(g => g.title === "Panels and dialogs")!.rows.map(r => r.cap);
    for (const cap of ["S", "B"]) expect(panels, cap).toContain(cap);
    const settings = KEY_HELP.find(g => g.title === "Settings")!.rows;
    expect(settings.map(r => r.cap)).toContain("V");
    expect(settings.find(r => r.cap === "V")!.action).toMatch(/^sound settings/);
    expect(rows.find(r => r.cap === "S")!.binds).toEqual(["s", "S"]);
    expect(rows.find(r => r.cap === "B")!.binds).toEqual(["b", "B"]);
    expect(rows.find(r => r.cap === "V")!.binds).toEqual(["v", "V"]);
  });

  it("says the key on the buttons that carry a title of their own", () => {
    // Through withKey, which names the letter while Settings › General's
    // single-key switch is on and drops it when the key does nothing (WCAG
    // 2.1.4); single-key-shortcuts-surfaces.test.ts draws both.
    expect(app).toMatch(/this machine — cores, memory, temperature`, "S", singleKeys\)/);
    expect(app).toMatch(/"Browser watch — not watching; reading the browser's history live", "B", singleKeys\)/);
  });
});
