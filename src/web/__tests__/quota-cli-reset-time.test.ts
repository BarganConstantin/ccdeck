// A reset time `claude --print /usage` prints without a date.
//
// The CLI gives the session window's reset as a bare clock reading when it
// falls today — "resets 4:09pm (Europe/Chisinau)" — and a date only for the
// week. parseResetToSec supplied the missing year by appending one, and V8
// reads "4:09 pm 2027" as the first of January: the nearest of the three
// years it tried was next year's. So on the CLI path the 5-hour bar read
// "resets in 88d 6h", and its pace, measured against a reset months away,
// disappeared.
//
// A bare time means the next time that clock reading comes round: later
// today, or tomorrow once it has gone by. The CLI prints to the minute, so a
// reading of the current minute is still today's.
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { parseResetToSec, parseUsageText } from "../../server/quota-shape.mjs";

const local = (...p: [number, number, number, number, number, number?]) => new Date(...p).getTime();
const sec = (ms: number) => Math.floor(ms / 1000);

describe("a reset time with no date", () => {
  it("is later today when the time has not come yet", () => {
    expect(parseResetToSec("4:09pm", local(2026, 9, 5, 10, 0))).toBe(sec(local(2026, 9, 5, 16, 9)));
    expect(parseResetToSec("4pm", local(2026, 9, 5, 10, 0))).toBe(sec(local(2026, 9, 5, 16, 0)));
  });

  it("is tomorrow when the time has already gone by today", () => {
    expect(parseResetToSec("1am", local(2026, 9, 5, 23, 30))).toBe(sec(local(2026, 9, 6, 1, 0)));
    expect(parseResetToSec("9:15am", local(2026, 9, 5, 9, 16, 30))).toBe(sec(local(2026, 9, 6, 9, 15)));
  });

  it("crosses the end of the year as a day, not a year", () => {
    expect(parseResetToSec("12:30am", local(2026, 11, 31, 22, 0))).toBe(sec(local(2027, 0, 1, 0, 30)));
  });

  it("is still today within the minute the CLI printed", () => {
    // Printed to the minute: at 10:00:40 a "10am" reset may not have happened yet.
    expect(parseResetToSec("10am", local(2026, 9, 5, 10, 0, 40))).toBe(sec(local(2026, 9, 5, 10, 0)));
  });

  it("reaches the session window the CLI path publishes", () => {
    const q = parseUsageText("Current session: 12% used · resets 4pm (Europe/Chisinau)\n");
    const ahead = q.session5hResetAt * 1000 - Date.now();
    expect(ahead).toBeGreaterThan(-60_000);
    expect(ahead).toBeLessThanOrEqual(24 * 3600_000);
  });

  it("leaves a time that carries its date to the year search", () => {
    expect(parseResetToSec("Oct 7, 4:09pm", local(2026, 9, 5, 10, 0))).toBe(sec(local(2026, 9, 7, 16, 9)));
    expect(parseResetToSec("Jan 2, 9am", local(2026, 11, 30, 12, 0))).toBe(sec(local(2027, 0, 2, 9, 0)));
  });
});
