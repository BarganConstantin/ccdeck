// Feedback's corner (V4). Feedback sat straight after Search in the bar's end
// group, and read as part of the search. The bar's top-right corner is its own
// cell now: as wide as the right stripe under it, with the stripe's line rising
// through the bar beside it, the button on the stripe's column, and Search
// ending 8 short of the line. In the desktop app on Windows and Linux the OS's
// window buttons own the corner, so the cell stands just before them; on a
// phone the cell is the end of the phone's bar and More drops its Feedback row,
// so there is one entry on every size. The button is the one it was: its name,
// its hint, its unread count and its press.
//
// Read from the sources and the sheet, the way the suite reads them; the
// cascade is sheet-cascade.ts's, at the widths the frames use.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cascade, el, selects, type El } from "./sheet-cascade";
import { sourceOf } from "./client-source";
import { railItems } from "../rail-items";
import { UtilityRun, railHint } from "../components/EdgeRails";

const noop = () => {};
const ref = () => ({ current: null });
const rails = (feedbackUnread?: number) => railItems({
  providers: { kind: "reported", claude: true, codex: true },
  sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
  usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
  setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
  openSettings: noop, onFeedback: noop, toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
  openQuickOpen: noop, feedbackUnread, openFeedbackConversations: noop,
});

const app = sourceOf("App.tsx");
const header = app.slice(app.indexOf('<header className="topbar">'), app.indexOf("</header>"));

const root = (attrs: Record<string, string> = {}) => el("html", [], { states: ["root"], attrs });
const barChain = (attrs?: Record<string, string>): El[] => [root(attrs), el("body"), el("div", ["app"]), el("header", ["topbar"])];
const cellChain = (attrs?: Record<string, string>): El[] => [...barChain(attrs), el("div", ["tb-corner"])];
const buttonChain = (attrs?: Record<string, string>): El[] => [...cellChain(attrs), el("div", ["utility-run"]),
  el("button", ["rail-btn", "rail-btn-bar", "rail-btn-icon"], { attrs: { type: "button", "data-rail-item": "feedback" } })];
const of = (chain: El[]) => (prop: string, width: number) => cascade(s => selects(s, chain), prop, width);
const cell = of(cellChain());
const bar = of(barChain());
const button = of(buttonChain());
const px = (v: string | null) => {
  expect(v, "a px length").toMatch(/^-?\d+(?:\.\d+)?px$/);
  return parseFloat(v!);
};
/** One side of a 1-to-4-value shorthand: top, right, bottom, left. */
const side = (v: string | null, i: 0 | 1 | 2 | 3) => {
  const parts = (v ?? "").split(/\s+/);
  const four = [parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0], parts[3] ?? parts[1] ?? parts[0]];
  return four[i] === "0" ? 0 : px(four[i]);
};

describe("where App draws it", () => {
  it("is its own cell after the end group, on every size, and the next stop after Search", () => {
    const search = header.indexOf("<UtilityRun items={[rails.search]} />");
    const corner = header.indexOf('<div className="tb-corner"><UtilityRun items={[rails.corner]} /></div>');
    expect(search).toBeGreaterThan(-1);
    expect(corner).toBeGreaterThan(search);
    // Outside the group and outside any phone guard: the phone's bar holds it too.
    expect(header.indexOf("</ReadoutGroup>")).toBeLessThan(corner);
    expect(header).not.toMatch(/\{!?phone && <div className="tb-corner">/);
    expect(header).not.toContain("rails.topUtilities");
  });

  it("is the button it was: Feedback, an icon, named Send feedback, hinted Feedback, opening a dialog", () => {
    const r = rails();
    expect(r.corner.id).toBe("feedback");
    expect(r.corner.barLook).toBe("icon");
    const html = renderToStaticMarkup(createElement(UtilityRun, { items: [r.corner] }));
    expect(html).toContain('class="rail-btn rail-btn-bar rail-btn-icon"');
    expect(html).toContain('aria-label="Send feedback"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("rail-word");
    expect(railHint(r.corner, true, false)?.label).toBe("Feedback");
    // Its unread replies: the count on the button, and in its name.
    const unread = renderToStaticMarkup(createElement(UtilityRun, { items: [rails(2).corner] }));
    expect(unread).toContain('aria-label="Feedback, 2 unread conversations"');
    expect(unread).toContain('<span class="rail-badge" aria-hidden="true">2</span>');
  });

  it("leaves the phone's More, so Feedback has one entry on every size", () => {
    expect(app).toContain("...rails.explore, ...rails.utilities.filter(item => item !== rails.corner)]}");
    // Quick open still lists it, by name, as it lists every door.
    expect(sourceOf("quick-open-items.tsx")).toContain("...src.rails.utilities,");
    expect(rails().utilities.map(i => i.id)).toEqual(["settings", "feedback"]);
  });
});

describe("the cell at 1440 wide", () => {
  const W = 1440;
  const edge = of([root(), el("body"), el("div", ["edge-rail", "edge-rail-right"])]);

  it("is as wide as the right stripe and draws the stripe's line through the bar", () => {
    expect(cell("width", W)).toBe("var(--edge-w)");
    expect(cascade(s => selects(s, [root()]), "--edge-w", W)).toBe("40px");
    expect(cell("border-left", W)).toBe("1px solid var(--line)");
    expect(edge("border-left", W)).toBe("1px solid var(--line)");
    expect(cell("flex", W)).toBe("none");
    expect(cell("align-self", W)).toBe("stretch");
    expect(cell("box-sizing", W)).toBe("border-box");
  });

  it("reaches the window's edge, so its line is the stripe's at 1400 and its button the stripe's doors' 1406", () => {
    const margin = cell("margin", W);
    const padding = cell("padding", W);
    // The bar's end padding, given back by the cell's right margin.
    expect(side(bar("padding", W), 1) + side(margin, 1)).toBe(0);
    const line = W - 40;
    expect(line).toBe(1400);
    // The stripe keeps a pixel on its outer side so its 28 doors sit 6 in from
    // the line; the cell keeps the same pixel, so its button does too.
    expect(side(padding, 1)).toBe(1);
    expect(px(button("width", W))).toBe(28);
    const contentLeft = line + 1;
    const contentWidth = 40 - 1 - side(padding, 1);
    expect(contentLeft + (contentWidth - 28) / 2).toBe(1406);
    expect(cell("justify-content", W)).toBe("center");
  });

  it("stands 8 after Search, the end group's own gap, and the end group takes the free space before it", () => {
    expect(px(bar("gap", W)) + side(cell("margin", W), 3)).toBe(8);
    expect(cascade(s => selects(s, [...barChain(), el("div", ["tb-end"])]), "margin-left", W)).toBe("auto");
    expect(cascade(s => selects(s, [...barChain(), el("div", ["tb-end"])]), "gap", W)).toBe("8px");
  });

  it("rises over the bar's top pixel to meet the window's top, and gives it back so the button stays on whole pixels", () => {
    expect(side(bar("padding", W), 0)).toBe(1);
    expect(side(cell("margin", W), 0)).toBe(-1);
    expect(side(cell("padding", W), 0)).toBe(1);
    // At Compact's 40: the cell is 0 to 39, its content 1 to 39, the 28 button 6 to 34.
    expect(1 + (40 - 1 - 1 - 28) / 2).toBe(6);
  });
});

describe("the cell on a phone", () => {
  const W = 390;

  it("has no stripe beside it, so no line, and the frame's 32 button 8 from the edge", () => {
    expect(cell("width", W)).toBe("auto");
    expect(cell("border-left", W)).toBe("0");
    expect(cell("padding", W)).toBe("0");
    expect(side(bar("padding", W), 1) + side(cell("margin", W), 1)).toBe(8);
    expect(button("width", W)).toBe("32px");
    expect(button("height", W)).toBe("32px");
    expect(button("border-radius", W)).toBe("var(--r-panel)");
  });

  it("is a 44 target around the 32 button", () => {
    // A pseudo-element is past what selects() reads, so the one rule is named.
    const target = (s: string) => (s === ".tb-corner .rail-btn-bar.rail-btn-icon::after" ? 31 : null);
    const after = cascade(target, "inset", W);
    expect(cascade(target, "inset", 1440)).toBeNull();
    expect(32 - 2 * px(after)).toBe(44);
  });

  it("keeps its count on the button's corner, the phone frame's 1 down and 2 out", () => {
    const badge = of([...buttonChain(), el("span", ["rail-badge"])]);
    expect(badge("top", W)).toBe("1px");
    expect(badge("right", W)).toBe("-2px");
    expect(badge("background", W)).toBe("var(--accent)");
    expect(badge("top", 1440)).toBe("-1px");
    expect(badge("right", 1440)).toBe("-3px");
  });
});

describe("the cell in the desktop app", () => {
  const chrome = { "data-desktop-chrome": "true" };

  it("stands just before the OS's window buttons on Windows and Linux, and in the window's corner on macOS", () => {
    // The bar keeps the OS's buttons' width and 6 more; the cell reaches over
    // the 6, so it ends where the OS's buttons begin.
    const winBar = of(barChain(chrome))("padding-right", 1440);
    expect(winBar).toBe("calc(100vw - env(titlebar-area-width, calc(100vw - 144px)) + 6px)");
    expect(of(cellChain(chrome))("margin-right", 1440)).toBe("-6px");
    // macOS draws its traffic lights on the left: the bar keeps 6 on the right,
    // and the cell takes the corner over the right stripe.
    const mac = { ...chrome, "data-desktop-platform": "darwin" };
    expect(of(barChain(mac))("padding-right", 1440)).toBe("6px");
    expect(of(cellChain(mac))("margin-right", 1440)).toBe("-6px");
  });
});
