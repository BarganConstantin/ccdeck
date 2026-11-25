// A Workspace pane's tabs in its header (PaneTabs.tsx): drawn only once the
// pane holds two sessions, each tab its session's glyph and name and the state
// word the header would say, the one on show selected and the strip's one tab
// stop; and what a key on the strip asks.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StageHeader, { tabWords, type StageHeaderProps } from "../components/terminal/StageHeader";
import { stripKey, type PaneTabsView } from "../components/terminal/PaneTabs";
import { en } from "../i18n/en";

const props = (over: Partial<StageHeaderProps> = {}): StageHeaderProps => ({
  identity: "session:s1", name: "api refactor", provider: "claude", workspace: "pane", split: true,
  status: { state: "idle", phrase: "idle" }, keysOwner: "pane", chordLabel: "Ctrl+Shift+X",
  canType: true, expanded: false, takeover: false,
  onKeys() {}, onExpand() {}, onClose() {},
  ...over,
});

const view = (over: Partial<PaneTabsView> = {}): PaneTabsView => ({
  items: [
    { key: "s:s1", id: "wsp-ptab-p0-s:s1", name: "api refactor", status: { state: "idle", phrase: "idle" }, on: true, panel: "workspace-pane" },
    { key: "s:s2", id: "wsp-ptab-p0-s:s2", name: "docs pass", status: { state: "waiting", phrase: "waiting", emphasis: "6m" }, on: false, panel: "wsp-ptabpanel-p0-s:s2" },
  ],
  onSelect() {},
  onClose() {},
  ...over,
});

const html = (p: StageHeaderProps) => renderToStaticMarkup(createElement(StageHeader, p));
const tags = (out: string, role: string) => [...out.matchAll(new RegExp(`<[a-z]+[^>]*role="${role}"[^>]*>`, "g"))].map(m => m[0]);

describe("a pane's header", () => {
  it("with one session is the header it always was: the name, no strip", () => {
    const out = html(props());
    expect(out).not.toContain('role="tablist"');
    expect(out).toContain('<h2 class="ts-name"');
    expect(out).toContain("api refactor");
  });

  it("with two or more, puts the strip in the name's place, in the same row", () => {
    const out = html(props({ tabs: view() }));
    const [list] = tags(out, "tablist");
    expect(list).toContain(`aria-label="${en["board.stage.tabs.label"]}"`);
    const tabs = tags(out, "tab");
    expect(tabs).toHaveLength(2);
    // The one on show is selected and the strip's one tab stop.
    expect(tabs[0]).toContain('aria-selected="true"');
    expect(tabs[0]).toContain('tabindex="0"');
    expect(tabs[0]).toContain('aria-controls="workspace-pane"');
    expect(tabs[0]).toContain("data-on");
    expect(tabs[1]).toContain('aria-selected="false"');
    expect(tabs[1]).toContain('tabindex="-1"');
    expect(tabs[1]).toContain('aria-controls="wsp-ptabpanel-p0-s:s2"');
    // The heading stays for a walk by headings, out of sight.
    expect(out).toContain('<h2 class="ts-name vis-hidden">api refactor</h2>');
    // No second state word beside the strip: each tab says its own.
    expect(out).not.toContain("ts-meta-state");
    expect(out.match(/class="ts-header|class="ts-head"/g)).toHaveLength(1);
  });

  it("says each tab's state as the header would: the word only where it is not the normal one", () => {
    const out = html(props({ tabs: view() }));
    expect(out).toContain('<span class="ts-tab-word" data-state="waiting" aria-hidden="true">waiting 6m</span>');
    expect(out.match(/ts-tab-word/g)).toHaveLength(1);
    expect(out).toContain('title="docs pass · waiting 6m"');
    // And the whole sentence for a screen reader, on every tab with a state.
    expect(out).toContain('<span class="vis-hidden"> · waiting 6m</span>');
    expect(out).toContain('<span class="vis-hidden"> · idle</span>');
  });

  it("gives the tab words the header's own: glyph, word and sentence", () => {
    expect(tabWords({ state: "waiting", phrase: "waiting", emphasis: "6m" })).toMatchObject({ word: "waiting 6m", sentence: "waiting 6m" });
    expect(tabWords({ state: "idle", phrase: "idle" }).word).toBeNull();
    expect(tabWords({ state: "none", phrase: "" })).toMatchObject({ word: null, sentence: "" });
  });
});

describe("a key on the strip", () => {
  const items = view().items;
  const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  it("walks the tabs with the arrows, Home and End, round at both ends", () => {
    expect(stripKey(key("ArrowRight"), 0, items)).toEqual({ kind: "select", key: "s:s2" });
    expect(stripKey(key("ArrowRight"), 1, items)).toEqual({ kind: "select", key: "s:s1" });
    expect(stripKey(key("ArrowLeft"), 0, items)).toEqual({ kind: "select", key: "s:s2" });
    expect(stripKey(key("Home"), 1, items)).toEqual({ kind: "select", key: "s:s1" });
    expect(stripKey(key("End"), 0, items)).toEqual({ kind: "select", key: "s:s2" });
  });

  it("closes the tab under the keyboard with Delete, and only a bare Delete", () => {
    expect(stripKey(key("Delete"), 1, items)).toEqual({ kind: "close", key: "s:s2" });
    expect(stripKey(key("Delete", { ctrlKey: true }), 1, items)).toBeNull();
    expect(stripKey(key("Delete", { altKey: true }), 1, items)).toBeNull();
  });

  it("leaves Enter (the tab's own press), Tab, Escape and the browser's chords alone", () => {
    for (const k of [key("Enter"), key("Tab"), key("Escape"), key("ArrowDown"), key("ArrowRight", { ctrlKey: true })]) {
      expect(stripKey(k, 0, items), k.key).toBeNull();
    }
    expect(stripKey(key("ArrowRight"), -1, items), "not a tab of this strip").toBeNull();
  });
});
