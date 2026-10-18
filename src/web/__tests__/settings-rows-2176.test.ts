// #2176: one row shape for every control in Settings, and the Keyboard
// section's list of every key.
//
// Settings had five row shapes for one job — `.appearance-row`,
// `.sm-setting`/`.sm-switch`, `.sm-row`, the reading fieldsets and Tool
// history's label over its select. Every section draws its rows through
// SettingsParts.tsx now; this holds the parts to their shape and the sections
// to the parts. Drawn with renderToStaticMarkup; no DOM.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingRow, SettingsGroup } from "../components/SettingsParts";
import KeyboardSection, { shortcutMatches, shortcutName } from "../components/KeyboardSection";
import ToolAuditSettings, { TOOL_HISTORY_NOTE } from "../components/ToolAuditSettings";
import { KEY_HELP } from "../key-help";
import { sourceOf } from "./client-source";

const noop = () => {};
const draw = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("the one row", () => {
  it("is a label round its name, its note and its control, so a press on the name reaches the control", () => {
    const html = draw(createElement(SettingRow, {
      name: "Play sounds", nameId: "n", note: "A tone.", noteId: "d", settingId: "play-sounds",
      control: createElement("button", { role: "switch" }),
    }));
    expect(html).toBe(
      '<label class="settings-row" data-setting="play-sounds"><span class="settings-row-name" id="n">Play sounds</span>'
      + '<span class="settings-row-note" id="d">A tone.</span><span class="settings-row-control"><button role="switch"></button></span></label>',
    );
  });

  it("is a div when it is not one control's label, and draws no slot it was not given", () => {
    const html = draw(createElement(SettingRow, { as: "div", name: "Version" }));
    expect(html).toBe('<div class="settings-row"><span class="settings-row-name">Version</span></div>');
  });
});

describe("the one group", () => {
  it("is a section named by its caption, over one bordered list", () => {
    const html = draw(createElement(SettingsGroup, { id: "g", title: "Board", note: "Shared." }, "rows"));
    expect(html).toBe(
      '<section class="settings-group" aria-labelledby="g"><div class="settings-caption"><div class="settings-caption-text">'
      + '<h3 id="g">Board</h3><p class="settings-caption-note">Shared.</p></div></div><div class="settings-list">rows</div></section>',
    );
  });

  it("has no caption for a section's master switch, and no list round content that draws its own frames", () => {
    expect(draw(createElement(SettingsGroup, null, "rows"))).toBe('<div class="settings-group"><div class="settings-list">rows</div></div>');
    expect(draw(createElement(SettingsGroup, { id: "t", title: "Theme", list: false }, "tiles"))).not.toContain("settings-list");
  });
});

describe("every section draws its rows through the shared parts", () => {
  const sections = readdirSync(new URL("../components", import.meta.url))
    .filter(f => /Section\.tsx$|^ToolAuditSettings\.tsx$|^SoundSwitch\.tsx$/.test(f))
    .map(f => [f, sourceOf(`components/${f}`)] as const);

  it("keeps none of the five row shapes it replaced", () => {
    expect(sections.length).toBeGreaterThan(8);
    for (const [file, src] of sections) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/"appearance-row|"sm-setting"|"sm-switch"|"sm-switch-label"|"ta-storage-row"|"sm-channel-head"/);
    }
  });

  it("names every searchable row by a data-setting id that is unique", () => {
    const ids = sections.flatMap(([, src]) => [...src.matchAll(/settingId="([^"]+)"/g)].map(m => m[1]));
    expect(ids.length).toBeGreaterThan(8);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Settings › Keyboard lists every key", () => {
  const rows = KEY_HELP.flatMap(g => g.rows);

  it("names each row as a setting is named, and the sheet's own row from outside it", () => {
    expect(shortcutName(rows.find(r => r.cap === "J")!)).toBe("Next agent");
    expect(shortcutName(rows.find(r => r.cap === "?")!)).toBe("The keyboard shortcuts sheet");
  });

  it("narrows by what a key does or by the key, either platform's spelling", () => {
    const zoom = rows.find(r => r.cap === "Z")!;
    const undo = rows.find(r => r.cap === "Ctrl + Z")!;
    expect(shortcutMatches(zoom, "ZOOM")).toBe(true);
    expect(shortcutMatches(zoom, "  ")).toBe(true);
    expect(shortcutMatches(undo, "⌘")).toBe(true);
    expect(shortcutMatches(undo, "ctrl")).toBe(true);
    expect(shortcutMatches(zoom, "nothing like it")).toBe(false);
  });

  it("empties a filled filter on Escape, and lets Escape close Settings only from an empty one", () => {
    // Checked in the browser: before this, Escape in "zoom" shut the dialog.
    expect(sourceOf("components/KeyboardSection.tsx"))
      .toMatch(/if \(event\.key === "Escape" && query\) \{ event\.stopPropagation\(\); setQuery\(""\); \}/);
  });

  it("names its filter with a label, not with a placeholder alone", () => {
    const html = draw(createElement(KeyboardSection, { singleKeys: true, onToggleSingleKeys: noop }));
    expect(html).toMatch(/<label class="vis-hidden" for="[^"]+">Filter shortcuts<\/label><input id="[^"]+" type="search"/);
  });
});

describe("Settings › Data", () => {
  it("says what tool history is before the size is read, and says it is reading", () => {
    const html = draw(createElement(ToolAuditSettings));
    expect(html).toContain(`>${TOOL_HISTORY_NOTE}</p>`);
    expect(html).toMatch(/>Storage size unavailable\.<|>Reading storage…</);
  });
});
