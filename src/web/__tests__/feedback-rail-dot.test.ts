// The Feedback button's dot (feedback conversations, design 4.5): while a
// ccdeck account's conversations hold a reply nobody has read, the topbar's
// Feedback wears a small dot where a badge would sit, says how many in its
// name and its hint, and opens the dialog on Your conversations. On a phone the
// dock's More wears the dot while no count shows, and Feedback's row says the
// count. Without an account — or with nothing unread — it is the button it
// always was. The dot is the accent; amber stays the waiting count's.
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
const bar = (unread?: number) => renderToStaticMarkup(createElement(UtilityRun, { items: items(unread).utilities }));
const dock = (unread?: number, watchUnseen = 0) => {
  const r = items(unread, watchUnseen);
  return renderToStaticMarkup(createElement(EdgeDock, {
    items: [...r.left, ...r.right[0], r.utilities[0]], more: [...r.right.slice(1).flat(), r.utilities[1]],
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

  it("wears the dot, hidden from the tree, and says the count in its name instead", () => {
    const one = buttonNamed(bar(1), "Feedback, 1 unread conversation");
    expect(one).toMatch(/<span class="rail-dot" aria-hidden="true"><\/span>$/);
    expect(buttonNamed(bar(3), "Feedback, 3 unread conversations")).toContain("rail-dot");
    expect(items(3).utilities[1].detail).toBe("3 unread");
  });

  it("opens on Your conversations while it shows the dot, and on Write otherwise", () => {
    opened.length = 0;
    items(2).utilities[1].onPress();
    items(0).utilities[1].onPress();
    items().utilities[1].onPress();
    expect(opened).toEqual(["conversations", "write", "write"]);
  });
});

describe("Feedback behind the phone's More", () => {
  it("puts the dot on More while no count does, and says the count on Feedback's row", () => {
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
    expect(dot).toMatch(/border-radius: 50%;/);
    expect(dot).toMatch(/background: var\(--accent\);/);
    expect(dot).not.toMatch(/--warn|--muted/);
    expect(edges).not.toMatch(/--warn/);
  });

  it("sits on the glyph's corner on the bar and in the dock, as a badge does", () => {
    expect(rule(".rail-btn-bar .rail-dot")).toMatch(/top: .*left: /s);
    expect(edges).toMatch(/\.rail-btn-dock \.rail-dot \{ top: 8px; left: calc\(50% \+ 5px\); \}/);
  });

  it("is redrawn in a forced-colours theme, in the one block that is last", () => {
    const forced = read("../styles/touch-and-forced-colours.css");
    expect(forced).toMatch(/\.rail-dot, \.fc-dot, \.fc-tab\[aria-selected="true"\]::after \{ forced-color-adjust: none; background: Highlight; \}/);
    const sheet = read("../styles.css");
    expect(sheet.trimEnd().split("\n").at(-1)).toContain("touch-and-forced-colours.css");
  });
});
