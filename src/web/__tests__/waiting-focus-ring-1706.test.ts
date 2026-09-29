// #1706: the blocked-session chip's focus ring showed as two brackets.
//
// `.topbar .readout` clips what overflows it — that is how it gives width up
// from the left on a narrow window — and it is exactly as tall as the chip, so
// the global ring, a 2px outline 2px outside the element, lost its top and
// bottom. The ring is pulled inside the chip's own edge, which is the one move
// DESIGN.md's focus rule lets a component make; its colour and width stay the
// global ones.
import { describe, expect, it } from "vitest";
import { sheetText } from "./sheet-source";

const css = sheetText();

describe("the topbar chips' focus rings", () => {
  it("are drawn inside the chip, where the readout cannot clip them", () => {
    expect(css).toContain(".topbar .waiting-stat:focus-visible { outline-offset: -3px; }");
    expect(css).toContain(".topbar .provider-incident:focus-visible { outline-offset: -3px; }");
  });

  it("move only the offset, never the ring's colour or width", () => {
    for (const rule of css.match(/\.topbar \.(?:waiting-stat|provider-incident):focus-visible \{[^}]*\}/g) ?? []) {
      expect(rule).not.toMatch(/outline(?:-color|-width|-style)?:/);
    }
  });

  it("clip because the readout does, which is why this is needed", () => {
    expect(css).toMatch(/\.topbar \.readout \{[^}]*overflow: hidden;/);
  });
});
