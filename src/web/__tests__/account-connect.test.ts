// Connecting a deck: the device authorization grant against the fake API
// (account-fake-api.ts), which answers the way design 3.2 says the real one
// will and starts every answer from a contract fixture.
//
// The flow's timers are the suite's (manualTimers): each poll happens when the
// test fires it, and the fake API's clock is the same clock the flow reads, so
// "polled too fast" and "the code expired" are a clock moved, not a wait.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeClock, manualTimers, settle, tempDir } from "./account-test-kit";
import { startFakeApi, type FakeApi } from "./account-fake-api";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { cleanDeviceName, createConnectFlow, defaultDeviceName, DEVICE_NAME_MAX } from "../../server/account-connect.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createAccountClient } from "../../server/account-client.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createAccountService } from "../../server/account-service.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createTokenStore } from "../../server/account-token-store.mjs";

const FACTS = { version: "3.43.0", os: "linux", arch: "x64", channel: "npm" };
const clock = fakeClock();
let api: FakeApi;
beforeAll(async () => { api = await startFakeApi({ now: clock.now }); });
afterAll(async () => { await api.close(); });

function flow() {
  const timers = manualTimers();
  const approved: any[] = [];
  const client = createAccountClient({ apiBase: api.url, version: "3.43.0" });
  const f = createConnectFlow({
    client, facts: FACTS, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    onApproved: async (t: unknown) => { approved.push(t); },
  });
  return { f, timers, approved, client };
}

const tokenPolls = () => api.requests.filter(r => r.path === "/v1/device/token").length;

describe("the connect flow", () => {
  it("asks for a code, polls while it is pending, and stops at the approval", async () => {
    const { f, timers, approved } = flow();
    const first = await f.start("laptop-a");
    expect(first.connecting).toBe(true);
    expect(first.connect.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(first.connect.verificationUriComplete).toBe(`https://app.ccdeck.dev/connect?code=${first.connect.userCode}`);
    // The device code never leaves the flow's answer.
    expect(JSON.stringify(first)).not.toContain("ccdc_");
    expect(timers.last()).toBe(5_000);

    clock.advance(5_000);
    await timers.fire({ next: true });
    expect(approved).toEqual([]);
    expect(f.state().connecting).toBe(true);
    expect(timers.last()).toBe(5_000);

    api.approve(first.connect.userCode);
    clock.advance(5_000);
    await timers.fire({ until: () => approved.length > 0 });
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({ accessToken: expect.stringMatching(/^ccdd_/), account: { email: "me@example.com" }, settings: { mode: "independent" } });
    expect(f.state()).toMatchObject({ connecting: false, connect: null, problem: null });
    expect(timers.pendingCount()).toBe(0);
  });

  it("slows down when the API says it polled too fast", async () => {
    const { f, timers } = flow();
    await f.start("laptop-a");
    clock.advance(5_000);
    await timers.fire({ next: true });  // pending
    await timers.fire({ next: true });  // again at once, by the API's clock: too fast
    expect(timers.last()).toBe(10_000);
    clock.advance(10_000);
    await timers.fire({ next: true });
    expect(f.state().connecting).toBe(true);
    expect(timers.last()).toBe(10_000);
    f.cancel();
  });

  it("stops at a denial, and says it was cancelled in the browser", async () => {
    const { f, timers, approved } = flow();
    const { connect } = await f.start("laptop-a");
    api.deny(connect.userCode);
    clock.advance(5_000);
    await timers.fire({ until: () => !f.state().connecting });
    expect(approved).toEqual([]);
    expect(f.state()).toMatchObject({ connecting: false, problem: "connect-denied" });
    expect(timers.pendingCount()).toBe(0);
  });

  it("stops when the code has expired, on its own clock or the API's", async () => {
    const own = flow();
    await own.f.start("laptop-a");
    const before = tokenPolls();
    clock.advance(601_000);
    await own.timers.fire({ until: () => !own.f.state().connecting });
    expect(own.f.state()).toMatchObject({ connecting: false, problem: "connect-expired" });
    expect(tokenPolls(), "an expired code is not even asked about").toBe(before);

    // The deck's clock behind the API's: the API is the one that says so.
    const lagging = fakeClock(clock.now() - 700_000);
    const timers = manualTimers();
    const f = createConnectFlow({
      client: createAccountClient({ apiBase: api.url }), facts: FACTS, now: lagging.now,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer, onApproved: async () => {},
    });
    await f.start("laptop-a");
    clock.advance(601_000);
    await timers.fire({ until: () => !f.state().connecting });
    expect(f.state()).toMatchObject({ connecting: false, problem: "connect-expired" });
  });

  it("cancels: no poll after it, and no state left", async () => {
    const { f, timers } = flow();
    await f.start("laptop-a");
    f.cancel();
    const before = tokenPolls();
    clock.advance(5_000);
    await timers.fire();
    expect(tokenPolls()).toBe(before);
    expect(f.state()).toEqual({ connecting: false, connect: null, problem: null });
  });

  it("recovers a lost token answer by polling again inside 120 s, and keeps the token it was given", async () => {
    const { f, timers, approved, client } = flow();
    const { connect } = await f.start("laptop-a");
    api.approve(connect.userCode);
    api.loseNextTokenResponse();
    clock.advance(5_000);
    await timers.fire({ next: true });
    expect(approved, "the answer never arrived").toEqual([]);
    expect(f.state().connecting).toBe(true);
    clock.advance(5_000);
    await timers.fire({ until: () => approved.length > 0 });
    expect(approved).toHaveLength(1);
    // The token the deck holds is the one that works: the lost one was killed
    // when the second was minted.
    const res = await client.get("/v1/device", { token: approved[0].accessToken });
    expect(res.status).toBe(200);
  });

  it("says accounts are not open yet when the API has them off", async () => {
    api.override("/v1/device/authorize", () => ({ status: 404, body: { type: "about:blank", title: "Not Found", status: 404 }, headers: { "content-type": "application/problem+json" } }));
    const { f } = flow();
    const out = await f.start("laptop-a");
    expect(out).toMatchObject({ connecting: false, problem: "api-disabled" });
    api.override("/v1/device/authorize", null);
  });
});

describe("the name a deck connects under", () => {
  it("is cleaned the way the API cleans it", () => {
    expect(cleanDeviceName("  my‮laptop\n\t x ")).toBe("mylaptop x");
    expect(cleanDeviceName("\u0000\u0007")).toBe("");
    expect(cleanDeviceName("x".repeat(80))).toHaveLength(DEVICE_NAME_MAX);
    expect(cleanDeviceName(42 as unknown as string, "fallback")).toBe("fallback");
    expect(defaultDeviceName("laptop-a.local")).toBe("laptop-a");
    expect(defaultDeviceName("")).toBe("this machine");
  });

  describe("through the service", () => {
    let dir = "";
    afterEach(() => { if (dir) rmTempDir(dir); dir = ""; });

    function service(lanName = "") {
      dir = tempDir("ccdeck-account-connect-");
      return createAccountService({
        env: { CCDECK_ACCOUNT_API: api.url },
        home: join(dir, "deck"),
        prefs: () => ({ lan: { name: lanName } }),
        tokenStore: createTokenStore({ platform: "linux", env: {}, home: join(dir, "deck"), which: () => false }),
        facts: FACTS,
        log: () => {},
      });
    }

    it("offers this deck's LAN name, or the machine's, before anything is sent", async () => {
      const s = service("desk");
      await s.start();
      const before = api.requests.length;
      expect(s.view()).toMatchObject({ state: "disconnected", suggestedName: "desk", tokenStorage: "file" });
      expect(api.requests.length, "nothing sent to show the name").toBe(before);
      s.stop();
    });

    it("sends the name the person typed, cleaned, and only the deck's four facts with it", async () => {
      const s = service("desk");
      await s.start();
      const view = await s.connect("  work‮ laptop \n");
      expect(view.state).toBe("connecting");
      const sent = api.requests.filter(r => r.path === "/v1/device/authorize").at(-1)!;
      expect(sent.body).toEqual({ name: "work laptop", ...FACTS });
      // No install id, no fingerprint, no cookie, no token: the account
      // channel carries nothing from the reports channel.
      expect(Object.keys(sent.headers).sort()).toEqual(["accept", "connection", "content-length", "content-type", "host", "user-agent"]);
      expect(sent.headers["user-agent"]).toBe("ccdeck/3.43.0");
      await s.cancelConnect();
      s.stop();
    });

    it("falls back to the suggestion for an empty name", async () => {
      const s = service("desk");
      await s.start();
      await s.connect("   ");
      expect(api.requests.filter(r => r.path === "/v1/device/authorize").at(-1)!.body.name).toBe("desk");
      await s.cancelConnect();
      s.stop();
    });

    it("keeps the token in a 0600 account.json on a machine with no secret store, and never in the view", async () => {
      const timers = manualTimers();
      dir = tempDir("ccdeck-account-connect-");
      const home = join(dir, "deck");
      const s = createAccountService({
        env: { CCDECK_ACCOUNT_API: api.url }, home, prefs: () => ({}),
        tokenStore: createTokenStore({ platform: "linux", env: {}, home, which: () => false }),
        facts: FACTS, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: () => {},
      });
      await s.start();
      const v = await s.connect("laptop-a");
      api.approve(v.connect.userCode);
      clock.advance(5_000);
      const { existsSync } = await import("node:fs");
      await timers.fire({ until: () => s.view().state === "connected" && existsSync(join(home, "account.json")) });
      await settle(50);
      const after = s.view();
      expect(after).toMatchObject({ state: "connected", account: { email: "me@example.com" }, tokenStorage: "file" });
      expect(after.device.consoleUrl).toBe(`https://app.ccdeck.dev/machines/${after.device.id}`);
      expect(JSON.stringify(after)).not.toMatch(/ccd[dc]_/);
      const file = join(home, "account.json");
      const { statSync } = await import("node:fs");
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).toMatch(/"token": "ccdd_/);
      s.stop();
    });
  });
});
