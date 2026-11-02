// What the accounts panel says about Auto-switch's home account and how it
// picks the next one (auto-choice.ts, picker-commit.ts nextCommit).
//
// The panel lost a strategy picker once because its options only made sense
// to somebody who had read claude-swap's source. These pin the words: options
// named by what they do, one quiet line for the option that is not obvious,
// and a home mark whose title says why Auto-switch is passing it over.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { homeTitle, isHome, isNextChoice, type NextChoice, NEXT_OPTIONS, WEEKLY_HINT } from "../auto-choice";
import { type AutoStatus } from "../claude-accounts";
import { AutoSwitchSettings } from "../components/AutoSwitchPolicy";
import { nextCommit, thresholdCommit } from "../picker-commit";

/** The policy block as the panel draws it, with Auto-switch on or off and a
 *  next-account pick over what is stored. */
function policy(enabled: boolean, pick: NextChoice, stored: NextChoice = pick): string {
  const auto: AutoStatus = {
    ok: true, enabled, external: false, lastTick: null,
    settings: { "autoswitch.threshold": { value: "90", isDefault: true } },
  };
  return renderToStaticMarkup(createElement(AutoSwitchSettings, {
    titleId: "t",
    auto, threshold: "90", thresholdPick: "90", thresholdCtl: thresholdCommit("90", "90"), thresholdSaved: false,
    thresholdRef: null, thresholdSaveRef: null, thresholdFieldRef: null, thresholdCustom: false, thresholdRefusal: null,
    proposeThreshold: () => {}, typeThreshold: () => {}, cancelThreshold: () => {}, leaveThreshold: () => {},
    doThreshold: () => {},
    nextPick: pick, nextCtl: nextCommit(pick, stored), nextSaved: false, nextRef: null, nextSaveRef: null,
    proposeNext: () => {}, doNext: () => {},
    pressProps: () => ({}), post: async () => null, load: async () => {},
  }));
}

describe("the next-account picker", () => {
  it("offers the two rules in plain words, the old behaviour first", () => {
    expect(NEXT_OPTIONS.map(o => o.label)).toEqual(["Most room left", "Soonest weekly reset"]);
    expect(NEXT_OPTIONS[0].value).toBe("room");
    expect(WEEKLY_HINT).toMatch(/4 days/);
    expect(isNextChoice("weekly")).toBe(true);
    expect(isNextChoice("consume-first")).toBe(false);
  });

  it("only sends when the pick differs from what is stored (#516)", () => {
    expect(nextCommit("room", "room").sends).toBe(false);
    expect(nextCommit("weekly", "room")).toMatchObject({ sends: true, label: "save", done: "saved", swaps: false });
    expect(nextCommit("weekly", "room").title).toMatch(/weekly limit resets soonest/);
  });

  // CHANGED ON PURPOSE (V4's Figma): the policy's settings are a popover from the
  // Auto-switch row — "Switch at" as chips and "Next account" as two options,
  // each stored by its own press, so the save step and the select are gone.
  it("is a group with Auto-switch on or off, so it is set up before it is turned on", () => {
    expect(policy(true, "room")).toContain(">Next account</span>");
    expect(policy(false, "room")).toContain(">Next account</span>");
    expect(policy(false, "weekly")).toContain(WEEKLY_HINT);
    expect(policy(false, "weekly", "room")).toMatch(/role="radiogroup"/);
  });

  it("explains the weekly rule on its own option, and says which option is chosen", () => {
    const html = policy(true, "weekly");
    expect(html).toContain(`<span class="ap-auto-option-note">${WEEKLY_HINT}</span>`);
    expect(html).toMatch(/role="radio" aria-checked="true" class="ap-auto-option" data-selected=""[^>]*>[\s\S]*?Soonest weekly reset/);
    expect(policy(true, "room")).toMatch(/role="radio" aria-checked="true" class="ap-auto-option" data-selected=""[^>]*>[\s\S]*?Most room left/);
  });

  it("stores a pick by pressing it, so there is no save button", () => {
    expect(policy(true, "weekly", "room")).not.toMatch(/>save<\/button>/);
    expect(policy(true, "room")).not.toMatch(/<select/);
  });
});

describe("the home mark", () => {
  const home = { email: "Work@X.com", orgUuid: "org-1" };

  it("is on the row with the same identity, whatever its slot", () => {
    expect(isHome({ email: "work@x.com", orgUuid: "org-1" }, home)).toBe(true);
    expect(isHome({ email: "work@x.com", orgUuid: "org-2" }, home)).toBe(false);
    expect(isHome({ email: "work@x.com", orgUuid: null }, { email: "work@x.com", orgUuid: null })).toBe(true);
    expect(isHome({ email: null, orgUuid: "org-1" }, home)).toBe(false);
    expect(isHome({ email: "work@x.com", orgUuid: "org-1" }, null)).toBe(false);
  });

  it("says what home does, or why it is being passed over", () => {
    const ok = { disabled: false, alive: true, error: null, reauth: null };
    expect(homeTitle(ok, true)).toBe("Home · Auto-switch comes back here after its 5-hour window resets");
    expect(homeTitle(ok, false)).toMatch(/while it is on/);
    expect(homeTitle({ ...ok, disabled: true }, true)).toMatch(/held out of rotation/);
    expect(homeTitle({ ...ok, alive: false }, true)).toMatch(/signed in again/);
  });
});
