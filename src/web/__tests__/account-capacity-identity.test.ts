import { describe, expect, it } from "vitest";
import { account } from "./fixtures/capacity-account";
import { laneKey, knownLanes } from "../lane-open";
// @ts-expect-error server ES module
import { rowIsFor } from "../../server/claude-accounts.mjs";
describe("identity is independent of display names and store slots", () => {
  it("keeps separate organizations with the same display name distinct", () => {
    const a = { ...account(), org: "Shared display name", orgUuid: "organization-a" };
    const b = { ...a, num: 2, orgUuid: "organization-b" };
    expect(laneKey(a)).not.toBe(laneKey(b));
    expect(laneKey({ ...a, num: 8, org: "Renamed organization" })).toBe(laneKey(a));
    expect(knownLanes([laneKey(a)], [b])).toEqual([]);
  });
  it("does not attach a cached reading when neither account has a known email", () => {
    expect(rowIsFor({ email: null, organizationUuid: null }, { email: null, organizationUuid: null })).toBe(false);
  });
});
