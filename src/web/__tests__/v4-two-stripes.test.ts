// V4's two stripes (V4's Figma): a door stays on the side where its panel
// opens, so the eye never crosses the canvas to find what it opened.
//
// Pinned here: each stripe's order and runs (with and without Claude, on a
// Codex-only deck, with a tracker connected); Radio and Settings in the left
// foot and no foot on the right; the Inspector's door, first on the right
// stripe (its key, aria-expanded in each place, what it controls, and that a
// press is what D does there); the corner tab gone with the header's padding
// back; the hint's side from each stripe; the open line's side in the sheet;
// two toolbars of one Tab stop each; the 40 the right stripe takes from the
// canvas; the floating panels standing clear of it; and the phone's dock, which
// no stripe touches.
//
// The order and the runs are rail-items.tsx's data; the look is read out of the
// sheet; what a bare-node suite cannot see (what App draws) is pinned at the
// source.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { railItems } from "../rail-items";
import { EdgeDock, EdgeRail, railHint } from "../components/EdgeRails";
import { INSPECTOR_REGION_ID, inspectorDoorOpen, inspectorDoorPress } from "../inspector-corner";
import { sheetRules } from "./sheet-cascade";
import { sheetText } from "./sheet-source";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const source = (p: string) => readFileSync(here(p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const rules = sheetRules();
function decl(selector: string, prop: string, media: string | null = null): string | undefined {
  let found: string | undefined;
  for (const r of rules) {
    if (r.media !== media || !r.selectors.includes(selector)) continue;
    const m = [...r.body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].at(-1);
    if (m) found = m[1].trim();
  }
  return found;
}

const noop = () => {};
const ref = () => ({ current: null });
const base = {
  sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
  usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
  setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
  setTrafficRadarOpen: noop, setRadioOpen: noop, openToolActivity: noop, openCapacity: noop,
  openSettings: noop, onFeedback: noop, openQuickOpen: noop, openExploreIntegrations: noop,
  toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
};
type Over = Partial<Parameters<typeof railItems>[0]>;
const make = (providers: { claude: boolean; codex: boolean }, over: Over = {}) =>
  railItems({ ...base, providers: { kind: "reported", ...providers }, ...over });
const ids = (group: { id: string }[]) => group.map(i => i.id);

const RIGHT_ALL = [
  ["inspector"],
  ["usage", "machine"],
  ["history", "tool-activity", "skill-activity"],
  ["browser-watch", "traffic-radar"],
];

describe("each stripe's order and runs", () => {
  it("Claude with Codex: Sessions, Accounts | capacity, calendar | Explore on the left; Inspector | Usage, Machine | records | watchers on the right", () => {
    const r = make({ claude: true, codex: true });
    expect(r.leftStripe.map(ids)).toEqual([["session-list", "accounts"], ["account-capacity", "reset-calendar"], ["explore-integrations"]]);
    expect(r.rightStripe.map(ids)).toEqual(RIGHT_ALL);
  });

  it("Claude alone is the same", () => {
    const r = make({ claude: true, codex: false });
    expect(r.leftStripe.map(ids)).toEqual([["session-list", "accounts"], ["account-capacity", "reset-calendar"], ["explore-integrations"]]);
    expect(r.rightStripe.map(ids)).toEqual(RIGHT_ALL);
  });

  it("without Claude, on a Codex-only deck, Codex's door stands beside Sessions and the Claude capacity run is gone", () => {
    const r = make({ claude: false, codex: true });
    expect(r.leftStripe.map(ids)).toEqual([["session-list", "codex-accounts"], ["explore-integrations"]]);
    expect(r.rightStripe.map(ids)).toEqual(RIGHT_ALL);
  });

  it("with neither CLI the left stripe is Sessions alone and Explore, and the right one is unchanged", () => {
    const r = make({ claude: false, codex: false });
    expect(r.leftStripe.map(ids)).toEqual([["session-list"], ["explore-integrations"]]);
    expect(r.rightStripe.map(ids)).toEqual(RIGHT_ALL);
  });

  it("a connected tracker is its own run on the left, ahead of Explore, and never on the right", () => {
    const Glyph = () => null;
    const r = make({ claude: true, codex: false }, {
      integrations: [{ provider: { kind: "jira", label: "Jira", Glyph, shortcut: "j", detail: { key: "x" } as never }, onPress: noop }],
    });
    expect(r.leftStripe.map(ids)).toEqual([
      ["session-list", "accounts"], ["account-capacity", "reset-calendar"], ["integration-jira"], ["explore-integrations"],
    ]);
    expect(r.rightStripe.map(ids)).toEqual(RIGHT_ALL);
  });

  it("every door is on one stripe only, and the phone's own grouping still has them all but the Inspector", () => {
    const r = make({ claude: true, codex: true });
    const placed = [...r.leftStripe.flat(), ...r.leftFoot, ...r.rightStripe.flat()].map(i => i.id);
    expect(new Set(placed).size).toBe(placed.length);
    // The phone's dock is built from `left` and `right`, which this change did not touch.
    expect(r.right.map(ids)).toEqual([["usage", "machine"], ["history", "tool-activity", "skill-activity"], ["browser-watch", "traffic-radar"], ["radio"]]);
    expect(r.right.flat().map(i => i.id)).not.toContain("inspector");
  });

  it("puts Radio and Settings in the left foot, and gives the right stripe no foot", () => {
    const r = make({ claude: true, codex: true });
    expect(ids(r.leftFoot)).toEqual(["radio", "settings"]);
    const right = renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Usage and activity", groups: r.rightStripe }));
    expect(right).not.toContain("rail-foot");
    expect(right).not.toContain('data-rail-item="radio"');
    expect(right).not.toContain('data-rail-item="settings"');
    const left = renderToStaticMarkup(createElement(EdgeRail, { side: "left", label: "Panels and tools", groups: r.leftStripe, foot: r.leftFoot }));
    expect(left).toMatch(/class="rail-foot"[\s\S]*data-rail-item="radio"[\s\S]*data-rail-item="settings"/);
  });

  it("keeps every key it had, each on the stripe it moved to", () => {
    const r = make({ claude: true, codex: true });
    const keys = Object.fromEntries([...r.leftStripe.flat(), ...r.leftFoot, ...r.rightStripe.flat()].map(i => [i.id, i.key?.cap]));
    expect(keys).toMatchObject({ "session-list": "L", accounts: "A", usage: "U", machine: "S", history: "H", "browser-watch": "B", inspector: "D" });
  });
});

describe("the Inspector's door", () => {
  const door = (over: Over = {}) => make({ claude: true, codex: false }, over).rightStripe[0][0];

  it("is first on the right stripe, alone in its run, a panel door on the kit's info icon", () => {
    const d = door();
    expect(d).toMatchObject({ id: "inspector", kind: "panel", label: "Show the Inspector", ariaLabel: "Show the Inspector" });
    expect(source("../components/rail-glyphs.tsx")).toContain('export const InspectorGlyph = () => <KitIcon name="info" className="glyph" />;');
    expect(d.group).toBeUndefined();
  });

  it("answers D, a single key, and names 'Show the Inspector' with it in its hint", () => {
    const d = door();
    expect(d.key).toEqual({ cap: "D", aria: "D", single: true });
    expect(railHint(d, true, false)).toEqual({ label: "Show the Inspector", keys: "D", detail: undefined });
    // With the single-key shortcuts off the hint keeps the name and drops the key.
    expect(railHint(d, false, false)).toEqual({ label: "Show the Inspector", keys: undefined, detail: undefined });
  });

  it("reads Open (aria-expanded true) and controls the Inspector's region while it shows", () => {
    const open = make({ claude: true, codex: false }, { inspectorOpen: true });
    const html = renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Usage and activity", groups: open.rightStripe }));
    const button = /<button[^>]*data-rail-item="inspector"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toContain('aria-expanded="true"');
    expect(button).toContain(`aria-controls="${INSPECTOR_REGION_ID}"`);
    expect(button).toContain('aria-keyshortcuts="D"');
    expect(button).not.toContain("aria-haspopup");
    const closed = make({ claude: true, codex: false });
    const html2 = renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Usage and activity", groups: closed.rightStripe }));
    const button2 = /<button[^>]*data-rail-item="inspector"[^>]*>/.exec(html2)?.[0] ?? "";
    expect(button2).toContain('aria-expanded="false"');
    expect(button2).not.toContain("aria-controls");
  });

  it("is the id both Inspector asides carry, so what it controls is there whichever is drawn", () => {
    expect(INSPECTOR_REGION_ID).toBe("inspector");
    expect(source("../components/DetailAside.tsx")).toContain("id={INSPECTOR_REGION_ID}");
    expect(source("../components/Inspector.tsx")).toMatch(/<aside id=\{INSPECTOR_REGION_ID\} className="detail"/);
    expect(source("../rail-items.tsx")).toContain("controls: INSPECTOR_REGION_ID");
  });

  describe("reads Open in each place", () => {
    const at = (over: Partial<Parameters<typeof inspectorDoorOpen>[0]>) =>
      inspectorDoorOpen({ workspace: true, column: true, folded: false, shown: false, zoomed: false, ...over });

    it("at 1440 the column is the Inspector: open until it is folded, with or without a session", () => {
      expect(at({})).toBe(true);
      expect(at({ shown: true })).toBe(true);
      expect(at({ folded: true })).toBe(false);
    });

    it("at 1280 and 1100 the sheet is the Inspector: open only while it shows", () => {
      expect(at({ column: false })).toBe(false);
      expect(at({ column: false, shown: true })).toBe(true);
      expect(at({ column: false, folded: true })).toBe(false);
    });

    it("on the Board it is open while the detail panel shows, and never otherwise", () => {
      expect(at({ workspace: false, column: false })).toBe(false);
      expect(at({ workspace: false, column: false, shown: true })).toBe(true);
    });

    it("is never open under Zoom, which folds the panels away", () => {
      expect(at({ zoomed: true })).toBe(false);
      expect(at({ zoomed: true, shown: true })).toBe(false);
    });
  });

  describe("a press is what D does where it is pressed", () => {
    const press = (over: Partial<Parameters<typeof inspectorDoorPress>[0]>) =>
      inspectorDoorPress({ workspace: true, column: true, sheet: false, open: true, ...over });

    it("folds the column while it shows and gives it back while it is folded (1440)", () => {
      expect(press({ open: true })).toBe("fold");
      expect(press({ open: false })).toBe("show");
    });

    it("folds the sheet while it shows and opens it over the pane while it is folded (1280, 1100)", () => {
      expect(press({ column: false, sheet: true, open: true })).toBe("fold");
      expect(press({ column: false, sheet: true, open: false })).toBe("show");
    });

    it("on the Board, and under 1100, is exactly D", () => {
      expect(press({ workspace: false, column: false, sheet: false })).toBe("d");
      expect(press({ workspace: false, column: false, sheet: false, open: false })).toBe("d");
      // Workspace under 1100: neither the column nor the sheet.
      expect(press({ column: false, sheet: false })).toBe("d");
    });

    it("is wired in App to the same paths the keys take: fold, show, D", () => {
      const app = strip(source("../App.tsx"));
      const at = app.indexOf("const toggleInspector = useCallback(");
      const body = app.slice(at, app.indexOf("// A click on the switch crossfades", at));
      expect(body).toContain('if (press === "fold") foldInspector();');
      expect(body).toContain('else if (press === "show") showInspector();');
      // D's own two lines (use-deck-shortcuts.ts), word for word.
      expect(body).toContain("else if (primarySelectedIdRef.current) setDetailOpen(o => !o);");
      expect(body).toContain("else pickSessionForInspector(stateRef.current, focusSession, stepAgent);");
      expect(app).toContain("inspectorOpen, toggleInspector,");
    });

    it("keeps Escape and the fold paths: the sheet's Esc, ›, D and the door fold it; the pane's Esc is the agent's", () => {
      const shortcuts = strip(source("../use-deck-shortcuts.ts"));
      expect(shortcuts).toContain('inspectorSheetFoldRef?.current && el?.closest?.(".detail")');
      expect(shortcuts.indexOf("if (inTerminalPanel(el))")).toBeLessThan(shortcuts.indexOf('if (e.key === "Escape")'));
      expect(shortcuts).toContain("if (primarySelectedIdRef.current) setDetailOpen(o => !o);");
    });
  });
});

describe("the corner tab is gone", () => {
  it("has no component, no presence rule and no data attribute left", () => {
    expect(existsSync(here("../components/InspectorTab.tsx"))).toBe(false);
    const app = strip(source("../App.tsx"));
    expect(app).not.toMatch(/InspectorTab\b|inspectorTab\b|data-insp-tab/);
    expect(source("../inspector-corner.ts")).not.toContain("inspectorTabShown");
  });

  it("has no corner or tab rule in the sheet, and the header's right padding is back to its own 6", () => {
    const css = strip(sheetText());
    expect(css).not.toMatch(/\.insp-corner|\.insp-show|data-insp-tab/);
    // The rightmost pane header is its own full width: 0 6px 0 12px, no extra 36.
    expect(decl(".ts-head", "padding")).toBe("0 6px 0 12px");
    expect(css).not.toMatch(/\.ts-head \{[^}]*padding-right/);
    expect(css).not.toContain("padding-right: calc(6px + 36px)");
  });
});

describe("the hint opens towards the canvas", () => {
  const edge = source("../components/EdgeRails.tsx");
  const hint = source("../components/use-hint.tsx");

  it("opens right from the left stripe and left from the right one", () => {
    expect(edge).toContain('const RAIL_HINT_SIDE = { left: "right", right: "left" } as const;');
    expect(edge).toContain("useHint(RAIL_HINT_SIDE[side])");
  });

  it("stands 8 off the stripe's edge on the canvas side: its rect is right of the left stripe, left of the right one", () => {
    expect(hint).toContain("const GAP_PX = 8;");
    expect(hint).toContain("if (side === \"right\") return { left: box.right + GAP_PX, top: clampY(midY) };");
    expect(hint).toContain("if (side === \"left\") return { left: box.left - GAP_PX - w, top: clampY(midY) };");
    // The box a stripe's hint is placed against is the stripe's own edge on that side.
    expect(hint).toContain("new DOMRect(box.left, box.top, edge.right - box.left, box.height)");
    expect(hint).toContain("new DOMRect(edge.left, box.top, box.right - edge.left, box.height)");
  });
});

describe("the stripes' look", () => {
  it("draws the right stripe at the window's right edge with its --line on the left, facing the canvas", () => {
    expect(decl(".edge-rail-right", "right")).toBe("0");
    expect(decl(".edge-rail-right", "border-left")).toBe("1px solid var(--line)");
    expect(decl(".edge-rail-left", "left")).toBe("0");
    expect(decl(".edge-rail-left", "border-right")).toBe("1px solid var(--line)");
    // Both from under the top bar to the status bar.
    expect(decl(".edge-rail", "top")).toBe("var(--topbar-h)");
    expect(decl(".edge-rail", "bottom")).toBe("var(--status-room, 0px)");
  });

  it("puts an open door's 2px line on the side facing the canvas: right on the left stripe, left on the right one", () => {
    expect(decl(".edge-rail-left .rail-btn-stripe::before", "right")).toBe("-5px");
    expect(decl(".edge-rail-right .rail-btn-stripe::before", "left")).toBe("-5px");
    expect(decl(".edge-rail-right .rail-btn-stripe::before", "right")).toBeUndefined();
    expect(decl(".rail-btn-stripe::before", "width")).toBe("2px");
    expect(decl('.rail-btn-stripe[aria-expanded="true"]::before', "opacity")).toBe("1");
    // The same fill as the left one's open door.
    expect(decl('.rail-btn[aria-expanded="true"]', "background")).toBe("var(--selected)");
  });

  it("keeps the right stripe's border and open line visible in forced colours, in the one block", () => {
    const css = strip(sheetText());
    expect(css.match(/@media \(forced-colors: active\)/g)!.length).toBeGreaterThanOrEqual(1);
    // The line is a fill the theme would repaint Canvas: it takes Highlight on either stripe.
    expect(decl(".rail-btn-stripe::before", "background", "(forced-colors: active)")).toBe("Highlight");
    // The border is a real border, which forced colours keep.
    expect(decl(".edge-rail-right", "border-left")).toMatch(/^1px solid /);
  });

  it("runs both stripes' doors 2 apart with a 16 x 1 rule between runs, on either stripe", () => {
    expect(decl(".rail-doors .rail-group + .rail-group::before", "width")).toBe("16px");
    expect(decl(".rail-doors .rail-group + .rail-group::before", "height")).toBe("1px");
    expect(decl(".edge-rail .rail-group", "flex-shrink")).toBe("0");
    expect(decl(".edge-rail-right", "overflow-y")).toBe("auto");
  });

  it("uses tokens, not hex colours, in the stripes' rules", () => {
    const css = strip(source("../styles/edge-rails.css"));
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("the 40 the right stripe takes, and the panels clear of it", () => {
  it("takes --edge-w from the canvas on each side: the grid, the columns, the Inspector and the banners move in with .app", () => {
    expect(source("../styles/tokens.css")).toMatch(/--edge-w:\s*40px/);
    expect(decl(".app", "padding-inline")).toBe("var(--edge-w)");
    // The top bar and the status bar reach back out across both sides.
    expect(decl(".app > .topbar", "margin-inline")).toBe("calc(-1 * var(--edge-w))");
    expect(decl(".statusbar", "margin-inline")).toBe("calc(-1 * var(--edge-w))");
  });

  it("stands the floating Usage and Machine panels --edge-w clear of the window's edge", () => {
    expect(decl(".app", "--rail-r")).toBe("calc(var(--inspector-w) + 8px + var(--edge-w))");
    expect(decl(".app:not(:has(.detail))", "--rail-r")).toBe("calc(8px + var(--edge-w))");
    expect(decl(".usage-panel", "right")).toBe("var(--rail-r)");
    expect(decl(".sysdetail", "right")).toBe("var(--rail-r)");
  });

  it("stands the Workspace column's panels, the 1100 to 1319 sheet and Zoom's Inspector clear of it too", () => {
    const css = strip(source("../styles/workspace.css"));
    const flat = css.replace(/\s+/g, " ");
    expect(flat).toContain(':has(.detail) :is(.usage-panel, .sysdetail):not([data-place]) { top: var(--ws-head); right: var(--edge-w);');
    expect(flat).toMatch(/\.app\[data-view="workspace"\] \.detail \{ position: fixed; top: [^;]*; right: var\(--edge-w\);/);
    expect(flat).toMatch(/\.app\[data-view="workspace"\]\[data-zoom\] \.detail \{ position: fixed; top: [^;]*; right: var\(--edge-w\);/);
    // A sheet leaving rests off the window's edge, not over the stripe's door.
    expect(flat).toContain("transform: translateX(calc(100% + var(--edge-w)));");
    expect(flat).not.toMatch(/(?<![-\w])right: 0;/);
  });

  it("keeps a moved panel clear of both stripes, in the sheet and in the drag", () => {
    expect(decl(".app :is(.usage-panel, .sysdetail)[data-place]", "--place-side")).toBe("calc(var(--edge-w) + 8px)");
    const place = source("../panel-place.ts");
    expect(place).toContain('document.querySelector(".edge-rail-right")');
    expect(place).toContain("sideRight: right + 8");
  });
});

describe("two toolbars, one Tab stop each", () => {
  const r = make({ claude: true, codex: true });
  const left = renderToStaticMarkup(createElement(EdgeRail, { side: "left", label: "Panels and tools", groups: r.leftStripe, foot: r.leftFoot }));
  const right = renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Usage and activity", groups: r.rightStripe }));

  it("draws each stripe as its own vertical toolbar, named for what it holds", () => {
    for (const [html, name] of [[left, "Panels and tools"], [right, "Usage and activity"]] as const) {
      expect(html.match(/role="toolbar"/g)).toHaveLength(1);
      expect(html).toContain(`aria-label="${name}" aria-orientation="vertical"`);
    }
    expect(left).toContain("edge-rail-left");
    expect(right).toContain("edge-rail-right");
  });

  it("has exactly one door in the Tab order in each", () => {
    expect(left.match(/tabindex="0"/g)).toHaveLength(1);
    expect(right.match(/tabindex="0"/g)).toHaveLength(1);
    expect(left.match(/tabindex="-1"/g)).toHaveLength([...left.matchAll(/data-rail-item=/g)].length - 1);
    expect(right.match(/tabindex="-1"/g)).toHaveLength([...right.matchAll(/data-rail-item=/g)].length - 1);
  });

  it("moves the arrows, Home and End among its own doors only", () => {
    const edge = source("../components/EdgeRails.tsx");
    // The roving reads the buttons inside the toolbar the key was pressed in.
    expect(edge).toContain('e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-rail-item]")');
    expect(edge).toContain("const roving = useRoving(items.flat().length + foot.length, \"vertical\");");
    // One roving state per stripe: each EdgeRail has its own.
    expect(edge.match(/useRoving\(/g)!.length).toBe(3); // the declaration, a stripe, the dock
  });
});

describe("the phone keeps its one dock", () => {
  it("draws no stripe under 641px, and the dock from the same lists as before", () => {
    const app = strip(source("../App.tsx"));
    expect(app).toMatch(/\{phone\s*(?:\/\/[^\n]*\s*)*\?\s*<EdgeDock\s+items=\{\[\.\.\.rails\.left, \.\.\.rails\.right\[0\]\]\.map\(sessionsDoorUnderSheet\)\}/);
    expect(app).toContain("more={[rails.search, ...rails.capacity, ...rails.right.slice(1).flat(), ...rails.integrations, ...rails.explore, ...rails.utilities]}");
    expect(app).toMatch(/\{!phone && <EdgeRail side="right"/);
    // The stripes take nothing on a phone: --edge-w is 0 there.
    expect(decl(":root", "--edge-w", "(max-width: 640px)")).toBe("0px");
  });

  it("has the same five doors and More as before", () => {
    const r = make({ claude: true, codex: true });
    const html = renderToStaticMarkup(createElement(EdgeDock, {
      items: [...r.left, ...r.right[0]], more: [r.search, ...r.capacity, ...r.right.slice(1).flat(), ...r.integrations, ...r.explore, ...r.utilities],
    }));
    expect([...html.matchAll(/<span class="rail-word">([^<]*)<\/span>/g)].map(m => m[1])).toEqual(["Accounts", "Sessions", "Usage", "Machine", "More"]);
    expect(html).not.toContain('data-rail-item="inspector"');
  });
});
