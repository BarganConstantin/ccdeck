import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string, a: string, b: string;
let now: number;
let selected: { home: string; profileId: string; revision: number; selectionEnabled: boolean };
const readSelection = async () => ({ ...selected });
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
async function login(home: string, account: string, expired = false) {
  await writeFile(join(home, "auth.json"), JSON.stringify({
    tokens: {
      access_token: jwt({ sub: account, exp: Math.floor(now / 1000) + (expired ? -3600 : 3600) }),
      refresh_token: `synthetic-refresh-${account}`, account_id: account,
      id_token: jwt({ email: `${account}@example.test`, "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }),
    },
  }));
}
const reply = (status: number, body: object = {}) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body });
const usage = (pct: number) => ({ rate_limit: { primary_window: { used_percent: pct, limit_window_seconds: 18_000, resets_at: 2000000000 } } });
function wireUsage(handler: (account: string) => unknown) {
  const wire = vi.fn(async (url: string, options: { headers: Record<string, string> }) => {
    if (url.includes("oauth/token")) throw new Error("selected readers must never refresh");
    if (url.includes("rate-limit-reset-credits")) return reply(404);
    return handler(options.headers["ChatGPT-Account-Id"]);
  });
  vi.stubGlobal("fetch", wire);
  return wire;
}
async function quotaModule() {
  return import("../../server/codex-quota.mjs");
}

beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(join(tmpdir(), "ccdeck-selected-quota-"));
  a = join(root, "a"); b = join(root, "b");
  await mkdir(a); await mkdir(b);
  vi.stubEnv("CODEX_HOME", a);
  vi.stubEnv("CCDECK_HOME", join(root, "deck"));
  vi.stubEnv("CCDECK_CODEX_HOMES", JSON.stringify([b]));
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  selected = { home: a, profileId: "profile-a", revision: 1, selectionEnabled: true };
  await login(a, "a"); await login(b, "b");
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("selected Codex quota", () => {
  it("keeps per-home cache and the full quota schema", async () => {
    const wire = wireUsage(account => reply(200, {
      ...usage(account === "a" ? 31 : 72), plan_type: "pro", credits: { balance: "12", unlimited: true },
      individual_limit: { limit: 100, used: 40 }, spend_control: { reached: true },
      additional_rate_limits: [{ limit_name: "Spark", metered_feature: "spark", rate_limit: { secondary_window: { used_percent: 8, limit_window_seconds: 604800 } } }],
    }));
    const { fetchCodexQuota, codexQuotaAccount } = await quotaModule();
    const first = await fetchCodexQuota({ readSelection });
    expect(first).toMatchObject({ windows: [{ pct: 31, key: "session", windowSec: 18000, resetAt: 2000000000 }], extraWindows: [{ pct: 8, family: "spark" }], creditsBalance: "12", creditsUnlimited: true, creditLimit: { used: 40 }, spendControlReached: true, refreshed: false });
    expect(codexQuotaAccount(first)).toEqual({ accountId: "a", email: "a@example.test" });
    selected = { ...selected, home: b, profileId: "profile-b", revision: 2 };
    expect((await fetchCodexQuota({ readSelection })).windows[0].pct).toBe(72);
    selected = { ...selected, home: a, profileId: "profile-a", revision: 3 };
    expect((await fetchCodexQuota({ readSelection })).windows[0].pct).toBe(31);
    expect(wire.mock.calls.filter(([url]) => !url.includes("reset-credits"))).toHaveLength(2);
  });

  it("rejects an old selection even if it changes away and back before completion", async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { started = resolve; });
    wireUsage(() => { started(); return new Promise(resolve => { finish = resolve; }); });
    const { fetchCodexQuota, codexQuotaAccount } = await quotaModule();
    const old = fetchCodexQuota({ readSelection });
    await gate;
    selected = { ...selected, revision: 3 };
    finish(reply(200, usage(19)));
    const result = await old;
    expect(result).toEqual({ ok: false, reason: "profile_changed" });
    expect(codexQuotaAccount(result)).toBeNull();
  });

  it("rejects a legacy quota completion when selection is first enabled", async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { started = resolve; });
    selected = { ...selected, selectionEnabled: false };
    wireUsage(() => { started(); return new Promise(resolve => { finish = resolve; }); });
    const { fetchCodexQuota } = await quotaModule();
    const old = fetchCodexQuota({ readSelection }); await gate;
    selected = { ...selected, home: b, profileId: "profile-b", revision: 1, selectionEnabled: true };
    finish(reply(200, usage(19)));
    expect(await old).toEqual({ ok: false, reason: "profile_changed" });
  });

  it("does not return A while B finishes or contaminate B's notification identity", async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { started = resolve; });
    wireUsage(account => account === "a" ? (started(), new Promise(resolve => { finish = resolve; })) : reply(200, usage(75)));
    const { fetchCodexQuota, codexQuotaAccount } = await quotaModule();
    const old = fetchCodexQuota({ readSelection }); await gate;
    selected = { ...selected, home: b, profileId: "profile-b", revision: 2 };
    const newer = await fetchCodexQuota({ readSelection });
    finish(reply(200, usage(19)));
    expect(await old).toEqual({ ok: false, reason: "profile_changed" });
    expect(newer.windows[0].pct).toBe(75);
    expect(codexQuotaAccount(newer)).toEqual({ accountId: "b", email: "b@example.test" });
  });

  it("invalidates re-login during a request without overwriting the newer cache or cooldown", async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { started = resolve; });
    const wire = wireUsage(account => account === "a" ? (started(), new Promise(resolve => { finish = resolve; })) : reply(200, usage(88)));
    const { fetchCodexQuota } = await quotaModule();
    const old = fetchCodexQuota({ readSelection }); await gate;
    await login(a, "new-a");
    const newer = await fetchCodexQuota({ readSelection });
    finish(reply(401));
    expect(await old).toEqual({ ok: false, reason: "profile_changed" });
    expect(newer.windows[0].pct).toBe(88);
    expect((await fetchCodexQuota({ force: true, readSelection })).windows[0].pct).toBe(88);
    expect(wire.mock.calls.filter(([url]) => !url.includes("reset-credits"))).toHaveLength(2);
  });

  it("does not carry A's last-good or refusal into B or a replacement login", async () => {
    let status = 200;
    wireUsage(account => reply(status, usage(account === "a" ? 22 : 64)));
    const { fetchCodexQuota, codexQuotaAccount } = await quotaModule();
    await fetchCodexQuota({ readSelection }); now += 61000; status = 429;
    const held = await fetchCodexQuota({ readSelection });
    expect(held).toMatchObject({ ok: true, stale: true, windows: [{ pct: 22 }] });
    expect(codexQuotaAccount(held)).toBeNull();
    selected = { ...selected, home: b, profileId: "profile-b", revision: 2 };
    expect(await fetchCodexQuota({ readSelection })).toMatchObject({ ok: false, reason: "rate_limited" });
    await login(b, "new-b"); status = 200;
    expect((await fetchCodexQuota({ readSelection })).windows[0].pct).toBe(64);
  });

  it("never refreshes selected primary or alternate credentials on expiry or 401", async () => {
    const wire = wireUsage(() => reply(401));
    const { fetchCodexQuota } = await quotaModule();
    await login(a, "a", true);
    const before = await readFile(join(a, "auth.json"), "utf8");
    expect(await fetchCodexQuota({ readSelection })).toMatchObject({ ok: false, reason: "expired" });
    expect(wire).not.toHaveBeenCalled();
    selected = { ...selected, home: b, profileId: "profile-b", revision: 2 };
    expect(await fetchCodexQuota({ readSelection })).toMatchObject({ ok: false, reason: "reauth_required" });
    expect(wire.mock.calls).toHaveLength(1);
    expect(await readFile(join(a, "auth.json"), "utf8")).toBe(before);
  });

  it("fails closed when selection cannot be read", async () => {
    const wire = wireUsage(() => reply(200, usage(1)));
    const { fetchCodexQuota } = await quotaModule();
    expect(await fetchCodexQuota({ readSelection: async () => { throw new Error("registry corrupt"); } })).toEqual({ ok: false, reason: "selection_unavailable" });
    expect(wire).not.toHaveBeenCalled();
  });

  it("reads explicit homes without allowing alternate refresh and scopes fingerprints", async () => {
    const wire = wireUsage(() => reply(200));
    await login(b, "a", true); await login(a, "a", true);
    const { getCodexAuth, codexCredentialFingerprint } = await import("../../server/codex-auth.mjs");
    expect(await getCodexAuth({ home: b })).toMatchObject({ ok: true, accountId: "a", refreshed: false });
    expect(await getCodexAuth({ home: a, allowRefresh: false })).toMatchObject({ ok: true, refreshed: false });
    expect(await codexCredentialFingerprint({ home: a })).not.toBe(await codexCredentialFingerprint({ home: b }));
    expect(wire).not.toHaveBeenCalled();
  });

  it("keeps a good home cached while the selected new home has no login yet", async () => {
    const wire = wireUsage(() => reply(200, usage(44)));
    const { fetchCodexQuota } = await quotaModule();
    await fetchCodexQuota({ readSelection });
    await rm(join(b, "auth.json"));
    selected = { ...selected, home: b, profileId: "profile-b", revision: 2 };
    expect(await fetchCodexQuota({ readSelection })).toMatchObject({ ok: false, reason: "no_token" });
    selected = { ...selected, home: a, profileId: "profile-a", revision: 3 };
    expect((await fetchCodexQuota({ readSelection })).windows[0].pct).toBe(44);
    expect(wire.mock.calls.filter(([url]) => !url.includes("reset-credits"))).toHaveLength(1);
  });

  it("prunes idle readers removed from the roster", async () => {
    const wire = wireUsage(() => reply(200, usage(44)));
    const { fetchCodexQuota } = await quotaModule();
    await fetchCodexQuota({ readSelection });
    selected = { ...selected, home: b, profileId: "profile-b", revision: 2 };
    await fetchCodexQuota({ readSelection: async () => ({ ...selected, homes: [b] }) });
    selected = { ...selected, home: a, profileId: "profile-a", revision: 3 };
    await fetchCodexQuota({ readSelection: async () => ({ ...selected, homes: [a, b] }) });
    expect(wire.mock.calls.filter(([url]) => !url.includes("reset-credits"))).toHaveLength(3);
  });

  it("bounds the reader cache without evicting active requests or duplicating them", async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const wire = wireUsage(() => pending);
    const { fetchCodexQuota } = await quotaModule();
    const requests: Promise<unknown>[] = [];
    for (let i = 0; i < 64; i++) {
      const home = join(root, `busy-${i}`);
      await mkdir(home); await login(home, `busy-${i}`);
      const snapshot = { home, profileId: `busy-${i}`, revision: 1, selectionEnabled: true };
      requests.push(fetchCodexQuota({ readSelection: async () => snapshot }));
    }
    await vi.waitFor(() => expect(wire.mock.calls).toHaveLength(64));
    const overflow = { home: b, profileId: "profile-b", revision: 1, selectionEnabled: true };
    expect(await fetchCodexQuota({ readSelection: async () => overflow })).toMatchObject({ ok: false, reason: "waiting" });
    const first = { home: join(root, "busy-0"), profileId: "busy-0", revision: 1, selectionEnabled: true };
    requests.push(fetchCodexQuota({ readSelection: async () => first }));
    finish(reply(200, usage(55)));
    expect((await Promise.all(requests)).every((value: any) => value.ok)).toBe(true);
    expect(wire.mock.calls.filter(([url]) => !url.includes("reset-credits"))).toHaveLength(64);
    expect(await fetchCodexQuota({ readSelection: async () => overflow })).toMatchObject({ ok: true });
  });

  it("uses the real selection contract for ambient quota and read-only plan inspection", async () => {
    wireUsage(() => reply(200, usage(66)));
    const { readCodexSelection, codexProfileId, selectCodexProfile } = await import("../../server/codex-selection.mjs");
    const original = await readCodexSelection();
    await selectCodexProfile({ id: await codexProfileId(b), expectedRevision: original.revision, operationId: "test-select-b" });
    const { fetchCodexQuota } = await quotaModule();
    expect((await fetchCodexQuota()).email).toBe("b@example.test");
    const { getCodexAuth } = await import("../../server/codex-auth.mjs");
    expect(await getCodexAuth({ selectedReadOnly: true })).toMatchObject({ ok: true, accountId: "b", refreshed: false, planType: "plus" });
  });
});
