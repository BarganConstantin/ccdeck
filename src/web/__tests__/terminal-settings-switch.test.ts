// Settings › Experimental's switch for the Command Panel (TerminalSection.tsx):
// on at first, drawn only when App hands it over, and fixed off
// — said rather than offered — where the deck's platform has no panel yet.
//
// No DOM in this suite, so the markup is drawn with renderToStaticMarkup.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TerminalSection, { terminalNote, type TerminalSwitch } from "../components/TerminalSection";
import { DEFAULTS } from "../../server/deck-prefs.mjs";
import en from "../i18n/areas/settings/en";
import { t as tEn } from "../i18n";

// The row's words live in the settings catalogs; English is the reference.
const TERMINAL_LABEL = en["settings.search.commandPanel"];
const TERMINAL_NOTE = en["settings.terminal.note"];
const TERMINAL_WINDOWS_NOTE = en["settings.terminal.noteWindows"];
const TERMINAL_UNSUPPORTED_NOTE = en["settings.terminal.unsupported"];

const noop = () => {};
const draw = (terminal: Partial<TerminalSwitch> = {}) =>
  renderToStaticMarkup(createElement(TerminalSection, { terminal: { on: false, supported: true, toggle: noop, ...terminal } }));
const switchOf = (html: string) => /<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";

describe("the Command Panel's switch in Settings", () => {
  it("is one row named Command Panel, its note saying it is experimental", () => {
    // CHANGED ON PURPOSE: the panel is on by default now, so a deck starts with the switch on.
    expect(DEFAULTS.terminal).toBe(true);
    const html = draw();
    expect(html).toContain(`>${TERMINAL_LABEL}<`);
    expect(TERMINAL_LABEL).toBe("Command Panel");
    expect(switchOf(html)).toContain('aria-checked="false"');
    expect(switchOf(html)).not.toContain("disabled");
    expect(html).toContain(TERMINAL_NOTE);
    expect(TERMINAL_NOTE).toMatch(/^Experimental: /);
    expect(TERMINAL_NOTE.split(". ").length, "one line: two short sentences at most").toBeLessThanOrEqual(2);
  });

  it("reads on once it is on", () => {
    expect(switchOf(draw({ on: true }))).toContain('aria-checked="true"');
  });

  it("is fixed off where the platform has no panel, and says so — but never fixed on there", () => {
    const html = draw({ supported: false });
    expect(switchOf(html)).toContain("disabled");
    expect(html).toContain(TERMINAL_UNSUPPORTED_NOTE);
    // CHANGED ON PURPOSE (V4 Figma): the row keeps its own note and the platform's answer
    // stands under it in a Note. The drawn row, not only the helper, must tie it to the
    // switch, or a screen reader never hears the panel is unavailable.
    expect(html).toContain(TERMINAL_NOTE);
    expect(html).toMatch(/<p class="settings-note" id="settings-terminal-unavailable">Not yet available on this platform\.<\/p>/);
    expect(switchOf(html)).toContain('aria-describedby="settings-terminal-note settings-terminal-unavailable"');
    expect(html).not.toContain('role="status"');
    expect(switchOf(draw())).toContain('aria-describedby="settings-terminal-note"');
    expect(TERMINAL_UNSUPPORTED_NOTE).toBe("Not yet available on this platform.");
    expect(switchOf(draw({ on: true, supported: false })), "a settings file from another machine can still be undone").not.toContain("disabled");
    expect(terminalNote(tEn, false)).toBe(TERMINAL_UNSUPPORTED_NOTE);
  });

  it("is offered as usual until the deck has said what its platform has", () => {
    const html = draw({ supported: null });
    expect(switchOf(html)).not.toContain("disabled");
    expect(terminalNote(tEn, null)).toBe(TERMINAL_NOTE);
    expect(terminalNote(tEn, true)).toBe(TERMINAL_NOTE);
  });

  it("names no variable, file, engine or tmux: plain words only", () => {
    for (const text of [TERMINAL_LABEL, TERMINAL_NOTE, TERMINAL_UNSUPPORTED_NOTE, TERMINAL_WINDOWS_NOTE]) {
      expect(text).not.toMatch(/CCDECK_|prefs\.json|engine|tmux|Beta/i);
    }
  });

  it("says what turning it off does: the panel closes, its sessions keep running, and are back when it is on", () => {
    expect(TERMINAL_NOTE).toBe("Experimental: open sessions beside the board and type into them. Turning it off closes the panel, not its sessions: they keep running and are back when you turn it on again.");
  });

  it("on Windows, says where they keep running: in the session host", () => {
    expect(TERMINAL_WINDOWS_NOTE).toBe("Experimental: open sessions beside the board and type into them. Turning it off closes the panel, not its sessions: they keep running in the session host and are back when you turn it on again.");
    expect(TERMINAL_WINDOWS_NOTE.split(". ").length, "one line: two short sentences at most").toBeLessThanOrEqual(2);
    expect(terminalNote(tEn, true, true)).toBe(TERMINAL_WINDOWS_NOTE);
    expect(terminalNote(tEn, null, true)).toBe(TERMINAL_WINDOWS_NOTE);
    expect(terminalNote(tEn, false, true), "a platform with no panel says only that").toBe(TERMINAL_UNSUPPORTED_NOTE);
    expect(draw({ windows: true })).toContain(TERMINAL_WINDOWS_NOTE);
    expect(draw()).not.toContain("session host");
  });
});
