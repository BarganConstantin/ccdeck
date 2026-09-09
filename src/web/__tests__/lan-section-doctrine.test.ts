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
import { roundLabel, writeFailure, sameKeys, parseAddress, askedLabel } from "../components/LanSyncSection";

const SRC = readFileSync(
  fileURLToPath(new URL("../components/LanSyncSection.tsx", import.meta.url)),
  "utf8",
);
const SERVER = readFileSync(
  fileURLToPath(new URL("../../server/index.mjs", import.meta.url)),
  "utf8",
);
const MODAL = readFileSync(
  fileURLToPath(new URL("../components/LanSetupModal.tsx", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
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
    expect([...CODE.matchAll(/setFailure\(writeFailure\(/g)].length).toBeGreaterThanOrEqual(4);
    expect([...MODAL.matchAll(/setFailure\(writeFailure\(/g)].length).toBeGreaterThanOrEqual(4);
    expect(CODE).toMatch(/catch\s*\{[\s\S]{0,400}?setFailure/);
  });

  it("gives every write the verb its failure will be reported with", () => {
    // save(patch) with no second argument is a write whose failure has no
    // sentence. Every call site passes one.
    expect(MODAL).not.toMatch(/\bwrite\(\s*\{[^{}]*\}\s*\)/);
    expect([...MODAL.matchAll(/\bwrite\(\s*\{[\s\S]*?\}\s*,/g)].length).toBeGreaterThanOrEqual(3);
  });

  it("keeps every decision out of the panel and in a dialog", () => {
    // The section had grown to nine controls in a 288px column, all of them on
    // screen every time somebody opened the panel to look at a quota. What is
    // left is an instrument: is it on, who is paired, what happened, who is
    // asking. The two exceptions are deliberate — the switch, because it is the
    // control that answers "is this on", and a request, because it arrives
    // while nobody has a dialog open.
    expect(CODE).toMatch(/LanSetupModal/);
    // The FIELDS, not the words: "by address" still appears in the panel as a
    // reading — it is how a peer row says how that deck got there — and a
    // reading is exactly what belongs in an instrument.
    for (const field of [
      `aria-label="This deck's name on the network"`,
      `aria-label="Another deck's address"`,
      'type="checkbox"',
    ]) {
      expect(CODE, field).not.toContain(field);
      expect(MODAL, field).toContain(field);
    }
    expect(CODE).toMatch(/role="switch"/);
    expect(CODE).toMatch(/wants to pair/);
  });

  it("builds the next share list from what it last sent, not from the last render", () => {
    // The race: `status.shared` only changes after a write has landed AND the
    // poll after it has returned, so a second tick inside that window rebuilt
    // its Set from before the first one and silently dropped an account.
    expect(MODAL).toMatch(/new Set\(pending\.current \?\? status\.shared \?\? \[\]\)/);
    expect(MODAL).toMatch(/pending\.current = \[\.\.\.next\]/);
    // And retires the optimistic copy once the server agrees with it, or the
    // boxes would keep showing what was sent even after the deck refused it.
    expect(MODAL).toMatch(/sameKeys\(pending\.current, status\.shared \?\? \[\]\)/);
  });

  it("says which state a press is in with a word, because aria-busy paints nothing", () => {
    // `check now` looked identical pressed and unpressed: selfPressProps sets
    // aria-busy, and aria-busy has no rule anywhere in the stylesheet.
    expect(CODE).toMatch(/checking\s*\?\s*"checking…"\s*:\s*"check now"/);
  });
});

describe("the pairing that replaced the passphrase", () => {
  it("asks a person about a named machine, not about a string nobody can see", () => {
    // THE DEFECT THE WHOLE REDESIGN CAME OUT OF. A passphrase differing by one
    // character produced a closed socket and no other symptom on both machines,
    // and a secret is the one value a panel must never print — so neither
    // person could check theirs against the other's.
    expect(CODE).toMatch(/wants to pair/);
    expect(CODE).toMatch(/accept/);
    expect(CODE).toMatch(/dismiss/);
    // And what the reader is asked to compare is on the request itself.
    expect(CODE).toMatch(/fingerprint is \$\{p\.fp\}/);
  });

  it("has no passphrase left anywhere in the surface", () => {
    for (const src of [CODE, MODAL]) {
      expect(src).not.toMatch(/passphrase/i);
      expect(src).not.toMatch(/type="password"/);
    }
  });

  it("puts the request above everything else, because nothing moves until it is answered", () => {
    const ask = CODE.indexOf('className="ap-lan-asks"');
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(CODE.indexOf(">\n            paired decks"));
    // Announced, because it arrives while the reader is three sections up
    // looking at a quota.
    expect(CODE).toMatch(/className="ap-lan-asks" role="alert"/);
  });

  it("says how long a request has been waiting, coarsely, because the answer is a press", () => {
    const NOW = 1_700_000_000_000;
    expect(askedLabel(NOW, NOW)).toBe("just now");
    expect(askedLabel(NOW - 30_000, NOW)).toBe("just now");
    expect(askedLabel(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(askedLabel(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  });

  it("routes accept, dismiss and unpair through one server verb each", () => {
    expect(SERVER).toMatch(/function handleLanPeer/);
    expect(SERVER).toMatch(/url\.pathname === "\/api\/lan\/peer"/);
    for (const verb of ["accept", "dismiss", "unpair"]) {
      expect(SERVER, verb).toMatch(new RegExp(`case "${verb}"`));
    }
    // The KEY being pinned comes from what this deck saw on the wire, never
    // from the page — so a page cannot pair this deck with a key nobody met.
    expect(SERVER).toMatch(/never from\s+\*\s*the page/);
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
    // The beacon carries it in the clear to everyone on the network, paired or
    // not. It is said beside the field, which moved into the dialog with it.
    expect(MODAL).toMatch(/Everyone on this network can see this name/);
  });
});
