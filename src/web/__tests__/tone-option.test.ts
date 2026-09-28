// A tone's <select> value, both ways (#1207). One select offers the built-in
// figures and the custom sounds, and the value is one string, so which kind a
// choice is rides in the string. The rule that matters is that the two kinds
// cannot be confused: a figure read as a custom sound would point the tone at
// a sound that does not exist, and a custom sound read as a figure would set
// the tone to an id no figure has — which figureIdFrom quietly turns into the
// default, so the person's choice would vanish without a word.
import { describe, it, expect } from "vitest";
import { customIdOf, customOptionValue } from "../tone-option";
import { FIGURE_SETS } from "../sound";
import { newAssetId } from "../notification-audio";

describe("a tone's select value", () => {
  it("gives back the custom sound it was made from", () => {
    const ids = [
      "856d9ed9-bd0a-4171-b566-11cbb7be78ff",   // crypto.randomUUID
      "mg3k9x2a-4f7q1z0b",                      // newAssetId's fallback off a secure context
      newAssetId(),
      "custom:nested",                          // an id that happens to carry the prefix
      "",
    ];
    for (const id of ids) expect(customIdOf(customOptionValue(id)), JSON.stringify(id)).toBe(id);
  });

  it("never reads a built-in figure as a custom sound", () => {
    for (const set of Object.values(FIGURE_SETS)) {
      for (const figure of set) expect(customIdOf(figure.id), figure.id).toBeNull();
    }
  });

  it("never makes a custom sound's value equal to a figure's", () => {
    const figures = new Set(Object.values(FIGURE_SETS).flatMap(set => set.map(f => f.id)));
    for (const id of [...figures, "two", "bell"]) expect(figures.has(customOptionValue(id)), id).toBe(false);
  });
});
