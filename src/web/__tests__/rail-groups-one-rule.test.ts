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
const groups = [...rails.leftStripe, ...rails.rightStripe];
const ids = (group: { id: string }[]) => group.map(i => i.id);
const left = renderToStaticMarkup(createElement(EdgeRail, { side: "left", label: "Panels and tools", groups: rails.leftStripe, foot: rails.leftFoot }));
const right = renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Usage and activity", groups: rails.rightStripe }));

describe("the two stripes follow one rule", () => {
  it("keeps every door, in runs that answer one question each", () => {
    expect(rails.leftStripe.map(ids)).toEqual([
      ["session-list", "accounts"],
      ["account-capacity", "reset-calendar"],
      ["explore-integrations"],
    ]);
    expect(ids(rails.leftFoot)).toEqual(["radio", "settings"]);
    expect(rails.rightStripe.map(ids)).toEqual([
      ["inspector"],
      ["usage", "machine"],
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
    for (const name of ["Accounts and sessions", "Claude accounts"]) {
      expect(left).toContain(`<div class="rail-group" role="group" aria-label="${name}">`);
    }
    for (const name of ["Usage and machine", "Activity history", "Watchers"]) {
      expect(right).toContain(`<div class="rail-group" role="group" aria-label="${name}">`);
    }
    // Explore stands alone: no group around one door.
    expect(left).toMatch(/<div class="rail-group" data-rail-group="explore"><button/);
    // So does the Inspector's door, first on the right stripe.
    expect(right).toMatch(/<div class="rail-group"><button[^>]*data-rail-item="inspector"/);
  });

  it("says Radio opens a dialog, the modal it does open, and never claims a panel", () => {
    const radio = rails.leftFoot.find(i => i.id === "radio")!;
    expect(radio.kind).toBe("dialog");
    expect(radio.open).toBeUndefined();
    expect(radio.controls).toBeUndefined();
    const button = /<button[^>]*data-rail-item="radio"[^>]*>/.exec(left)?.[0] ?? "";
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).not.toContain("aria-expanded");
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
