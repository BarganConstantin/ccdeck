// Settings › General's Beta switch for the terminal (TerminalSection.tsx): off
// on every deck at first, drawn only when App hands it over, and fixed — said
// rather than offered — when the launch forced it on or the machine is
// Windows, which has no tmux.
//
// No DOM in this suite, so the markup is drawn with renderToStaticMarkup.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TerminalSection, {
  BETA_TITLE, TERMINAL_FORCED_NOTE, TERMINAL_LABEL, TERMINAL_NOTE, TERMINAL_WINDOWS_NOTE, terminalNote, type TerminalSwitch,
} from "../components/TerminalSection";
import { DEFAULTS } from "../../server/deck-prefs.mjs";

const noop = () => {};
const draw = (terminal: Partial<TerminalSwitch> = {}, platform = "Linux x86_64") =>
  renderToStaticMarkup(createElement(TerminalSection, { terminal: { on: false, forced: false, toggle: noop, ...terminal }, platform }));
const switchOf = (html: string) => /<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";

describe("the terminal's switch in Settings", () => {
  it("is a Terminal group with Beta on the caption's right, and its switch off as every deck starts", () => {
    expect(DEFAULTS.terminal).toBe(false);
    const html = draw();
    expect(html).toContain(">Terminal</h3>");
    expect(html).toContain(`<span class="settings-beta" title="${BETA_TITLE}">Beta</span>`);
    expect(html).toContain(TERMINAL_LABEL);
    expect(switchOf(html)).toContain('aria-checked="false"');
    expect(switchOf(html)).not.toContain("disabled");
    expect(html).toContain(TERMINAL_NOTE.replace(/'/g, "&#x27;"));
  });

  it("reads on once it is on", () => {
    expect(switchOf(draw({ on: true }))).toContain('aria-checked="true"');
  });

  it("is fixed on, and says why, when the launch forced it", () => {
    const html = draw({ on: true, forced: true });
    expect(switchOf(html)).toContain('aria-checked="true"');
    expect(switchOf(html)).toContain("disabled");
    expect(html).toContain(TERMINAL_FORCED_NOTE);
  });

  it("is fixed off on Windows, and says why — but never fixed on there", () => {
    const html = draw({}, "Win32");
    expect(switchOf(html)).toContain("disabled");
    expect(switchOf(draw({ on: true }, "Win32")), "a settings file from another machine can still be undone").not.toContain("disabled");
    expect(html).toContain(TERMINAL_WINDOWS_NOTE);
    expect(terminalNote(false, true)).toBe(TERMINAL_WINDOWS_NOTE);
    expect(terminalNote(true, true), "a forced launch is the truer sentence").toBe(TERMINAL_FORCED_NOTE);
  });

  it("never names the launch variable, which stays undocumented while this is a Beta", () => {
    for (const text of [TERMINAL_LABEL, TERMINAL_NOTE, TERMINAL_FORCED_NOTE, TERMINAL_WINDOWS_NOTE, BETA_TITLE]) {
      expect(text).not.toMatch(/CCDECK_|prefs\.json/);
    }
  });
});
