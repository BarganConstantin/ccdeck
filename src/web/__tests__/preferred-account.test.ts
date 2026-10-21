import { describe, expect, it } from "vitest";
import { shouldReturnToPreferred } from "../../server/preferred-account.mjs";

const state = { email: "work@example.com", orgUuid: "org", resetAt: 100, awaitingWindow: false };
const account = {
  num: 2, email: "work@example.com", orgUuid: "org", active: false, disabled: false,
  alive: true, stale: false, fetchedAt: 150_000,
  lanes: [
    { id: "five_hour", pct: 0, resetAt: 200 },
    { id: "seven_day", pct: 60, resetAt: 500 },
  ],
};

describe("return to preferred account", () => {
  it("requires a new five-hour window with every limit below the threshold", () => {
    expect(shouldReturnToPreferred(state, account, 90)).toBe(true);
    expect(shouldReturnToPreferred(state, { ...account, lanes: [{ ...account.lanes[0], resetAt: 100 }, account.lanes[1]] }, 90)).toBe(false);
    expect(shouldReturnToPreferred(state, { ...account, lanes: [account.lanes[0], { ...account.lanes[1], pct: 90 }] }, 90)).toBe(false);
    expect(shouldReturnToPreferred(state, { ...account, active: true }, 90)).toBe(false);
    expect(shouldReturnToPreferred(state, { ...account, disabled: true }, 90)).toBe(false);
    expect(shouldReturnToPreferred(state, { ...account, alive: false }, 90)).toBe(false);
    expect(shouldReturnToPreferred(state, { ...account, stale: true }, 90)).toBe(false);
    expect(shouldReturnToPreferred(state, { ...account, email: "other@example.com" }, 90)).toBe(false);
    expect(shouldReturnToPreferred(state, { ...account, orgUuid: "other" }, 90)).toBe(false);
  });

  it("recognizes a fresh idle window without a reset timestamp", () => {
    const idle = { ...account, lanes: [{ ...account.lanes[0], resetAt: null }, account.lanes[1]] };
    expect(shouldReturnToPreferred(state, idle, 90)).toBe(true);
    expect(shouldReturnToPreferred(state, { ...idle, fetchedAt: 90_000 }, 90)).toBe(false);
    expect(shouldReturnToPreferred({ ...state, awaitingWindow: true }, idle, 90)).toBe(false);
  });
});
