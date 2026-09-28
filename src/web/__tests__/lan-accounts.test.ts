// This deck's accounts in the shape the sync rules want, one rule per field.
//
// The engine suites hand whole stores to whole engines and watch what a round
// moves. What is pinned here is the translation underneath, on rows the test
// writes: which login counts as alive, which as readable, what a deck says
// about one it cannot read, and which one it is on.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { syncAccounts } from "../../server/lan-accounts.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { SENDER_UNREADABLE } from "../../server/lan-sync.mjs";

const row = (extra: Record<string, unknown> = {}) =>
  ({ num: 3, email: "Claude1@Sapec.md", orgUuid: "org-1", alive: true, ...extra });

describe("an account as the rules read it", () => {
  it("is keyed by its identity and keeps its slot number", () => {
    expect(syncAccounts({ accounts: [row()] })).toEqual([{
      key: "claude1@sapec.md@@org-1", email: "Claude1@Sapec.md", org: "org-1",
      alive: true, readable: true, unreadableWhy: "export failed", num: 3, active: false,
    }]);
  });

  it("is nothing at all when the reader has nothing", () => {
    expect(syncAccounts(null)).toEqual([]);
    expect(syncAccounts({})).toEqual([]);
  });
});

describe("alive", () => {
  it("is the stored copy's verdict, and a failure to check is not a death", () => {
    expect(syncAccounts({ accounts: [row({ alive: false })] })[0].alive).toBe(false);
    expect(syncAccounts({ accounts: [row({ collector: "relogin_required" })] })[0].alive).toBe(false);
    expect(syncAccounts({ accounts: [row({ alive: false, collector: "keychain_unavailable" })] })[0].alive).toBe(true);
  });
});

describe("readable, and what a deck says when it is not", () => {
  it("is false for a login the wiring says this process cannot read", () => {
    const [a] = syncAccounts({ accounts: [row({ readable: false })] });
    expect(a.readable).toBe(false);
    expect(a.unreadableWhy).toBe(SENDER_UNREADABLE);
  });

  it("is false for a Keychain that will not open, and names that", () => {
    const [a] = syncAccounts({ accounts: [row({ collector: "keychain_unavailable" })] });
    expect(a.readable).toBe(false);
    expect(a.unreadableWhy).toBe(SENDER_UNREADABLE);
  });

  it("waits for a verdict on the slot the deck is on, and not on any other", () => {
    // The active slot exports the live login, which a missing verdict says
    // nothing about; another slot exports its own stored copy.
    const [on, off] = syncAccounts({ accounts: [row({ active: true }), row({ num: 4 })] });
    expect(on.readable).toBe(false);
    expect(on.unreadableWhy).toBe("export failed");
    expect(off.readable).toBe(true);
    expect(syncAccounts({ accounts: [row({ active: true, collector: "ok" })] })[0].readable).toBe(true);
  });

  it("is false for any verdict other than ok", () => {
    expect(syncAccounts({ accounts: [row({ collector: "rate_limited" })] })[0].readable).toBe(false);
  });
});

describe("active", () => {
  it("is claude-swap's own answer, and only a plain true", () => {
    expect(syncAccounts({ accounts: [row({ active: true, collector: "ok" })] })[0].active).toBe(true);
    expect(syncAccounts({ accounts: [row({ active: "yes" })] })[0].active).toBe(false);
  });
});
