// V4's two stripes (V4's Figma): a door stays on the side where its panel
// opens. The left stripe holds Sessions, Accounts, the capacity doors and the
// integrations, with Radio and Settings at its foot; the right one the
// Inspector, Usage and Machine, the records and the watchers, with no foot.
// Both 40 wide, doors in runs between 16x1 rules, Settings gone from the top
// bar. And V4's Tooltip: one line, 24 high, the name and a key chip.
//
// The order and the rules are rail-items.tsx's data; the look is read out of
// the sheet; what a bare-node suite cannot see (what App draws) is pinned at
// the source.
//
// CHANGED ON PURPOSE (V4's Figma): this file pinned ONE bar on the left, with
// every door in it and no right stripe. V4's Figma puts the doors back on two
// stripes, each on the side its panel opens; each test below that said "the
// bar" or "no right bar" now says the two-stripe answer, and the new
// v4-two-stripes.test.ts holds the rest (the Inspector door, the sides).
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { railItems } from "../rail-items";
import { EdgeRail } from "../components/EdgeRails";
import { sheetRules } from "./sheet-cascade";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const source = (p: string) => readFileSync(here(p), "utf8");
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
const rails = railItems({ ...base, providers: { kind: "reported", claude: true, codex: false } });
const ids = (group: { id: string }[]) => group.map(i => i.id);

describe("the stripes' doors, in V4's order", () => {
  // CHANGED ON PURPOSE (V4's Figma): one bar's six runs are now two stripes'.
  it("runs the left stripe Sessions, Accounts | capacity, calendar | Explore", () => {
    expect(rails.leftStripe.map(ids)).toEqual([
      ["session-list", "accounts"],
      ["account-capacity", "reset-calendar"],
      ["explore-integrations"],
    ]);
  });

  it("runs the right stripe Inspector | Usage, Machine | the three records | Browser watch, Radar", () => {
    expect(rails.rightStripe.map(ids)).toEqual([
      ["inspector"],
      ["usage", "machine"],
      ["history", "tool-activity", "skill-activity"],
      ["browser-watch", "traffic-radar"],
    ]);
  });

  it("puts Radio and Settings in the left foot, with no run of doors among them", () => {
    expect(ids(rails.leftFoot)).toEqual(["radio", "settings"]);
    const all = [...rails.leftStripe.flat(), ...rails.rightStripe.flat()].map(i => i.id);
    expect(all).not.toContain("radio");
    expect(all).not.toContain("settings");
  });

  it("keeps Settings out of the top bar, and Feedback in", () => {
    // CHANGED ON PURPOSE (V4): Feedback stands alone in the bar's corner cell.
    expect(rails.corner.id).toBe("feedback");
    const app = source("../App.tsx");
    expect(app).toContain("<UtilityRun items={[rails.search]} />");
    expect(app).toContain('<div className="tb-corner"><UtilityRun items={[rails.corner]} /></div>');
  });

  it("keeps a door the frame does not draw: Codex's own button, beside Sessions, where Codex is all there is", () => {
    const codexOnly = railItems({ ...base, providers: { kind: "reported", claude: false, codex: true } });
    // CHANGED ON PURPOSE (V4's Figma): the stripes are two lists now.
    expect(codexOnly.leftStripe.map(ids)).toEqual([
      ["session-list", "codex-accounts"],
      ["explore-integrations"],
    ]);
    expect(codexOnly.rightStripe.map(ids)).toEqual([
      ["inspector"],
      ["usage", "machine"],
      ["history", "tool-activity", "skill-activity"],
      ["browser-watch", "traffic-radar"],
    ]);
  });

  it("keeps a connected tracker in a run of its own, ahead of Explore", () => {
    const Glyph = () => null;
    const withJira = railItems({
      ...base, providers: { kind: "reported", claude: true, codex: false },
      integrations: [{ provider: { kind: "jira", label: "Jira", Glyph, shortcut: "j", detail: { key: "x" } as never }, onPress: noop }],
    });
    // CHANGED ON PURPOSE (V4's Figma): the tracker is on the left stripe's list.
    expect(withJira.leftStripe.slice(-2).map(ids)).toEqual([["integration-jira"], ["explore-integrations"]]);
  });

  it("keeps every key it had", () => {
    const keys = Object.fromEntries([...rails.leftStripe.flat(), ...rails.leftFoot, ...rails.rightStripe.flat()].map(i => [i.id, i.key?.cap]));
    expect(keys["session-list"]).toBe("L");
    expect(keys["accounts"]).toBe("A");
    expect(keys["usage"]).toBe("U");
    expect(keys["machine"]).toBe("S");
    expect(keys["history"]).toBe("H");
    expect(keys["browser-watch"]).toBe("B");
    expect(keys["settings"]).toBeTruthy();
  });
});

describe("the stripes' markup", () => {
  // CHANGED ON PURPOSE (V4's Figma): one toolbar on the left is two toolbars.
  const html = renderToStaticMarkup(createElement(EdgeRail, { side: "left", label: "Panels and tools", groups: rails.leftStripe, foot: rails.leftFoot }));
  const right = renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Usage and activity", groups: rails.rightStripe }));

  it("is a toolbar on the left, with the doors and the foot as its two groups", () => {
    expect(html.match(/role="toolbar"/g)).toHaveLength(1);
    expect(html).toContain('class="edge-rail edge-rail-left"');
    expect(html).not.toContain("edge-rail-right");
    expect(html).toMatch(/<div class="rail-doors">[\s\S]*<\/div><div class="rail-foot" role="group"/);
  });

  it("draws the doors in order and the foot last, Radio then Settings", () => {
    const order = [...html.matchAll(/data-rail-item="([^"]+)"/g)].map(m => m[1]);
    expect(order).toEqual([...rails.leftStripe.flat(), ...rails.leftFoot].map(i => i.id));
    expect(order.slice(-2)).toEqual(["radio", "settings"]);
  });

  it("draws the right stripe's doors in order, with no foot", () => {
    expect(right).toContain('class="edge-rail edge-rail-right"');
    expect(right).not.toContain("rail-foot");
    expect([...right.matchAll(/data-rail-item="([^"]+)"/g)].map(m => m[1])).toEqual(rails.rightStripe.flat().map(i => i.id));
  });

  it("names its runs for a screen reader and the foot by its two doors", () => {
    for (const name of ["Accounts and sessions", "Claude accounts"]) {
      expect(html).toContain(`role="group" aria-label="${name}"`);
    }
    for (const name of ["Usage and machine", "Activity history", "Watchers"]) {
      expect(right).toContain(`role="group" aria-label="${name}"`);
    }
    expect(html).toContain('class="rail-foot" role="group" aria-label="Radio, Settings"');
  });

  it("keeps a door's help line for assistive tech, off the tooltip", () => {
    expect(html).toMatch(/data-rail-item="account-capacity"[^>]*aria-description="[^"]+"/);
  });
});

describe("the stripes' look", () => {
  // CHANGED ON PURPOSE (V4's Figma): the 1px line sits on the side facing the
  // canvas, so the left stripe keeps it on the right and the right one has it on
  // the left; the 1px of padding is on the opposite side in each.
  it("is 40 wide, --panel, a 1px --line on the canvas side only, 6 of air top and foot, the groups pushed apart", () => {
    expect(source("../styles/tokens.css")).toMatch(/--edge-w:\s*40px/);
    expect(decl(".edge-rail", "width")).toBe("var(--edge-w)");
    expect(decl(".edge-rail", "background")).toBe("var(--panel)");
    expect(decl(".edge-rail", "justify-content")).toBe("space-between");
    // 1 on the side away from the canvas for the 1px border on the side facing
    // it: the doors centre on the whole 40, 6 in, where V4 draws them with its
    // edge inside the stripe.
    expect(decl(".edge-rail", "padding")).toBe("6px 0");
    expect(decl(".edge-rail-left", "padding-left")).toBe("1px");
    expect(decl(".edge-rail-right", "padding-right")).toBe("1px");
    expect(decl(".edge-rail-left", "border-right")).toBe("1px solid var(--line)");
    expect(decl(".edge-rail-left", "border-left")).toBeUndefined();
    expect(decl(".edge-rail-right", "border-left")).toBe("1px solid var(--line)");
    expect(decl(".edge-rail-right", "border-right")).toBeUndefined();
  });

  it("holds its doors and its foot 2 apart", () => {
    expect(decl(".rail-doors", "gap")).toBe("2px");
    expect(decl(".rail-group", "gap")).toBe("2px");
  });

  it("draws a door 28x28 with --r-ctl corners and a 14px glyph", () => {
    expect(decl(".rail-btn-stripe", "width")).toBe("28px");
    expect(decl(".rail-btn-stripe", "height")).toBe("28px");
    expect(decl(".rail-btn-stripe", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".rail-btn-stripe .glyph", "width")).toBe("14px");
  });

  it("draws the rule 16x1 in --line-soft, and the open line 2x16-ish at the bar's edge", () => {
    expect(decl(".rail-doors .rail-group + .rail-group::before", "width")).toBe("16px");
    expect(decl(".rail-doors .rail-group + .rail-group::before", "height")).toBe("1px");
    expect(decl(".rail-doors .rail-group + .rail-group::before", "background")).toBe("var(--line-soft)");
    expect(decl(".rail-btn-stripe::before", "width")).toBe("2px");
    expect(decl(".rail-btn-stripe::before", "border-radius")).toBe("1px");
    expect(decl(".rail-btn-stripe::before", "background")).toBe("var(--text)");
    expect(decl(".rail-btn[aria-expanded=\"true\"]", "background")).toBe("var(--selected)");
  });

  it("reserves both stripes' width: the canvas, the columns and the Inspector move in by 40 each side", () => {
    // CHANGED ON PURPOSE (V4's Figma): the right stripe takes its 40 back.
    expect(decl(".app", "padding-inline")).toBe("var(--edge-w)");
    expect(decl(".app", "padding-left")).toBeUndefined();
    expect(decl(".app > .topbar", "margin-inline")).toBe("calc(-1 * var(--edge-w))");
    expect(decl(".app", "--rail-r")).toBe("calc(var(--inspector-w) + 8px + var(--edge-w))");
  });

  it("makes the floating Usage and Machine panels 320 wide", () => {
    expect(decl(".usage-panel", "width")).toBe("calc(320px + var(--ui-panel-increase, 0px))");
    expect(decl(".sysdetail", "width")).toMatch(/^calc\(320px/);
  });
});

describe("V4's Tooltip", () => {
  it("is one 24-high line: --r-ctl corners, --panel, a 1px --line edge, 4 8 to its outer edge, --shadow-overlay", () => {
    expect(decl(".hint", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".hint", "background")).toBe("var(--panel)");
    // V4's 4 8 counts its stroke, drawn inside: the 1px --line edge is an inset
    // shadow over the padding, so a line of 16 makes 24, with or without a key,
    // and the padding is a step on the spacing ladder.
    expect(decl(".hint", "border")).toBe("0");
    expect(decl(".hint", "padding")).toBe("4px 8px");
    expect(decl(".hint:has(.hint-key)", "padding-right")).toBeUndefined();
    expect(decl(".hint", "box-shadow")).toBe("inset 0 0 0 1px var(--line), var(--shadow-overlay)");
    expect(decl(".hint", "line-height")).toMatch(/^calc\(16px/);
    expect(decl(".hint-head", "gap")).toBe("6px");
    expect(decl(".hint-right .hint-label", "white-space")).toBe("nowrap");
    expect(decl(".hint-left .hint-label", "white-space")).toBe("nowrap");
  });

  it("sets the label at 12/16 in --text", () => {
    expect(decl(".hint", "font-size")).toMatch(/^calc\(12px/);
    expect(decl(".hint", "color")).toBe("var(--text)");
  });

  it("draws the key as the kit's Kbd: 16 high, radius 4, --bg-soft, 1px --line, mono 11/14 500 --muted", () => {
    expect(decl(".hint-key", "height")).toBe("16px");
    // Its 5 across counts the 1px edge, as V4 draws it.
    expect(decl(".hint-key", "padding")).toBe("0 4px");
    expect(decl(".hint-key", "border-radius")).toBe("4px");
    expect(decl(".hint-key", "background")).toBe("var(--bg-soft)");
    expect(decl(".hint-key", "border")).toBe("1px solid var(--line)");
    expect(decl(".hint-key", "color")).toBe("var(--muted)");
    expect(decl(".hint-key", "font")).toMatch(/^500 calc\(11px .*\)\/calc\(14px .*\) var\(--font-mono\)$/);
  });

  it("stands 8 off the stripe's edge towards the canvas, centred on its door", () => {
    const hint = source("../components/use-hint.tsx");
    expect(hint).toContain("const GAP_PX = 8;");
    expect(hint).toContain(`closest?.(".edge-rail")`);
    expect(hint).toContain("edge.right - box.left");
    // CHANGED ON PURPOSE (V4's Figma): and, from the right stripe, off its left edge.
    expect(hint).toContain("new DOMRect(edge.left, box.top, box.right - edge.left, box.height)");
  });

  it("leaves the tooltip's timers where they were", () => {
    const hint = source("../components/use-hint.tsx");
    expect(hint).toContain("FIRST_HINT_DELAY_MS = 450");
    expect(hint).toContain("HINT_GRACE_MS = 100");
  });

  it("arrives in Fast with 4px of travel, and under reduced motion fades without the travel", () => {
    expect(decl(".hint", "transition")).toBe("opacity var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease)");
    expect(decl(".hint", "transition", "(prefers-reduced-motion: reduce)")).toBe("opacity var(--dur-fast) var(--ease)");
    expect(source("../styles/hint.css")).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*@starting-style \{\s*\.hint-right, \.hint-left, \.hint-below, \.hint-above \{ transform: none; \}/);
  });
});
