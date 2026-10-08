// #826: every other topbar panel had a single key (L, U, A, H, T…), and the
// machine panel, Browser Watch and the sound menu had none — pointer-only, and
// missing from the keyboard sheet. S, B and V open them now, and the sheet
// lists all three. V's popover left the topbar with its speaker (2026-10-07):
// V opens Settings at Sounds, where everything the popover held already was,
// and the sheet lists it with Settings.
// The panel buttons left the topbar for the window's edges (2026-10-08,
// EdgeRails.tsx); the keys did not move, and the control that opens each panel
// still names its key — in its hint's keycap and in aria-keyshortcuts now,
// rather than in a title.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KEY_HELP } from "../key-help";
import { railItems } from "../rail-items";
import { railHint } from "../components/EdgeRails";

// The keydown handler moved to use-deck-shortcuts.ts; the keys and the rest of the deck are read as one.
const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8")
  + "\n" + readFileSync(fileURLToPath(new URL("../use-deck-shortcuts.ts", import.meta.url)), "utf8");
const noop = () => {};
const ref = () => ({ current: null });
const items = railItems({
  providers: { kind: "reported", claude: true, codex: true } as never,
  sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
  usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
  setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
  openSettings: noop, onFeedback: noop, toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
});
const every = [...items.left, ...items.right.flat(), ...items.utilities];
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

  it("says the key on the control that opens each, in its hint and to assistive tech", () => {
    // Through railHint, which names the key while Settings › General's
    // single-key switch is on and drops it when the key does nothing (WCAG
    // 2.1.4); edge-keys-switch.test.ts draws both. The hint keeps what the old
    // titles said beyond the word: whether Browser watch is watching.
    const machine = every.find(i => i.id === "machine")!;
    const watch = every.find(i => i.id === "browser-watch")!;
    expect(machine.key).toEqual({ cap: "S", aria: "S", single: true });
    expect(watch.key).toEqual({ cap: "B", aria: "B", single: true });
    expect(railHint(machine, true, true)?.keys).toBe("S");
    expect(railHint(watch, true, true)?.keys).toBe("B");
    expect(railHint(watch, true, true)?.detail).toMatch(/^Not watching\b/);
  });
});
