// #994 §2c: the default usage window starts on a LOCAL calendar date.
//
// fetchCcusageDaily's default `--since` was `new Date(now - 30 days)
// .toISOString()`, the UTC date, while ccusage buckets its rows by local
// calendar date — usage-range.ts says so, and presetSince does the page's half
// of this correctly. At 08:30 in Tokyo it asked for 20260815 when the local
// date thirty days back is 20260816; at 20:30 in Los Angeles it ran a day the
// other way.
//
// Zones are pinned the way usage-range.test.ts pins them, with a Date whose
// local getters report a chosen wall clock, because Node does not honour a TZ
// changed mid-process, notably on Windows.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs server module, no types
import { defaultCcusageSince } from "../../server/ccusage.mjs";

const SRC = readFileSync(fileURLToPath(new URL("../../server/ccusage.mjs", import.meta.url)), "utf8");

/** usage-range.test.ts's ZonedNow: a real instant whose local getters report
 *  the wall clock of a fixed-offset zone. */
class ZonedNow extends Date {
  private readonly wall: Date;
  constructor(wallClock: string, offsetHours: number) {
    const wall = new Date(`${wallClock}Z`);
    super(wall.getTime() - offsetHours * 3600_000);
    this.wall = wall;
  }
  getFullYear(): number { return this.wall.getUTCFullYear(); }
  getMonth(): number { return this.wall.getUTCMonth(); }
  getDate(): number { return this.wall.getUTCDate(); }
}

/** What the default used to ask for: the UTC date thirty 24-hour days back. */
const old = (now: Date): string =>
  new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10).replace(/-/g, "");

const TOKYO_MORNING = new ZonedNow("2026-09-15T08:30:00", 9);
const LA_EVENING = new ZonedNow("2026-09-14T20:30:00", -7);

describe("the default usage window", () => {
  it("starts thirty local days back in Tokyo's morning, where UTC is still yesterday", () => {
    expect(TOKYO_MORNING.toISOString().slice(0, 10)).toBe("2026-09-14");
    expect(defaultCcusageSince(TOKYO_MORNING)).toBe("20260816");
  });

  it("starts thirty local days back in Los Angeles' evening, where UTC is already tomorrow", () => {
    expect(LA_EVENING.toISOString().slice(0, 10)).toBe("2026-09-15");
    expect(defaultCcusageSince(LA_EVENING)).toBe("20260815");
  });

  it("gives the date the old formula gave, in UTC itself", () => {
    const noon = new ZonedNow("2026-09-15T12:00:00", 0);
    expect(defaultCcusageSince(noon)).toBe("20260816");
    expect(old(noon)).toBe("20260816");
  });

  it("differs from the old formula in both zones above, so those cases can tell the two apart", () => {
    expect(old(TOKYO_MORNING)).toBe("20260815");
    expect(old(LA_EVENING)).toBe("20260816");
  });

  it("starts exactly `days` local days before today, at every hour, east and west of UTC", () => {
    for (const offset of [-12, -7, -3.5, 0, 5.5, 9, 14]) {
      for (let hour = 0; hour < 24; hour++) {
        const now = new ZonedNow(`2026-03-08T${String(hour).padStart(2, "0")}:30:00`, offset);
        expect(defaultCcusageSince(now, 30)).toBe("20260206");
        expect(defaultCcusageSince(now, 7)).toBe("20260301");
      }
    }
  });

  it("is what fetchCcusageDaily asks for when no range is given", () => {
    expect(SRC).toMatch(/const sinceArg = since \|\| defaultCcusageSince\(new Date\(now\)\);/);
    // And the UTC formatter it replaced is gone, rather than left for the next
    // default to reach for. (The old formula is still quoted in the comment
    // above defaultCcusageSince, so this checks for the function, not the text.)
    expect(SRC).not.toMatch(/function toCliDate\b/);
  });
});
