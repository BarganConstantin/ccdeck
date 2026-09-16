// #828 AND ITS REVERSAL, IN ONE PLACE.
//
// What #828 found: "Say yes to every deck that asks" paired any deck on the
// network from one unguarded press, on a switch drawn exactly like the harmless
// "Ask every deck this one finds" beside it. One mis-toggle offered the logins
// this deck shares to any machine that asked. It answered that with three
// things — a second press to turn it on, --warn on the switch, and a line under
// it saying what it gives away.
//
// What changed on 2026-09-16, at the owner's asking: the switch ships ON, so
// the second press no longer stood between a reader and a state their deck was
// not already in. It stood between them and the state it WAS in — and the
// direction people actually reach for it, turning it off, was never armed. A
// first press that does nothing visible reads as broken, and that is how it was
// reported.
//
// So the arming is gone and the other two stay. This file holds the line: one
// press either way, the warning ink, and the sentence that names what is given
// away. It also pins that nothing else grew a second press in its place.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const MODAL = read("../components/LanSetupModal.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The <button …> whose accessible name is `label`, attributes and handlers. */
const button = (label: string): string => {
  const at = MODAL.indexOf(`aria-label="${label}"`);
  expect(at, label).toBeGreaterThan(-1);
  const open = MODAL.lastIndexOf("<button", at);
  return MODAL.slice(open, MODAL.indexOf("<span className=\"switch-knob\"", at));
};
const yes = button("Say yes to every deck that asks");
const ask = button("Ask every deck this one finds");

describe("one press, in both directions (#828, reversed)", () => {
  it("writes on the first press, the way the switch beside it does", () => {
    expect(yes).toMatch(/onClick=\{\(\) => void write\(\s*\{ autoAccept: !says \}/);
    // The shape that made it read as broken: a first press that armed instead
    // of writing, and a second that wrote.
    expect(MODAL).not.toMatch(/armedAccept|setArmedAccept|CONFIRM_GAP_MS/);
  });

  it("keeps a held key from being two decisions", () => {
    // The one guard that survives, because it is about the keyboard repeating
    // rather than about the reader hesitating.
    expect(yes).toMatch(/onKeyDown=\{e => \{ if \(e\.repeat\) e\.preventDefault\(\); \}\}/);
  });

  it("leaves nothing behind that armed a switch", () => {
    // The edge and knob the armed state wore. A rule no markup can reach is a
    // rule that outlives its reason.
    expect(css).not.toMatch(/\.switch\[data-armed/);
    expect(MODAL).not.toMatch(/data-armed/);
  });
});

describe("it still looks and reads like what it does (#828)", () => {
  it("marks only this switch as the one that gives something away", () => {
    expect(yes).toMatch(/data-tone="warn"/);
    expect(ask).not.toMatch(/data-tone|data-armed/);
  });

  it("fills with --warn when on", () => {
    expect(css).toMatch(/\.switch\[data-tone="warn"\]\[aria-checked="true"\] \{ border-color: var\(--warn\); background: var\(--warn\); \}/);
    // After the shared hover rule, so a pointer resting on it keeps the warning.
    expect(css.indexOf('.switch[data-tone="warn"]')).toBeGreaterThan(css.indexOf(".switch:hover:not(:disabled) {"));
  });

  it("says what it gives away on the control, not in a paragraph under it", () => {
    // The line under the switches is gone (owner's call, 2026-09-16). With the
    // setting shipping ON, that paragraph was yellow at rest — a warning about
    // the way the deck comes out of the box, repeating the label above it.
    expect(MODAL).not.toMatch(/lan-warn/);
    expect(MODAL).not.toMatch(/without you being asked/);
    // So the switch has to carry it alone: the label names the act, the tone
    // marks it as the one that costs something, and the title says the rest.
    expect(yes).toMatch(/aria-label="Say yes to every deck that asks"/);
    expect(yes).toMatch(/data-tone="warn"/);
    expect(yes).toMatch(/paired without anybody being asked here\."\}/);
  });

  it("names the gate that the default rests on, where the default is written", () => {
    // The whole argument for shipping it on: pairing is a name in a list, and
    // a paired deck is offered nothing until somebody ticks a login. If that
    // ever stops being true, this reads as the place that said it was.
    const prefs = read("../../server/deck-prefs.mjs");
    expect(prefs).toMatch(/autoAccept: true,/);
    expect(prefs).toMatch(/offered NOTHING until somebody ticks a\s+\/\/ login here/);
  });
});
