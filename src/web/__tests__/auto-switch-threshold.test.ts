// What the auto-switch threshold picker can show.
//
// `cswap config set autoswitch.threshold` takes any number, and a <select>
// whose value is not one of its options shows its first option instead — a
// setting the loop is not using, on the one control that says what the loop
// does. thresholdChoices keeps the stored value on offer; these pin that, and
// that it adds nothing when there is nothing to add.
import { describe, expect, it } from "vitest";

import { thresholdChoices } from "../auto-switch-threshold";

describe("the threshold picker's options", () => {
  it("offers the five when the store holds one of them", () => {
    for (const stored of ["70", "80", "85", "90", "95"]) {
      expect(thresholdChoices(stored), stored).toEqual([70, 80, 85, 90, 95]);
    }
  });

  it("keeps a value set from the terminal on offer, in order", () => {
    expect(thresholdChoices("88")).toEqual([70, 80, 85, 88, 90, 95]);
    expect(thresholdChoices("50")).toEqual([50, 70, 80, 85, 90, 95]);
    expect(thresholdChoices("99.5")).toEqual([70, 80, 85, 90, 95, 99.5]);
  });

  it("adds nothing for a value that is not a threshold at all", () => {
    for (const stored of ["", "abc", "0", "-5", "NaN", "Infinity"]) {
      expect(thresholdChoices(stored), JSON.stringify(stored)).toEqual([70, 80, 85, 90, 95]);
    }
  });

  it("hands back a list of its own, so a caller cannot reorder the five", () => {
    const shown = thresholdChoices("90");
    shown.reverse();
    expect(thresholdChoices("90")).toEqual([70, 80, 85, 90, 95]);
  });
});
