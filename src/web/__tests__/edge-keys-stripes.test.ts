// The panel toggles on the window's edges (2026-10-08): what each stripe is to
// assistive tech, what each button discloses or opens, that the keys did not
// move with the buttons, and that the left stripe is the left column's.
//
// The toggles used to stand in one row at the top right, whatever side their
// panel opened on. Each edge owns its own now (components/EdgeRails.tsx,
// rail-items.tsx): the left stripe holds Session list and Accounts, which share
// the left column; the right one holds Usage and Machine, the two rail panels,
// then History and Browser watch, which open as dialogs; the phone draws one
// dock along the bottom instead. These are show/hide toggles beside one
// canvas, not tabs: several can be open at once and the canvas never leaves.
//
// Drawn with renderToStaticMarkup; no DOM.
import { describe, expect, it } from "vitest";
import { EdgeDock, EdgeRail } from "../components/EdgeRails";
import { attr, buttons, createElement, draw, items } from "./edge-keys-rails";
import { sourceOf } from "./client-source";

type State = Parameters<typeof items>[0];
const left = (state: State = {}) => draw(createElement(EdgeRail, { side: "left", label: "Left column", groups: [items(state).left] }));
const right = (state: State = {}) => draw(createElement(EdgeRail, { side: "right", label: "Right panels", groups: items(state).right }));
const dock = (state: State = {}) => {
  const c = items(state);
  return draw(createElement(EdgeDock, { items: [...c.left, ...c.right[0], c.utilities[0]], more: [...c.right[1], c.utilities[1]] }));
};
const opening = (html: string) => /^<div\b[^>]*>/.exec(html)![0];
const ids = (html: string) => [...buttons(html).keys()];

describe("each stripe is a toolbar, and the dock is one", () => {
  it("names the stripes, says they run vertically, and gives each one Tab stop", () => {
    // The APG toolbar: one stop for the whole set, the arrows inside it. The
    // first button is the stop; the rest are reached by Up and Down.
    for (const [html, name] of [[left(), "Left column"], [right(), "Right panels"]] as const) {
      const tag = opening(html);
      expect(attr(tag, "role"), name).toBe("toolbar");
      expect(attr(tag, "aria-label"), name).toBe(name);
      expect(attr(tag, "aria-orientation"), name).toBe("vertical");
      const stops = [...buttons(html).values()].map(b => attr(b, "tabindex"));
      expect(stops[0], name).toBe("0");
      expect(stops.slice(1).every(t => t === "-1"), name).toBe(true);
    }
  });

  it("lays the dock out the other way, with its More in the same single stop", () => {
    const html = dock();
    const tag = opening(html);
    expect(attr(tag, "role")).toBe("toolbar");
    expect(attr(tag, "aria-label")).toBe("Panels and tools");
    // Horizontal is a toolbar's default, so it is not said.
    expect(attr(tag, "aria-orientation")).toBeNull();
    expect([...buttons(html).values()].filter(b => attr(b, "tabindex") === "0")).toHaveLength(1);
    // Accounts first since 2026-10-08, the owner's order for the left stripe,
    // which the dock draws from the same list.
    expect(ids(html)).toEqual(["accounts", "session-list", "usage", "machine", "settings", "more"]);
    const more = buttons(html).get("more")!;
    expect(attr(more, "aria-haspopup")).toBe("menu");
    expect(attr(more, "aria-expanded")).toBe("false");
  });

  it("walks the arrows of its own orientation, and Home and End", () => {
    const src = sourceOf("components/EdgeRails.tsx");
    expect(src).toMatch(/const NEXT_KEYS = \{ vertical: "ArrowDown", horizontal: "ArrowRight" \} as const;/);
    expect(src).toMatch(/const PREV_KEYS = \{ vertical: "ArrowUp", horizontal: "ArrowLeft" \} as const;/);
    expect(src).toMatch(/else if \(e\.key === "Home"\) to = 0;/);
    expect(src).toMatch(/else if \(e\.key === "End"\) to = buttons\.length - 1;/);
    expect(src).toMatch(/useRoving\(items\.flat\(\)\.length, "vertical"\)/);
    expect(src).toMatch(/useRoving\(items\.length \+ 1, "horizontal"\)/);
  });
});

describe("what each button is to assistive tech", () => {
  it("puts the left column's two on the left, and the rest on the right in their two groups", () => {
    // Accounts at the top, then Session list (the owner's order, 2026-10-08).
    expect(ids(left())).toEqual(["accounts", "session-list"]);
    expect(ids(right())).toEqual(["usage", "machine", "history", "browser-watch"]);
    expect([...right().matchAll(/<div class="rail-group">/g)]).toHaveLength(2);
  });

  it("makes the four panels disclosures: aria-expanded, and aria-controls only while the panel is there", () => {
    const panels: Array<[string, keyof NonNullable<State>, string]> = [
      ["session-list", "sessionListOpen", "session-list"],
      ["accounts", "accountsPanelOpen", "accounts-panel"],
      ["usage", "usagePanelOpen", "usage-panel"],
      ["machine", "machinePanelOpen", "system-panel"],
    ];
    for (const [id, state, region] of panels) {
      const stripe = id === "session-list" || id === "accounts" ? left : right;
      const shut = buttons(stripe()).get(id)!;
      expect(attr(shut, "aria-expanded"), id).toBe("false");
      expect(attr(shut, "aria-controls"), id).toBeNull();
      expect(attr(shut, "aria-haspopup"), id).toBeNull();
      const open = buttons(stripe({ [state]: true })).get(id)!;
      expect(attr(open, "aria-expanded"), id).toBe("true");
      expect(attr(open, "aria-controls"), id).toBe(region);
      // And the same in the dock, where the same panel opens.
      expect(attr(buttons(dock({ [state]: true })).get(id)!, "aria-controls"), `dock ${id}`).toBe(region);
    }
  });

  it("says aria-haspopup=\"dialog\" on the four that open a modal, and claims no state", () => {
    const c = items();
    const drawn = buttons(draw(createElement("div", null,
      createElement(EdgeRail, { side: "right", label: "Right panels", groups: c.right }),
      createElement(EdgeRail, { side: "left", label: "x", groups: [c.utilities] }),
    )));
    for (const id of ["history", "browser-watch", "settings", "feedback"]) {
      expect(attr(drawn.get(id)!, "aria-haspopup"), id).toBe("dialog");
      expect(drawn.get(id)!, id).not.toMatch(/aria-expanded|aria-pressed|aria-controls/);
    }
  });

  it("can be open several at once — they are toggles beside the canvas, not tabs", () => {
    // A tab strip selects one page and hides the rest; these show or hide
    // panels next to a canvas that never leaves (PRODUCT.md: "One canvas. No
    // tabs."). No tab roles, and two rail panels open at once both say so.
    const both = buttons(right({ usagePanelOpen: true, machinePanelOpen: true }));
    expect(attr(both.get("usage")!, "aria-expanded")).toBe("true");
    expect(attr(both.get("machine")!, "aria-expanded")).toBe("true");
    for (const html of [left(), right(), dock()]) {
      expect(html).not.toMatch(/role="tab|aria-selected|role="tablist/);
    }
  });

  it("carries Browser watch's unread count in its name, its badge drawn for the eye alone", () => {
    const watch = buttons(right({ watchUnseen: 2, watchOn: true })).get("browser-watch")!;
    expect(attr(watch, "aria-label")).toBe("Browser watch, watching, 2 unread");
    expect(right({ watchUnseen: 2 })).toMatch(/<span class="rail-badge" aria-hidden="true">2<\/span>/);
    expect(right()).not.toMatch(/rail-badge/);
  });
});

describe("the keys did not move with the buttons", () => {
  // Every key reaches the same setter the button presses: L and A the left
  // column's two toggles, U, S, H and B the panels' and dialogs' own.
  const keys = sourceOf("use-deck-shortcuts.ts");
  const rails = sourceOf("rail-items.tsx");
  const pairs: Array<[string, RegExp, RegExp]> = [
    ["L", /if \(e\.key === "l" \|\| e\.key === "L"\) toggleSessionList\(\);/, /onPress: toggleSessionList,/],
    ["A", /if \(e\.key === "a" \|\| e\.key === "A"\) \{ if \(providersRef\.current\.claude\) toggleAccountsPanel\(\); \}/, /onPress: toggleAccountsPanel,/],
    ["U", /if \(e\.key === "u" \|\| e\.key === "U"\) setUsagePanelOpen\(o => !o\);/, /onPress: \(\) => setUsagePanelOpen\(o => !o\),/],
    ["S", /if \(e\.key === "s" \|\| e\.key === "S"\) setMachinePanelOpen\(o => !o\);/, /onPress: \(\) => setMachinePanelOpen\(o => !o\),/],
    ["H", /if \(e\.key === "h" \|\| e\.key === "H"\) setUsageHistoryOpen\(o => !o\);/, /onPress: \(\) => setUsageHistoryOpen\(o => !o\),/],
    ["B", /if \(e\.key === "b" \|\| e\.key === "B"\) setBrowserWatchOpen\(o => !o\);/, /onPress: \(\) => setBrowserWatchOpen\(o => !o\),/],
  ];
  it("binds L, A, U, S, H and B to the setters the stripe buttons press", () => {
    for (const [cap, key, press] of pairs) {
      expect(keys, `${cap}'s handler`).toMatch(key);
      expect(rails, `${cap}'s button`).toMatch(press);
    }
  });
});

describe("Accounts, and the left column it shares", () => {
  it("is gone without Claude Code — from the stripe and from the dock — rather than present and inert", () => {
    expect(ids(left({ claude: false }))).toEqual(["session-list"]);
    expect(ids(dock({ claude: false }))).not.toContain("accounts");
    expect(ids(dock({ claude: true }))).toContain("accounts");
  });

  it("opens through the left column's own toggles, the only two that can open either, and each evicts the other", () => {
    // The eviction itself is use-left-column.ts's and left-column-824.test.ts
    // runs it; what this pins is that the stripe reaches the panels through
    // those toggles and nothing else, so it cannot draw both into one slot.
    expect(sourceOf("App.tsx")).toMatch(/railItems\(\{\s*providers, sessionListOpen, toggleSessionList, accountsPanelOpen, toggleAccountsPanel,/);
    const column = sourceOf("use-left-column.ts");
    expect(column).toMatch(/const toggleSessionList = useCallback\(\(\) => \{\s*setSessionListOpen\(open => \{[\s\S]*?if \(!open\) setAccountsPanelOpen\(/);
    expect(column).toMatch(/const toggleAccountsPanel = useCallback\(\(\) => \{[\s\S]*?if \(!open\) setSessionListOpen\(false\);/);
  });
});
