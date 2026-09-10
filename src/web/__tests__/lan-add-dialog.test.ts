// `+ add a deck` is two methods and three tasks, and for one release it drew
// them as two methods and a stray button.
//
// The dialog held BY ADDRESS (heading, field, three lines of prose) and WITH AN
// INVITE (heading, field, one line of prose), and then `make an invite for
// them` — full width, bordered, centred, at the foot of the invite section,
// directly under that section's help. Which is the position a form puts its
// submit and the heaviest mark in the dialog, spent on the one action that does
// not add a deck at all: it is the OTHER DIRECTION of the invite method, where
// they add this deck rather than this deck adding them.
//
// This file pins what the rewrite decided, in the two places a regression would
// actually land: the shape of the dialog, and the sentences that carry the one
// difference a reader is choosing between.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addressFault, faultLine } from "../components/LanAddDeckModal";
import { parseAddress, writeFailure } from "../components/LanSyncSection";

/** The dialog, with its comments taken out, so no rule here can be satisfied by
 *  a paragraph that describes it. */
const ADD = readFileSync(
  fileURLToPath(new URL("../components/LanAddDeckModal.tsx", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const CSS = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

/** The body of the first rule whose selector matches, comments stripped. */
function rule(selector: string): string {
  const at = CSS.indexOf(selector + " {");
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return CSS.slice(at, CSS.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, " ");
}

describe("two ways in, drawn as two of a kind", () => {
  it("puts the mint on the invite heading's own row, not under the field as its submit", () => {
    // THE DEFECT. `lan-add-mint` was `width: 100%` and centred, so the strongest
    // thing on screen was the action that does not add a deck — and it sat
    // where a form's submit sits, one line under the paste field's help, so it
    // read as the commit for the field above it.
    expect(ADD).not.toContain("lan-add-mint");
    expect(CSS).not.toContain("lan-add-mint");
    const head = /<h3 className="lan-h">\s*With an invite([\s\S]*?)<\/h3>/.exec(ADD);
    expect(head, "the invite heading carries the other direction").not.toBeNull();
    expect(head?.[1]).toMatch(/lan-h-act/);
    expect(head?.[1]).toMatch(/invite\("make"\)/);
    // Quiet, and quiet on purpose: no border, no fill, the heading's own ink.
    // A bordered pill here would put it back in competition with `join`.
    expect(head?.[1]).not.toMatch(/ap-manage-btn/);
    // It goes away while one is live, because the card below is then the thing
    // to act on and a deck may only offer one token at a time.
    expect(ADD).toMatch(/\{!live && \(/);
  });

  it("gives each method the same three parts, so the pair reads as a pair", () => {
    // Identical rhythm twice is the whole of "there are two ways in" — no card,
    // no rule, no word spent saying it. The prose used to be three lines under
    // one field and one under the other, which made them look like a main way
    // and an afterthought.
    const sections = [...ADD.matchAll(/<h3 className="lan-h">([\s\S]*?)<\/div>\s*<p className="lan-note">([\s\S]*?)<\/p>/g)];
    expect(sections.length).toBe(2);
    for (const [, , note] of sections) {
      const words = note.trim().split(/\s+/).length;
      expect(words, note.trim()).toBeLessThan(14);
    }
    // And the sentence each one spends is the SAME question answered two ways,
    // because that is the difference a reader is choosing between. Pinned by
    // meaning rather than verbatim, so an honest rewording is not a regression.
    expect(sections[0][2]).toMatch(/accepts/);
    expect(sections[1][2]).toMatch(/nobody has to accept/);
  });

  it("leaves no gutter open for a verb that is not there", () => {
    // The alternative was tried and measured. Holding 70px open for the verb
    // #620 keeps out of an empty row stops the field shrinking once on the
    // first keystroke, and charges for it a permanent ragged right edge: both
    // fields inset from the one the heading's own verb sits on, every time the
    // dialog opens. The resting composition is the one a reader always sees.
    expect(ADD).not.toMatch(/ap-lan-verb/);
    expect(CSS).not.toMatch(/ap-lan-verb/);
    // The gap BETWEEN the two methods has to beat every gap inside one of them,
    // or distance stops grouping anything. A heading sits 6px off its field.
    const gap = /gap:\s*(\d+)px/.exec(rule(".modal.lan-add .modal-body"))?.[1];
    expect(Number(gap)).toBeGreaterThan(20);
  });
});

describe("a refusal says what to do about it", () => {
  it("names which of the three mistakes an address is, because each has its own correction", () => {
    // One sentence covered a missing port, a typo and an IPv6 address written
    // without brackets — three mistakes with three different fixes. The shape
    // is shown rather than described: a person fixing a typed address copies
    // the example.
    expect(addressFault("")).toMatch(/192\.168\.1\.5:54340/);
    expect(addressFault("192.168.1.5")).toMatch(/port/);
    expect(addressFault("192.168.1.5")).toMatch(/192\.168\.1\.5:54340/);
    expect(addressFault("10.0.0.1:")).toMatch(/missing its port/);
    expect(addressFault("192.168.1.5:abc")).toMatch(/number/);
    expect(addressFault("192.168.1.5:70000")).toMatch(/1 to 65535/);
    expect(addressFault("fe80::1:54340")).toMatch(/colons/);
    // And it promises nothing about IPv6, because nothing downstream delivers
    // it: lan-engine splits a stored entry on its last colon too.
    expect(addressFault("fe80::1:54340")).not.toMatch(/\[/);
  });

  it("refuses an unbracketed IPv6 address rather than dialling its last group", () => {
    // `fe80::1` parsed as the host `fe80:` on port 1 — a well-formed entry
    // pointing at nothing, which the list then reports as a failure every
    // minute and no correction fixes, because nothing looks wrong with what was
    // typed.
    expect(parseAddress("fe80::1")).toBeNull();
    expect(parseAddress("fe80::1:54340")).toBeNull();
    expect(parseAddress("[fe80::1]:54340")).toEqual({ addr: "[fe80::1]", port: 54340 });
    expect(parseAddress("192.168.1.5:54340")).toEqual({ addr: "192.168.1.5", port: 54340 });
  });

  it("says what an engine reason means, and still prints one it has never seen", () => {
    // `the deck refused it (expired)` is a code where a next move belongs. A
    // reason this dialog does not know still falls through whole, so a new one
    // is reported rather than swallowed by a guess.
    const known = { expired: "That invite has run out. Ask them for a fresh one." };
    expect(faultLine(known, { ok: false, reason: "expired" }, "use that invite"))
      .toBe(known.expired);
    expect(faultLine(known, { ok: false, reason: "wedged" }, "use that invite"))
      .toBe(writeFailure("use that invite", { ok: false, reason: "wedged" }));
    expect(faultLine(known, null, "use that invite")).toBe(writeFailure("use that invite", null));
  });

  it("ties the message to the field that caused it", () => {
    // One alert box at the top of a dialog with two fields cannot say which one
    // it is about to somebody who is not looking at the top of the dialog.
    expect(ADD).toMatch(/id="lan-add-failure"/);
    expect(ADD).toMatch(/"aria-describedby": "lan-add-failure"/);
    expect(ADD).toMatch(/"aria-invalid": true/);
  });

  it("does not add an address the list already has, or a deck already paired", () => {
    // Both wrote, both closed the dialog, and the list behind it looked exactly
    // as it had — so typing the address of a deck you are already paired with
    // was indistinguishable from typing one that has not answered yet.
    expect(ADD).toMatch(/Already paired with/);
    expect(ADD).toMatch(/already calls that address/);
  });

  it("reports an unreachable invite once, in the list of what was tried", () => {
    // The alert said "nothing answered" at the top of the dialog and the block
    // under the field said it again, with the dialog's whole body pushed down
    // between the two.
    expect(ADD).toMatch(/out\?\.reason === "unreachable"/);
    expect(ADD).toMatch(/setTried\(out\.tried\);\s*setFailure\(null\)/);
  });
});
