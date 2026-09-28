// What the accounts panel's fold is drawn from, run rather than read.
//
// The peers, the live account's strain and whether auto-switch is armed were
// three expressions in the middle of the panel's render, pinned by the text of
// their lines. They are functions in account-fold.ts now, so what the fold's
// row counts — who can be reached, and why not — is asserted as behaviour.
import { describe, expect, it } from "vitest";

import { isAutoArmed, pastThreshold, peersOf } from "../account-fold";
import { accountIssue } from "../account-issue";
import { type Account, type AutoStatus } from "../claude-accounts";
import { laneKey } from "../lane-open";

const NOW = 1_800_000_000;

/** A healthy, collected, inactive account; each case changes one thing. */
function account(num: number, over: Partial<Account> = {}): Account {
  return {
    num, email: `a${num}@example.com`, alias: null, org: "Acme", orgUuid: "org-a",
    active: false, disabled: false, lanes: [], headroom: 40,
    fetchedAt: (NOW - 60) * 1000, nextAt: (NOW + 300) * 1000, stale: false, error: null,
    ...over,
  };
}

/** A login no collection can get past: the row withholds `Switch` for it. */
const dead = (num: number) => account(num, { stopped: true, collector: "relogin_required" });

function auto(over: Partial<AutoStatus> = {}): AutoStatus {
  return { ok: true, enabled: false, external: false, lastTick: null, settings: {}, ...over };
}

describe("the accounts behind the fold, as its row counts them", () => {
  it("counts a healthy account as reachable, with nothing to say about it", () => {
    const [p] = peersOf([account(2)], NOW);
    expect(p).toEqual({ key: laneKey(account(2)), name: "a2@example.com", ready: true, why: null, warn: false, headroom: 40 });
  });

  it("names it the way its row does: alias, then address, then slot", () => {
    expect(peersOf([account(2, { alias: "side" })], NOW)[0].name).toBe("side");
    expect(peersOf([account(2, { email: null })], NOW)[0].name).toBe("account 2");
  });

  it("keys it by identity, so a move that trades slots cannot trade keys", () => {
    const before = peersOf([account(2)], NOW)[0].key;
    const after = peersOf([account(3, { email: "a2@example.com" })], NOW)[0].key;
    expect(after).toBe(before);
  });

  it("refuses a held-out account in the row's own words", () => {
    expect(peersOf([account(2, { disabled: true })], NOW)[0]).toMatchObject({ ready: false, why: "held out" });
  });

  it("refuses a dead login with the sentence its row shows, at the row's urgency", () => {
    const issue = accountIssue(dead(2), NOW)!;
    expect(issue.blocksSwitch).toBe(true);
    expect(peersOf([dead(2)], NOW)[0]).toMatchObject({ ready: false, why: issue.text, warn: issue.tone === "warn" });
  });

  it("says held out first when an account is both, since that is the one the reader chose", () => {
    const both = account(2, { disabled: true, stopped: true, collector: "relogin_required" });
    expect(peersOf([both], NOW)[0].why).toBe("held out");
  });

  it("agrees with the row's `Switch` on every account in a mixed roster", () => {
    // The row offers `Switch` for `!a.disabled && !issue?.blocksSwitch`; the
    // count and the button must never disagree about who can be reached.
    const roster = [account(2), account(3, { disabled: true }), dead(4), account(5, { staleCopy: true })];
    for (const [i, p] of peersOf(roster, NOW).entries()) {
      const a = roster[i];
      expect(p.ready, `slot ${a.num}`).toBe(!a.disabled && !accountIssue(a, NOW)?.blocksSwitch);
    }
  });

  it("carries the server's headroom through, never collected included", () => {
    expect(peersOf([account(2, { headroom: null })], NOW)[0].headroom).toBeNull();
  });
});

describe("whether the live account is past the threshold", () => {
  it("is past it once its fullest window reaches the threshold, and not a point before", () => {
    expect(pastThreshold(account(1, { active: true, headroom: 10 }), "90")).toBe(true);
    expect(pastThreshold(account(1, { active: true, headroom: 5 }), "90")).toBe(true);
    expect(pastThreshold(account(1, { active: true, headroom: 11 }), "90")).toBe(false);
  });

  it("is never past it with nothing to measure", () => {
    expect(pastThreshold(undefined, "90")).toBe(false);
    expect(pastThreshold(account(1, { active: true, headroom: null }), "90")).toBe(false);
    // A threshold the store holds as something that is not a number.
    expect(pastThreshold(account(1, { active: true, headroom: 0 }), "ninety")).toBe(false);
  });
});

describe("whether anything will switch without a press", () => {
  it("is armed by the deck's own loop and by a terminal's alike", () => {
    expect(isAutoArmed(auto({ enabled: true }))).toBe(true);
    expect(isAutoArmed(auto({ external: true }))).toBe(true);
    expect(isAutoArmed(auto())).toBe(false);
  });

  it("is not armed by a status nobody could read", () => {
    expect(isAutoArmed(null)).toBe(false);
    expect(isAutoArmed(auto({ ok: false, enabled: true }))).toBe(false);
  });
});
