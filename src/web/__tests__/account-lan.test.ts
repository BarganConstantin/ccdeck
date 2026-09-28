// The accounts panel's roster as Local network reads it, held to the server.
//
// Both halves of each row restate a rule the server holds: the key is
// lan-sync.mjs's accountKey — the identity two decks match accounts on — and
// `shareable` is account-health.mjs's export preflight, cachedExportReadable.
// While the mapping was written inline in the panel's JSX nothing could run it
// against either. It is account-lan.ts's lanAccounts now, so both copies are
// driven through the same inputs here and must answer alike.
import { describe, expect, it } from "vitest";

import { lanAccounts } from "../account-lan";
import { type Account } from "../claude-accounts";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { cachedExportReadable } from "../../server/account-health.mjs";

function account(over: Partial<Account> = {}): Account {
  return {
    num: 2, email: "side@example.com", alias: null, org: "Acme", orgUuid: "org-a",
    active: false, disabled: false, lanes: [], headroom: 40,
    fetchedAt: null, nextAt: null, stale: false, error: null,
    ...over,
  };
}

describe("Local network's row for each account", () => {
  it("is keyed exactly as the server keys it", () => {
    const cases: Array<[string | null, string | null | undefined]> = [
      ["side@example.com", "org-a"],
      ["  Side@Example.COM ", "org-a"],
      ["side@example.com", null],
      ["side@example.com", undefined],
      [null, "org-a"],
      [null, null],
    ];
    for (const [email, orgUuid] of cases) {
      const [row] = lanAccounts([account({ email, orgUuid })]);
      expect(row.key, `${email} / ${orgUuid}`).toBe(accountKey(email, orgUuid));
    }
  });

  it("offers it to a peer exactly when the server's preflight would export it", () => {
    for (const collector of ["ok", "relogin_required", "keychain_unavailable", "token_expired", "something new", null, undefined]) {
      for (const active of [false, true]) {
        const [row] = lanAccounts([account({ collector, active })]);
        expect(row.shareable, `${collector} / active ${active}`)
          .toBe(cachedExportReadable(collector, { active }));
      }
    }
  });

  it("calls a stored copy alive only when the roster says so outright", () => {
    expect(lanAccounts([account({ alive: true })])[0].alive).toBe(true);
    expect(lanAccounts([account({ alive: false })])[0].alive).toBe(false);
    expect(lanAccounts([account({ alive: undefined })])[0].alive).toBe(false);
  });

  it("hands an address, even for an account that has none", () => {
    expect(lanAccounts([account({ email: null })])[0].email).toBe("");
  });

  it("keeps the roster's order and one row per account", () => {
    const rows = lanAccounts([account({ num: 3, email: "c@x" }), account({ num: 1, email: "a@x" })]);
    expect(rows.map(r => r.email)).toEqual(["c@x", "a@x"]);
  });
});
