// /api/integrations end to end (#2178): a booted deck in a sandbox home, and a
// fake tracker on this machine behind a provider this suite registers itself
// (integrations-fake.ts) — the deck registers none. What it holds the deck to
// is the issue's own list: the token goes in through the form and never comes
// back out — not in an answer, not in a log, not in prefs, not in any file but
// the secrets file — every read under the prefix is a guarded read, and the
// asset route answers an image or an empty refusal and never touches the
// connection.
//
// These are the host's cases of development's suite. Its Jira cases (the mock
// Jira's boards and sprints, Jira Cloud's two kinds of token) belong to the
// Jira provider and stay with it.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { rmTempDir } from "./rm-temp-dir";
import { fakeProvider, fakeToken, startFakeTracker, type FakeTracker } from "./integrations-fake";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-integrations-2178-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.AGENTS_DECK_NO_LAN = "1";
if (!resolve(process.env.CCDECK_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

/** Everything the deck says while it runs, to look for a token in afterwards. */
const said: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { said.push(args.map(String).join(" ")); });
}

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { GUARDED_READS, isGuardedRead } = await import("../../server/request-gates.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { registerProvider } = await import("../../server/integrations/registry.mjs");

const TOKEN = fakeToken("routes");
const SECRETS = [TOKEN];
const tracker = fakeProvider({ kind: "tracker", label: "Tracker" });
let api: FakeTracker;
const twoOrigins = fakeProvider({ kind: "tracker-api", label: "Tracker API", extraOrigins: () => [api.url] });

let server: Server;
let port = 0;
let token = "";
let site: FakeTracker;
let old: FakeTracker;
let other: FakeTracker;
beforeAll(async () => {
  [site, api, old, other] = await Promise.all([1, 2, 3, 4].map(() => startFakeTracker({ token: TOKEN })));
  old.setMode("old");
  registerProvider(tracker);
  registerProvider(twoOrigins);
  server = await mod.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
  token = mod.hookToken();
}, 30_000);
afterAll(async () => {
  await new Promise(r => server.close(r));
  await Promise.all([site, api, old, other].map(t => t?.close()));
  rmTempDir(DIR);
});

interface Answer { status: number; body: any; raw: string; headers: IncomingHttpHeaders }
function call(method: string, path: string, { body, headers }: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve_, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method,
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
    req.setTimeout(20_000, () => { req.destroy(); reject(new Error(`${method} ${path} timed out`)); });
    req.end(payload);
  });
}
const page = (path: string) => call("GET", path, { headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } });

/** Every file under the sandbox but the one that is allowed to hold a token. */
function filesBut(skip: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (name !== skip && st.size < 8 * 1024 * 1024) out.push(path);
    }
  };
  walk(DIR);
  return out;
}

describe("every read under /api/integrations/ is a guarded read", () => {
  const paths = [
    "/api/integrations/gitlab/abc123/changes",
    `/api/integrations/tracker/abc123/asset?url=${encodeURIComponent("https://tracker.example.com/secure/useravatar?avatarId=1")}`,
  ];

  it("names the list and the whole prefix", () => {
    expect(GUARDED_READS.has("/api/integrations")).toBe(true);
    for (const path of paths) expect(isGuardedRead(new URL(path, "http://x").pathname), path).toBe(true);
    expect(isGuardedRead("/api/integrationsX")).toBe(false);
  });

  for (const path of paths) {
    it(`refuses a cross-site read of ${path.split("?")[0]}`, async () => {
      const r = await call("GET", path, { headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site" } });
      expect(r.status).toBe(401);
    });

    it(`refuses a read with no fetch metadata and no Referer of ${path.split("?")[0]}`, async () => {
      const r = await call("GET", path, { headers: { host: `127.0.0.1:${port}` } });
      expect(r.status).toBe(401);
    });

    it(`lets the deck's own page read ${path.split("?")[0]}, which the route then answers`, async () => {
      // Past the gate: no connection abc123, and no provider at all for
      // gitlab, so the route itself says not found — an image's refusal empty.
      const r = await page(path);
      expect(r.status).toBe(404);
      if (path.includes("/asset?")) expect(r.raw).toBe("");
    });
  }
});

describe("a connection to a tracker", () => {
  let id = "";
  let avatar = "";

  it("connects with a token, and answers with the account but never the token", async () => {
    const r = await call("POST", "/api/integrations/connections", {
      body: { kind: "tracker", name: "Work", input: { baseUrl: site.url, token: TOKEN } },
    });
    expect(r.status).toBe(201);
    expect(r.body.connection).toMatchObject({ kind: "tracker", name: "Work", baseUrl: site.url, tokenSaved: true, account: { login: "jdoe" } });
    expect(r.body.connection.meta).toMatchObject({ version: 9 });
    for (const s of SECRETS) expect(r.raw).not.toContain(s);
    id = r.body.connection.id;
    avatar = r.body.connection.account.avatarUrl;
    expect(avatar).toMatch(new RegExp(`^/api/integrations/tracker/${id}/asset\\?url=`));
  });

  it("keeps the token out of the list, and out of every file but the secrets file", async () => {
    const list = await page("/api/integrations");
    expect(list.status).toBe(200);
    expect(list.body.connections.map((c: { id: string }) => c.id)).toContain(id);
    for (const s of SECRETS) expect(list.raw).not.toContain(s);
    const prefs = await page("/api/prefs");
    for (const s of SECRETS) expect(prefs.raw).not.toContain(s);
    const home = join(DIR, "deck");
    const secretsFile = readdirSync(home, { recursive: true }).map(String).find(f => f.endsWith("integrations-secrets.json"))!;
    expect(secretsFile).toBeTruthy();
    const secretsPath = join(home, secretsFile);
    expect(readFileSync(secretsPath, "utf8")).toContain(TOKEN);
    if (process.platform !== "win32") {
      expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(secretsPath, "..", "integrations.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(secretsPath, "..")).mode & 0o777).toBe(0o700);
    }
    for (const file of filesBut("integrations-secrets.json")) {
      const text = readFileSync(file, "latin1");
      for (const s of SECRETS) expect(text.includes(s), `${file} holds a token`).toBe(false);
    }
  });

  it("reads through the provider's own routes, signed with the saved token", async () => {
    const from = site.requests.length;
    const items = await page(`/api/integrations/tracker/${id}/items`);
    expect(items.status).toBe(200);
    expect(items.body).toEqual({ ok: true, items: [{ id: 1, title: "First" }, { id: 2, title: "Second" }] });
    expect(site.requests.slice(from)).toEqual([{ path: "/items", signed: true }]);
    for (const s of SECRETS) expect(items.raw).not.toContain(s);
    const missing = await page(`/api/integrations/tracker/${id}/nothing/here`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ ok: false, error: { kind: "not-found" } });
  });

  it("serves an avatar as an image, under headers that keep it one", async () => {
    const r = await page(avatar);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(r.headers["cache-control"]).toBe("private, max-age=300");
  });

  const asset = (url: string) => `/api/integrations/tracker/${id}/asset?url=${encodeURIComponent(url)}`;

  it("serves an image as the raster type its bytes are, whatever raster type it was labelled", async () => {
    // Jira Data Center labels an uploaded avatar's PNG image/jpeg; refusing it
    // drew every Jira face as initials.
    const r = await page(asset(`${site.url}/useravatar`));
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("refuses an image on any other host, an SVG, and a page that calls itself a PNG — each with an empty body", async () => {
    const foreign = await page(asset("https://evil.example/a.png"));
    expect([foreign.status, foreign.raw]).toEqual([403, ""]);
    const svg = await page(asset(`${site.url}/icon.svg`));
    expect([svg.status, svg.raw]).toEqual([404, ""]);
    const fake = await page(asset(`${site.url}/fake.png`));
    expect([fake.status, fake.raw]).toEqual([404, ""]);
    const away = await page(asset(`${site.url}/redirect-foreign`));
    expect([away.status, away.raw]).toEqual([403, ""]);
    expect(svg.headers["content-type"]).toBeUndefined();
  });

  it("takes a 401 on an image as a missing image: the connection is exactly as it was", async () => {
    const before = (await page("/api/integrations")).body.connections.find((c: { id: string }) => c.id === id);
    site.setMode("401");
    try {
      const r = await page(asset(`${site.url}/avatar.png?size=small`));
      expect([r.status, r.raw]).toEqual([404, ""]);
    } finally {
      site.setMode("ok");
    }
    const after = (await page("/api/integrations")).body.connections.find((c: { id: string }) => c.id === id);
    expect(after).toEqual(before);
    expect((await page(`/api/integrations/tracker/${id}/items`)).status).toBe(200);
  });

  it("answers a refused token on a read with the envelope's expired, and leaves the connection for the user to fix", async () => {
    site.setMode("401");
    try {
      const r = await page(`/api/integrations/tracker/${id}/items`);
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ ok: false, error: { kind: "expired" } });
    } finally {
      site.setMode("ok");
    }
    const list = await page("/api/integrations");
    expect(list.body.connections.find((c: { id: string }) => c.id === id)).toMatchObject({ tokenSaved: true });
  });

  it("answers a rate limit with its Retry-After", async () => {
    site.setMode("429");
    try {
      const r = await page(`/api/integrations/tracker/${id}/items?page=2`);
      expect(r.status).toBe(429);
      expect(r.body.error).toMatchObject({ kind: "rate-limit", retryAfter: 30 });
    } finally {
      site.setMode("ok");
    }
  });

  it("asks the tracker again on Test, and says so", async () => {
    const r = await call("POST", `/api/integrations/connections/${id}/test`, { body: {} });
    expect(r.status).toBe(200);
    expect(r.body.connection.tokenSaved).toBe(true);
    for (const s of SECRETS) expect(r.raw).not.toContain(s);
  });

  it("refuses a token the tracker does not accept", async () => {
    const r = await call("POST", "/api/integrations/connections", {
      body: { kind: "tracker", input: { baseUrl: site.url, token: "not-the-token" } },
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatchObject({ kind: "auth" });
    expect(r.raw).not.toContain("not-the-token");
  });

  it("refuses a server the provider cannot read, and saves nothing", async () => {
    const before = (await page("/api/integrations")).body.connections.length;
    const r = await call("POST", "/api/integrations/connections", {
      body: { kind: "tracker", input: { baseUrl: old.url, token: TOKEN } },
    });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatchObject({ kind: "incompatible" });
    expect((await page("/api/integrations")).body.connections.length).toBe(before);
  });

  it("only reads: a write to a provider route is refused", async () => {
    const r = await call("POST", `/api/integrations/tracker/${id}/items`, { body: {} });
    expect(r.status).toBe(405);
  });

  it("disconnects, and the token goes with the connection", async () => {
    const r = await call("DELETE", `/api/integrations/connections/${id}`);
    expect(r.status).toBe(200);
    const list = await page("/api/integrations");
    expect(list.body.connections.map((c: { id: string }) => c.id)).not.toContain(id);
    for (const file of filesBut("")) {
      expect(readFileSync(file, "latin1").includes(TOKEN), file).toBe(false);
    }
    expect((await page(`/api/integrations/tracker/${id}/items`)).status).toBe(404);
  });
});

describe("a connection whose provider finds another origin while validating", () => {
  it("keeps every origin it learned, each checked, and sends the token to those only", async () => {
    const r = await call("POST", "/api/integrations/connections", {
      body: { kind: "tracker-api", input: { baseUrl: site.url, token: TOKEN } },
    });
    expect(r.status).toBe(201);
    const conn = r.body.connection;
    expect(conn.allowedOrigins).toEqual([new URL(site.url).origin, new URL(api.url).origin]);
    for (const s of SECRETS) expect(r.raw).not.toContain(s);
    // An image on the learned origin is read with the token; one on an origin
    // the connection never learned is refused before anything is fetched.
    const from = api.requests.length;
    const learned = await page(`/api/integrations/tracker-api/${conn.id}/asset?url=${encodeURIComponent(`${api.url}/avatar.png`)}`);
    expect(learned.status).toBe(200);
    expect(api.requests.slice(from)).toEqual([{ path: "/avatar.png", signed: true }]);
    const elsewhere = await page(`/api/integrations/tracker-api/${conn.id}/asset?url=${encodeURIComponent(`${other.url}/avatar.png`)}`);
    expect([elsewhere.status, elsewhere.raw]).toEqual([403, ""]);
    expect(other.requests).toEqual([]);
    expect((await call("DELETE", `/api/integrations/connections/${conn.id}`)).status).toBe(200);
  });
});

describe("what the deck said while it ran", () => {
  it("never once named a token", () => {
    expect(said.length).toBeGreaterThanOrEqual(0);
    for (const line of said) for (const s of SECRETS) expect(line.includes(s), line.slice(0, 120)).toBe(false);
  });
});
