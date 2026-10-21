// What the integrations host refuses (#2178), before any provider is asked:
// the gates, the methods, the path and the connection, the body, what a
// provider answers, and the asset route. A booted deck in a sandbox home, with
// fake providers this suite registers itself (integrations-fake.ts): the deck
// registers none.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { rmTempDir } from "./rm-temp-dir";
import { fakeProvider, fakeToken, startFakeTracker, type FakeTracker } from "./integrations-fake";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-integrations-requests-"));
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
const { registerProvider } = await import("../../server/integrations/registry.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { integrationsStore } = await import("../../server/integrations/store.mjs");

const TOKEN = fakeToken("requests");
const tracker = fakeProvider({ kind: "tracker", label: "Tracker" });
const otherKind = fakeProvider({ kind: "tracker-b", label: "Tracker B" });
// A client that finds, while validating, that it would send the token over
// plain http to a host that is not this machine.
const unsafe = fakeProvider({ kind: "tracker-unsafe", label: "Unsafe", extraOrigins: () => ["http://tracker.example.com"] });
// A provider whose read answers without a status the deck can send.
const odd = { ...fakeProvider({ kind: "tracker-odd", label: "Odd" }), routes: async () => ({ status: "200", body: { ok: true } }) };

let server: Server;
let port = 0;
let token = "";
let site: FakeTracker;
let id = "";
beforeAll(async () => {
  site = await startFakeTracker({ token: TOKEN });
  for (const p of [tracker, otherKind, unsafe, odd]) registerProvider(p);
  server = await mod.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
  token = mod.hookToken();
  const r = await call("POST", "/api/integrations/connections", { body: { kind: "tracker", name: "Work", input: { baseUrl: site.url, token: TOKEN } } });
  if (r.status !== 201) throw new Error(`setup connection: ${r.status}`);
  id = r.body.connection.id;
}, 30_000);
afterAll(async () => {
  await new Promise(r => server.close(r));
  await site?.close();
  rmTempDir(DIR);
});

interface Answer { status: number; body: any; raw: string; headers: IncomingHttpHeaders }
function call(method: string, path: string, { body, raw, headers }: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve_, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = request({
      host: "127.0.0.1", port, path, method, agent: false,
      headers: headers ?? { host: `127.0.0.1:${port}`, "x-ccdeck-token": token, ...(payload ? { "content-type": "application/json" } : {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* an image, or nothing */ }
        resolve_({ status: res.statusCode ?? 0, body: parsed, raw: text, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => { req.destroy(); reject(new Error(`${method} ${path} timed out`)); });
    req.end(payload);
  });
}
const page = (path: string, method = "GET") => call(method, path, { headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });
const list = async () => (await page("/api/integrations")).body.connections;
/** What the providers were asked and what the tracker was sent, to show
 *  neither happened. (Making a client asks nothing of the tracker.) */
const asked = () => JSON.stringify([tracker, otherKind].map(p => [p.calls.validate, p.calls.asset, p.calls.routes]).concat([site.requests.length]));
const expectRefused = (r: Answer, status: number, kind: string, field?: string) => {
  expect(r.status).toBe(status);
  expect(r.body).toMatchObject({ ok: false, error: { kind, ...(field ? { field } : {}) } });
};

describe("the gates", () => {
  const reads = () => [
    "/api/integrations",
    `/api/integrations/tracker/${id}/items`,
    `/api/integrations/tracker/${id}/asset?url=${encodeURIComponent(`${site.url}/avatar.png`)}`,
  ];

  it("refuses a cross-site read of the list or of anything under it, and asks no provider", async () => {
    const before = asked();
    for (const path of reads()) {
      const r = await call("GET", path, { headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site" } });
      expect(r.status, path).toBe(401);
    }
    expect(asked()).toBe(before);
  });

  it("refuses a read with no fetch metadata and no Referer", async () => {
    const before = asked();
    for (const path of reads()) {
      const r = await call("GET", path, { headers: { host: `127.0.0.1:${port}` } });
      expect(r.status, path).toBe(401);
    }
    expect(asked()).toBe(before);
  });

  it("refuses a mutation without the page or the deck token, and changes nothing", async () => {
    const before = JSON.stringify(await list());
    const mutations: Array<[string, string]> = [
      ["POST", "/api/integrations/connections"],
      ["PATCH", `/api/integrations/connections/${id}`],
      ["POST", `/api/integrations/connections/${id}/test`],
      ["DELETE", `/api/integrations/connections/${id}`],
    ];
    const body = JSON.stringify({ kind: "tracker", name: "Hijacked", input: { baseUrl: site.url, token: TOKEN } });
    for (const [method, path] of mutations) {
      // A DELETE carries no body, as the page sends it.
      const raw = method === "DELETE" ? undefined : body;
      const bare = await call(method, path, { raw, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" } });
      expect(bare.status, `${method} ${path}`).toBe(401);
      const crossSite = await call(method, path, { raw, headers: { host: `127.0.0.1:${port}`, origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" } });
      expect(crossSite.status, `${method} ${path} cross-site`).toBe(403);
    }
    expect(JSON.stringify(await list())).toBe(before);
  });
});

describe("the methods", () => {
  it("answers anything but GET and HEAD on a read with 405, and asks no provider", async () => {
    const before = asked();
    const clients = tracker.calls.createClient;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expectRefused(await call(method, `/api/integrations/tracker/${id}/items`, { body: {} }), 405, "invalid");
    }
    expect(asked()).toBe(before);
    expect(tracker.calls.createClient).toBe(clients);
  });

  it("hands HEAD to the provider as HEAD, and a GET-only provider's 405 comes back", async () => {
    const r = await page(`/api/integrations/tracker/${id}/items`, "HEAD");
    expect(r.status).toBe(405);
    expect(tracker.calls.routes.at(-1)).toBe("HEAD items");
  });

  it("answers anything but GET and HEAD on the list with 405", async () => {
    expectRefused(await call("POST", "/api/integrations", { body: {} }), 405, "invalid");
    expectRefused(await call("PUT", `/api/integrations/connections/${id}`, { body: {} }), 405, "invalid");
  });
});

describe("the path and the connection", () => {
  it("says not found for an unknown kind, no id, or no sub-path", async () => {
    for (const path of ["/api/integrations/nope/abc/items", "/api/integrations/tracker", `/api/integrations/tracker/${id}`]) {
      expectRefused(await page(path), 404, "not-found");
    }
    expectRefused(await call("POST", `/api/integrations/connections/${id}/test/more`, { body: {} }), 404, "not-found");
    expectRefused(await call("DELETE", "/api/integrations/connections/no-such-id"), 404, "not-found");
  });

  it("says not found for a connection read as another kind, or one that is not there, and asks no provider", async () => {
    const before = asked();
    expectRefused(await page(`/api/integrations/tracker-b/${id}/items`), 404, "not-found");
    expectRefused(await page("/api/integrations/tracker/no-such-id/items"), 404, "not-found");
    expect(asked()).toBe(before);
  });

  it("answers expired for a connection with no saved token, and asks no provider", async () => {
    const r = await call("POST", "/api/integrations/connections", { body: { kind: "tracker", input: { baseUrl: site.url, token: TOKEN } } });
    const bare = r.body.connection.id;
    await integrationsStore.update(bare, {}, null);
    const before = asked();
    expectRefused(await page(`/api/integrations/tracker/${bare}/items`), 401, "expired");
    expectRefused(await call("POST", `/api/integrations/connections/${bare}/test`, { body: {} }), 401, "expired");
    expect(asked()).toBe(before);
    expect((await call("DELETE", `/api/integrations/connections/${bare}`)).status).toBe(200);
  });
});

describe("the body", () => {
  it("asks which tracker when the kind is missing or unknown", async () => {
    expectRefused(await call("POST", "/api/integrations/connections", { body: { input: { baseUrl: site.url, token: TOKEN } } }), 400, "invalid", "kind");
    expectRefused(await call("POST", "/api/integrations/connections", { body: { kind: "nope", input: { baseUrl: site.url, token: TOKEN } } }), 400, "invalid", "kind");
  });

  it("refuses a body over 64,000 bytes with 413, and saves nothing", async () => {
    const before = (await list()).length;
    const r = await call("POST", "/api/integrations/connections", { body: { kind: "tracker", name: "x".repeat(64_001), input: { baseUrl: site.url, token: TOKEN } } });
    expect(r.status).toBe(413);
    expect((await list()).length).toBe(before);
  });

  it("reads a body that is not a JSON object as an empty one", async () => {
    for (const raw of ["[1, 2]", "\"tracker\"", "not json", "null"]) {
      expectRefused(await call("POST", "/api/integrations/connections", { raw }), 400, "invalid", "kind");
    }
    const r = await call("PATCH", `/api/integrations/connections/${id}`, { raw: "[\"name\"]" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, validated: false, connection: { name: "Work" } });
  });

  it("cuts a name to 120 characters, on connect and on edit", async () => {
    const r = await call("POST", "/api/integrations/connections", { body: { kind: "tracker", name: "n".repeat(300), input: { baseUrl: site.url, token: TOKEN } } });
    expect(r.status).toBe(201);
    expect(r.body.connection.name).toBe("n".repeat(120));
    const edited = await call("PATCH", `/api/integrations/connections/${r.body.connection.id}`, { body: { name: "e".repeat(300) } });
    expect(edited.body.connection.name).toBe("e".repeat(120));
    expect((await call("DELETE", `/api/integrations/connections/${r.body.connection.id}`)).status).toBe(200);
  });

  it("refuses an address or a token the form rules out, by its field, before asking the tracker", async () => {
    const before = site.requests.length;
    const connect = (input: Record<string, string>) => call("POST", "/api/integrations/connections", { body: { kind: "tracker", input } });
    expectRefused(await connect({ token: TOKEN }), 400, "invalid", "baseUrl");
    expectRefused(await connect({ baseUrl: "http://tracker.example.com", token: TOKEN }), 400, "invalid", "baseUrl");
    expectRefused(await connect({ baseUrl: "https://me:pw@tracker.example.com", token: TOKEN }), 400, "invalid", "baseUrl");
    expectRefused(await connect({ baseUrl: site.url }), 400, "invalid", "token");
    expectRefused(await connect({ baseUrl: site.url, token: "   " }), 400, "invalid", "token");
    expect(site.requests.length).toBe(before);
  });
});

describe("what a provider answers", () => {
  it("refuses an origin the deck would not send a token to, and saves nothing", async () => {
    const before = await list();
    const r = await call("POST", "/api/integrations/connections", { body: { kind: "tracker-unsafe", input: { baseUrl: site.url, token: TOKEN } } });
    expectRefused(r, 400, "invalid");
    expect(r.body.error.message).toMatch(/will not send a token to http:\/\/tracker\.example\.com/);
    expect(await list()).toEqual(before);
  });

  it("answers a read without a status it can send with the deck's 500", async () => {
    const r = await call("POST", "/api/integrations/connections", { body: { kind: "tracker-odd", input: { baseUrl: site.url, token: TOKEN } } });
    expect(r.status).toBe(201);
    expect((await page(`/api/integrations/tracker-odd/${r.body.connection.id}/items`)).status).toBe(500);
    expect((await call("DELETE", `/api/integrations/connections/${r.body.connection.id}`)).status).toBe(200);
  });
});

describe("the asset route", () => {
  const asset = (url: string | null, kind = "tracker", conn = id) =>
    `/api/integrations/${kind}/${conn}/asset${url === null ? "" : `?url=${encodeURIComponent(url)}`}`;

  it("answers an address it will not read with an empty 404, asking nobody", async () => {
    const before = asked();
    for (const url of [null, "", `${site.url}/${"a".repeat(4000)}.png`, "file:///etc/passwd", "javascript:alert(1)", "data:image/png;base64,iVBORw0KGgo=", "ftp://tracker.example.com/a.png", "not a url"]) {
      const r = await page(asset(url));
      expect([r.status, r.raw], String(url).slice(0, 40)).toEqual([404, ""]);
      expect(r.headers["content-type"]).toBeUndefined();
    }
    expect(asked()).toBe(before);
  });

  it("answers a host off the list with an empty 403, before anything is fetched", async () => {
    const before = site.requests.length;
    const r = await page(asset("https://evil.example/a.png"));
    expect([r.status, r.raw]).toEqual([403, ""]);
    expect(site.requests.length).toBe(before);
  });

  it("answers SVG, or bytes that are not the image they say, with an empty 404", async () => {
    for (const path of ["/icon.svg", "/fake.png"]) {
      const r = await page(asset(`${site.url}${path}`));
      expect([r.status, r.raw], path).toEqual([404, ""]);
      expect(r.headers["content-type"]).toBeUndefined();
    }
  });

  it("answers an image of a connection that is not there, or of another kind, with an empty 404", async () => {
    for (const path of [asset(`${site.url}/avatar.png`, "tracker", "no-such-id"), asset(`${site.url}/avatar.png`, "tracker-b")]) {
      const r = await page(path);
      expect([r.status, r.raw], path).toEqual([404, ""]);
    }
  });

  it("touches the connection in none of these", async () => {
    const before = await list();
    for (const url of ["https://evil.example/a.png", `${site.url}/icon.svg`, `${site.url}/fake.png`, "file:///etc/passwd"]) await page(asset(url));
    expect(await list()).toEqual(before);
    expect((await page(`/api/integrations/tracker/${id}/items`)).status).toBe(200);
  });
});

describe("what the deck said and kept while it ran", () => {
  it("never once named the token, and kept it in the secrets file only", () => {
    for (const line of said) expect(line.includes(TOKEN), line.slice(0, 120)).toBe(false);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
    for (const file of walk(DIR)) {
      if (file.endsWith("integrations-secrets.json")) continue;
      expect(readFileSync(file, "latin1").includes(TOKEN), file).toBe(false);
    }
  });
});
