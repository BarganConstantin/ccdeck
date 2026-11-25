// A Workspace pane's tabs in its header (PaneTabs.tsx): drawn only once the
// pane holds two sessions, each tab its session's glyph and name and the state
// word the header would say, the one on show selected and the strip's one tab
// stop until the keyboard moves along it; and what a key on the strip asks.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StageHeader, { tabWords, type StageHeaderProps } from "../components/terminal/StageHeader";
import { stripKey, stripStop, type PaneTabsView } from "../components/terminal/PaneTabs";
import { firstRunClause } from "../components/terminal/KeysBar";
import { en } from "../i18n/en";
import { buildRows, rank, rowGlyphOf } from "../components/SessionList";
import { railGlyph } from "../rail-row-copy";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

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

describe("a key on the strip: manual activation, since showing a tab attaches its terminal", () => {
  const items = view().items;
  const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  it("moves the keyboard along the tabs with the arrows, Home and End, round at both ends, and shows none of them", () => {
    expect(stripKey(key("ArrowRight"), 0, items)).toEqual({ kind: "focus", key: "s:s2" });
    expect(stripKey(key("ArrowRight"), 1, items)).toEqual({ kind: "focus", key: "s:s1" });
    expect(stripKey(key("ArrowLeft"), 0, items)).toEqual({ kind: "focus", key: "s:s2" });
    expect(stripKey(key("Home"), 1, items)).toEqual({ kind: "focus", key: "s:s1" });
    expect(stripKey(key("End"), 0, items)).toEqual({ kind: "focus", key: "s:s2" });
  });

  it("shows the tab under the keyboard with Space, which keeps the keyboard on the strip", () => {
    expect(stripKey(key(" "), 1, items)).toEqual({ kind: "show", key: "s:s2" });
    expect(stripKey(key(" "), 0, items)).toEqual({ kind: "show", key: "s:s1" });
    expect(stripKey(key(" ", { ctrlKey: true }), 1, items), "a browser chord").toBeNull();
  });

  it("closes the tab under the keyboard with Delete, and only a bare Delete", () => {
    expect(stripKey(key("Delete"), 1, items)).toEqual({ kind: "close", key: "s:s2" });
    expect(stripKey(key("Delete", { ctrlKey: true }), 1, items)).toBeNull();
    expect(stripKey(key("Delete", { altKey: true }), 1, items)).toBeNull();
  });

  it("leaves Enter (the tab's own press: shown, with the keys in its terminal), Tab, Escape and the browser's chords alone", () => {
    for (const k of [key("Enter"), key("Tab"), key("Escape"), key("ArrowDown"), key("ArrowRight", { ctrlKey: true })]) {
      expect(stripKey(k, 0, items), k.key).toBeNull();
    }
    expect(stripKey(key("ArrowRight"), -1, items), "not a tab of this strip").toBeNull();
  });

  it("keeps one tab stop: the tab the keyboard moved to, else the tab on show", () => {
    expect(stripStop(items, null)).toBe("s:s1");
    expect(stripStop(items, "s:s2"), "aria-selected stays on s1; the stop follows the keyboard").toBe("s:s2");
    expect(stripStop(items, "s:gone"), "a tab closed meanwhile").toBe("s:s1");
    expect(stripStop(items.map(x => ({ ...x, on: false })), null), "none on show").toBe("s:s1");
  });
});

describe("a tab's mark, the one its session's row wears in the Sessions list", () => {
  const T0 = 1_700_000_000_000;
  let seq = 0;
  const send = (state: GraphState, sid: string, payload: HookPayload) =>
    applyEvent(state, { seq: ++seq, receivedAt: T0 + seq * 1_000, source: "hook", payload: { session_id: sid, ...payload } } as HookEnvelope);
  function board(): GraphState {
    let s = initialState();
    s = send(s, "blocked", { hook_event_name: "SessionStart", cwd: "/home/dev/blocked" });
    s = send(s, "blocked", { hook_event_name: "UserPromptSubmit", prompt: "build" });
    s = send(s, "blocked", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "make" } });
    s = send(s, "blocked", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" } as HookPayload);
    s = send(s, "ended", { hook_event_name: "SessionStart", cwd: "/home/dev/ended" });
    s = send(s, "ended", { hook_event_name: "UserPromptSubmit", prompt: "fix it" });
    s = send(s, "ended", { hook_event_name: "Stop" } as HookPayload);
    s = send(s, "ended", { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" } as HookPayload);
    s = send(s, "busy", { hook_event_name: "SessionStart", cwd: "/home/dev/busy" });
    s = send(s, "busy", { hook_event_name: "UserPromptSubmit", prompt: "test" });
    s = send(s, "busy", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "npm test" } });
    s = send(s, "fresh", { hook_event_name: "SessionStart", cwd: "/home/dev/fresh" });
    return s;
  }
  const rootOf = (s: GraphState, sid: string) => [...s.agents.values()].find(a => a.kind === "root" && a.sessionId === sid)!;

  it("is Done's tick for a turn that ended, where the header's own glyph is the hollow ring", () => {
    const s = board();
    expect(rowGlyphOf(rootOf(s, "ended"))).toBe("done");
    expect(rowGlyphOf(rootOf(s, "blocked"))).toBe("waiting");
    expect(rowGlyphOf(rootOf(s, "busy"))).toBe("working");
    expect(rowGlyphOf(rootOf(s, "fresh"))).toBe("idle");
  });

  it("is the very mark the list draws for each row", () => {
    const s = board();
    const rows = buildRows(s, T0 + 60_000);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect([r.sessionId, rowGlyphOf(rootOf(s, r.sessionId))]).toEqual([r.sessionId, railGlyph(r, rank(r))]);
  });

  it("is drawn in the tab in place of the header's glyph, and the state word stays the header's", () => {
    const v = view();
    const out = html(props({ tabs: { ...v, items: [{ ...v.items[0]!, mark: "done" }, v.items[1]!] } }));
    const tabs = tags(out, "tab");
    expect(out.split('role="tab"')[1]).toContain('data-glyph="done"');
    expect(out.split('role="tab"')[2]).toContain('data-glyph="waiting"');
    expect(tabs).toHaveLength(2);
  });
});

describe("the first-run line, true of the ✕ beside it", () => {
  it("says ✕ closes the tab in a pane with tabs, empties the pane in one without, and closes the Command Panel on the Board", () => {
    expect(firstRunClause(true, true)).toBe(en["board.keys.firstWorkspaceTab"]);
    expect(firstRunClause(true, false)).toBe(en["board.keys.firstWorkspace"]);
    expect(firstRunClause(true)).toBe(en["board.keys.firstWorkspace"]);
    expect(firstRunClause(false, true)).toBe(en["board.keys.firstBoard"]);
    for (const k of ["board.keys.firstWorkspaceTab", "board.keys.firstWorkspace", "board.keys.firstBoard"] as const) expect(en[k]).toMatch(/keeps running/);
  });
});
