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

describe("how long ago the deck last looked", () => {
  it("says `just now` rather than reading a zero off a clock", async () => {
    // "0 sec ago" is a machine speaking. Under five seconds a person says
    // "just now", and this line is read most often at exactly that moment —
    // the panel polls every ten seconds while it is open.
    const { agoLabel } = await import("../components/BrowserWatchModal");
    const now = 1_000_000;
    expect(agoLabel(now, now)).toBe("just now");
    expect(agoLabel(now - 4_000, now)).toBe("just now");
    expect(agoLabel(now - 6_000, now)).toBe("6 sec ago");
  });

  it("climbs through seconds, minutes and hours", async () => {
    const { agoLabel } = await import("../components/BrowserWatchModal");
    const now = 10_000_000;
    expect(agoLabel(now - 45_000, now)).toBe("45 sec ago");
    expect(agoLabel(now - 4 * 60_000, now)).toBe("4 min ago");
    expect(agoLabel(now - 3 * 3600_000, now)).toBe("3 hr ago");
    // Nothing read yet is a different answer from "a long time ago".
    expect(agoLabel(null, now)).toBeNull();
  });
});
