// The accounts panel's two clock words, run rather than read.
//
// `ago` was pinned by the text of its one line and `due` by nothing, because
// both lived inside the component and the suite has no DOM to render it in.
// They are plain functions in account-freshness.ts now, so the thresholds each
// one promises in its doc are asserted here as behaviour.
import { describe, expect, it } from "vitest";

import { ago, due } from "../account-freshness";
import { shortAgo } from "../relative-time";

describe("how old an account's numbers are", () => {
  it("says the relative-time dialect, at the panel's second resolution", () => {
    const nowSec = 1_800_000_000;
    expect(ago(nowSec * 1000, nowSec)).toBe("just now");
    expect(ago((nowSec - 59) * 1000, nowSec)).toBe("just now");
    expect(ago((nowSec - 60) * 1000, nowSec)).toBe("1m ago");
    expect(ago((nowSec - 3600) * 1000, nowSec)).toBe("1h ago");
    expect(ago((nowSec - 86400) * 1000, nowSec)).toBe("1d ago");
  });

  it("floors the stamp before subtracting, which is where the millisecond form lands a second low", () => {
    // The whole reason the wrapper exists. A stamp half a second into the
    // second a minute back is a minute old to a clock that only has whole
    // seconds; subtract first and floor after, and it is fifty-nine and a half,
    // which is "just now". Every threshold moves by that second.
    const nowSec = 1_800_000_000;
    const at = (nowSec - 60) * 1000 + 500;
    expect(ago(at, nowSec)).toBe("1m ago");
    expect(shortAgo(nowSec * 1000 - at)).toBe("just now");
  });

  it("does not count a clock that was set back as a negative age", () => {
    expect(ago(1_800_000_100_000, 1_800_000_000)).toBe("just now");
  });
});

describe("when claude-swap reads an account next", () => {
  const nowSec = 1_800_000_000;
  const at = (s: number) => (nowSec + s) * 1000;

  it("says nothing when there is no plan", () => {
    expect(due(null, nowSec)).toBe("");
    // A stamp of zero is no plan either, not the start of the epoch.
    expect(due(0, nowSec)).toBe("");
  });

  it("says `due` once the read is due, rather than counting to zero and lingering", () => {
    expect(due(at(0), nowSec)).toBe(" · due");
    expect(due(at(-600), nowSec)).toBe(" · due");
  });

  it("counts seconds under a minute and rounds to minutes past it", () => {
    expect(due(at(1), nowSec)).toBe(" · next in 1s");
    expect(due(at(59), nowSec)).toBe(" · next in 59s");
    expect(due(at(60), nowSec)).toBe(" · next in 1m");
    expect(due(at(89), nowSec)).toBe(" · next in 1m");
    expect(due(at(90), nowSec)).toBe(" · next in 2m");
    expect(due(at(15 * 60), nowSec)).toBe(" · next in 15m");
  });

  it("floors the planned stamp to the panel's second, as `ago` does", () => {
    // Half a second into the next second is still that second: `next in 1s`,
    // never a `due` for a read that has not happened yet.
    expect(due(at(1) + 999, nowSec)).toBe(" · next in 1s");
    expect(due(at(0) + 999, nowSec)).toBe(" · due");
  });
});
