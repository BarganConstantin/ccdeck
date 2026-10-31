// One rule for both stripes (2026-10-23).
//
// A user wrote that the deck has a lot in it but is "not organized". Thirteen
// doors had grown on the two stripes in runs grouped by two different rules —
// the left by topic, the right by whether a press opened a panel or a dialog —
// so where a button sat said nothing about it, and the right stripe's toolbar
// was called "Right panels" while six of its eight doors opened dialogs.
//
// Now each stripe is runs of doors that answer one question each, three at
// most, between the same rules, every run of two or more a group with a name
// a screen reader says on the way in. Every door stayed, in the owner's order.
// Radio said it opened a panel (aria-expanded) and opened a modal; it says
// "dialog" now, like every other door that opens one.
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
const leftGroups = [...rails.leftStripe, rails.integrations, rails.explore].filter(g => g.length > 0);
const ids = (group: { id: string }[]) => group.map(i => i.id);

describe("both stripes follow one rule", () => {
  it("keeps every door, in runs that answer one question each", () => {
    expect(leftGroups.map(ids)).toEqual([
      ["accounts", "account-capacity", "reset-calendar"],
      ["codex-accounts"],
      ["session-list"],
      ["explore-integrations"],
    ]);
    expect(rails.right.map(ids)).toEqual([
      ["usage", "machine"],
      ["history", "tool-activity", "skill-activity"],
      ["browser-watch", "traffic-radar"],
      ["radio"],
    ]);
  });

  it("holds no run of more than three doors", () => {
    for (const group of [...leftGroups, ...rails.right]) expect(group.length, ids(group).join()).toBeLessThanOrEqual(3);
  });

  it("names every run of two or more, the same name on each of its doors", () => {
    const names = [...leftGroups, ...rails.right].filter(g => g.length > 1).map(g => [...new Set(g.map(i => i.group))]);
    expect(names).toEqual([["Claude accounts"], ["Usage and machine"], ["Activity history"], ["Watchers"]]);
  });

  it("draws each named run as a group a screen reader announces, and a lone door as itself", () => {
    const right = renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Usage and activity", groups: rails.right }));
    expect(right).toContain('role="toolbar" aria-label="Usage and activity"');
    expect(right.match(/role="group"/g)).toHaveLength(3);
    for (const name of ["Usage and machine", "Activity history", "Watchers"]) {
      expect(right).toContain(`<div class="rail-group" role="group" aria-label="${name}">`);
    }
    // Radio stands alone: no group around one door.
    expect(right).toMatch(/<div class="rail-group"><button[^>]*data-rail-item="radio"/);
  });

  it("says Radio opens a dialog, the modal it does open, and never claims a panel", () => {
    const radio = rails.right.flat().find(i => i.id === "radio")!;
    expect(radio.kind).toBe("dialog");
    expect(radio.open).toBeUndefined();
    expect(radio.controls).toBeUndefined();
    const right = renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Usage and activity", groups: rails.right }));
    const button = /<button[^>]*data-rail-item="radio"[^>]*>/.exec(right)?.[0] ?? "";
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).not.toContain("aria-expanded");
  });

  it("gives a Codex-only stripe its own button, without the Claude capacity doors", () => {
    const codexOnly = railItems({
      providers: { kind: "reported", claude: false, codex: true },
      sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
      usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
      setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
      openCapacity: noop, openSettings: noop, onFeedback: noop,
      toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
    });
    expect(codexOnly.leftStripe.map(ids)).toEqual([["codex-accounts"], ["session-list"]]);
  });
});
