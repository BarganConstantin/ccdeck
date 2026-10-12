// Nothing on the bar moves because a panel opened or Browser watch found
// something (2026-10-08).
//
// The bar the redesign replaced moved twice over. An open panel drew an edge
// and a fill on its button, and Browser watch's unread count arrived inline
// after its word, so every control left of it slid by the count's width — a
// bar that shifts while the reader is aiming at it. With the panel toggles on
// the window's edges the bar holds no panel toggle at all, and the unread count
// is the last thing in the last button of its stripe.
//
// Measured in headless Brave at 1440 on a demo deck: every control on the bar
// and on both stripes stood where it was with three panels open (0px), and
// with one unread finding only Browser watch's own button grew, at its foot,
// by the badge and the gap before it (24px); nothing else moved.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { railItems } from "../rail-items";
import { EdgeRail } from "../components/EdgeRails";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const app = sourceOf("App.tsx");
const header = app.slice(app.indexOf('<header className="topbar">'), app.indexOf("</header>"));

const noop = () => {};
const ref = () => ({ current: null });
const items = (watchUnseen: number) => railItems({
  providers: { kind: "reported", claude: true, codex: true } as never,
  sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
  usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
  setUsageHistoryOpen: noop, watchOn: false, watchUnseen, setBrowserWatchOpen: noop, openSettings: noop,
  onFeedback: noop, toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() } as never,
});

describe("the bar holds nothing a panel changes", () => {
  it("draws no panel toggle: only Settings and Feedback, which open dialogs", () => {
    expect(header).toContain("<UtilityRun items={rails.utilities} />");
    expect(header).not.toMatch(/rails\.left|rails\.right|<EdgeRail|<EdgeDock/);
    const utilities = items(0).utilities;
    expect(utilities.map(i => i.id)).toEqual(["settings", "feedback"]);
    for (const u of utilities) {
      expect(u.kind, u.id).toBe("dialog");
      expect(u.open, u.id).toBeUndefined();
    }
  });

  it("keeps the waiting queue's box mounted while nothing waits, so the ribbon after it stays put", () => {
    // Mounted whenever the stripes are, not when somebody waits: the box takes
    // the bar's free room either way, and the ribbon after it stands in one
    // place whether or not a session is waiting.
    expect(header).toMatch(/\{!phone && \(\s*<WaitingNames /);
    expect(header).not.toMatch(/waitingSessions\.length > 0 && \(\s*<WaitingNames/);
  });
});

describe("an unread finding moves nothing but its own button's foot", () => {
  it("is the last thing in the last button of the right stripe", () => {
    const right = items(1).right;
    const last = right[right.length - 1];
    expect(last[last.length - 1].id).toBe("browser-watch");
    const html = renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Right panels", groups: right }));
    // The badge closes the button, and the button closes the stripe.
    expect(html).toMatch(/<span class="rail-badge" aria-hidden="true">1<\/span><\/button><\/div><\/div>$/);
    expect(renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Right panels", groups: items(0).right })))
      .not.toContain("rail-badge");
  });

  it("is laid out in its button's column, not pinned over a neighbour", () => {
    // In flow after the word on a stripe, so the button grows down by its
    // height; only in the dock, where a button is a fixed 48px cell, does it
    // sit on the glyph's corner, absolutely, and grow nothing.
    const stripeBadge = /\n\.rail-badge \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(stripeBadge).not.toMatch(/position:/);
    expect(css).toMatch(/\.rail-btn-stripe \{[^}]*flex-direction: column;/);
    expect(css).toMatch(/\.rail-btn-dock \.rail-badge \{[^}]*position: absolute;/);
  });
});
