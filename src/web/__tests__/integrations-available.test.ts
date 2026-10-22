// Whether this deck can connect and read a kind (#2178): each provider says
// so (`available`), the page is told of every registered provider with that
// answer and offers only those that can (a deck with none lists none), and a
// route that would ask a provider that is not answering, or ask for a saved
// connection whose provider this deck does not have, answers the error kind
// `unavailable` (503) and asks nothing. An image is an empty 404 as always,
// and Disconnect still works. A booted deck in a sandbox home, with fake
// providers this suite registers itself.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { rmTempDir } from "./rm-temp-dir";
import { fakeProvider, fakeToken, startFakeTracker, type FakeTracker } from "./integrations-fake";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-integrations-available-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.AGENTS_DECK_NO_LAN = "1";
if (!resolve(process.env.CCDECK_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

const said: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { said.push(args.map(String).join(" ")); });
}

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { isAvailable, providerList, registerProvider } = await import("../../server/integrations/registry.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { ERROR_STATUS, errorResponse, integrationError, isTypedError } = await import("../../server/integrations/errors.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { integrationsStore } = await import("../../server/integrations/store.mjs");

const TOKEN = fakeToken("available");
let down = false;
let validateDown = false;
const tracker = fakeProvider({ kind: "tracker", label: "Tracker" });
const flaky = fakeProvider({ kind: "tracker-down", label: "Tracker Down", available: () => !down });
const leaving = fakeProvider({ kind: "tracker-leaving", label: "Tracker Leaving",
  validateFails: () => (validateDown ? integrationError("unavailable", "Tracker Leaving stopped answering.") : null) });

let server: Server;
let port = 0;
let token = "";
let site: FakeTracker;
beforeAll(async () => {
  site = await startFakeTracker({ token: TOKEN });
  for (const p of [tracker, flaky, leaving]) registerProvider(p);
  server = await mod.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
  token = mod.hookToken();
}, 30_000);
afterAll(async () => {
  await new Promise(r => server.close(r));
  await site?.close();
  rmTempDir(DIR);
});

interface Answer { status: number; body: any; raw: string; headers: IncomingHttpHeaders }
function call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Answer> {
  return new Promise((resolve_, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method, agent: false,
      headers: headers ?? { host: `127.0.0.1:${port}`, "x-ccdeck-token": token, ...(payload ? { "content-type": "application/json" } : {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: any = null;
        try { parsed = JSON.parse(raw); } catch { /* an image, or nothing */ }
        resolve_({ status: res.statusCode ?? 0, body: parsed, raw, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}
const page = (path: string, method = "GET") => call(method, path, undefined, { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
const list = async () => (await page("/api/integrations")).body.connections;
const expectUnavailable = (r: Answer) => {
  expect(r.status).toBe(503);
  expect(r.body).toMatchObject({ ok: false, error: { kind: "unavailable" } });
  expect(r.body.error.message).toMatch(/is not available on this deck\./);
};
const askedOf = (p: ReturnType<typeof fakeProvider>) => JSON.stringify([p.calls.validate, p.calls.asset, p.calls.routes, site.requests.length]);
const connect = async (kind: string) => {
  const r = await call("POST", "/api/integrations/connections", { kind, input: { baseUrl: site.url, token: TOKEN } });
  expect(r.status).toBe(201);
  return r.body.connection.id as string;
};

describe("the kinds the page is told about", () => {
  it("say of each provider whether this deck can connect and read it now", async () => {
    down = false;
    expect(providerList()).toEqual(expect.arrayContaining([
      { kind: "tracker", label: "Tracker", available: true },
      { kind: "tracker-down", label: "Tracker Down", available: true },
    ]));
    down = true;
    expect(providerList()).toEqual(expect.arrayContaining([{ kind: "tracker-down", label: "Tracker Down", available: false }]));
    down = false;
    const r = await page("/api/integrations");
    expect(r.body.providers).toEqual(expect.arrayContaining([{ kind: "tracker", label: "Tracker", available: true }]));
  });

  it("are every registered provider, one not answering listed with available false, and every saved connection stays listed", async () => {
    down = false;
    const id = await connect("tracker-down");
    const listed = async () => (await page("/api/integrations")).body.providers;
    expect(await listed()).toContainEqual({ kind: "tracker-down", label: "Tracker Down", available: true });
    down = true;
    try {
      const r = await page("/api/integrations");
      expect(r.status).toBe(200);
      // Listed, as not available now: the page keeps reading the list (it
      // polls where the deck reports a provider) and offers the kind only
      // once it says true.
      expect(r.body.providers).toContainEqual({ kind: "tracker-down", label: "Tracker Down", available: false });
      expect(r.body.providers).toContainEqual({ kind: "tracker", label: "Tracker", available: true });
      expect(r.body.providers).toEqual(providerList());
      expect(r.body.connections.find((c: { id: string }) => c.id === id)).toMatchObject({ kind: "tracker-down", tokenSaved: true });
      expect((await page("/api/integrations", "HEAD")).status).toBe(200);
    } finally {
      down = false;
    }
    expect(await listed()).toContainEqual({ kind: "tracker-down", label: "Tracker Down", available: true });
    expect((await call("DELETE", `/api/integrations/connections/${id}`)).status).toBe(200);
  });

  it("take a provider that cannot say, or fails saying it, as not available", () => {
    expect(isAvailable(null)).toBe(false);
    expect(isAvailable({ kind: "x" })).toBe(true);
    expect(isAvailable({ available: () => "yes" })).toBe(false);
    expect(isAvailable({ available: () => { throw new Error("gone"); } })).toBe(false);
    expect(() => registerProvider({ ...fakeProvider({ kind: "tracker-bad" }), available: true })).toThrow(/available must be a function/);
  });
});

describe("the error kind unavailable", () => {
  it("is the deck's 503, in the shared envelope", () => {
    expect(ERROR_STATUS.unavailable).toBe(503);
    const err = integrationError("unavailable", "Tracker is not available on this deck.");
    expect(isTypedError(err)).toBe(true);
    expect(errorResponse(err)).toEqual({ status: 503, body: { ok: false, error: { kind: "unavailable", message: "Tracker is not available on this deck." } } });
  });
});

describe("a provider that is not available", () => {
  let id = "";

  it("is not asked to connect, and nothing is saved", async () => {
    down = true;
    const before = await list();
    const asked = askedOf(flaky);
    expectUnavailable(await call("POST", "/api/integrations/connections", { kind: "tracker-down", input: { baseUrl: site.url, token: TOKEN } }));
    expect(askedOf(flaky)).toBe(asked);
    expect(await list()).toEqual(before);
    down = false;
    id = await connect("tracker-down");
  });

  it("answers every read, HEAD too, unavailable, and asks nothing", async () => {
    down = true;
    const asked = askedOf(flaky);
    expectUnavailable(await page(`/api/integrations/tracker-down/${id}/items`));
    expect((await page(`/api/integrations/tracker-down/${id}/items`, "HEAD")).status).toBe(503);
    expect(askedOf(flaky)).toBe(asked);
  });

  it("answers an image with an empty 404, and asks nothing", async () => {
    const asked = askedOf(flaky);
    const r = await page(`/api/integrations/tracker-down/${id}/asset?url=${encodeURIComponent(`${site.url}/avatar.png`)}`);
    expect([r.status, r.raw]).toEqual([404, ""]);
    expect(askedOf(flaky)).toBe(asked);
  });

  it("answers Test and Edit unavailable, and changes nothing", async () => {
    const before = await list();
    const asked = askedOf(flaky);
    expectUnavailable(await call("POST", `/api/integrations/connections/${id}/test`, {}));
    expectUnavailable(await call("PATCH", `/api/integrations/connections/${id}`, { name: "Renamed" }));
    expectUnavailable(await call("PATCH", `/api/integrations/connections/${id}`, { input: { baseUrl: site.url, token: TOKEN } }));
    expect(askedOf(flaky)).toBe(asked);
    expect(await list()).toEqual(before);
  });

  it("still says not found for a connection that is not there, and refuses a write", async () => {
    const r = await page("/api/integrations/tracker-down/no-such-id/items");
    expect(r.status).toBe(404);
    expect(r.body.error.kind).toBe("not-found");
    expect((await call("POST", `/api/integrations/tracker-down/${id}/items`, {})).status).toBe(405);
  });

  it("reads again the moment it is back", async () => {
    down = false;
    const r = await page(`/api/integrations/tracker-down/${id}/items`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
  });

  it("is disconnected while it is not available, with its token", async () => {
    down = true;
    const r = await call("DELETE", `/api/integrations/connections/${id}`);
    expect(r.status).toBe(200);
    expect((await list()).map((c: { id: string }) => c.id)).not.toContain(id);
    expect(readFileSync(join(DIR, "deck", "integrations", "integrations-secrets.json"), "utf8")).not.toContain(TOKEN);
    down = false;
  });
});

describe("a provider that stops answering", () => {
  it("answers the read it stopped in unavailable, and the connection is as it was", async () => {
    const id = await connect("tracker");
    const before = await list();
    const r = await page(`/api/integrations/tracker/${id}/gone`);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, error: { kind: "unavailable", message: "Tracker stopped answering." } });
    expect(await list()).toEqual(before);
    expect((await call("DELETE", `/api/integrations/connections/${id}`)).status).toBe(200);
  });

  it("answers a connect it stopped in unavailable, and nothing is saved", async () => {
    validateDown = true;
    try {
      const before = await list();
      const r = await call("POST", "/api/integrations/connections", { kind: "tracker-leaving", input: { baseUrl: site.url, token: TOKEN } });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ ok: false, error: { kind: "unavailable", message: "Tracker Leaving stopped answering." } });
      expect(await list()).toEqual(before);
    } finally {
      validateDown = false;
    }
  });
});

describe("a saved connection whose provider this deck does not have", () => {
  // A kind no provider here is registered for: a connection a newer deck saved,
  // or one whose provider was taken out.
  const STRANDED = fakeToken("stranded-youtrack");
  let id = "";
  beforeAll(async () => {
    const conn = await integrationsStore.create({
      kind: "youtrack", name: "Old", baseUrl: "https://youtrack.example.com",
      account: { login: "jdoe" }, allowedOrigins: ["https://youtrack.example.com"],
    }, { auth: "bearer", token: STRANDED });
    id = conn.id;
  });

  it("is listed, with no token, and no provider for its kind", async () => {
    const r = await page("/api/integrations");
    expect(r.body.connections.find((c: { id: string }) => c.id === id)).toMatchObject({ kind: "youtrack", tokenSaved: true });
    expect(r.body.providers.map((p: { kind: string }) => p.kind)).not.toContain("youtrack");
    expect(r.raw).not.toContain(STRANDED);
  });

  it("answers every read unavailable, HEAD too", async () => {
    for (const read of ["boards", "board/1", "board/1/closed-sprints", "board/1/issues", "issue/KEY-1", "issue/KEY-1/subtasks"]) {
      expectUnavailable(await page(`/api/integrations/youtrack/${id}/${read}`));
      expect((await page(`/api/integrations/youtrack/${id}/${read}`, "HEAD")).status).toBe(503);
    }
  });

  it("answers an image with an empty 404", async () => {
    const r = await page(`/api/integrations/youtrack/${id}/asset?url=${encodeURIComponent("https://youtrack.example.com/secure/useravatar?avatarId=1")}`);
    expect([r.status, r.raw]).toEqual([404, ""]);
  });

  it("answers Test and Edit unavailable, and changes nothing", async () => {
    const before = await list();
    expectUnavailable(await call("POST", `/api/integrations/connections/${id}/test`, {}));
    expectUnavailable(await call("PATCH", `/api/integrations/connections/${id}`, { name: "Renamed" }));
    expect(await list()).toEqual(before);
  });

  it("refuses a write to a read with 405, and says not found for anything that is not a saved connection", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await call(method, `/api/integrations/youtrack/${id}/boards`, {})).status, method).toBe(405);
    }
    for (const path of ["/api/integrations/jira/no-such-id/boards", "/api/integrations/nope/abc/items", `/api/integrations/github/${id}/repos`]) {
      const r = await page(path);
      expect([r.status, r.body?.error?.kind], path).toEqual([404, "not-found"]);
    }
  });

  it("is disconnected, with its token", async () => {
    expect((await call("DELETE", `/api/integrations/connections/${id}`)).status).toBe(200);
    expect((await list()).map((c: { id: string }) => c.id)).not.toContain(id);
    expect(readFileSync(join(DIR, "deck", "integrations", "integrations-secrets.json"), "utf8")).not.toContain(STRANDED);
  });
});

describe("what the deck said while it ran", () => {
  it("never once named a token", () => {
    for (const line of said) expect(line.includes(TOKEN), line.slice(0, 120)).toBe(false);
  });
});
