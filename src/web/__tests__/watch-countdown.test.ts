import { describe, it, expect } from "vitest";
import { armsIn, untilLabel } from "../components/BrowserWatchModal";

describe("when a program page would start counting", () => {
  it("counts down from the last visit a person made", () => {
    // The shell tool counted down to "armed" off the keyboard's idle clock.
    // There is no keyboard here: the gate is measured from the last navigation
    // a PERSON made, so this is the same question asked of the evidence the
    // watch actually has.
    const now = 1_000_000;
    expect(armsIn(now - 60_000, 15 * 60_000, now)).toBe(14 * 60_000);
  });

  it("says nothing once the gate is already open", () => {
    // Null rather than zero: the bar reads it as "there is no countdown to
    // show", which is a different sentence from "0s".
    const now = 1_000_000;
    expect(armsIn(now - 20 * 60_000, 15 * 60_000, now)).toBeNull();
    // And when nobody has browsed at all since the deck started.
    expect(armsIn(null, 15 * 60_000, now)).toBeNull();
  });

  it("keeps seconds all the way up", () => {
    // A countdown that rounds to minutes appears frozen for a minute at a time,
    // which is the one thing a countdown must not do.
    expect(untilLabel(45_000)).toBe("45s");
    expect(untilLabel(150_000)).toBe("2m 30s");
    expect(untilLabel(1)).toBe("1s");
  });
});
