// One wait, one precision. V4 draws a session's wait as "6m 42s" in the rail
// row, the pane's header ("waiting 6m 42s"), the empty pane and the phone's
// row alike, and a running turn the same way ("4m 33s"); the row had dropped
// the seconds from a minute on while the empty pane kept them, so one wait
// read two ways on one screen. Ages ("3m ago", "read 12m ago") keep the
// minute, and an hour reads "1h 15m" as before.
//
// The countdown to a quota reset takes two digits for its minutes once an hour
// leads them, as V4 draws every reset: "Resets in 2h 09m".
import { describe, it, expect } from "vitest";
import { agoShort, clockShort, elapsedShort } from "../elapsed-short";
import { railTime } from "../rail-row-copy";
import { waitedFor } from "../components/terminal/stage-model";
import { barAsks, waitingCardFor } from "../components/terminal/stage-board";
import { resetCountdown } from "../relative-time";
import { durationLabel } from "../i18n/format";
import { translate } from "../i18n/translate";
import { en } from "../i18n/en";
import type { Row } from "../components/SessionList";
import type { BlockedSession } from "../ambient-counts";

const NOW = 10_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

describe("the clock a wait and a turn are counted in", () => {
  it("reads to the second under an hour, the seconds padded once a minute leads", () => {
    expect(clockShort(42)).toBe("42s");
    expect(clockShort(6 * 60 + 42)).toBe("6m 42s");
    expect(clockShort(6 * 60 + 7)).toBe("6m 07s");
    expect(clockShort(60)).toBe("1m 00s");
    expect(clockShort(59 * 60 + 59)).toBe("59m 59s");
  });

  it("keeps the hour as it was: hours and minutes, no seconds", () => {
    expect(clockShort(3600)).toBe("1h 0m");
    expect(clockShort(75 * 60 + 12)).toBe("1h 15m");
    expect(clockShort(2 * 3600 + 5 * 60 + 59)).toBe("2h 5m");
  });

  it("says under a second as the row always has, and the header as \"0s\"", () => {
    expect(elapsedShort(NOW - 400, undefined, NOW)).toBe("<1s");
    expect(waitedFor(400)).toBe("0s");
    expect(waitedFor(-5)).toBe("0s");
  });

  it("keeps an age to the minute", () => {
    expect(agoShort(NOW - (3 * MIN + 12 * SEC), undefined, NOW)).toBe("3m");
    expect(agoShort(NOW - 42 * SEC, undefined, NOW)).toBe("42s");
    expect(agoShort(NOW - 400, undefined, NOW)).toBe("<1s");
    expect(agoShort(NOW - 75 * MIN, undefined, NOW)).toBe("1h 15m");
  });

  it("is one clock for the row, the header, the empty pane and the next ask, at every second past the first", () => {
    const moved: number[] = [];
    for (let s = 1; s < 30 * 3600; s += 7) {
      const ms = s * SEC;
      if (elapsedShort(NOW - ms, undefined, NOW) !== waitedFor(ms)) moved.push(s);
    }
    expect(moved).toEqual([]);
  });
});

describe("where the deck prints a wait", () => {
  const waiting = { kind: "permission", message: "", since: NOW - (6 * MIN + 42 * SEC), tool: { name: "Bash", preview: "npm test" } } as Row["waiting"];

  it("prints the rail row's wait and turn to the second, and its age to the minute", () => {
    const row = { waiting, startedAt: NOW - 30 * MIN, turnStartedAt: NOW - (4 * MIN + 33 * SEC), turnEndedAt: NOW - (3 * MIN + 20 * SEC), neverPrompted: false } as Row;
    expect(railTime(row, 0, NOW)?.text).toBe("6m 42s");
    expect(railTime(row, 1, NOW)?.text).toBe("4m 33s");
    expect(railTime({ ...row, waiting: null } as Row, 2, NOW)?.text).toBe("3m ago");
  });

  it("prints the empty pane's and the next ask's wait as the row does", () => {
    const blocked: BlockedSession[] = [{ id: "s1", label: "web-api", waiting: waiting as BlockedSession["waiting"] }];
    expect(waitingCardFor(blocked, NOW)?.waited).toBe("6m 42s");
    const asks = barAsks({ track: ["s0", "s1"], position: null, next: { id: "s1", label: "web-api" }, resumed: null, clear: false } as unknown as Parameters<typeof barAsks>[0], blocked, NOW);
    expect(asks?.next?.waited).toBe("6m 42s");
  });
});

describe("the countdown to a quota reset", () => {
  const tEn = (key: never, vars?: Record<string, string | number>) => translate("en", en, key, vars);

  it("pads the minutes once an hour leads them, and only then", () => {
    expect(resetCountdown(1000 + 2 * 3600 + 9 * 60, 1000)).toBe("2h 09m");
    expect(resetCountdown(1000 + 6 * 3600 + 5 * 60 + 30, 1000)).toBe("6h 05m");
    expect(resetCountdown(1000 + 3 * 3600 + 40 * 60, 1000)).toBe("3h 40m");
    expect(resetCountdown(1000 + 22 * 60, 1000)).toBe("22m");
    expect(resetCountdown(1000 + 9 * 60, 1000)).toBe("9m");
    expect(resetCountdown(1000 + 2 * 86400 + 9 * 3600, 1000)).toBe("2d 9h");
  });

  it("says it the same way in the usage panel's own reading", () => {
    expect(durationLabel(tEn, 2 * 3600 + 9 * 60)).toBe("2h 09m");
    for (let s = 1; s <= 3 * 86400; s += 61) expect(durationLabel(tEn, s), String(s)).toBe(resetCountdown(1000 + s, 1000));
  });
});
