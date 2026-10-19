// The status publisher against the fake API: its schedule, its frames, and
// what each answer makes it do (design 4.5).
//
// The publisher's timers are the suite's (manualTimers): a frame goes when the
// test fires it, and each delay the publisher asks for is recorded, so the
// schedule is read off a list rather than waited out. `random` is fixed, so
// the jitter and the backoff spread are exact numbers.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enroll, fakeClock, manualTimers, settle, tempDir, until } from "./account-test-kit";
import { fixture, frameProblem, leafPaths, startFakeApi, type FakeApi } from "./account-fake-api";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { BACKOFF_SEC, createStatusPublisher, FIRST_FRAME_MS } from "../../server/account-status.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createAccountClient } from "../../server/account-client.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createAccountService } from "../../server/account-service.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createTokenStore } from "../../server/account-token-store.mjs";

const DECK = { version: "3.43.0", os: "linux", arch: "x64", channel: "npm" };
const clock = fakeClock();
let api: FakeApi;
beforeAll(async () => { api = await startFakeApi({ now: clock.now }); });
afterAll(async () => { await api.close(); });

const warm = () => ({
  cpu: { pct: 37.5, cores: 10, sampledAt: clock.now() - 2_000 },
  memory: { usedPct: 61.2, totalMb: 32768, sampledAt: clock.now() - 20_000 },
});

async function publisher(over: Record<string, unknown> = {}) {
  const t = await enroll(api);
  const timers = manualTimers();
  const events: string[] = [];
  let token = t.accessToken;
  const p = createStatusPublisher({
    client: createAccountClient({ apiBase: api.url, version: "3.43.0" }),
    token: () => token,
    reading: warm,
    counts: (at: number) => ({ running: 3, waiting: 1, sampledAt: at }),
    binding: () => ({ profileId: t.settings.profileId, appliedRevision: 0 }),
    deck: DECK,
    now: clock.now,
    random: () => 0.5,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onRevoked: (why: string) => events.push(`revoked:${why}`),
    log: () => {},
    ...over,
  });
  return { p, timers, events, t, device: () => api.devices.get(t.deviceId)!, setToken: (v: string) => { token = v; } };
}

const frames = (deviceId: string) => api.devices.get(deviceId)!.frames;
const statusPosts = () => api.requests.filter(r => r.path === "/v1/device/status");

describe("the schedule", () => {
  it("sends the first frame about three seconds after start, then every nextInSec with ±2 s jitter", async () => {
    const { p, timers, t } = await publisher({ random: () => 0 });
    p.start();
    expect(timers.last()).toBe(FIRST_FRAME_MS);
    await timers.fire({ next: true });
    expect(frames(t.deviceId)).toHaveLength(1);
    expect(timers.last(), "15 s, the most jitter early").toBe(13_000);
    p.stop();
    const late = await publisher({ random: () => 0.999999 });
    late.p.start();
    await late.timers.fire({ next: true });
    expect(late.timers.last()).toBeCloseTo(17_000, -1);
    late.p.stop();
  });

  it("takes the interval the API sends back", async () => {
    const { p, timers } = await publisher();
    api.override("/v1/device/status", () => ({ status: 200, body: { ...fixture("status-response.json"), nextInSec: 30 }, headers: { "content-type": "application/json" } }));
    p.start();
    await timers.fire({ next: true });
    expect(timers.last()).toBe(30_000);
    api.override("/v1/device/status", null);
    p.stop();
  });
});

describe("the frames", () => {
  it("keep one boot id and a sequence that only climbs", async () => {
    const { p, timers, t } = await publisher();
    p.start();
    for (let i = 0; i < 4; i++) await timers.fire({ next: true });
    const got = frames(t.deviceId);
    expect(got.map(f => f.seq)).toEqual([1, 2, 3, 4]);
    expect(new Set(got.map(f => f.bootId)).size).toBe(1);
    expect(got.every(f => f.bootId === p.bootId())).toBe(true);
    p.stop();
  });

  it("carry exactly the contract fixture's fields", async () => {
    const { p, timers } = await publisher();
    p.start();
    await timers.fire({ next: true });
    const sent = statusPosts().at(-1)!.body;
    expect(leafPaths(sent).sort()).toEqual(leafPaths(fixture("status-frame.json")).sort());
    expect(frameProblem(sent)).toBeNull();
    expect(sent).toMatchObject({ v: 1, state: "running", deck: DECK, cpu: { pct: 37.5, cores: 10 }, agents: { running: 3, waiting: 1 } });
    expect(JSON.stringify(sent)).not.toMatch(/load|hostname|ccdd_/);
    p.stop();
  });

  it("say unknown, never zero, before the CPU has two samples and before the ring is read", async () => {
    const { p, timers } = await publisher({
      reading: () => ({ cpu: { unknown: "warming-up" }, memory: { unknown: "warming-up" } }),
      counts: () => ({ unknown: "starting" }),
    });
    p.start();
    await timers.fire({ next: true });
    const sent = statusPosts().at(-1)!.body;
    expect(sent.cpu).toEqual({ unknown: "warming-up" });
    expect(sent.memory).toEqual({ unknown: "warming-up" });
    expect(sent.agents).toEqual({ unknown: "starting" });
    expect(frameProblem(sent)).toBeNull();
    p.stop();
  });

  it("start a new boot after the API refuses two in a row as stale", async () => {
    const { p, timers } = await publisher();
    p.start();
    await timers.fire({ next: true });
    const first = p.bootId();
    api.override("/v1/device/status", () => ({ status: 409, body: fixture("device-error.stale-sequence.json"), headers: { "content-type": "application/problem+json" } }));
    await timers.fire({ next: true });
    expect(p.bootId(), "one refusal is dropped").toBe(first);
    await timers.fire({ next: true });
    expect(p.bootId()).not.toBe(first);
    api.override("/v1/device/status", null);
    await timers.fire({ next: true });
    expect(statusPosts().at(-1)!.body).toMatchObject({ bootId: p.bootId(), seq: 1 });
    p.stop();
  });
});

describe("failures", () => {
  it("back off 15, 30, 60, 120, then 300 s, and reset on success", async () => {
    const { p, timers } = await publisher();
    api.override("/v1/device/status", () => ({ status: 503, body: { error: "unavailable" } }));
    p.start();
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) { await timers.fire({ next: true }); seen.push(timers.last()); }
    expect(seen).toEqual([...BACKOFF_SEC, 300].map((s: number) => s * 1000));
    api.override("/v1/device/status", null);
    await timers.fire({ next: true });
    expect(timers.last()).toBe(15_000);
    expect(p.status().lastResult).toBe("ok");
    p.stop();
  });

  it("spread the backoff by up to 20% either way", async () => {
    const { p, timers } = await publisher({ random: () => 0 });
    api.override("/v1/device/status", () => ({ status: 502 }));
    p.start();
    await timers.fire({ next: true });
    expect(timers.last()).toBe(12_000);
    api.override("/v1/device/status", null);
    p.stop();
  });

  it("back off the same way when the API cannot be reached at all", async () => {
    const { p, timers } = await publisher({ client: createAccountClient({ apiBase: "http://127.0.0.1:1", version: "x" }) });
    p.start();
    await timers.fire({ next: true });
    expect(timers.last()).toBe(15_000);
    expect(p.status().lastResult).toBe("offline");
    p.stop();
  });

  it("honour Retry-After", async () => {
    const { p, timers } = await publisher();
    api.override("/v1/device/status", () => ({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "42" } }));
    p.start();
    await timers.fire({ next: true });
    expect(timers.last()).toBe(42_000);
    api.override("/v1/device/status", null);
    p.stop();
  });

  it("stop for good on a 401 that says the device is gone", async () => {
    const { p, timers, events } = await publisher();
    p.start();
    await timers.fire({ next: true });
    api.revoke();
    await timers.fire({ until: () => events.length > 0 });
    expect(events).toEqual(["revoked:device_revoked"]);
    expect(timers.pendingCount()).toBe(0);
  });

  it("drop a frame the API refuses as a frame, and carry on", async () => {
    const { p, timers } = await publisher();
    api.override("/v1/device/status", () => ({
      status: 400,
      body: { type: "https://tools.ietf.org/html/rfc9110#section-15.5.1", title: "One or more validation errors occurred.", status: 400, errors: { "cpu.pct": ["A number from 0 to 100."] } },
      headers: { "content-type": "application/problem+json" },
    }));
    p.start();
    await timers.fire({ next: true });
    expect(timers.last()).toBe(15_000);
    api.override("/v1/device/status", null);
    p.stop();
  });
});

describe("a clean stop", () => {
  it("sends one last frame that says stopping, and nothing after it", async () => {
    const { p, timers, t } = await publisher();
    p.start();
    await timers.fire({ next: true });
    await p.sendStopping();
    const got = frames(t.deviceId);
    expect(got.at(-1)).toMatchObject({ state: "stopping", seq: 2 });
    expect(timers.pendingCount()).toBe(0);
    await p.sendStopping();
    expect(frames(t.deviceId)).toHaveLength(2);
  });

  it("gives up on the stopping frame after a second and a half", async () => {
    const { createServer } = await import("node:http");
    const hang = createServer(() => { /* never answers */ });
    await new Promise<void>(r => hang.listen(0, "127.0.0.1", r));
    const port = (hang.address() as { port: number }).port;
    const { p, timers } = await publisher({ client: createAccountClient({ apiBase: `http://127.0.0.1:${port}` }) });
    p.start();
    const started = Date.now();
    await p.sendStopping();
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(timers.pendingCount()).toBe(0);
    hang.closeAllConnections?.();
    await new Promise(r => hang.close(r));
  });
});

describe("through the service", () => {
  let dir = "";
  afterEach(() => { if (dir) rmTempDir(dir); dir = ""; });

  async function connected() {
    dir = tempDir("ccdeck-account-status-");
    const home = join(dir, "deck");
    const timers = manualTimers();
    const redacted: string[][] = [];
    const exits: (() => unknown)[] = [];
    const s = createAccountService({
      env: { CCDECK_ACCOUNT_API: api.url }, home, prefs: () => ({}),
      tokenStore: createTokenStore({ platform: "linux", env: {}, home, which: () => false }),
      facts: DECK, now: clock.now, random: () => 0.5, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      reading: warm, setRedactions: (t: string[]) => redacted.push(t), registerShutdown: (fn: () => unknown) => { exits.push(fn); return () => {}; },
      log: () => {},
    });
    await s.start();
    const v = await s.connect("laptop-a");
    api.approve(v.connect.userCode);
    clock.advance(5_000);
    await timers.fire({ until: () => s.view().state === "connected" });
    // Connected, written, and talking: the view says connected the moment the
    // record changes in memory; the file and the publisher follow.
    const { existsSync } = await import("node:fs");
    await until(() => s.view().state === "connected" && s.publisher() != null && existsSync(join(home, "account.json")), 3_000, "connected");
    await settle(50);
    return { s, timers, home, redacted, exits, deviceId: s.view().device.id };
  }

  const fileToken = (home: string) => JSON.parse(readFileSync(join(home, "account.json"), "utf8")).token;
  const bearer = (r: { headers: Record<string, unknown> }) => String(r.headers.authorization).replace(/^Bearer /, "");

  it("rotates when asked, persisting the new token before using it", async () => {
    const { s, timers, home, redacted, deviceId } = await connected();
    const before = fileToken(home);
    api.askRotate(deviceId);
    await timers.fire({ next: true });         // the frame whose answer asks
    await until(() => fileToken(home) !== before, 3_000, "the new token on disk");
    const after = fileToken(home);
    const rotateCall = api.requests.filter(r => r.path === "/v1/device/token/rotate").at(-1)!;
    expect(bearer(rotateCall)).toBe(before);
    await timers.fire({ next: true });         // the next frame, with the new one
    expect(bearer(statusPosts().at(-1)!)).toBe(after);
    // Promoted on its first use: the old one is dead now.
    const old = await createAccountClient({ apiBase: api.url }).get("/v1/device", { token: before });
    expect(old).toMatchObject({ status: 401, error: "invalid_token" });
    // Both were redacted while both were valid, and the new one after.
    expect(redacted.some(r => r.includes(before) && r.includes(after))).toBe(true);
    expect(redacted.at(-1)).toEqual([after]);
    s.stop();
  });

  it("forgets the token and says removed when the console revokes the device", async () => {
    const { s, timers, home, deviceId } = await connected();
    api.revoke(deviceId);
    await timers.fire({ until: () => s.view().state === "revoked" });
    const onDisk = JSON.parse(readFileSync(join(home, "account.json"), "utf8"));
    expect(onDisk.token).toBe("");
    expect(onDisk.deviceId).toBe("");
    expect(onDisk.revokedReason).toBe("device_revoked");
    expect(s.view()).toMatchObject({ state: "revoked", device: null, account: { email: "me@example.com" } });
    s.stop();
  });

  it("registers the stopping frame on the way out", async () => {
    const { s, exits, deviceId } = await connected();
    expect(exits).toHaveLength(1);
    await exits[0]();
    expect(api.devices.get(deviceId)!.frames.at(-1)).toMatchObject({ state: "stopping" });
    s.stop();
  });

  it("keeps the token and retries every minute while the keychain is locked", async () => {
    dir = tempDir("ccdeck-account-locked-");
    const home = join(dir, "deck");
    const { saveAccount } = await import("../../server/account-store.mjs" as string);
    await saveAccount({ apiBase: api.url, accountId: "a", email: "me@example.com", deviceId: "d", deviceName: "laptop", tokenStorage: "keychain" }, home);
    let locked = true;
    const timers = manualTimers();
    const store = {
      backend: () => "keychain",
      save: async () => ({ tokenStorage: "keychain" }),
      load: async () => (locked ? { ok: false, reason: "locked" } : { ok: true, token: (await enroll(api)).accessToken }),
      remove: async () => { throw new Error("must not be removed"); },
    };
    const s = createAccountService({
      env: { CCDECK_ACCOUNT_API: api.url }, home, tokenStore: store, facts: DECK, now: clock.now,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: () => {},
    });
    await s.start();
    expect(s.view()).toMatchObject({ state: "connected", problem: "keychain-locked" });
    expect(timers.last()).toBe(60_000);
    expect(JSON.parse(readFileSync(join(home, "account.json"), "utf8")).deviceId).toBe("d");
    locked = false;
    await timers.fire({ until: () => s.view().problem === null });
    expect(s.view().problem).toBeNull();
    s.stop();
  });
});
