// V4's command menu (⌘K / Ctrl+K): the box, the field, the rows, the groups
// in V4's order, the Tab jump between groups and the foot. How it looks drawn
// is checked in a browser; this pins the numbers and the rules, and that the
// regrouping lost no command and no kind of result.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { sheetText } from "./sheet-source";
import type { RailItem } from "../components/EdgeRails";
import type { RailItems } from "../rail-items";
import type { Row } from "../components/SessionList";
import { GROUP_ORDER, flatGroupRows, groupQuick, jumpGroup, quickKeyAction, rankQuick, type QuickItem, type QuickKeyEvent } from "../quick-open";
import { quickOpenItems } from "../quick-open-items";
import { indexFor } from "../settings-search";
import QuickOpen from "../components/QuickOpen";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const source = read("../components/QuickOpen.tsx");
const en = read("../i18n/areas/board/en.ts");

/** The value of `prop` in the first rule written for exactly this selector. */
function decl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  const m = rule && new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(rule[1]);
  return m ? m[1].trim() : null;
}

describe("the box", () => {
  it("is 600 wide and at most 432 high, in V4's overlay frame, near the top", () => {
    expect(decl(".qo", "width")).toBe("min(600px, calc(100vw - 32px))");
    expect(decl(".qo", "max-height")).toMatch(/^min\(432px,/);
    expect(decl(".qo", "border-radius")).toBe("var(--r-overlay)");
    expect(decl(".qo", "border")).toBe("1px solid var(--line)");
    expect(decl(".qo", "background")).toBe("var(--panel)");
    // CHANGED ON PURPOSE (V4's Figma): the menu's own two drop shadows, 28 at 0,12 .38 and 4 at
    // 0,2 .28, not the dialog's one; Light takes them at its overlay's and contact's strength.
    expect(decl(".qo", "box-shadow")).toBe("0 12px 28px rgba(0,0,0,0.38), 0 2px 4px rgba(0,0,0,0.28)");
    expect(decl(':root[data-color-scheme="light"] .qo', "box-shadow")).toBe("0 12px 28px rgba(0,0,0,0.16), 0 2px 4px rgba(15,23,42,0.10)");
    expect(decl(".qo-backdrop", "padding")).toBe("max(13vh, 64px) 16px 16px");
  });

  it("never runs past the bottom of a short window: the backdrop's own offsets come off the viewport", () => {
    const cap = "min(432px, calc(100dvh - max(13vh, 64px) - 16px))";
    expect(decl(".qo", "max-height")).toBe(cap);
    // The offsets in the cap are the backdrop's top and bottom padding.
    expect(decl(".qo-backdrop", "padding")).toBe("max(13vh, 64px) 16px 16px");
    // 1440 x 900: 900 - max(117, 64) - 16 = 767, so 432 holds. 844 x 390: 390 - 64 - 16 = 310 fits.
    expect(Math.min(432, 900 - Math.max(0.13 * 900, 64) - 16)).toBe(432);
    expect(Math.min(432, 390 - Math.max(0.13 * 390, 64) - 16)).toBe(310);
    expect(css).toMatch(/@media \(max-width: 640px\) \{[^@]*\.qo \{ max-height: min\(432px, calc\(100dvh - 16px\)\); \}/);
  });

  it("lets the list be shorter when little matches, up to 360", () => {
    expect(decl(".qo-list", "max-height")).toBe("360px");
    expect(decl(".qo-list", "height")).toBeNull();
    expect(decl(".qo-list", "padding")).toBe("4px 12px");
  });
});

describe("the field", () => {
  it("is 40 high with a 12 gutter, an 8 gap, a 14 icon and the rule under it", () => {
    expect(decl(".qo-field", "height")).toBe("40px");
    expect(decl(".qo-field", "padding")).toBe("0 12px");
    expect(decl(".qo-field", "gap")).toBe("8px");
    expect(decl(".qo-field", "border-bottom")).toBe("1px solid var(--line)");
    expect(decl(".qo-field > .glyph", "width")).toBe("14px");
    expect(decl(".qo-field > .glyph", "height")).toBe("14px");
  });

  it("types 14 on a 20 line, with the muted placeholder V4 words", () => {
    expect(decl(".qo-input", "font-size")).toBe("calc(14px + var(--ui-text-increase, 0px))");
    expect(decl(".qo-input", "line-height")).toBe("20px");
    expect(decl(".qo-input::placeholder", "color")).toBe("var(--muted)");
    expect(en).toContain('"board.quick.placeholder": "Open a session or run a command"');
  });

  // CHANGED ON PURPOSE (V4's Figma): no ring on the field. The caret (--accent) and the rule
  // under the field mark where the keys go: the rule takes --accent while the input holds focus,
  // as the deck's other text fields turn their edge. The corner that kept the old ring uncut went with it.
  it("draws no ring on the field: the caret and the rule under it mark focus", () => {
    expect(decl(".qo-field:has(.qo-input:focus-visible)", "outline")).toBeNull();
    expect(decl(".qo-field:has(.qo-input:focus-visible)", "border-bottom-color")).toBe("var(--accent)");
    expect(decl(".qo-input:focus-visible", "outline")).toBe("none");
    expect(decl(".qo-input", "caret-color")).toBe("var(--accent)");
    expect(decl(".qo-field", "border-radius")).toBeNull();
  });
});

describe("the rows", () => {
  it("are 32 high, r6, 8 inside and 8 apart, and the selected one takes the selected fill", () => {
    expect(decl(".qo-row", "height")).toBe("32px");
    expect(decl(".qo-row", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".qo-row", "padding")).toBe("0 8px");
    expect(decl(".qo-row", "gap")).toBe("8px");
    expect(decl('.qo-row[aria-selected="true"]', "background")).toBe("var(--selected)");
  });

  it("draw a 14 icon with no tile, a 13 label and a 12 muted secondary text after it", () => {
    expect(decl(".qo-icon", "width")).toBe("14px");
    expect(decl(".qo-icon", "background")).toBeNull();
    expect(decl(".qo-title", "font-size")).toBe("calc(13px + var(--ui-text-increase, 0px))");
    expect(decl(".qo-title", "line-height")).toBe("20px");
    expect(decl(".qo-sub", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(".qo-sub", "color")).toBe("var(--muted)");
  });

  it("draw a session's state as the rail row's 14px glyph, working in --inflight, and hold it still", () => {
    const html = renderToStaticMarkup(createElement(QuickOpen, {
      items: [item("session:a", "sessions", "api", { tone: "working" }), item("session:b", "sessions", "web", { tone: "waiting" })],
      onClose: noop, onRun: noop,
    }));
    expect(html).toContain('<svg class="qo-state" data-kind="working" width="14" height="14"');
    expect(html).toContain('<svg class="qo-state" data-kind="waiting" width="14" height="14"');
    expect(html).not.toContain("qo-dot");
    expect(decl(".qo-icon > .qo-state", "width")).toBe("14px");
    expect(decl('.qo-state[data-kind="working"]', "color")).toBe("var(--inflight)");
    expect(decl('.qo-state[data-kind="waiting"]', "color")).toBe("var(--warn)");
    expect(decl('.qo-state[data-kind="done"]', "color")).toBe("var(--ok)");
    expect(decl('.qo-state[data-kind="error"]', "color")).toBe("var(--err)");
    expect(decl('.qo-state[data-kind="idle"]', "color")).toBe("var(--muted)");
    expect(css).not.toMatch(/\.qo-state[^{]*\{[^}]*animation/);
  });

  it("put the key chip on the right, after any drawn tag", () => {
    expect(source.indexOf("qo-tag")).toBeLessThan(source.indexOf('className="qo-key"'));
    expect(decl(".qo-tag", "position")).toBe("absolute");
    expect(decl(".qo-tag.state", "position")).toBe("static");
  });

  it("take 40 high under a coarse pointer, and keep 32 for the mouse", () => {
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.qo-row \{ height: 40px; \}/);
    expect(decl(".qo-row", "height")).toBe("32px");
  });

  it("draw the chosen row with an outline in forced colours", () => {
    // The deck answers forced colours in one block at the end of the sheet.
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/\n\s*\.qo-row\[aria-selected="true"\] \{ outline: 2px solid Highlight;/);
  });

  it("show the group names in V4's caption style", () => {
    expect(decl(".qo-caption", "height")).toBe("24px");
    expect(decl(".qo-caption", "padding")).toBe("0 8px");
    expect(decl(".qo-caption", "color")).toBe("var(--text-secondary)");
    expect(decl(".qo-caption", "font-weight")).toBe("600");
  });
});

describe("the foot", () => {
  it("is 32 high on the soft fill with a rule over it, 12 inside", () => {
    expect(decl(".qo-foot", "height")).toBe("32px");
    expect(decl(".qo-foot", "background")).toBe("var(--bg-soft)");
    expect(decl(".qo-foot", "border-top")).toBe("1px solid var(--line)");
    expect(decl(".qo-foot", "padding")).toBe("0 12px");
  });

  // CHANGED ON PURPOSE (V4's Figma): the foot is Tab's jump and what Enter does; the arrows and
  // the count are gone from it. The count is still said to a screen reader as a query narrows.
  it("says Tab jumps between groups and what Enter does, at the two ends", () => {
    expect(source).toContain('t("board.quick.tabKey")');
    expect(source).toContain('t("board.quick.tabHint")');
    expect(en).toContain('"board.quick.tabHint": "jumps between groups"');
    expect(source).not.toContain("<kbd>↑</kbd><kbd>↓</kbd>");
    expect(source).not.toContain("qo-foot-count");
    expect(en).not.toContain('"board.quick.move"');
    expect(source).toContain("<kbd>↵</kbd> <span>{activeRow.item.verb}</span>");
    expect(source).toMatch(/className="qo-live" role="status">\{query\.trim\(\) \? t\("board\.quick\.results\.count"/);
    expect(decl(".qo-foot-run", "margin-left")).toBe("auto");
    const html = renderToStaticMarkup(createElement(QuickOpen, { items: [item("action:fit", "actions", "Fit")], onClose: noop, onRun: noop }));
    const foot = html.slice(html.indexOf('class="qo-foot"'));
    expect(foot).toContain("jumps between groups");
    expect(foot).not.toContain("↑");
    expect(foot.slice(0, foot.indexOf('class="qo-live"'))).not.toMatch(/\d+ results?/);
  });
});

// ── the groups ──────────────────────────────────────────────────────────────

const noop = () => {};
function item(id: string, section: QuickItem["section"], title: string, extra: Partial<QuickItem> = {}): QuickItem {
  return { id, section, title, tag: "Tag", verb: "Open", run: noop, ...extra };
}

describe("the groups", () => {
  // CHANGED ON PURPOSE (V4's Figma): Start is a group again, between Sessions and Do, now that
  // the deck can start a session from the menu (where the Command Panel is on).
  it("are Needs you, Sessions, Start, Do, with the rest after Do", () => {
    expect(GROUP_ORDER).toEqual(["recent", "needs", "sessions", "start", "do", "open", "settings", "themes"]);
    expect(en).toContain('"board.quick.group.needs": "Needs you"');
    expect(en).toContain('"board.quick.section.start": "Start"');
    expect(en).toContain('"board.quick.group.do": "Do"');
  });

  const items = [
    item("session:a", "sessions", "api", { tone: "working" }),
    item("session:b", "sessions", "web-api", { tone: "waiting" }),
    item("session:c", "sessions", "infra", { tone: "error" }),
    item("action:fit", "actions", "Fit every agent on screen"),
    item("door:usage", "open", "Usage"),
    item("settings:section:sounds", "settings", "Sounds"),
  ];

  it("name starting a session in the field, and list Start, only where the menu can start one", () => {
    const plain = renderToStaticMarkup(createElement(QuickOpen, { items: [item("action:fit", "actions", "Fit")], onClose: noop, onRun: noop }));
    expect(plain).toContain('placeholder="Open a session or run a command"');
    expect(plain).not.toContain(">Start</div>");
    const start = [item("start:claude", "start", "New Claude session"), item("action:fit", "actions", "Fit")];
    const withStart = renderToStaticMarkup(createElement(QuickOpen, { items: start, onClose: noop, onRun: noop }));
    expect(withStart).toContain('placeholder="Open a session, start one, or run a command"');
    expect(withStart.indexOf(">Start</div>")).toBeLessThan(withStart.indexOf(">Do</div>"));
    expect(groupQuick(rankQuick([...items, ...start], ""), false).map(g => g.group)).toEqual(["needs", "sessions", "start", "do", "open", "settings"]);
  });

  it("put a session that needs you in Needs you and the others in Sessions", () => {
    const groups = groupQuick(rankQuick(items, ""), false);
    expect(groups.map(g => g.group)).toEqual(["needs", "sessions", "do", "open", "settings"]);
    expect(groups[0].items.map(r => r.item.id)).toEqual(["session:b"]);
    expect(groups[1].items.map(r => r.item.id)).toEqual(["session:a", "session:c"]);
    expect(groups[2].items.map(r => r.item.id)).toEqual(["action:fit"]);
  });

  it("keep the order of the best answers while typing, still splitting out who needs you", () => {
    const groups = groupQuick(rankQuick(items, "api"), true);
    expect(groups.map(g => g.group)).toEqual(["sessions", "needs"]);
    expect(flatGroupRows(groups).map(r => r.item.id).sort()).toEqual(["session:a", "session:b"]);
  });

  it("lose no row: every item the sections listed is in some group", () => {
    const sections = rankQuick(items, "");
    const before = sections.flatMap(s => s.items.map(r => r.item.id)).sort();
    const after = flatGroupRows(groupQuick(sections, false)).map(r => r.item.id).sort();
    expect(after).toEqual(before);
  });

  it("send a waiting session to Needs you even when it was opened lately, and draw it once", () => {
    const groups = groupQuick(rankQuick(items, "", ["session:b", "door:usage"]), false);
    expect(groups.map(g => g.group)).toEqual(["recent", "needs", "sessions", "do", "settings"]);
    expect(groups[0].items.map(r => r.item.id)).toEqual(["door:usage"]);
    expect(groups.find(g => g.group === "needs")?.items.map(r => r.item.id)).toEqual(["session:b"]);
    expect(flatGroupRows(groups).filter(r => r.item.id === "session:b")).toHaveLength(1);
  });

  it("keep a failed session in Sessions, where the rail's alarm signal puts it", () => {
    const groups = groupQuick(rankQuick(items, ""), false);
    expect(groups.find(g => g.group === "sessions")?.items.map(r => r.item.id)).toContain("session:c");
  });

  it("list the recent ones first, as an extra group", () => {
    const groups = groupQuick(rankQuick(items, "", ["door:usage"]), false);
    expect(groups[0].group).toBe("recent");
    expect(groups[0].items.map(r => r.item.id)).toEqual(["door:usage"]);
  });
});

describe("Tab between groups", () => {
  const groups = groupQuick(rankQuick([
    item("session:b", "sessions", "web-api", { tone: "waiting" }),
    item("session:a", "sessions", "api"),
    item("session:c", "sessions", "docs"),
    item("action:fit", "actions", "Fit"),
    item("action:pause", "actions", "Pause"),
  ], ""), false);
  // rows: 0 web-api | 1 api, 2 docs | 3 fit, 4 pause

  it("goes to the first row of the next group, wrapping", () => {
    expect(jumpGroup(groups, 0, 1)).toBe(1);
    expect(jumpGroup(groups, 2, 1)).toBe(3);
    expect(jumpGroup(groups, 4, 1)).toBe(0);
  });

  it("goes to the first row of the previous group with Shift+Tab, wrapping", () => {
    expect(jumpGroup(groups, 4, -1)).toBe(1);
    expect(jumpGroup(groups, 2, -1)).toBe(0);
    expect(jumpGroup(groups, 0, -1)).toBe(3);
  });

  it("does nothing with no rows", () => {
    expect(jumpGroup([], -1, 1)).toBe(-1);
  });

  it("stays on the one group's first row when there is only one", () => {
    const one = groupQuick(rankQuick([item("action:fit", "actions", "Fit"), item("action:pause", "actions", "Pause")], ""), false);
    expect(jumpGroup(one, 1, 1)).toBe(0);
    expect(jumpGroup(one, 1, -1)).toBe(0);
  });

  // The suite has no DOM to mount the dialog in, so the field's key handler
  // is the pure quickKeyAction the component calls; it is driven with events
  // that record what the dialog's window-level focus trap would have to see.
  function press(key: string, extra: Partial<QuickKeyEvent> = {}) {
    return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  }

  it("Tab moves the selection to the next group's first row and keeps the event from the focus trap", () => {
    const e = press("Tab");
    expect(quickKeyAction(e, groups, 0)).toEqual({ to: 1 });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("Shift+Tab moves to the previous group's first row, wrapping", () => {
    const e = press("Tab", { shiftKey: true });
    expect(quickKeyAction(e, groups, 0)).toEqual({ to: 3 });
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("swallows Tab with nothing listed too, so focus never leaves the field for Esc", () => {
    for (const shiftKey of [false, true]) {
      const e = press("Tab", { shiftKey });
      expect(quickKeyAction(e, [], -1)).toBeNull();
      expect(e.preventDefault).toHaveBeenCalled();
      expect(e.stopPropagation).toHaveBeenCalled();
    }
  });

  it("leaves the browser's Ctrl+Tab and Alt+Tab alone", () => {
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      const e = press("Tab", extra);
      expect(quickKeyAction(e, groups, 0)).toBeNull();
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(e.stopPropagation).not.toHaveBeenCalled();
    }
  });

  it("keeps the arrows, Page keys, Ctrl-N, Enter, and lets typing through", () => {
    expect(quickKeyAction(press("ArrowDown"), groups, 4)).toEqual({ to: 0 });
    expect(quickKeyAction(press("ArrowUp"), groups, 0)).toEqual({ to: 4 });
    expect(quickKeyAction(press("n", { ctrlKey: true }), groups, 0)).toEqual({ to: 1 });
    expect(quickKeyAction(press("PageDown"), groups, 0)).toEqual({ to: 4 });
    expect(quickKeyAction(press("Enter"), groups, 0)).toBe("run");
    const typing = press("a");
    expect(quickKeyAction(typing, groups, 0)).toBeNull();
    expect(typing.preventDefault).not.toHaveBeenCalled();
  });

  it("is what the field's onKeyDown calls, and the combobox names the shortcut", () => {
    expect(source).toContain("quickKeyAction(e, groups, active)");
    expect(source).toContain('aria-keyshortcuts="Tab Shift+Tab"');
    expect(source).toContain("useModalDismiss(");
  });
});

// ── nothing was dropped ─────────────────────────────────────────────────────

function door(id: string, extra: Partial<RailItem> = {}): RailItem {
  return { id, label: id, short: id, ariaLabel: id, glyph: null, kind: "panel", onPress: vi.fn(), ...extra };
}

describe("every command and result kind is still found", () => {
  const rails = {
    left: [door("session-list", { label: "Sessions", open: true })],
    leftStripe: [],
    capacity: [door("account-capacity", { label: "Capacity", kind: "dialog" })],
    right: [[door("usage", { label: "Usage" })]],
    integrations: [],
    explore: [],
    utilities: [door("settings", { label: "Settings", kind: "dialog" })],
    search: door("quick-open", { label: "Search", kind: "dialog" }),
  } as unknown as RailItems;
  const row = (sessionId: string, o: Partial<Row>) => ({ sessionId, state: "active" as const, label: sessionId, cwdBasename: "api", waiting: null, ...o }) as unknown as Row;
  const all = quickOpenItems({
    rails,
    sessions: [row("web-api", { waiting: { kind: "permission", since: 40_000 } as Row["waiting"] }), row("data-pipeline", {})],
    now: 100_000, openSession: vi.fn(), settings: indexFor(true), openSettings: vi.fn(), singleKeys: true,
    fit: vi.fn(), rearrange: vi.fn(), paused: false, togglePause: vi.fn(), clear: vi.fn(), keyHelp: vi.fn(), tour: vi.fn(),
    theme: "rider-black", setTheme: vi.fn(),
  });
  const found = (query: string) => flatGroupRows(groupQuick(rankQuick(all, query), true)).map(r => r.item.id);

  it("a query finds the same row through the groups as through the sections", () => {
    for (const query of ["web", "data", "usage", "capacity", "fit", "arrange", "pause", "keys", "tour", "clear", "rider", "sound"]) {
      const bySection = rankQuick(all, query).flatMap(s => s.items.map(r => r.item.id));
      expect(found(query).sort(), query).toEqual(bySection.sort());
      expect(found(query).length, query).toBeGreaterThan(0);
    }
  });

  it("keeps every kind: each item in the full list comes out of the grouping when its title is typed", () => {
    const kinds = new Set<string>();
    for (const it of all) {
      expect(found(it.title), it.id).toContain(it.id);
      kinds.add(it.id.split(":")[0]);
    }
    expect([...kinds].sort()).toEqual(["action", "door", "session", "settings", "theme"]);
  });

  it("lists every item an empty field shows, whole, through the groups", () => {
    const sections = rankQuick(all, "");
    const groups = groupQuick(sections, false);
    expect(flatGroupRows(groups).map(r => r.item.id).sort()).toEqual(sections.flatMap(s => s.items.map(r => r.item.id)).sort());
    expect(groups.map(g => g.group)).toEqual(["needs", "sessions", "do", "open", "settings"]);
  });

  it("draws the kind as secondary text where a group mixes kinds (Recent, Panels and dialogs), and a state anywhere", () => {
    const html = renderToStaticMarkup(createElement(QuickOpen, { items: all, onClose: noop, onRun: noop }));
    const tagsIn = (caption: string) => {
      const start = html.indexOf(`>${caption}</div>`);
      const end = html.indexOf("qo-caption", start + 1);
      return [...html.slice(start, end < 0 ? undefined : end).matchAll(/class="(qo-tag[^"]*)"/g)].map(m => m[1]);
    };
    expect(tagsIn("Sessions")).not.toHaveLength(0);
    expect(tagsIn("Sessions").every(c => c === "qo-tag")).toBe(true);
    expect(tagsIn("Do").every(c => c === "qo-tag")).toBe(true);
    expect(tagsIn("Panels and dialogs")).not.toHaveLength(0);
    expect(tagsIn("Panels and dialogs").every(c => c === "qo-tag state")).toBe(true);
    expect(html).toContain('aria-keyshortcuts="Tab Shift+Tab"');
  });

  it("sends the session that waits on you to Needs you, as the rail's signal says", () => {
    const groups = groupQuick(rankQuick(all, ""), false);
    expect(groups.find(g => g.group === "needs")?.items.map(r => r.item.id)).toEqual(["session:web-api"]);
    expect(groups.find(g => g.group === "sessions")?.items.map(r => r.item.id)).toEqual(["session:data-pipeline"]);
  });

  it("keeps a panel's Shown and the current theme as drawn states", () => {
    expect(all.find(i => i.id === "door:session-list")?.tagIsState).toBe(true);
    expect(all.find(i => i.id === "theme:rider-black")?.tagIsState).toBe(true);
    expect(all.find(i => i.id === "door:usage")?.tagIsState).toBeUndefined();
  });
});
