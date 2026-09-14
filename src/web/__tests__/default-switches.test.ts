// What a deck does before anybody has chosen anything — the three defaults
// 3.22.7 changed, and the rule that keeps the change away from a deck that did
// choose.
//
// Local network and Browser Watch start ON: a deck that finds no other deck and
// watches no browser is a deck whose two least obvious features are invisible to
// the person who just installed it, and both are useless until somebody goes
// looking for a switch. Desktop notifications start OFF: the deck already has a
// voice — its own sounds, which are on — and a notification is the louder half
// of the same message.
//
// THE RULE THAT MAKES THAT SAFE: a saved boolean always wins. Every normaliser
// below tests `typeof x === "boolean"` and falls back only when the file has no
// answer, so an upgrade never flips a switch somebody set.
import { describe, it, expect } from "vitest";
import { DEFAULTS, lanEnabled, normalise } from "../../server/deck-prefs.mjs";
import {
  DEFAULTS as WATCH_DEFAULTS, normalise as watchNormalise,
} from "../../server/browser-watch-store.mjs";

describe("the switches a deck starts with", () => {
  it("is on the local network and watching the browser, and off the desktop", () => {
    expect(DEFAULTS.lan.enabled).toBe(true);
    expect(WATCH_DEFAULTS.enabled).toBe(true);
    expect(DEFAULTS.notifications).toBe(false);
  });

  it("pairs only when somebody at the other machine says yes", () => {
    // The half that had to change with `enabled`. Auto-accept is the accept
    // button pressed in advance, which was a fair trade while the only decks on
    // the network were ones somebody had switched on themselves. On by default,
    // every ccdeck in an office or a café would pair with every other one in
    // silence — and a login ticked later goes to everything paired.
    expect(DEFAULTS.lan.autoAccept).toBe(false);
    expect(DEFAULTS.lan.autoAsk).toBe(true);
    expect(normalise({}).lan.autoAccept).toBe(false);
    // Nothing is offered to a paired deck until a person ticks a login, which
    // is the gate that did not change.
    expect(normalise({}).lan.shared).toEqual([]);
  });

  it("never overrules a choice already on disk", () => {
    expect(normalise({ lan: { enabled: false } }).lan.enabled).toBe(false);
    expect(normalise({ notifications: true }).notifications).toBe(true);
    expect(watchNormalise({ enabled: false }).enabled).toBe(false);
    // And the other way: a deck that turned auto-accept on keeps it.
    expect(normalise({ lan: { autoAccept: true } }).lan.autoAccept).toBe(true);
  });

  it("lets the machine keep the LAN off whatever the file says", () => {
    // The same shape as AGENTS_DECK_NO_NOTIFY, for the same reason: whoever
    // launched the deck is making a claim about the machine, and a page posting
    // to /api/prefs must not be able to overrule it. It is also what keeps this
    // suite off the office network — see no-lan.ts, which sets it for every
    // worker, since several suites boot a real deck with no prefs.json.
    const on = { lan: { enabled: true } };
    expect(lanEnabled(on, {})).toBe(true);
    expect(lanEnabled(on, { AGENTS_DECK_NO_LAN: "1" })).toBe(false);
    expect(lanEnabled({ lan: { enabled: false } }, {})).toBe(false);
    // Nothing saved at all reads as the default, which is on.
    expect(lanEnabled(null, {})).toBe(true);
  });
});
