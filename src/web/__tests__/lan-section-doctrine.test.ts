// The accounts panel spent a year learning three rules, and the LAN section
// shipped without any of them.
//
// A critique of the whole surface found the same shape three times: the panel
// commits on a press and never on a blur, reports every failure in a box a
// reader can see, and makes an act you cannot undo cost a second deliberate
// press — and `LanSyncSection.tsx` saved two fields on blur, checked `ok` with
// no `else` anywhere, and offered a live login to the network on one unguarded
// click. These are the rules, pinned where a regression trips rather than where
// somebody has to notice it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { roundLabel, writeFailure, sameKeys, parseAddress } from "../components/LanSyncSection";

const SRC = readFileSync(
  fileURLToPath(new URL("../components/LanSyncSection.tsx", import.meta.url)),
  "utf8",
);
const SERVER = readFileSync(
  fileURLToPath(new URL("../../server/index.mjs", import.meta.url)),
  "utf8",
);
/** The file with its comments taken out, so a rule cannot be satisfied by a
 *  paragraph that describes it. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const NOW = 1_700_000_000_000;

describe("a round says which of the three things it was", () => {
  it("marks a deck it could not reach, so the one row worth reading is the one that reads differently", () => {
    // The whole point. The sentence was already honest; it was drawn in the
    // dimmest ink the panel has, identical to `nothing to do` on the row above,
    // and in Operate mode the only thing anybody scans a list like this for is
    // which row is wrong.
    expect(roundLabel({ at: NOW, error: "handshake refused" }, NOW))
      .toEqual({ text: "could not reach it — handshake refused", tone: "bad" });
  });

  it("calls a round that moved nothing idle rather than wrong", () => {
    // Two decks whose accounts all agree is the STEADY STATE of this feature,
    // not a fault. Painting it like one would make the list permanently red.
    expect(roundLabel({ at: NOW, done: [] }, NOW))
      .toEqual({ text: "nothing to do · checked now", tone: "idle" });
  });

  it("calls a clean round ok, and counts in the singular when it is one", () => {
    expect(roundLabel({ at: NOW, done: [{ email: "a@b.c", action: "heal", ok: true }] }, NOW))
      .toEqual({ text: "took 1 account · now", tone: "ok" });
    expect(roundLabel({
      at: NOW,
      done: [
        { email: "a@b.c", action: "heal", ok: true },
        { email: "d@e.f", action: "add", ok: true },
      ],
    }, NOW)).toEqual({ text: "took 2 accounts · now", tone: "ok" });
  });

  it("marks a partial round, because some of it failed and nothing else says so", () => {
    // Reached the deck, so it is not an error; did not do what it set out to
    // do, so it is not ok either. The tone follows the failure, not the reach.
    expect(roundLabel({
      at: NOW,
      done: [
        { email: "a@b.c", action: "heal", ok: true },
        { email: "d@e.f", action: "add", ok: false },
      ],
    }, NOW)).toEqual({ text: "took 1 of 2 · now", tone: "bad" });
  });

  it("says nothing at all about a deck it has not had a round with yet", () => {
    expect(roundLabel(null, NOW)).toBeNull();
    expect(roundLabel(undefined, NOW)).toBeNull();
  });
});

describe("a write that did not happen says so", () => {
  it("tells a deck that refused apart from a deck that is gone", () => {
    // The two fail for completely different causes and lead to completely
    // different next moves, and both were the same silence.
    expect(writeFailure("save the passphrase", null))
      .toBe("Could not save the passphrase — the deck did not answer.");
    expect(writeFailure("save the passphrase", { ok: false, reason: "bad_request" }))
      .toBe("Could not save the passphrase — the deck refused it (bad_request).");
    expect(writeFailure("save the passphrase", { ok: false }))
      .toBe("Could not save the passphrase.");
  });

  it("names what the user was doing, never the route it used", () => {
    // `/api/prefs failed` is true and answers nothing. The verb is the content.
    for (const what of ["share that account", "add that address", "turn this on"]) {
      expect(writeFailure(what, null)).toContain(what);
    }
    expect(writeFailure("share that account", null)).not.toMatch(/api|prefs|POST|\b\d{3}\b/);
  });
});

describe("what we last sent, against what the server says", () => {
  it("ignores order, because the panel sends a Set and the server stores what it is sent", () => {
    expect(sameKeys(["a@@1", "b@@2"], ["b@@2", "a@@1"])).toBe(true);
  });

  it("refuses two lists that are not the same members", () => {
    expect(sameKeys(["a@@1"], ["a@@1", "b@@2"])).toBe(false);
    expect(sameKeys(["a@@1", "b@@2"], ["a@@1", "c@@3"])).toBe(false);
    // Same length, and one of them is a repeat rather than a second member.
    expect(sameKeys(["a@@1", "a@@1"], ["a@@1", "b@@2"])).toBe(false);
  });

  it("holds for the empty case, which is the state the section starts in", () => {
    expect(sameKeys([], [])).toBe(true);
  });
});

describe("the three rules the panel above it already keeps", () => {
  it("commits on a press and never on a blur", () => {
    // `appear as` saved on blur, and `by address` parsed on blur and threw the
    // text away when the parse failed — a typo produced an empty box, no peer,
    // and no statement that anything had gone wrong. picker-commit.ts spends
    // three paragraphs on why nothing in this panel may act on an event the
    // user did not aim at.
    expect(CODE).not.toMatch(/onBlur/);
  });

  it("has a failure box, announced and dismissible, like the panel's own", () => {
    expect(CODE).toMatch(/className="ap-failure"/);
    expect(CODE).toMatch(/role="alert"/);
    expect(CODE).toMatch(/className="ap-failure-x"/);
  });

  it("reports every write that did not land, in both ways it can fail", () => {
    // The `else` that was missing, and the `catch` that was missing. Counted
    // rather than merely present: a single setFailure would satisfy a `toMatch`
    // and leave the other path silent.
    expect([...CODE.matchAll(/setFailure\(writeFailure\(/g)]).toHaveLength(4);
    expect(CODE).toMatch(/catch\s*\{[\s\S]{0,400}?setFailure/);
  });

  it("gives every write the verb its failure will be reported with", () => {
    // save(patch) with no second argument is a write whose failure has no
    // sentence. Every call site passes one.
    const calls = [...CODE.matchAll(/\bsave\(\s*\{[\s\S]*?\}\s*,/g)];
    expect(calls.length).toBeGreaterThanOrEqual(6);
    expect(CODE).not.toMatch(/\bsave\(\s*\{[^{}]*\}\s*\)/);
  });

  it("costs one deliberate press before the first login is offered", () => {
    // Not a confirmation on every tick — the second account is a decision the
    // user has already made once. The block is closed only while it is empty,
    // so nothing that exists is ever hidden, and the press is what puts the
    // warning above it in front of the decision rather than beside it.
    expect(CODE).toMatch(/const showPicks = picking \|\| sharedList\.length > 0;/);
    expect(CODE).toMatch(/choose accounts to share/);
  });

  it("builds the next share list from what it last sent, not from the last render", () => {
    // The race: `status.shared` only changes after a write has landed AND the
    // poll after it has returned, so a second tick inside that window rebuilt
    // its Set from before the first one and silently dropped an account from
    // the group.
    expect(CODE).toMatch(/new Set\(pending\.current \?\? status\?\.shared \?\? \[\]\)/);
    expect(CODE).toMatch(/pending\.current = \[\.\.\.next\]/);
    // And retires the optimistic copy once the server agrees with it, or the
    // panel would stop believing the server forever.
    expect(CODE).toMatch(/sameKeys\(pending\.current, lan\.shared \?\? \[\]\)/);
  });

  it("says which state a press is in with a word, because aria-busy paints nothing", () => {
    // `check now` looked identical pressed and unpressed: selfPressProps sets
    // aria-busy, and aria-busy has no rule anywhere in the stylesheet.
    expect(CODE).toMatch(/checking\s*\?\s*"checking…"\s*:\s*"check now"/);
  });
});

describe("the passphrase the deck knows how to make", () => {
  it("is reachable from the panel at all, which it was not", () => {
    // suggestPassphrase was written, documented and tested with the first
    // commit of this feature and called by nothing but its own test, while the
    // field opened empty under a placeholder reading "the same words on every
    // deck" — an instruction to invent one two people can both remember.
    expect(SERVER).toMatch(/import \{ suggestPassphrase \} from "\.\/lan-sync\.mjs";/);
    expect(SERVER).toMatch(/url\.pathname === "\/api\/lan\/passphrase"/);
    expect(CODE).toMatch(/fetch\("\/api\/lan\/passphrase"\)/);
  });

  it("is generated per request, not folded into the polled status route", () => {
    // The status route is polled every five seconds. A suggestion that changed
    // under somebody's fingers while they read it out loud would be worse than
    // none.
    expect(SERVER).toMatch(/function handleLanSuggest/);
    expect(SERVER).not.toMatch(/lanEngine\.status\(\)[\s\S]{0,120}suggestPassphrase/);
  });

  it("is readable while it is being set, and never put back in a field afterwards", () => {
    // The rule is about a STORED value: publicPrefs does not send one, so there
    // is nothing to re-display. A suggestion nobody has saved yet is a
    // different thing, and hiding it would hide the one thing this step exists
    // to move to a second machine.
    expect(CODE).not.toMatch(/type="password"/);
    expect(CODE).toMatch(/hasPassphrase \? "set" : "not set yet"/);
    expect(CODE).not.toMatch(/•{3,}|•/);
  });

  it("only fills a field the user has not started typing in", () => {
    // The fetch is a round trip and somebody can type inside it.
    expect(CODE).toMatch(/setDraft\(d => \(d === "" \? out\.passphrase : d\)\)/);
  });
});

describe("what did not change", () => {
  it("still refuses an address with no usable port", () => {
    expect(parseAddress("192.168.1.5:54340")).toEqual({ addr: "192.168.1.5", port: 54340 });
    for (const bad of ["192.168.1.5", "192.168.1.5:", ":54340", "192.168.1.5:0", "192.168.1.5:70000"]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });

  it("still keeps the sentence that cannot be softened", () => {
    expect(SRC).toMatch(/cannot be taken back/);
  });

  it("still says the deck's name is public, where the field is", () => {
    // The beacon carries it in the clear to everyone on the network, with or
    // without the passphrase, and the panel had never said so.
    expect(CODE).toMatch(/everyone on this network can see this name/);
  });
});
