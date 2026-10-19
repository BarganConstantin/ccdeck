// /api/integrations end to end (#2178): a booted deck in a sandbox home, and the
// mock Jira (scripts/mock-jira.mjs) as Server / Data Center and as Cloud, with
// both kinds of Cloud token. What it holds the deck to is the issue's own list:
// the token goes in through the form and never comes back out — not in an
// answer, not in a log, not in prefs, not in any file but the secrets file —
// every read under the prefix is a guarded read, and the asset route answers an
// image or an empty refusal and never touches the connection.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { rmTempDir } from "./rm-temp-dir";

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
// @ts-expect-error — plain .mjs script, no types
const { startMockJira, MOCK_CREDENTIALS } = await import("../../../scripts/mock-jira.mjs");

type Mock = { url: string; apiUrl: string | null; setMode: (m: string) => void; close: () => Promise<void>; requests: Array<{ path: string; auth: string }> };
const SECRETS = [MOCK_CREDENTIALS.server.bearer, MOCK_CREDENTIALS.cloud.classicToken, MOCK_CREDENTIALS.cloud.scopedToken] as string[];

let server: Server;
let port = 0;
let token = "";
let jiraServer: Mock;
let jiraCloud: Mock;
let jiraOld: Mock;
beforeAll(async () => {
  [jiraServer, jiraCloud, jiraOld] = await Promise.all([
    startMockJira({ flavor: "server", port: 0 }),
    startMockJira({ flavor: "cloud", port: 0, apiPort: 0 }),
    startMockJira({ flavor: "server", port: 0, version: "8.5.0" }),
  ]);
  // The scoped token's api.atlassian.com, on this machine: honoured only for a
  // site that is on this machine too (atlassianApiOrigin).
  process.env.CCDECK_JIRA_API_ORIGIN = jiraCloud.apiUrl!;
  server = await mod.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
  token = mod.hookToken();
}, 30_000);
afterAll(async () => {
  await new Promise(r => server.close(r));
  await Promise.all([jiraServer, jiraCloud, jiraOld].map(j => j?.close()));
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
const get = (path: string) => call("GET", path);
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
    `/api/integrations/jira/abc123/asset?url=${encodeURIComponent("https://jira.example.com/secure/useravatar?avatarId=1")}`,
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
      // Past the gate: no connection abc123 (for jira, or for the gitlab
      // provider #2179 registers), so the route itself says not found — an
      // image's refusal empty.
      const r = await page(path);
      expect(r.status).toBe(404);
      if (path.includes("/asset?")) expect(r.raw).toBe("");
    });
  }
});

describe("a Jira Server / Data Center connection", () => {
  let id = "";
  let avatar = "";

  it("connects with a personal access token, and answers with the account but never the token", async () => {
    const r = await call("POST", "/api/integrations/connections", {
      body: { kind: "jira", name: "Work", input: { deployment: "server", baseUrl: jiraServer.url, token: MOCK_CREDENTIALS.server.bearer } },
    });
    expect(r.status).toBe(201);
    expect(r.body.connection).toMatchObject({ kind: "jira", name: "Work", baseUrl: jiraServer.url, tokenSaved: true, account: { login: "jdoe" } });
    expect(r.body.connection.meta).toMatchObject({ deployment: "server" });
    for (const s of SECRETS) expect(r.raw).not.toContain(s);
    id = r.body.connection.id;
    avatar = r.body.connection.account.avatarUrl;
    expect(avatar).toMatch(new RegExp(`^/api/integrations/jira/${id}/asset\\?url=`));
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
    expect(readFileSync(secretsPath, "utf8")).toContain(MOCK_CREDENTIALS.server.bearer);
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

  it("reads the boards, a board's sprints and the issues in one", async () => {
    const boards = await page(`/api/integrations/jira/${id}/boards`);
    expect(boards.status).toBe(200);
    expect(boards.body.boards[0]).toMatchObject({ id: 1, name: "MOCK board" });
    const board = await page(`/api/integrations/jira/${id}/board/1`);
    expect(board.status).toBe(200);
    expect(board.body.sprints.active.map((s: { name: string }) => s.name)).toEqual(["MOCK Sprint 13"]);
    const sprint = board.body.sprints.active[0].id;
    const issues = await page(`/api/integrations/jira/${id}/board/1/issues?source=sprint&sprint=${sprint}&mine=1`);
    expect(issues.status).toBe(200);
    const keys = issues.body.issues.map((i: { key: string }) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["MOCK-10", "MOCK-11", "MOCK-21", "MOCK-30", "MOCK-33"]));
    expect(keys).not.toContain("MOCK-22");
    const detail = await page(`/api/integrations/jira/${id}/issue/MOCK-10`);
    expect(detail.status).toBe(200);
    expect(detail.body.issue.key).toBe("MOCK-10");
    expect(detail.body.attachments.length).toBe(3);
  });

  it("serves an avatar as an image, under headers that keep it one", async () => {
    const r = await page(avatar);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(r.headers["cache-control"]).toBe("private, max-age=300");
  });

  const asset = (url: string) => `/api/integrations/jira/${id}/asset?url=${encodeURIComponent(url)}`;

  it("refuses an image on any other host, an SVG, and a page that calls itself a PNG — each with an empty body", async () => {
    const foreign = await page(asset("https://evil.example/a.png"));
    expect([foreign.status, foreign.raw]).toEqual([403, ""]);
    const svg = await page(asset(`${jiraServer.url}/images/icons/priorities/high.svg`));
    expect([svg.status, svg.raw]).toEqual([404, ""]);
    const fake = await page(asset(`${jiraServer.url}/images/fake.png`));
    expect([fake.status, fake.raw]).toEqual([404, ""]);
    const away = await page(asset(`${jiraServer.url}/redirect-foreign`));
    expect([away.status, away.raw]).toEqual([403, ""]);
    expect(svg.headers["content-type"]).toBeUndefined();
  });

  it("takes a 401 on an image as a missing image: the connection is exactly as it was", async () => {
    const before = (await page("/api/integrations")).body.connections.find((c: { id: string }) => c.id === id);
    jiraServer.setMode("401");
    try {
      const r = await page(asset(`${jiraServer.url}/secure/useravatar?ownerId=amorgan&size=small`));
      expect([r.status, r.raw]).toEqual([404, ""]);
    } finally {
      jiraServer.setMode("ok");
    }
    const after = (await page("/api/integrations")).body.connections.find((c: { id: string }) => c.id === id);
    expect(after).toEqual(before);
    expect((await page(`/api/integrations/jira/${id}/boards`)).status).toBe(200);
  });

  it("answers a refused token on a read with the envelope's expired, and leaves the connection for the user to fix", async () => {
    jiraServer.setMode("401");
    try {
      const r = await page(`/api/integrations/jira/${id}/board/1/closed-sprints`);
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ ok: false, error: { kind: "expired" } });
    } finally {
      jiraServer.setMode("ok");
    }
  });

  it("answers a rate limit with its Retry-After", async () => {
    jiraServer.setMode("429");
    try {
      const r = await page(`/api/integrations/jira/${id}/boards?startAt=50`);
      expect(r.status).toBe(429);
      expect(r.body.error).toMatchObject({ kind: "rate-limit", retryAfter: 30 });
    } finally {
      jiraServer.setMode("ok");
    }
  });

  it("asks Jira again on Test, and says so", async () => {
    const r = await call("POST", `/api/integrations/connections/${id}/test`, { body: {} });
    expect(r.status).toBe(200);
    expect(r.body.connection.tokenSaved).toBe(true);
    for (const s of SECRETS) expect(r.raw).not.toContain(s);
  });

  it("refuses a token Jira does not accept, by its field", async () => {
    const r = await call("POST", "/api/integrations/connections", {
      body: { kind: "jira", input: { deployment: "server", baseUrl: jiraServer.url, token: "not-the-token" } },
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatchObject({ kind: "auth" });
    expect(r.raw).not.toContain("not-the-token");
  });

  it("refuses a Jira older than 8.14, which has no personal access tokens", async () => {
    const r = await call("POST", "/api/integrations/connections", {
      body: { kind: "jira", input: { deployment: "server", baseUrl: jiraOld.url, token: MOCK_CREDENTIALS.server.bearer } },
    });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatchObject({ kind: "incompatible" });
  });

  it("only reads: a write to a provider route is refused", async () => {
    const r = await call("POST", `/api/integrations/jira/${id}/issue/MOCK-10`, { body: {} });
    expect(r.status).toBe(405);
  });

  it("disconnects, and the token goes with the connection", async () => {
    const r = await call("DELETE", `/api/integrations/connections/${id}`);
    expect(r.status).toBe(200);
    const list = await page("/api/integrations");
    expect(list.body.connections.map((c: { id: string }) => c.id)).not.toContain(id);
    for (const file of filesBut("")) {
      expect(readFileSync(file, "latin1").includes(MOCK_CREDENTIALS.server.bearer), file).toBe(false);
    }
    expect((await page(`/api/integrations/jira/${id}/boards`)).status).toBe(404);
  });
});

describe("a Jira Cloud connection", () => {
  it("connects with a classic API token as Basic auth, on the site itself", async () => {
    const r = await call("POST", "/api/integrations/connections", {
      body: { kind: "jira", input: { deployment: "cloud", baseUrl: jiraCloud.url, email: MOCK_CREDENTIALS.cloud.email, token: MOCK_CREDENTIALS.cloud.classicToken } },
    });
    expect(r.status).toBe(201);
    expect(r.body.connection.meta).toMatchObject({ deployment: "cloud" });
    expect(r.body.connection.meta.apiBase ?? null).toBeNull();
    for (const s of SECRETS) expect(r.raw).not.toContain(s);
    const id = r.body.connection.id;
    const board = await page(`/api/integrations/jira/${id}/board/1`);
    expect(board.status).toBe(200);
    expect(board.body.sprints.active).toHaveLength(1);
    expect((await call("DELETE", `/api/integrations/connections/${id}`)).status).toBe(200);
  });

  it("falls back to api.atlassian.com for a scoped token, which the site refuses", async () => {
    const r = await call("POST", "/api/integrations/connections", {
      body: { kind: "jira", input: { deployment: "cloud", baseUrl: jiraCloud.url, email: MOCK_CREDENTIALS.cloud.email, token: MOCK_CREDENTIALS.cloud.scopedToken } },
    });
    expect(r.status).toBe(201);
    const conn = r.body.connection;
    expect(conn.meta.apiBase).toMatch(new RegExp(`^${jiraCloud.apiUrl}/ex/jira/`));
    expect(conn.allowedOrigins).toEqual(expect.arrayContaining([new URL(jiraCloud.url).origin, new URL(jiraCloud.apiUrl!).origin]));
    const from = jiraCloud.requests.length;
    const issues = await page(`/api/integrations/jira/${conn.id}/board/1/issues?source=backlog`);
    expect(issues.status).toBe(200);
    expect(issues.body.issues.length).toBeGreaterThan(0);
    // Once connected, every signed read goes to the api origin: the site
    // refuses this token, so it is not sent there again.
    const signed = jiraCloud.requests.slice(from).filter(q => q.auth !== "none");
    expect(signed.length).toBeGreaterThan(0);
    expect(signed.map(q => (q as { origin?: string }).origin)).toEqual(signed.map(() => "api"));
    expect((await call("DELETE", `/api/integrations/connections/${conn.id}`)).status).toBe(200);
  });
});

describe("what the deck said while it ran", () => {
  it("never once named a token", () => {
    expect(said.length).toBeGreaterThanOrEqual(0);
    for (const line of said) for (const s of SECRETS) expect(line.includes(s), line.slice(0, 120)).toBe(false);
  });
});
