// Which account a paired deck is on, and how its dialog marks it.
//
// The rule the whole feature hangs on: a deck names the account it is working
// on only when that account is one it shares. On one it does not share it says
// "another account" and never which; with its owner's switch off it says
// "hidden". Everything below checks one side of that promise — what is sent,
// what is kept of what arrives, and what the dialog draws from it.
//
// Only THAT deck's account is marked. This deck's own is not: its owner sees it
// in the accounts panel's switcher, and asked for the dialog to answer the one
// question it is opened for — which account is the other machine on.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs server module, no types
import { currentFor } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { heardCurrent } from "../../server/lan-engine.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { DEFAULTS, normalise } from "../../server/deck-prefs.mjs";
import { exchangeLanes } from "../components/LanSyncSection";

/** A file with its comments taken out, so a rule cannot be satisfied by a
 *  paragraph that describes it. */
const code = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const MODAL = code("../components/LanPeerModal.tsx");
const SETUP = code("../components/LanSetupModal.tsx");
const CSS = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

describe("what a deck says about the account it is on", () => {
  const mine = (key: string, active = false) => ({ key, email: key, alive: true, active });

  it("names it when it is one the deck shares", () => {
    expect(currentFor([mine("a@@1", true), mine("b@@1")], ["a@@1", "b@@1"], true))
      .toEqual({ current: { key: "a@@1" } });
  });

  it("says only 'another account' about one it does not share — never which", () => {
    const said = currentFor([mine("a@@1", true)], ["b@@1"], true);
    expect(said).toEqual({ current: { other: true } });
    expect(JSON.stringify(said)).not.toContain("a@@1");
  });

  it("says nothing at all when no account is active", () => {
    expect(currentFor([mine("a@@1")], ["a@@1"], true)).toEqual({});
  });

  it("says it is hidden when its owner switched that off, shared or not", () => {
    expect(currentFor([mine("a@@1", true)], ["a@@1"], false)).toEqual({ current: { hidden: true } });
    expect(currentFor([mine("a@@1", true)], [], false)).toEqual({ current: { hidden: true } });
    expect(currentFor([], [], false)).toEqual({ current: { hidden: true } });
  });

  it("reads a missing switch as on, which is what the engine does", () => {
    expect(currentFor([mine("a@@1", true)], ["a@@1"], undefined)).toEqual({ current: { key: "a@@1" } });
  });
});

describe("what a deck keeps of what another said", () => {
  const list = [{ key: "a@@1", email: "a", alive: true }];

  it("keeps a key that is in the list it came with", () => {
    expect(heardCurrent({ key: "a@@1" }, list)).toEqual({ key: "a@@1" });
  });

  it("drops a key the same frame did not offer", () => {
    expect(heardCurrent({ key: "z@@9" }, list)).toBeNull();
  });

  it("keeps hidden and another-account, and nothing else it cannot read", () => {
    expect(heardCurrent({ hidden: true }, [])).toEqual({ hidden: true });
    expect(heardCurrent({ other: true }, [])).toEqual({ other: true });
    for (const junk of [null, undefined, "a@@1", 7, [], { key: 7 }, { hidden: "yes" }, { other: 1 }]) {
      expect(heardCurrent(junk, list), JSON.stringify(junk)).toBeNull();
    }
  });
});

describe("the lane that deck is on", () => {
  const acct = (key: string, alive = true) => ({ key, email: key, alive });

  it("is the one it named, and no other", () => {
    const lanes = exchangeLanes([acct("a"), acct("b")], [acct("a"), acct("b")], ["a", "b"], "b");
    expect(lanes.map(l => [l.key, l.usedThere])).toEqual([["a", false], ["b", true]]);
  });

  it("is never a lane that deck does not offer", () => {
    const lanes = exchangeLanes([], [acct("a")], ["a"], "a");
    expect(lanes[0].usedThere).toBe(false);
  });

  it("is still marked when its copy is expired, and still says it is expired", () => {
    const [l] = exchangeLanes([acct("a", false)], [acct("a", false)], ["a"], "a");
    expect(l).toMatchObject({ here: "expired", there: "broken", usedThere: true });
  });

  it("is the only mark — this deck's own account is not drawn", () => {
    const [l] = exchangeLanes([acct("a")], [acct("a")], ["a"], null);
    expect(l).not.toHaveProperty("usedHere");
    expect(MODAL).not.toContain("data-used-here");
    expect(CSS).not.toContain("data-used-here");
  });
});

describe("the switch", () => {
  it("is on by default, and only a real boolean turns it off", () => {
    expect(DEFAULTS.lan.shareActive).toBe(true);
    expect(normalise({}).lan.shareActive).toBe(true);
    expect(normalise({ lan: { shareActive: false } }).lan.shareActive).toBe(false);
    expect(normalise({ lan: { shareActive: "no" } }).lan.shareActive).toBe(true);
  });

  it("sits under the accounts it can name, and writes the setting the engine reads", () => {
    const share = SETUP.indexOf(">Share these accounts<");
    const sw = SETUP.indexOf(">Show paired decks which of these this deck is using<");
    const pairing = SETUP.indexOf(">Pairing<");
    expect(share).toBeGreaterThan(-1);
    expect(sw).toBeGreaterThan(share);
    expect(sw).toBeLessThan(pairing);
    expect(SETUP).toMatch(/\{ shareActive: !tells \}/);
    expect(SETUP).toMatch(/const tells = status\.shareActive !== false;/);
  });
});

describe("the dialog", () => {
  it("marks only while that deck answers", () => {
    expect(MODAL).toMatch(/const current = link === "up" \? offers\?\.current \?\? null : null;/);
  });

  it("says current account hidden under whichever machine is hiding it", () => {
    expect(MODAL.match(/current account hidden/g)?.length).toBe(2);
    expect(MODAL).toMatch(/paired && status\.shareActive === false/);
    expect(MODAL).toMatch(/\{hiddenThere && /);
  });

  it("says on another account under that deck when it is on one it does not share", () => {
    expect(MODAL.match(/on another account/g)?.length).toBe(1);
    expect(MODAL).toMatch(/\{otherThere && /);
  });

  it("puts the mark on that deck's lane", () => {
    expect(MODAL).toMatch(/data-used-there=\{l\.usedThere \|\| undefined\}/);
  });

  it("rings that deck's end with the rows' own ping, and holds it still for less motion", () => {
    expect(CSS).toMatch(/\.lan-lane\[data-used-there\] \.lan-pip\[data-end="there"\]::after \{[^}]*animation: ap-ping /);
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.lan-lane\[data-used-there\] \.lan-pip\[data-end="there"\]::after \{ animation: none;/,
    );
  });
});
