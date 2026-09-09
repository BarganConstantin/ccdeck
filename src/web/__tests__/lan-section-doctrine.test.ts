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
import {
  askedLabel, isOnline, leftLabel, parseAddress, roundLabel, rosterSplit, sameKeys,
  sectionState, writeFailure, ONLINE_MS,
} from "../components/LanSyncSection";

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
    expect(MODAL).toMatch(/checking\s*\?\s*"checking…"\s*:\s*"check now"/);
    expect(MODAL).toMatch(/joining\s*\?\s*"joining…"\s*:\s*"join"/);
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
    // Above the roster, which is the only other thing in the section.
    expect(ask).toBeLessThan(CODE.indexOf('className="ap-lan-here"'));
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

describe("who is here, which is what the panel is for now", () => {
  const NOW2 = 1_700_000_000_000;
  const peer = (over: Record<string, unknown> = {}) => ({ fp: "a", name: "Deck", addr: "", port: 0, ...over });

  it("counts a deck that beacons recently as here", () => {
    expect(isOnline(peer({ lastSeen: NOW2 - 10_000 }) as never, NOW2)).toBe(true);
    expect(isOnline(peer({ lastSeen: NOW2 - ONLINE_MS - 1 }) as never, NOW2)).toBe(false);
  });

  it("counts a deck reached by address, which never beacons at all", () => {
    // The only evidence for a typed peer is whether the last round got through,
    // and that is exactly what a person means by "is it up".
    expect(isOnline(peer({ last: { at: NOW2 - 5_000, done: [] } }) as never, NOW2)).toBe(true);
  });

  it("counts a deck it can hear and cannot talk to as away", () => {
    // A round that failed is offline whatever the beacon says: somewhere you
    // cannot send an account is not somewhere that is here.
    expect(isOnline(peer({ lastSeen: NOW2, last: { at: NOW2, error: "timed out" } }) as never, NOW2)).toBe(false);
  });

  it("splits the roster so the panel can list one half and count the other", () => {
    const { online, offline } = rosterSplit([
      peer({ fp: "a", lastSeen: NOW2 }),
      peer({ fp: "b", lastSeen: NOW2 - 10 * 60_000 }),
    ] as never, NOW2);
    expect(online.map(p => p.fp)).toEqual(["a"]);
    expect(offline.map(p => p.fp)).toEqual(["b"]);
  });

  it("says what is happening in one line, in the words a person would use", () => {
    expect(sectionState(null, NOW2).text).toMatch(/^off/);
    expect(sectionState({ enabled: true, running: false }, NOW2).text).toBe("starting…");
    expect(sectionState({ enabled: true, running: true, peers: [] }, NOW2))
      .toEqual({ text: "no decks paired yet", tone: "idle" });
    expect(sectionState({ enabled: true, running: true, peers: [peer({ lastSeen: NOW2 })] as never }, NOW2))
      .toEqual({ text: "1 deck here", tone: "ok" });
    expect(sectionState({
      enabled: true, running: true,
      peers: [peer({ fp: "a", lastSeen: NOW2 }), peer({ fp: "b", lastSeen: NOW2 - 10 * 60_000 })] as never,
    }, NOW2)).toEqual({ text: "1 deck here · 1 away", tone: "ok" });
  });

  it("leads with a request, because until it is answered nothing moves", () => {
    expect(sectionState({
      enabled: true, running: true, pending: [{ fp: "a", name: "x", addr: "y", at: NOW2 }],
      peers: [peer({ lastSeen: NOW2 })] as never,
    }, NOW2)).toEqual({ text: "one deck is asking to pair", tone: "wait" });
  });

  it("says it plainly when nothing is reachable, rather than counting to zero", () => {
    expect(sectionState({
      enabled: true, running: true,
      peers: [peer({ last: { at: NOW2, error: "timed out" } })] as never,
    }, NOW2)).toEqual({ text: "the paired deck is not reachable", tone: "bad" });
  });

  it("counts an invite down in minutes and seconds, which is how it is read out", () => {
    expect(leftLabel(NOW2 + 600_000, NOW2)).toBe("10:00");
    expect(leftLabel(NOW2 + 61_000, NOW2)).toBe("1:01");
    expect(leftLabel(NOW2 + 9_000, NOW2)).toBe("0:09");
    expect(leftLabel(NOW2 - 5_000, NOW2)).toBe("0:00");
  });
});

describe("the invite, which is one piece of text and every address", () => {
  it("carries all of them, because nobody knows which one routes", async () => {
    const { mintInvite, readInvite } = await import("../../server/lan-sync.mjs");
    const made = mintInvite({ addrs: ["100.67.32.58:49336", "192.168.1.82:49336"], name: "Constantins-iMac" });
    const read = readInvite(made.token);
    expect(read.addrs).toEqual([
      { addr: "100.67.32.58", port: 49336 },
      { addr: "192.168.1.82", port: 49336 },
    ]);
    expect(read.name).toBe("Constantins-iMac");
    expect(read.code).toBe(made.code);
  });

  it("tells an expired one apart from a thing that is not an invite", async () => {
    // Two different instructions for the reader: ask for a new one, or paste
    // the whole thing. A reader who cannot tell them apart retypes the same.
    const { mintInvite, readInvite, INVITE_MS } = await import("../../server/lan-sync.mjs");
    const made = mintInvite({ addrs: ["1.2.3.4:5"], name: "x", now: 1_000 });
    expect(readInvite(made.token, 1_000).expired).toBe(false);
    expect(readInvite(made.token, 1_000 + INVITE_MS + 1).expired).toBe(true);
    for (const junk of ["", "hello", "ccdeck1.", "ccdeck1.!!!", "ccdeck2.abc", null, 5]) {
      expect(readInvite(junk as string), String(junk)).toBeNull();
    }
  });

  it("has a code that is six digits and evenly drawn", async () => {
    // A modulo over a byte would make 0-5 likelier than 6-9, in the one number
    // that decides whether a stranger can pair.
    const { inviteCode } = await import("../../server/lan-sync.mjs");
    const seen = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const c = inviteCode();
      expect(c).toMatch(/^[0-9]{6}$/);
      for (const d of c) seen.set(d, (seen.get(d) ?? 0) + 1);
    }
    const counts = [...Array(10).keys()].map(d => seen.get(String(d)) ?? 0);
    expect(Math.min(...counts)).toBeGreaterThan(Math.max(...counts) * 0.6);
  });

  it("proves the holder without ever sending the code", async () => {
    const { inviteProof } = await import("../../server/lan-sync.mjs");
    const a = inviteProof("482100", "fpA|fpB|c1|c2");
    expect(a).not.toContain("482100");
    // Bound to the transcript, so a recording of one exchange is worth nothing.
    expect(inviteProof("482100", "fpA|fpB|c1|c3")).not.toBe(a);
    expect(inviteProof("482101", "fpA|fpB|c1|c2")).not.toBe(a);
  });

  it("refuses a token built to make this deck dial a list", async () => {
    const { mintInvite, MAX_INVITE_ADDRS, readInvite } = await import("../../server/lan-sync.mjs");
    const many = Array.from({ length: 50 }, (_, i) => `10.0.0.${i}:5000`);
    const made = mintInvite({ addrs: many, name: "x" });
    expect(readInvite(made.token).addrs).toHaveLength(MAX_INVITE_ADDRS);
  });
});

describe("the list of decks nearby, which was a wall of ghosts", () => {
  const T = 1_700_000_000_000;
  const heard = (over: Record<string, unknown> = {}) => ({ fp: "a", name: "Deck-A", addr: "192.168.1.82", port: 1, at: T, ...over });

  it("drops a deck nobody has heard from in a while", async () => {
    // Every deck ever heard stayed forever, so a machine started and stopped
    // seven times was seven rows — same name, same address, none of them
    // reachable. That is what made the dialog unreadable.
    const { pairable, PRESENT_MS } = await import("../../server/lan-sync.mjs");
    const live = heard({ at: T - 1_000 });
    const gone = heard({ fp: "b", name: "Deck-B", at: T - PRESENT_MS - 1 });
    expect(pairable([live, gone], T).shown.map((p: { fp: string }) => p.fp)).toEqual(["a"]);
  });

  it("shows one row per machine, keeping the one still running", async () => {
    // A deck that restarts takes a new key, so the same machine arrives under a
    // new fingerprint. To the person reading, a name at an address is a
    // machine — and the freshest of them is the one still there.
    const { pairable } = await import("../../server/lan-sync.mjs");
    const shown = pairable([
      heard({ fp: "old", at: T - 40_000 }),
      heard({ fp: "new", at: T - 1_000 }),
      heard({ fp: "other", name: "Deck-B", at: T - 2_000 }),
    ], T).shown;
    expect(shown.map((p: { fp: string }) => p.fp)).toEqual(["new", "other"]);
  });

  it("puts the deck somebody just started at the top", async () => {
    const { pairable } = await import("../../server/lan-sync.mjs");
    const shown = pairable([
      heard({ fp: "a", name: "A", at: T - 50_000 }),
      heard({ fp: "b", name: "B", at: T - 1_000 }),
    ], T).shown;
    expect(shown.map((p: { name: string }) => p.name)).toEqual(["B", "A"]);
  });

  it("caps the list and says how many it did not show", async () => {
    const { pairable } = await import("../../server/lan-sync.mjs");
    const many = Array.from({ length: 14 }, (_, i) => heard({ fp: `f${i}`, name: `Deck-${i}`, at: T - i }));
    const out = pairable(many, T, { limit: 8 });
    expect(out.shown).toHaveLength(8);
    expect(out.more).toBe(6);
  });

  it("survives an empty list and junk in it", async () => {
    const { pairable } = await import("../../server/lan-sync.mjs");
    expect(pairable([], T).shown).toEqual([]);
    expect(pairable(null as never, T).shown).toEqual([]);
    expect(pairable([null, {}, heard()] as never, T).shown).toHaveLength(1);
  });
});

describe("what did not change", () => {
  it("still refuses an address with no usable port", () => {
    expect(parseAddress("192.168.1.5:54340")).toEqual({ addr: "192.168.1.5", port: 54340 });
    for (const bad of ["192.168.1.5", "192.168.1.5:", ":54340", "192.168.1.5:0", "192.168.1.5:70000"]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });

  it("still says the thing that cannot be softened, where the decision is", () => {
    // It moved with the checkboxes, and a clarify pass changed the words. What
    // is pinned is the MEANING, in the two halves that have to survive any
    // rewrite: another machine keeps its own copy, and untick does not take
    // that copy back. Pinning the sentence verbatim would have made honest
    // rewording look like a regression.
    const warn = /<p className="lan-warn">([\s\S]*?)<\/p>/.exec(MODAL)?.[1] ?? "";
    expect(warn).toMatch(/keeps its own copy/);
    expect(warn).toMatch(/does not take back/);
    expect(MODAL.indexOf("lan-warn")).toBeLessThan(MODAL.indexOf('type="checkbox"'));
  });

  it("still says the deck's name is public, where the field is", () => {
    // The beacon carries it in the clear to everyone on the network, paired or
    // not. It is said beside the field, which moved into the dialog with it.
    expect(MODAL).toMatch(/Everyone on this network can see this name/);
  });
});
