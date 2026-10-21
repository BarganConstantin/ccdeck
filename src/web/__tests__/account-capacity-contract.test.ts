import { describe, expect, it } from "vitest";
import { account, NOW } from "./fixtures/capacity-account";
import { isAccountsData } from "../accounts-contract";
describe("runtime roster contract", () => {
  it("retains partial windows but rejects malformed required data and duplicate slots", () => {
    expect(isAccountsData({ ok: true, accounts: [{ ...account(NOW + 10), lanes: [] }] })).toBe(true);
    for (const bad of [null, [], { ok: true }, { ok: true, accounts: {} }, { ok: true, accounts: [account(), account()] }, { ok: true, accounts: [{ ...account(), lanes: null }] }, { ok: true, accounts: [{ ...account(), fetchedAt: Infinity }] }]) {
      expect(isAccountsData(bad)).toBe(false);
    }
  });
});
