import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RadioPanel from "../components/RadioPanel";
import { resolveRadioStations } from "../radio-library";
import { useClaudeFm } from "../use-claude-fm";
import { useRadioLibrary } from "../use-radio-library";
import { sheetText } from "./sheet-source";
import { cascade, el, selects } from "./sheet-cascade";

const [station] = resolveRadioStations([{ id: "radio-00000000-0000-4000-8000-000000000001", name: "Test radio", url: "https://radio.example/live", country: "Moldova", countryCode: "MD" }]);
const noop = () => {};
function Panel({ saved }: { saved: boolean }) {
  const fm = useClaudeFm();
  const library = useRadioLibrary();
  return createElement(RadioPanel, {
    fm, library: { ...library, catalogue: [station], favorites: saved ? [station.id] : [] },
    selected: station, label: station.name, enabled: true, disabledReason: "",
    player: { probe: null, dead: false, armed: false, playing: false, buffering: false, frame: { current: null }, say: noop, press: noop },
    onPick: noop, onQueueChange: noop, onClose: noop,
  });
}

describe("radio favorite indicators", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("styles both the current station and the list heart for each saved state", () => {
    for (const saved of [false, true, false]) {
      const html = renderToStaticMarkup(createElement(Panel, { saved }));
      const hearts = [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0])
        .filter(button => /aria-label="(?:Save station to favorites|Remove station from favorites|Save Test radio|Unsave Test radio)"/.test(button));
      expect(hearts).toHaveLength(2);
      for (const heart of hearts) {
        expect(heart).toContain(`aria-pressed="${saved}"`);
        expect(heart).toMatch(/class="[^"]*\bradio-favorite\b/);
      }
    }
  });

  it("fills saved hearts with their foreground color instead of a faint background tint", () => {
    const rule = sheetText().match(/\.radio-panel \.radio-favorite\[aria-pressed="true"\] path\s*\{([^}]+)\}/)?.[1];
    expect(rule).toMatch(/fill:\s*currentColor/);
  });

  it("keeps the saved icon accent independent of the button hover color", () => {
    for (const saved of [true, false]) {
      const chain = [el("div", ["radio-panel"]), el("button", ["icon-btn", "radio-favorite"], {
        attrs: { "aria-pressed": String(saved) }, states: ["hover"],
      }), el("svg")];
      expect(cascade(selector => selects(selector, chain), "color", 1280)).toBe(saved ? "var(--accent)" : null);
    }
  });
});
