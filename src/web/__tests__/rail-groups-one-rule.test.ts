// One rule for the doors (2026-10-23), now on V4's one Panel bar.
//
// A user wrote that the deck has a lot in it but is "not organized". Thirteen
// doors had grown on two stripes in runs grouped by two different rules, so
// where a button sat said nothing about it. Now the one bar is runs of doors
// that answer one question each, three at most, between the same rules, every
// run of two or more a group with a name a screen reader says on the way in.
// Every door stayed. Radio said it opened a panel (aria-expanded) and opened a
// modal; it says "dialog" now, like every other door that opens one.
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
const groups = rails.panelBar;
const ids = (group: { id: string }[]) => group.map(i => i.id);
const bar = renderToStaticMarkup(createElement(EdgeRail, { label: "Panels and tools", groups: rails.panelBar, foot: rails.panelFoot }));

describe("the one bar follows one rule", () => {
  it("keeps every door, in runs that answer one question each", () => {
    expect(groups.map(ids)).toEqual([
      ["session-list", "accounts"],
      ["account-capacity", "reset-calendar"],
      ["usage", "machine"],
      ["history", "tool-activity", "skill-activity"],
      ["browser-watch", "traffic-radar"],
      ["explore-integrations"],
    ]);
    expect(ids(rails.panelFoot)).toEqual(["radio", "settings"]);
  });

  it("holds no run of more than three doors", () => {
    for (const group of groups) expect(group.length, ids(group).join()).toBeLessThanOrEqual(3);
  });

  it("names every run of two or more, the same name on each of its doors", () => {
    const names = groups.filter(g => g.length > 1).map(g => [...new Set(g.map(i => i.group))]);
    expect(names).toEqual([["Accounts and sessions"], ["Claude accounts"], ["Usage and machine"], ["Activity history"], ["Watchers"]]);
  });

  it("draws each named run as a group a screen reader announces, and a lone door as itself", () => {
    expect(bar).toContain('role="toolbar" aria-label="Panels and tools"');
    for (const name of ["Accounts and sessions", "Claude accounts", "Usage and machine", "Activity history", "Watchers"]) {
      expect(bar).toContain(`<div class="rail-group" role="group" aria-label="${name}">`);
    }
    // Explore stands alone: no group around one door.
    expect(bar).toMatch(/<div class="rail-group" data-rail-group="explore"><button/);
  });

  it("says Radio opens a dialog, the modal it does open, and never claims a panel", () => {
    const radio = rails.panelFoot.find(i => i.id === "radio")!;
    expect(radio.kind).toBe("dialog");
    expect(radio.open).toBeUndefined();
    expect(radio.controls).toBeUndefined();
    const button = /<button[^>]*data-rail-item="radio"[^>]*>/.exec(bar)?.[0] ?? "";
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).not.toContain("aria-expanded");
  });

  it("gives a Codex-only bar its own button, without the Claude capacity doors", () => {
    const codexOnly = railItems({
      providers: { kind: "reported", claude: false, codex: true },
      sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
      usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
      setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
      openCapacity: noop, openSettings: noop, onFeedback: noop,
      toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
    });
    expect(codexOnly.panelBar[0].map(i => i.id)).toEqual(["session-list", "codex-accounts"]);
    expect(codexOnly.panelBar.flat().map(i => i.id)).not.toContain("account-capacity");
  });
});
