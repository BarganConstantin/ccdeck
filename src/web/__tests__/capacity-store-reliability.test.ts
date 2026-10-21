import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
vi.mock("../../server/cswap-install.mjs", () => ({ cswapBin: () => "fixture-only", cswapInstalling: () => false, cswapRefusal: async () => null, cswapVersion: async () => "fixture", installHint: async () => "fixture" }));
vi.mock("../../server/exec.mjs", () => ({ run: async () => { throw new Error("No process allowed in this fixture"); }, runDetached: () => { throw new Error("No process allowed in this fixture"); } }));
vi.mock("../../server/claude-collector.mjs", () => ({ nudgeCollector: () => {}, nextReadAt: () => null }));
// @ts-expect-error server ES module
import { fetchClaudeAccounts, invalidateClaudeAccountsCache, usageRows } from "../../server/claude-accounts.mjs";
const root = mkdtempSync(join(tmpdir(), "ccdeck-capacity-store-"));
const previous = process.env.CLAUDE_SWAP_BACKUP;
process.env.CLAUDE_SWAP_BACKUP = root;
mkdirSync(join(root, "cache"));
const now = Date.now();
const identity = { email: "sample@example.test", organizationUuid: "org-a", organizationName: "Display" };
const seed = (seq: unknown, usage: unknown) => {
  writeFileSync(join(root, "sequence.json"), JSON.stringify(seq));
  writeFileSync(join(root, "cache", "usage.json"), typeof usage === "string" ? usage : JSON.stringify(usage));
};
beforeEach(() => invalidateClaudeAccountsCache());
afterAll(() => { if (previous == null) delete process.env.CLAUDE_SWAP_BACKUP; else process.env.CLAUDE_SWAP_BACKUP = previous; rmTempDir(root); });

describe("persisted account capacity contract", () => {
  it("returns every existing slot once even when stored order is incomplete or repeats slots", async () => {
    seed({ accounts: { 1: identity, 2: { ...identity, email: "other@example.test" } }, sequence: [1, 1, 99], activeAccountNumber: 2 }, { schemaVersion: 2, accounts: {} });
    const response = await fetchClaudeAccounts({ force: true });
    expect(response.accounts.map((a: { num: number }) => a.num)).toEqual([1, 2]);
    expect(response.accounts.filter((a: { active: boolean }) => a.active)).toHaveLength(1);
  });
  it("normalizes impossible observations and out-of-range percentages before the API", async () => {
    seed({ accounts: { 1: identity }, sequence: [1], activeAccountNumber: 1 }, { schemaVersion: 2, accounts: { 1: { ...identity, fetchedAt: 1e20, lastGood: { five_hour: { pct: -3 }, seven_day: { pct: 140, resets_at: "not a timestamp" } } } } });
    const a = (await fetchClaudeAccounts({ force: true })).accounts[0];
    expect(a.fetchedAt).toBeNull();
    expect(a.stale).toBe(true);
    expect(a.lanes.map((l: { pct: number }) => l.pct)).toEqual([0, 100]);
    expect(a.headroom).toBe(0);
  });
  it("rejects an array masquerading as schema-2 account rows", () => {
    expect(usageRows({ schemaVersion: 2, accounts: [{ email: "sample@example.test" }] })).toEqual({});
  });
  it("never applies a removed slot's readings to its new occupant", async () => {
    seed({ accounts: { 1: { ...identity, email: "replacement@example.test" } }, sequence: [1], activeAccountNumber: 1 }, { schemaVersion: 2, accounts: { 1: { ...identity, fetchedAt: now / 1000, lastGood: { seven_day: { pct: 0 } } } } });
    const a = (await fetchClaudeAccounts({ force: true })).accounts[0];
    expect(a.lanes).toEqual([]);
    expect(a.fetchedAt).toBeNull();
    expect(a.headroom).toBeNull();
  });
  it("recovers from corrupt usage cache and restores the same identity on module restart", async () => {
    const seq = { accounts: { 1: identity }, sequence: [1], activeAccountNumber: 1 };
    seed(seq, "{");
    const unread = (await fetchClaudeAccounts({ force: true })).accounts[0];
    expect(unread.lanes).toEqual([]);
    expect(unread.stale).toBe(true);
    seed(seq, { schemaVersion: 2, accounts: { 1: { ...identity, fetchedAt: now / 1000, lastGood: { seven_day: { pct: 69, resets_at: new Date(now + 3600000).toISOString() } } } } });
    invalidateClaudeAccountsCache();
    const recovered = (await fetchClaudeAccounts({ force: true })).accounts[0];
    expect(recovered.lanes[0].pct).toBe(69);
    vi.resetModules();
    // @ts-expect-error server ES module
    const restarted = await import("../../server/claude-accounts.mjs");
    const restored = (await restarted.fetchClaudeAccounts()).accounts[0];
    expect(restored.email).toBe(identity.email);
    expect(restored.orgUuid).toBe(identity.organizationUuid);
    expect(restored.fetchedAt).toBe(recovered.fetchedAt);
    expect(restored.lanes).toEqual(recovered.lanes);
  });
});
