// Three rules claude-accounts.mjs applies to what it reads out of claude-swap's
// store, each spelled once and called by every reader that needs it.
//
//   usageRows     a usage.json in any schema but 2 has no rows. The roster, the
//                 Usage panel's active account and the refresh button's
//                 collection request all read the file, and each used to state
//                 the schema test for itself.
//   rowIsFor      a row is keyed by slot and guarded on identity, because a
//                 slot is reused while the removed account's row stays behind.
//                 The roster and activeAccountUsage each carried a copy.
//   accountKey    the identity a cached verdict is filed under, which is the
//                 one lan-sync.mjs matches accounts on. The verdict cache wrote
//                 it and read it back in two more hand-written spellings.
//
// The verdict cache lives in claude-verdicts.mjs now, which is why the last
// rule is checked across both modules.
//
// claude-swap-row-identity.test.ts drives the two row readers end to end
// against a real store, and account-health.test.ts drives the verdict cache;
// this file pins the rules themselves, and that each has one spelling.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error plain JS module
import { rowIsFor, usageRows } from "../../server/claude-accounts.mjs";
// @ts-expect-error plain JS module
import { cachedVerdictFor } from "../../server/claude-verdicts.mjs";
// @ts-expect-error plain JS module
import { accountKey } from "../../server/lan-sync.mjs";

/** A server module with its comments gone, since the prose quotes the rules. */
const codeOf = (name: string) => readFileSync(new URL(`../../server/${name}`, import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
const code = codeOf("claude-accounts.mjs");
const verdictCode = codeOf("claude-verdicts.mjs");

describe("usageRows", () => {
  it("answers the rows of a schema-2 file, as they are", () => {
    const accounts = { 2: { email: "a@example.test" }, 3: { email: "b@example.test" } };
    expect(usageRows({ schemaVersion: 2, accounts })).toBe(accounts);
  });

  it("answers no rows for a schema-2 file that has none", () => {
    expect(usageRows({ schemaVersion: 2 })).toEqual({});
    expect(usageRows({ schemaVersion: 2, accounts: null })).toEqual({});
  });

  it("answers no rows for any other schema, since its rows may mean something else", () => {
    const accounts = { 2: { email: "a@example.test", fetchedAt: 1 } };
    for (const schemaVersion of [1, 3, "2", null, undefined]) {
      expect(usageRows({ schemaVersion, accounts }), String(schemaVersion)).toEqual({});
    }
  });

  it("answers no rows for a file that is missing or did not parse", () => {
    // readJson answers null for both.
    expect(usageRows(null)).toEqual({});
    expect(usageRows(undefined)).toEqual({});
  });

  it("is the only place the schema is tested", () => {
    expect(code.match(/schemaVersion\s*[!=]==/g) ?? []).toHaveLength(1);
  });
});

describe("rowIsFor", () => {
  const acct = { email: "ana@example.test", organizationUuid: "org-1" };

  it("accepts the row written for this account", () => {
    expect(rowIsFor({ email: "ana@example.test", organizationUuid: "org-1", fetchedAt: 1 }, acct)).toBe(true);
  });

  it("refuses the row a removed account left in the slot", () => {
    expect(rowIsFor({ email: "gone@example.test", organizationUuid: "org-1" }, acct)).toBe(false);
  });

  it("refuses the same email under another organization, which is another account", () => {
    expect(rowIsFor({ email: "ana@example.test", organizationUuid: "org-2" }, acct)).toBe(false);
    expect(rowIsFor({ email: "ana@example.test" }, acct)).toBe(false);
  });

  it("reads a missing organization on both sides as the same one", () => {
    const personal = { email: "ana@example.test" };
    expect(rowIsFor({ email: "ana@example.test" }, personal)).toBe(true);
    expect(rowIsFor({ email: "ana@example.test", organizationUuid: null }, personal)).toBe(true);
    expect(rowIsFor({ email: "ana@example.test", organizationUuid: "" }, { ...personal, organizationUuid: null })).toBe(true);
  });

  it("compares the email as claude-swap wrote it, never case-folded", () => {
    expect(rowIsFor({ email: "Ana@example.test", organizationUuid: "org-1" }, acct)).toBe(false);
  });

  it("answers false, never the row itself, when there is no row", () => {
    expect(rowIsFor(undefined, acct)).toBe(false);
    expect(rowIsFor(null, acct)).toBe(false);
  });

  it("is the only place the guard is written", () => {
    expect(code.match(/\(row\??\.organizationUuid \?\? ""\)/g) ?? []).toHaveLength(1);
    // Called by both readers — the roster and activeAccountUsage.
    expect(code.match(/(?<!function )rowIsFor\(row, acct\)/g) ?? []).toHaveLength(2);
  });
});

describe("the identity a cached verdict is filed under", () => {
  it("is lan-sync's accountKey, trimmed and case-folded on the email", () => {
    const cache = {
      at: 1_000,
      byNum: { 4: "no_credentials" },
      identities: { 4: accountKey(" Ana@Example.test ", "org-1") },
    };
    expect(cachedVerdictFor(cache, 4, 1_001, "ana@example.test", "org-1")).toBe("no_credentials");
    expect(cachedVerdictFor(cache, 4, 1_001, "ANA@EXAMPLE.TEST", "org-1")).toBe("no_credentials");
    expect(cachedVerdictFor(cache, 4, 1_001, "ana@example.test", "org-2")).toBeNull();
    expect(cachedVerdictFor(cache, 4, 1_001, "ana@example.test", null)).toBeNull();
  });

  it("is never spelled out by hand in the roster or the verdict cache", () => {
    // Both modules: the roster read the cache before the cache moved out.
    expect(code + verdictCode).not.toMatch(/@@\$\{/);
    // Written once when a collection lands, read once when a row asks.
    expect(verdictCode.match(/accountKey\(/g) ?? []).toHaveLength(2);
  });
});
