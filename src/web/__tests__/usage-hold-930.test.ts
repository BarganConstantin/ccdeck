// #930, this deck's own reads of an account held for a paired deck's readings.
//
// `cswap import-usage --hold` keeps every claude-swap collector off the
// account, and claude-swap refuses to fetch it. The deck has to know as well,
// or it keeps spawning `cswap list` every minute for a row nothing will read,
// promises a "next in" nobody will keep, and still spends the account's
// requests on its own saved-resets read. And the version check that decides
// whether this deck takes part at all.
import { describe, it, expect, vi } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { collectionDue, freshenAllowed, heldNow, nextReadAt } from "../../server/claude-collector.mjs";
// @ts-expect-error — .mjs server module, no types
import { collectionWouldRead } from "../../server/login-guard.mjs";
// @ts-expect-error — .mjs server module, no types
import { resetCreditsDue } from "../../server/quota-store-resets.mjs";

const NOW = 1_800_000_000_000;
const s = (ms: number) => ms / 1000;
// A row claude-swap would fetch now: old, overdue, healthy.
const due = { fetchedAt: s(NOW - 600_000), nextPollAt: s(NOW - 60_000), consecutiveFailures: 0 };
const held = { ...due, heldUntil: s(NOW + 300_000) };
const lapsed = { ...due, heldUntil: s(NOW - 1_000) };

describe("a row held for another deck's reading", () => {
  it("is held only until heldUntil", () => {
    expect(heldNow(held, NOW)).toBe(true);
    expect(heldNow(lapsed, NOW)).toBe(false);
    expect(heldNow(due, NOW)).toBe(false);
  });

  it("is not waiting to be collected, so no cswap list is spawned for it", () => {
    expect(collectionDue({ 1: held }, ["1"], NOW)).toBe(false);
    expect(collectionDue({ 1: lapsed }, ["1"], NOW)).toBe(true);
    // Another account still counts.
    expect(collectionDue({ 1: held, 2: due }, ["1", "2"], NOW)).toBe(true);
  });

  it("is not freshened through the engine either", () => {
    expect(freshenAllowed(held, NOW)).toBe(false);
    expect(freshenAllowed(lapsed, NOW)).toBe(true);
  });

  it("promises no next read here", () => {
    expect(nextReadAt(held, true, NOW - 600_000, true, NOW)).toBeNull();
    expect(nextReadAt(lapsed, true, NOW - 600_000, true, NOW)).not.toBeNull();
  });

  it("is not read before a switch, whose reading is trusted meanwhile", () => {
    expect(collectionWouldRead(held, { matches: true, now: NOW })).toBe(false);
    expect(collectionWouldRead(lapsed, { matches: true, now: NOW })).toBe(true);
  });
});

describe("the saved-resets read while another deck reads the account", () => {
  const base = { now: NOW, force: false, rateLimitedUntil: 0, triedThisAccount: true };
  it("waits three hours instead of thirty minutes", () => {
    expect(resetCreditsDue({ ...base, triedAt: NOW - 31 * 60_000 })).toBe(true);
    expect(resetCreditsDue({ ...base, triedAt: NOW - 31 * 60_000, shared: true })).toBe(false);
    expect(resetCreditsDue({ ...base, triedAt: NOW - 181 * 60_000, shared: true })).toBe(true);
  });
  it("still reads a new account, or on the refresh button, on the short floor", () => {
    expect(resetCreditsDue({ ...base, triedAt: NOW - 6 * 60_000, triedThisAccount: false, shared: true })).toBe(true);
    expect(resetCreditsDue({ ...base, triedAt: NOW - 6 * 60_000, force: true, shared: true })).toBe(true);
  });
});

const { version } = vi.hoisted(() => ({ version: { is: "claude-swap 0.27.0" as string | null } }));
vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) =>
    /cswap(\.exe)?$/.test(cmd) && args[0] === "--version" && version.is
      ? { ok: true, code: 0, killed: false, stdout: version.is, stderr: "" }
      : { ok: false, code: "ENOENT", killed: false, stdout: "", stderr: "" },
  runDetached: () => {},
  runInteractive: () => ({ done: Promise.resolve({ ok: false }) }),
}));

describe("whether this deck takes part", () => {
  async function fresh(v: string | null) {
    version.is = v;
    vi.resetModules();
    // @ts-expect-error — .mjs server module, no types
    return (await import("../../server/cswap-install.mjs")).cswapImportsUsage();
  }
  it("needs claude-swap 0.27.0, the release with import-usage", async () => {
    expect(await fresh("claude-swap 0.26.0")).toBe(false);
    expect(await fresh("claude-swap 0.27.0")).toBe(true);
    expect(await fresh("claude-swap 0.28.0")).toBe(true);
  });
  it("is not assumed for a copy that prints no version, or none at all", async () => {
    expect(await fresh("claude-swap")).toBe(false);
    expect(await fresh(null)).toBe(false);
  });
});
