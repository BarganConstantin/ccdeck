// #815: the pair dialog asked for a comparison nobody could make.
//
// When another deck asks to pair, LanPairRequestModal prints the requester's
// fingerprint and said it "should match the one on their screen" — but no
// screen in the deck showed its own. The line had been taken out of "This deck
// on the network" on purpose, as the cost of a dialog that had grown three
// paragraphs of prose around two controls. Comparing fingerprints is the only
// check a person can make against a rogue deck on the network, and pairing
// hands over logins.
//
// The owner chose the fix on 2026-09-14: the fingerprint comes back as one
// monospace line with a copy word and no prose, and the request names where the
// other machine shows it. Read as text, the way the LAN dialogs are read
// elsewhere in this suite.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const setup = read("../components/LanSetupModal.tsx");
const ask = read("../components/LanPairRequestModal.tsx");

/** Markup only: the prose in these files quotes the lines it replaced. */
const code = (src: string) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

/** The fingerprint row, from its label to the row's closing tag. */
const row = /<span className="ap-lan-label">fingerprint<\/span>[\s\S]*?\n {12}<\/div>/.exec(code(setup))?.[0] ?? "";

describe("this deck's own fingerprint is on screen again (#815)", () => {
  it("is printed in This deck on the network, as code", () => {
    expect(row).toMatch(/<code className="ap-lan-code">\{status\.fp\}<\/code>/);
    expect(setup).toMatch(/>This deck on the network</);
  });

  it("can be copied, through the one clipboard helper the deck has", () => {
    expect(setup).toMatch(/import \{ copyText \} from "\.\.\/copy-text";/);
    expect(code(setup)).toMatch(/copyText\(status\.fp\)/);
    expect(row).toMatch(/onClick=\{\(\) => void copyFingerprint\(\)\}/);
  });

  it("carries no sentence of its own", () => {
    // A label, the value and a copy word. The prose it used to have is what
    // took it out of this dialog the first time.
    expect(row).not.toBe("");
    expect(row).not.toMatch(/<p\b|modal-note/);
  });
});

describe("the request says where the other machine shows it (#815)", () => {
  it("no longer points at a screen nobody could find", () => {
    expect(code(ask)).not.toMatch(/the one on their screen/);
  });

  it("names the dialog that prints it", () => {
    expect(code(ask)).toMatch(/This deck on the network/);
  });
});
