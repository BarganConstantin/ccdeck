import { describe, expect, it } from "vitest";
import { NOW } from "./fixtures/capacity-account";
// @ts-expect-error server ES module
import { mapOAuthUsage, quotaFromStore } from "../../server/quota-shape.mjs";
describe("provider window contract", () => {
  it("never labels weekly-only usage as a measured 5-hour window", () => {
    for (const q of [mapOAuthUsage({ seven_day: { utilization: 69 } }), quotaFromStore({ lastGood: { seven_day: { pct: 69 } }, fetchedAt: NOW * 1000 })]) {
      expect(q.week7dPct).toBe(69);
      expect(q.session5hPct).toBeNull();
      expect(q.session5hResetAt).toBeNull();
    }
  });
  it("rejects malformed utilization rather than coercing it into healthy capacity", () => {
    for (const value of ["", "12", false, NaN, Infinity, {}, []]) {
      expect(mapOAuthUsage({ five_hour: { utilization: value } })).toBeNull();
      expect(quotaFromStore({ lastGood: { five_hour: { pct: value } } })).toBeNull();
    }
  });
});
