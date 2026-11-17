// The two vetoes win over both ways on.
//
// AGENTS_DECK_NO_ACCOUNT=1 is whoever launched the deck saying no account on
// this machine, and AGENTS_DECK_NO_INSTALL=1 is the README's promise that the
// deck "turns off everything but the quota reads". Either one beats the launch
// variable and the stored switch: the routes are the 404 an /api path with no
// route answers, nothing of the account is imported, and nothing is sent — and
// Settings is told it was asked for and vetoed, so it can say "off on this
// machine" rather than draw nothing.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { startFakeApi, type FakeApi } from "./account-fake-api";
// @ts-expect-error — plain .mjs server module, no types
import { accountApiBase, accountOn, accountRequested, accountVetoed, ACCOUNT_API_DEFAULT } from "../../server/account-flag.mjs";

const imported = vi.hoisted(() => [] as string[]);
vi.mock("../../server/ccdeck-account-routes.mjs", () => { imported.push("ccdeck-account-routes"); return {}; });
vi.mock("../../server/account-service.mjs", () => { imported.push("account-service"); return {}; });

describe("accountOn and the vetoes", () => {
  it("is on with the launch variable or the stored switch, and only exactly those", () => {
    expect(accountOn({}, {})).toBe(false);
    expect(accountOn(undefined, {})).toBe(false);
    expect(accountOn({}, { CCDECK_ACCOUNT: "1" })).toBe(true);
    expect(accountOn({ account: true }, {})).toBe(true);
    for (const v of ["", "0", "true", "yes", " 1"]) expect(accountOn({}, { CCDECK_ACCOUNT: v }), JSON.stringify(v)).toBe(false);
    expect(accountOn({ account: "true" }, {})).toBe(false);
  });

  it("is off under AGENTS_DECK_NO_ACCOUNT, whatever else says on", () => {
    const veto = { AGENTS_DECK_NO_ACCOUNT: "1" };
    expect(accountVetoed(veto)).toBe(true);
    expect(accountOn({ account: true }, { ...veto, CCDECK_ACCOUNT: "1" })).toBe(false);
    expect(accountOn({ account: true }, veto)).toBe(false);
    expect(accountOn({}, { ...veto, CCDECK_ACCOUNT: "1" })).toBe(false);
  });

  it("is off under AGENTS_DECK_NO_INSTALL, which the README says turns off everything but the quota reads", () => {
    const veto = { AGENTS_DECK_NO_INSTALL: "1" };
    expect(accountVetoed(veto)).toBe(true);
    expect(accountOn({ account: true }, { ...veto, CCDECK_ACCOUNT: "1" })).toBe(false);
  });

  it("is not vetoed by AGENTS_DECK_NO_REPORTS: the account is chosen, reports are not", () => {
    expect(accountVetoed({ AGENTS_DECK_NO_REPORTS: "1" })).toBe(false);
    expect(accountOn({}, { CCDECK_ACCOUNT: "1", AGENTS_DECK_NO_REPORTS: "1" })).toBe(true);
  });

  it("knows it was asked for, apart from whether it is allowed", () => {
    expect(accountRequested({}, { CCDECK_ACCOUNT: "1", AGENTS_DECK_NO_ACCOUNT: "1" })).toBe(true);
    expect(accountRequested({}, { AGENTS_DECK_NO_INSTALL: "1" })).toBe(false);
  });

  it("talks to https, or to a development API on loopback, and nothing else", () => {
    const warn = vi.fn();
    expect(accountApiBase({}, warn)).toBe(ACCOUNT_API_DEFAULT);
    expect(accountApiBase({ CCDECK_ACCOUNT_API: "http://127.0.0.1:5317" }, warn)).toBe("http://127.0.0.1:5317");
    expect(accountApiBase({ CCDECK_ACCOUNT_API: "http://localhost:5317/" }, warn)).toBe("http://localhost:5317");
    expect(accountApiBase({ CCDECK_ACCOUNT_API: "https://staging.example.com" }, warn)).toBe("https://staging.example.com");
    expect(warn).not.toHaveBeenCalled();
    // A device token must never cross a network in the clear, nor carry a path
    // or a credential the deck did not choose.
    for (const bad of ["http://192.168.1.5:5317", "http://evil.example", "https://u:p@api.example", "https://api.example/v1", "ftp://x", "nonsense"]) {
      expect(accountApiBase({ CCDECK_ACCOUNT_API: bad }, warn), bad).toBe(ACCOUNT_API_DEFAULT);
    }
    expect(warn).toHaveBeenCalled();
  });
});

describe("a deck launched with the account on and a veto", () => {
  const DIR = mkdtempSync(join(tmpdir(), "ccdeck-account-veto-"));
  let api: FakeApi;
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      HOME: DIR, USERPROFILE: DIR, CLAUDE_CONFIG_DIR: join(DIR, "claude"), CODEX_HOME: join(DIR, "codex"),
      CCDECK_HOME: join(DIR, "deck"), XDG_CONFIG_HOME: join(DIR, "config"), XDG_DATA_HOME: join(DIR, "data"),
      XDG_STATE_HOME: join(DIR, "state"), CLAUDE_SWAP_BACKUP: join(DIR, "claude-swap"),
    })) process.env[k] = v;
    if (!resolve(process.env.CLAUDE_CONFIG_DIR!).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
    api = await startFakeApi();
    process.env.CCDECK_ACCOUNT_API = api.url;
    process.env.CCDECK_ACCOUNT = "1";
    process.env.AGENTS_DECK_NO_ACCOUNT = "1";
    // @ts-expect-error — plain .mjs server module, no types
    const mod = await import("../../server/index.mjs");
    server = await mod.startServer({ port: 0, persist: false, claude: false, codex: false });
    port = (server.address() as { port: number }).port;
  }, 30_000);
  afterAll(async () => {
    await new Promise(r => server.close(r));
    await api.close();
    for (const k of ["CCDECK_ACCOUNT", "CCDECK_ACCOUNT_API", "AGENTS_DECK_NO_ACCOUNT", "AGENTS_DECK_NO_INSTALL"]) delete process.env[k];
    rmTempDir(DIR);
  });

  const ask = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: string }>((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: {
        host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin",
        ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
      },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body: raw }));
    });
    req.on("error", fail);
    req.end(payload);
  });

  it("has no account routes, under either veto", async () => {
    for (const veto of ["AGENTS_DECK_NO_ACCOUNT", "AGENTS_DECK_NO_INSTALL"]) {
      delete process.env.AGENTS_DECK_NO_ACCOUNT;
      delete process.env.AGENTS_DECK_NO_INSTALL;
      process.env[veto] = "1";
      expect((await ask("GET", "/api/account")).status, veto).toBe(404);
      expect((await ask("POST", "/api/account/connect", { name: "x" })).status, veto).toBe(404);
    }
  });

  it("tells Settings the account was asked for and is off on this machine", async () => {
    const body = JSON.parse((await ask("GET", "/api/prefs")).body);
    expect(body.accountOn).toBe(false);
    expect(body.accountVetoed).toBe(true);
  });

  it("imported nothing of the account and sent nothing", async () => {
    await new Promise(r => setTimeout(r, 300));
    expect(imported).toEqual([]);
    expect(api.requests).toEqual([]);
  });
});
