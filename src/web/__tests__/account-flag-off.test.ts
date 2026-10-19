// A deck with the ccdeck account switched off is a deck without one.
//
// The account ships hidden and off: off unless CCDECK_ACCOUNT=1 or the
// deck-owned `account` pref says otherwise. Off has to mean ABSENT, not
// "present and refusing": every /api/account* path answers exactly what an
// /api path with no route answers, the page is told `accountOn: false`, none
// of the account's modules is ever imported, and no request goes to the API —
// even on a machine where account.json still holds a device and its token.
//
// This boots the deck the product boots — startServer with no stand-ins —
// under a sandboxed HOME, with CCDECK_ACCOUNT_API pointing at the fake API, so
// a request that went anywhere would be counted there. Every account module is
// replaced by a factory that writes down that it was asked for, so "not
// imported" is a list that stays empty rather than a claim.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { startFakeApi, type FakeApi } from "./account-fake-api";

const imported = vi.hoisted(() => [] as string[]);
vi.mock("../../server/ccdeck-account-routes.mjs", () => { imported.push("ccdeck-account-routes"); return {}; });
vi.mock("../../server/account-service.mjs", () => { imported.push("account-service"); return {}; });
vi.mock("../../server/account-store.mjs", () => { imported.push("account-store"); return {}; });
vi.mock("../../server/account-token-store.mjs", () => { imported.push("account-token-store"); return {}; });
vi.mock("../../server/account-client.mjs", () => { imported.push("account-client"); return {}; });
vi.mock("../../server/account-connect.mjs", () => { imported.push("account-connect"); return {}; });
vi.mock("../../server/account-status.mjs", () => { imported.push("account-status"); return {}; });
vi.mock("../../server/account-sync.mjs", () => { imported.push("account-sync"); return {}; });
vi.mock("../../server/account-ui-fields.mjs", () => { imported.push("account-ui-fields"); return {}; });
vi.mock("../../server/session-counts.mjs", () => { imported.push("session-counts"); return {}; });

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-account-off-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.XDG_STATE_HOME = join(DIR, "state");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "claude-swap");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
// Off by the variable's absence, whatever the shell running the suite has set.
delete process.env.CCDECK_ACCOUNT;
delete process.env.AGENTS_DECK_NO_ACCOUNT;
delete process.env.AGENTS_DECK_NO_INSTALL;

// A deck that WAS connected: a device and its token on disk. With the account
// off neither may be read, let alone used.
mkdirSync(process.env.CCDECK_HOME, { recursive: true });
writeFileSync(join(process.env.CCDECK_HOME, "account.json"), JSON.stringify({
  v: 1, apiBase: "http://127.0.0.1:1", accountId: "acct", email: "me@example.com", deviceId: "dev", deviceName: "laptop",
  tokenStorage: "file", token: "ccdd_9QmN2fX0aLr7tYc3Kp8VbWzE1uHs6jDg4oRiTe5yAqM",
}), { mode: 0o600 });

let api: FakeApi;
let server: Server;
let port = 0;
let mod: any;
let prefs: any;
let gates: any;
let login: any;

beforeAll(async () => {
  api = await startFakeApi();
  process.env.CCDECK_ACCOUNT_API = api.url;
  // @ts-expect-error — plain .mjs server module, no types
  mod = await import("../../server/index.mjs");
  // @ts-expect-error — plain .mjs server module, no types
  prefs = await import("../../server/deck-prefs.mjs");
  // @ts-expect-error — plain .mjs server module, no types
  gates = await import("../../server/request-gates.mjs");
  // @ts-expect-error — plain .mjs server module, no types
  login = await import("../../server/login-service.mjs");
  server = await mod.startServer({ port: 0, persist: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
}, 30_000);
afterAll(async () => {
  await new Promise(r => server.close(r));
  await api.close();
  delete process.env.CCDECK_ACCOUNT_API;
  rmTempDir(DIR);
});

/** The deck's own page: what passes every gate, so what is left is the route. */
const page = () => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });

interface Answer { status: number; type: string; body: string }

function ask(method: string, path: string, body?: unknown, headers: Record<string, string> = page()): Promise<Answer> {
  return new Promise((resolve_, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: { ...headers, ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve_({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: raw }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error(`${method} ${path} timed out`)); });
    req.end(payload);
  });
}

const ACCOUNT_ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/account"],
  ["POST", "/api/account/connect", { name: "laptop-a" }],
  ["POST", "/api/account/connect/cancel", {}],
  ["POST", "/api/account/disconnect", {}],
  ["POST", "/api/account/ui", { values: { theme: "paper" }, reason: "user" }],
  ["POST", "/api/account/ui/applied", { revision: 1 }],
  ["GET", "/api/account/sync/preview"],
  ["POST", "/api/account/sync/mode", { mode: "shared", join: "use-shared" }],
  ["POST", "/api/account/sync/resolve", { action: "use-latest" }],
  ["POST", "/api/account/sync/upload", { upload: true }],
];

describe("the account routes on a deck with the account switched off", () => {
  it("answer exactly what an /api path with no route answers", async () => {
    for (const [method, path, body] of ACCOUNT_ROUTES) {
      const got = await ask(method, path, body);
      const none = await ask(method, "/api/account/no-such-route", body);
      expect(none.status, "the comparison itself").toBe(404);
      expect(got, `${method} ${path}`).toEqual(none);
    }
  });

  it("are still behind the gates that come first, as every path is", async () => {
    expect(gates.GUARDED_READS.has("/api/account")).toBe(true);
    expect(gates.GUARDED_READS.has("/api/account/sync/preview")).toBe(true);
    expect((await ask("GET", "/api/account", undefined, { host: `127.0.0.1:${port}` })).status).toBe(401);
    expect((await ask("POST", "/api/account/connect", { name: "x" }, { host: `127.0.0.1:${port}` })).status).toBe(401);
  });

  it("tell the page the account is off, in the read it already makes", async () => {
    const got = await ask("GET", "/api/prefs");
    expect(got.status).toBe(200);
    const body = JSON.parse(got.body);
    expect(body.accountOn).toBe(false);
    expect(body.accountVetoed).toBe(false);
    expect(body.prefs.account).toBe(false);
    // And the token on disk is nowhere in it.
    expect(got.body).not.toContain("ccdd_");
  });

  it("is not switched on by a page", async () => {
    const on = JSON.parse((await ask("POST", "/api/prefs", { account: true })).body);
    expect(on.accountOn).toBe(false);
    expect((await ask("GET", "/api/account")).status).toBe(404);
  });

  it("imported none of the account's modules", () => {
    expect(imported).toEqual([]);
  });

  it("sent nothing to the API, with a device and its token on disk", async () => {
    // Long enough for a first status frame (about three seconds after start)
    // to have gone, had anything started.
    await new Promise(r => setTimeout(r, 3_500));
    expect(api.requests).toEqual([]);
  }, 10_000);

  it("would have caught an import: the mocks do intercept", async () => {
    // The positive control for the empty list above. Last, so nothing before
    // it could have been the import it counts.
    // @ts-expect-error — plain .mjs server module, no types
    await import("../../server/session-counts.mjs");
    expect(imported).toEqual(["session-counts"]);
  });
});

describe("accountOn", () => {
  it("is off by default", () => {
    expect(prefs.DEFAULTS.account).toBe(false);
    expect(prefs.normalise({}).account).toBe(false);
  });

  it("is a field no page may write, while the account is hidden", () => {
    expect(prefs.PAGE_FIELDS.top).not.toContain("account");
    expect(prefs.pagePatch({ account: true })).toEqual({});
  });

  it("keeps a hand-edited switch, and only a real true", () => {
    expect(prefs.normalise({ account: true }).account).toBe(true);
    expect(prefs.normalise({ account: "true" }).account).toBe(false);
    expect(prefs.normalise({ account: 1 }).account).toBe(false);
  });

  it("is hidden: the launch variable is in neither the README nor what a login item carries", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
    expect(readme).not.toContain("CCDECK_ACCOUNT");
    expect([...login.SETTING_VARS, ...login.SCOPE_VARS]).not.toContain("CCDECK_ACCOUNT");
    // The veto is carried: a veto is always safe to pass on.
    expect(login.SETTING_VARS).toContain("AGENTS_DECK_NO_ACCOUNT");
  });
});
