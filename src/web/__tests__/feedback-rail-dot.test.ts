// The Feedback button's unread mark (feedback conversations, design 4.5): while
// a ccdeck account's conversations hold a reply nobody has read, the topbar's
// Feedback says how many in its name and its hint, and opens the dialog on Your
// conversations. CHANGED ON PURPOSE (V4): its corner cell has the room for the
// number, so the mark is a 14px count in the accent where the dot sat, on
// every size; the phone's More no longer lists Feedback. A dot behind More
// still shows for any door that wears one. Without an account — or with
// nothing unread — it is the button it always was. The mark is the accent;
// amber stays the waiting count's.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { feedbackUnreadDoor, railItems } from "../rail-items";
import { EdgeDock, UtilityRun } from "../components/EdgeRails";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const edges = strip(read("../styles/edge-rails.css"));
const rails = read("../components/EdgeRails.tsx");

const noop = () => {};
const ref = () => ({ current: null });
const opened: string[] = [];
const items = (feedbackUnread?: number, watchUnseen = 0) => railItems({
  providers: { kind: "reported", claude: true, codex: true },
  sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
  usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
  setUsageHistoryOpen: noop, watchOn: false, watchUnseen, setBrowserWatchOpen: noop,
  openSettings: noop, onFeedback: () => opened.push("write"), toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
  openQuickOpen: noop, feedbackUnread, openFeedbackConversations: () => opened.push("conversations"),
});
// The corner cell as App.tsx draws it, on the desktop and the phone alike.
const bar = (unread?: number) => renderToStaticMarkup(createElement(UtilityRun, { items: [items(unread).corner] }));
// No door App puts behind More wears a dot today: Feedback, the one that did,
// has its corner and its count. More still carries a dot for a door that does,
// so this one is Feedback's dot without the count its corner adds.
const dock = (unread?: number, watchUnseen = 0) => {
  const r = items(unread, watchUnseen);
  const dotted = { ...r.corner, badge: undefined };
  return renderToStaticMarkup(createElement(EdgeDock, {
    items: [...r.left, ...r.right[0], r.utilities[0]], more: [...r.right.slice(1).flat(), dotted],
  }));
};
const buttonNamed = (html: string, name: string) => {
  const at = html.indexOf(`aria-label="${name}`);
  expect(at, name).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", at), html.indexOf("</button>", at));
};

describe("Feedback on the topbar", () => {
  it("is the button it always was with nothing unread, or no account at all", () => {
    for (const unread of [undefined, 0]) {
      const button = buttonNamed(bar(unread), "Send feedback");
      expect(button).not.toContain("rail-dot");
      expect(button).not.toContain("rail-badge");
    }
    expect(feedbackUnreadDoor(0)).toEqual({});
  });

  it("wears the count, hidden from the tree, and says it in its name too", () => {
    // CHANGED ON PURPOSE (V4): the count where the dot was, and no dot with it.
    const one = buttonNamed(bar(1), "Feedback, 1 unread conversation");
    expect(one).toMatch(/<span class="rail-badge" aria-hidden="true">1<\/span>$/);
    expect(one).not.toContain("rail-dot");
    expect(buttonNamed(bar(3), "Feedback, 3 unread conversations")).toMatch(/<span class="rail-badge" aria-hidden="true">3<\/span>$/);
    expect(items(3).corner.detail).toBe("3 unread");
    // The door it was keeps its dot and its words: the corner adds the number.
    expect(feedbackUnreadDoor(3)).toMatchObject({ dot: true, detail: "3 unread" });
  });

  it("opens on Your conversations while it shows the dot, and on Write otherwise", () => {
    opened.length = 0;
    items(2).utilities[1].onPress();
    items(0).utilities[1].onPress();
    items().utilities[1].onPress();
    expect(opened).toEqual(["conversations", "write", "write"]);
  });
});

describe("a dot behind the phone's More", () => {
  it("is not Feedback's: More has no Feedback row, its corner on the bar is its one entry", () => {
    const app = read("../App.tsx");
    expect(app).toMatch(/\.\.\.rails\.utilities\.filter\(item => item !== rails\.corner\)\]\}/);
    expect(app).toContain('<div className="tb-corner"><UtilityRun items={[rails.corner]} /></div>');
  });

  it("puts the dot on More while no count does, and says the count on the door's row", () => {
    const more = buttonNamed(dock(2), "More:");
    expect(more).toMatch(/aria-label="More: Usage history, Browser watch, not watching, Feedback, 2 unread conversations"/);
    expect(more).toMatch(/<span class="rail-dot" aria-hidden="true"><\/span>$/);
    expect(buttonNamed(dock(0), "More:")).not.toContain("rail-dot");
    expect(rails).toMatch(/item\.dot && item\.detail \? `\$\{item\.menu \?\? item\.label\} · \$\{item\.detail\}`/);
  });

  it("lets a count behind More stand alone: one mark, the number", () => {
    const more = buttonNamed(dock(2, 4), "More:");
    expect(more).toMatch(/<span class="rail-badge" aria-hidden="true">4<\/span>$/);
    expect(more).not.toContain("rail-dot");
  });
});

describe("the dot itself", () => {
  const rule = (sel: string) => [...edges.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, s]) => s.trim() === sel)?.[2] ?? "";

  it("is a 6px accent disc, never amber and never the resting grey it would vanish on", () => {
    const dot = rule(".rail-dot");
    expect(dot).toMatch(/width: 6px;/);
    expect(dot).toMatch(/height: 6px;/);
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a dot is the pill token.
    expect(dot).toMatch(/border-radius: var\(--r-pill\);/);
    expect(dot).toMatch(/background: var\(--accent\);/);
    expect(dot).not.toMatch(/--warn|--muted/);
    expect(edges).not.toMatch(/--warn/);
  });

  it("sits on the glyph's corner on the bar and in the dock, as a badge does", () => {
    expect(rule(".rail-btn-bar .rail-dot")).toMatch(/top: .*left: /s);
    // CHANGED ON PURPOSE (V4's Figma phone frame): the glyph is 12 under the
    // dock's border now, so the dot on its corner is 10 down, not 8.
    expect(edges).toMatch(/\.rail-btn-dock \.rail-dot \{ top: 10px; left: calc\(50% \+ 5px\); \}/);
  });

  it("becomes a 14px count in the accent on Feedback's corner, never the resting grey or amber", () => {
    const count = rule(".tb-corner .rail-badge");
    expect(count).toMatch(/position: absolute;/);
    expect(count).toMatch(/top: -1px;\s*right: -3px;/);
    expect(count).toMatch(/min-width: 14px;\s*height: 14px;\s*padding: 0 4px;/);
    expect(count).toMatch(/background: var\(--accent\);\s*color: var\(--bg\);/);
    expect(count).toMatch(/font-size: calc\(11px \+ max\(-1px, var\(--ui-text-increase, 0px\)\)\);\s*font-weight: 400;/);
    expect(count).toMatch(/line-height: calc\(14px \+ var\(--ui-text-increase, 0px\)\);/);
    expect(count).not.toMatch(/--warn|--muted/);
    // A forced-colours theme redraws every count, this one with them.
    expect(read("../styles/touch-and-forced-colours.css")).toMatch(/\.rail-badge \{ forced-color-adjust: none; background: CanvasText; color: Canvas; \}/);
  });

  it("is redrawn in a forced-colours theme, in the one block that is last", () => {
    const forced = read("../styles/touch-and-forced-colours.css");
    expect(forced).toMatch(/\.rail-dot, \.fc-dot, \.fc-tab\[aria-selected="true"\]::after \{ forced-color-adjust: none; background: Highlight; \}/);
    const sheet = read("../styles.css");
    expect(sheet.trimEnd().split("\n").at(-1)).toContain("touch-and-forced-colours.css");
  });
});
