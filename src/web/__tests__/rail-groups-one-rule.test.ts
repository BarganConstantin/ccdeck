// One rule for the doors (2026-10-23), now on V4's two stripes.
//
// A user wrote that the deck has a lot in it but is "not organized". Thirteen
// doors had grown on two stripes in runs grouped by two different rules, so
// where a button sat said nothing about it. Now each stripe is runs of doors
// that answer one question each, three at most, between the same rules, every
// run of two or more a group with a name a screen reader says on the way in.
// Every door stayed. Radio said it opened a panel (aria-expanded) and opened a
// modal; it says "dialog" now, like every other door that opens one.
//
// CHANGED ON PURPOSE (V4's Figma): this file pinned the one bar on the left,
// every run in it. V4's Figma puts the doors back on two stripes, each on the
// side its panel opens, so the runs below are the two stripes' and each test
// that spoke of "the one bar" speaks of both.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { railItems } from "../rail-items";
import { EdgeRail } from "../components/EdgeRails";

const noop = () => {};
const ref = () => ({ current: null });
const rails = railItems({
  providers: { kind: "reported", claude: true, codex: true },
  sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
  usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
  setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
  setTrafficRadarOpen: noop, setRadioOpen: noop, openToolActivity: noop, openCapacity: noop,
  openSettings: noop, onFeedback: noop, toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
  openExploreIntegrations: noop,
});
// CHANGED ON PURPOSE (V4 top-10 #4): every door stood on a stripe → the
// occasional ones are runs of a More at each stripe's foot, because the stripe
// keeps the everyday doors. The one rule holds for both: runs of three at most,
// each about one thing; on a stripe a run is a named group, in a More's menu it
// is set apart by the menu's rule.
const groups = [...rails.leftStripe, ...rails.leftMore, ...rails.rightStripe, ...rails.rightMore];
const ids = (group: { id: string }[]) => group.map(i => i.id);
const left = renderToStaticMarkup(createElement(EdgeRail, { side: "left", label: "Panels and tools", groups: rails.leftStripe, more: rails.leftMore, foot: rails.leftFoot }));
const right = renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Usage and activity", groups: rails.rightStripe, more: rails.rightMore }));

describe("the two stripes follow one rule", () => {
  it("keeps every door, in runs that answer one question each", () => {
    expect(rails.leftStripe.map(ids)).toEqual([
      ["session-list", "accounts"],
    ]);
    expect(rails.leftMore.map(ids)).toEqual([
      ["account-capacity", "reset-calendar"],
      ["explore-integrations"],
      ["radio"],
    ]);
    expect(ids(rails.leftFoot)).toEqual(["settings"]);
    expect(rails.rightStripe.map(ids)).toEqual([
      ["inspector"],
      ["usage", "machine"],
    ]);
    expect(rails.rightMore.map(ids)).toEqual([
      ["history", "tool-activity", "skill-activity"],
      ["browser-watch", "traffic-radar"],
    ]);
  });

  it("holds no run of more than three doors", () => {
    for (const group of groups) expect(group.length, ids(group).join()).toBeLessThanOrEqual(3);
  });

  it("names every run of two or more, the same name on each of its doors", () => {
    const names = groups.filter(g => g.length > 1).map(g => [...new Set(g.map(i => i.group))]);
    expect(names).toEqual([["Accounts and sessions"], ["Claude accounts"], ["Usage and machine"], ["Activity history"], ["Watchers"]]);
  });

  it("draws each named run as a group a screen reader announces, and a lone door as itself", () => {
    expect(left).toContain('role="toolbar" aria-label="Panels and tools"');
    expect(right).toContain('role="toolbar" aria-label="Usage and activity"');
    expect(left).toContain('<div class="rail-group" role="group" aria-label="Accounts and sessions">');
    expect(right).toContain('<div class="rail-group" role="group" aria-label="Usage and machine">');
    // The Inspector's door stands alone, first on the right stripe: no group
    // around one door.
    expect(right).toMatch(/<div class="rail-group"><button[^>]*data-rail-item="inspector"/);
  });

  // CHANGED ON PURPOSE (V4 top-10 #4): Radio's door was in the left foot → it
  // is a row of the left More; read off the stripe door's own rule, drawn on
  // a stripe, it still says "dialog" and claims no panel.
  it("says Radio opens a dialog, the modal it does open, and never claims a panel", () => {
    const radio = rails.leftMore.flat().find(i => i.id === "radio")!;
    expect(radio.kind).toBe("dialog");
    expect(radio.open).toBeUndefined();
    expect(radio.controls).toBeUndefined();
    const drawn = renderToStaticMarkup(createElement(EdgeRail, { side: "left", label: "Panels and tools", groups: [[radio]] }));
    const button = /<button[^>]*data-rail-item="radio"[^>]*>/.exec(drawn)?.[0] ?? "";
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).not.toContain("aria-expanded");
    expect(left).not.toContain('data-rail-item="radio"');
  });

  it("gives a Codex-only deck its own button, without the Claude capacity doors", () => {
    const codexOnly = railItems({
      providers: { kind: "reported", claude: false, codex: true },
      sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
      usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
      setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
      openCapacity: noop, openSettings: noop, onFeedback: noop,
      toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
    });
    expect(codexOnly.leftStripe[0].map(i => i.id)).toEqual(["session-list", "codex-accounts"]);
    expect(codexOnly.leftStripe.flat().map(i => i.id)).not.toContain("account-capacity");
  });
});
