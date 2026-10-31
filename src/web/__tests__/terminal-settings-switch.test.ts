// Settings › Experimental's switch for the Command Panel (TerminalSection.tsx):
// off on every deck at first, drawn only when App hands it over, and fixed off
// — said rather than offered — where the deck's platform has no panel yet.
//
// No DOM in this suite, so the markup is drawn with renderToStaticMarkup.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TerminalSection, {
  TERMINAL_LABEL, TERMINAL_NOTE, TERMINAL_UNSUPPORTED_NOTE, TERMINAL_WINDOWS_NOTE, terminalNote, type TerminalSwitch,
} from "../components/TerminalSection";
import { DEFAULTS } from "../../server/deck-prefs.mjs";

const noop = () => {};
const draw = (terminal: Partial<TerminalSwitch> = {}) =>
  renderToStaticMarkup(createElement(TerminalSection, { terminal: { on: false, supported: true, toggle: noop, ...terminal } }));
const switchOf = (html: string) => /<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";

describe("the Command Panel's switch in Settings", () => {
  it("is one row named Command Panel, its note saying it is experimental, off as every deck starts", () => {
    expect(DEFAULTS.terminal).toBe(false);
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
    expect(TERMINAL_UNSUPPORTED_NOTE).toBe("Not yet available on this platform.");
    expect(switchOf(draw({ on: true, supported: false })), "a settings file from another machine can still be undone").not.toContain("disabled");
    expect(terminalNote(false)).toBe(TERMINAL_UNSUPPORTED_NOTE);
  });

  it("is offered as usual until the deck has said what its platform has", () => {
    const html = draw({ supported: null });
    expect(switchOf(html)).not.toContain("disabled");
    expect(terminalNote(null)).toBe(TERMINAL_NOTE);
    expect(terminalNote(true)).toBe(TERMINAL_NOTE);
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
    expect(terminalNote(true, true)).toBe(TERMINAL_WINDOWS_NOTE);
    expect(terminalNote(null, true)).toBe(TERMINAL_WINDOWS_NOTE);
    expect(terminalNote(false, true), "a platform with no panel says only that").toBe(TERMINAL_UNSUPPORTED_NOTE);
    expect(draw({ windows: true })).toContain(TERMINAL_WINDOWS_NOTE);
    expect(draw()).not.toContain("session host");
  });
});
