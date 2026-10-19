// The account switched on, end to end inside one deck: the deck the product
// boots (startServer), CCDECK_ACCOUNT=1, and CCDECK_ACCOUNT_API pointing at the
// fake API. Connect through /api/account/connect, approve "in the browser",
// and watch the deck come up connected over its own event stream, send its
// frames, sync its settings, keep its token out of every answer and every
// event, say "stopping" on the way out, and disconnect.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { frameProblem, startFakeApi, type FakeApi } from "./account-fake-api";
import { until } from "./account-test-kit";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-account-on-"));
for (const [k, v] of Object.entries({
  HOME: DIR, USERPROFILE: DIR, CLAUDE_CONFIG_DIR: join(DIR, "claude"), CODEX_HOME: join(DIR, "codex"),
  CCDECK_HOME: join(DIR, "deck"), XDG_CONFIG_HOME: join(DIR, "config"), XDG_DATA_HOME: join(DIR, "data"),
  XDG_STATE_HOME: join(DIR, "state"), CLAUDE_SWAP_BACKUP: join(DIR, "claude-swap"),
})) process.env[k] = v;
if (!resolve(process.env.CLAUDE_CONFIG_DIR!).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
delete process.env.AGENTS_DECK_NO_ACCOUNT;
delete process.env.AGENTS_DECK_NO_INSTALL;

let api: FakeApi;
let server: Server;
let port = 0;
let mod: any;
let token = "";

beforeAll(async () => {
  api = await startFakeApi();
  api.interval = 1;
  process.env.CCDECK_ACCOUNT = "1";
  process.env.CCDECK_ACCOUNT_API = api.url;
  // @ts-expect-error — plain .mjs server module, no types
  mod = await import("../../server/index.mjs");
  server = await mod.startServer({
    port: 0, persist: false, claude: false, codex: false,
    // Never a real keychain from the suite: the file backend.
    account: { tokenStoreOptions: { platform: "linux", env: {}, which: () => false } },
  });
  port = (server.address() as { port: number }).port;
}, 30_000);
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  await api.close();
  for (const k of ["CCDECK_ACCOUNT", "CCDECK_ACCOUNT_API"]) delete process.env[k];
  rmTempDir(DIR);
});

const page = () => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });

function ask(method: string, path: string, body?: unknown, headers: Record<string, string> = page()): Promise<{ status: number; body: string; json: any }> {
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: { ...headers, ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } done({ status: res.statusCode ?? 0, body: raw, json }); });
    });
    req.on("error", fail);
    req.end(payload);
  });
}

/** The deck's event stream, as a page holds it: every frame, by event name. */
function stream() {
  const frames: { event: string; data: string }[] = [];
  const req = request({ host: "127.0.0.1", port, path: "/events", method: "GET", headers: page() }, res => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", c => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
        frames.push({ event, data });
      }
    });
  });
  req.on("error", () => {});
  req.end();
  return { frames, close: () => req.destroy() };
}

describe("a deck with the account on", () => {
  let sse: ReturnType<typeof stream>;

  it("starts disconnected, offering the name it would appear under", async () => {
    sse = stream();
    const got = await ask("GET", "/api/account");
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ enabled: true, state: "disconnected", tokenStorage: "file", connect: null });
    expect(typeof got.json.suggestedName).toBe("string");
    expect((await ask("GET", "/api/prefs")).json).toMatchObject({ accountOn: true, accountVetoed: false });
    expect(api.deviceRequests(), "nothing sent before Connect").toEqual([]);
  });

  it("connects: a code for the browser, then connected on the event stream once approved", async () => {
    const got = await ask("POST", "/api/account/connect", { name: "laptop-a" });
    expect(got.json).toMatchObject({ state: "connecting", connect: { userCode: expect.stringMatching(/^[A-Z]{4}-[A-Z]{4}$/) } });
    expect(got.body).not.toContain("ccdc_");
    api.approve(got.json.connect.userCode);
    await until(() => sse.frames.some(f => f.event === "account" && JSON.parse(f.data).state === "connected"), 8_000, "event: account connected");
    const view = (await ask("GET", "/api/account")).json;
    expect(view).toMatchObject({ state: "connected", account: { email: "me@example.com" }, device: { name: "laptop-a" } });
    const file = JSON.parse(readFileSync(join(process.env.CCDECK_HOME!, "account.json"), "utf8"));
    token = file.token;
    expect(token).toMatch(/^ccdd_/);
    if (process.platform !== "win32") expect(statSync(join(process.env.CCDECK_HOME!, "account.json")).mode & 0o777).toBe(0o600);
  });

  it("sends a valid status frame about three seconds later, on the bearer and nothing else", async () => {
    const device = () => [...api.devices.values()].at(-1)!;
    await until(() => device().frames.length > 0, 8_000, "a status frame");
    const post = api.requests.filter(r => r.path === "/v1/device/status").at(-1)!;
    expect(frameProblem(post.body)).toBeNull();
    // This deck was booted watching neither CLI, and says so rather than
    // sending two zeros nobody measured.
    expect(post.body.agents).toEqual({ unknown: "no-capture" });
    expect(post.headers.authorization).toBe(`Bearer ${token}`);
    expect(Object.keys(post.headers).sort()).toEqual(["accept", "authorization", "connection", "content-length", "content-type", "host", "user-agent"]);
    expect(post.raw).not.toMatch(/installId|deviceId|load/);
  });

  it("keeps the token out of every answer and every event", async () => {
    for (const path of ["/api/account", "/api/prefs"]) {
      const got = await ask("GET", path);
      expect(got.body, path).not.toContain(token);
      expect(got.body, path).not.toMatch(/ccd[dc]_/);
    }
    for (const f of sse.frames) expect(f.data).not.toContain(token);
    // An agent that cat's account.json puts the token into an event; it is
    // taken out before the ring, the stream or the log can hold it.
    await ask("POST", "/api/event", { hook_event_name: "PostToolUse", session_id: "s", tool_response: `{"token": "${token}"}` }, { host: `127.0.0.1:${port}` });
    const ring = await ask("GET", "/api/events");
    expect(ring.body).not.toContain(token);
    expect(ring.body).toContain("[redacted: ccdeck device token]");
  });

  it("syncs: the first tab's values become the device profile", async () => {
    const got = await ask("POST", "/api/account/ui", { values: { theme: "light", density: "compact", fontFamily: "nope" }, reason: "initial" });
    expect(got.status).toBe(200);
    expect(got.json.sync).toMatchObject({ savedRevision: 1, appliedRevision: 1, pending: null });
    const own = api.profiles.get([...api.devices.values()].at(-1)!.ownProfileId)!;
    expect(own.values).toEqual({ theme: "light", density: "compact" });
    const preview = await ask("GET", "/api/account/sync/preview");
    expect(preview.json).toMatchObject({ shared: null, differences: [] });
  });

  it("says stopping on the way out", async () => {
    const device = () => [...api.devices.values()].at(-1)!;
    await mod.beforeShutdown();
    expect(device().frames.at(-1)).toMatchObject({ state: "stopping" });
  });

  it("disconnects: tells the API, forgets the token, keeps the settings", async () => {
    const got = await ask("POST", "/api/account/disconnect", {});
    expect(got.json).toMatchObject({ state: "disconnected", device: null });
    expect(api.requests.filter(r => r.method === "DELETE" && r.path === "/v1/device")).toHaveLength(1);
    const file = JSON.parse(readFileSync(join(process.env.CCDECK_HOME!, "account.json"), "utf8"));
    expect(file.token).toBe("");
    expect(file.previousAccountId).toBe("0199e1c0-0d5b-7d02-8a51-3f6e2c9b1a77");
    expect((await ask("POST", "/api/account/ui", { values: { theme: "dark" }, reason: "user" })).status).toBe(409);
    sse.close();
  });
});

describe("reports never carry the device token", () => {
  it("scrubs ccdd_ and ccdc_ tokens, short ones included", async () => {
    // @ts-expect-error — plain .mjs server module, no types
    const { scrub } = await import("../../server/reports.mjs");
    const said = scrub("failed with ccdd_9QmN2fX0aLr7tYc3Kp8VbWzE1uHs6jDg4oRiTe5yAqM and ccdc_shortbutstilltwentyplus");
    expect(said).not.toMatch(/ccd[dc]_/);
    expect(said).toContain("<secret>");
  });
});
