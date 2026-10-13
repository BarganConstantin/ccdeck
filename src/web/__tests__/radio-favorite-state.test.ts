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
function Panel({ saved, workspace = false }: { saved: boolean; workspace?: boolean }) {
  const fm = useClaudeFm();
  const library = useRadioLibrary();
  return createElement(RadioPanel, {
    fm: workspace ? { ...fm, fmSource: "good-life-radio" } : fm, library: { ...library, catalogue: [station], favorites: saved ? [workspace ? "good-life-radio" : station.id] : [] },
    selected: workspace ? undefined : station, label: workspace ? "The Good Life Radio" : station.name, enabled: true, disabledReason: "",
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

  it("draws the same country image in the player and station row", () => {
    const html = renderToStaticMarkup(createElement(Panel, { saved: false }));
    const flags = [...html.matchAll(/<img\b[^>]*class="radio-country-flag"[^>]*>/g)];
    expect(flags).toHaveLength(2);
    for (const [flag] of flags) expect(flag).toContain("/radio-flags/md.svg");
  });

  it("shows available workspace streams first without removed stations", () => {
    const html = renderToStaticMarkup(createElement(Panel, { saved: false }));
    expect(html).toMatch(/<details class="radio-own" open="">/);
    const buttons = [...html.matchAll(/<button\b[^>]*class="radio-own-station radio-station-pick"[^>]*>/g)].map(match => match[0]);
    expect(buttons).toHaveLength(7);
    expect(buttons[0]).toContain('aria-label="Play Claude FM"');
    expect(buttons.join(" ")).toContain('aria-label="Play Lofi Girl · Chill / game"');
    expect(html).not.toContain("Cafe music BGM");
    expect(html).not.toContain("Best of nostalgia live");
    expect(html.indexOf('class="radio-own"')).toBeLessThan(html.indexOf('class="radio-daily"'));
    expect(html.indexOf('class="radio-own"')).toBeLessThan(html.indexOf('data-station-id='));
    expect(html).toContain("7 workspace streams · 1 radio station");
  });

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

  it("exposes the player heart for workspace streams using their shared favorite ID", () => {
    for (const saved of [false, true]) {
      const html = renderToStaticMarkup(createElement(Panel, { saved, workspace: true }));
      const heart = [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).find(button => /aria-label="(?:Save station to favorites|Remove station from favorites)"/.test(button));
      expect(heart).toContain(`aria-pressed="${saved}"`);
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
