// The mock Jira (scripts/mock-jira.mjs) held to the behaviour the Jira client's
// tests will lean on: both flavours boot on ephemeral ports, authenticate the
// way real Jira does (PAT on Server, classic vs scoped API tokens on Cloud and
// the api.atlassian.com stand-in), page every list the way the docs say, answer
// a JQL query in rank order, and fail on demand (setMode).
//
// A self-test of a test tool: if one of these breaks, the client tests built on
// the mock are measuring the mock, not the client.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs script, no types
import { startMockJira } from "../../../scripts/mock-jira.mjs";

type MockJira = {
  url: string;
  apiUrl: string | null;
  cloudId: string | null;
  requests: Array<Record<string, unknown>>;
  setMode(mode: string): void;
  close(): Promise<void>;
};
// Response bodies are read loosely: the shapes are what the assertions check.
type Json = any;

const PAT = { Authorization: "Bearer mock-server-pat" };
const basic = (secret: string) => ({ Authorization: `Basic ${Buffer.from(`jane@example.com:${secret}`).toString("base64")}` });
const CLASSIC = basic("ATATTmockClassicToken0123456789abcdef");
const SCOPED = basic("ATATTmockScopedToken0123456789abcdef");

async function call(url: string, headers: Record<string, string> = {}, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  const text = await res.text();
  let body: Json = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body };
}
const jql = (q: string) => encodeURIComponent(q);

let server: MockJira;
let cloud: MockJira;

beforeAll(async () => {
  server = await startMockJira({ flavor: "server", port: 0 });
  cloud = await startMockJira({ flavor: "cloud", port: 0, apiPort: 0 });
});
afterAll(async () => {
  await server?.close();
  await cloud?.close();
});

describe("mock Jira Server/DC", () => {
  it("accepts the PAT and refuses anything else with Jira's 401", async () => {
    const ok = await call(`${server.url}/rest/api/2/myself`, PAT);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(ok.body).toMatchObject({ name: "jdoe", key: "JIRAUSER10000", displayName: "Jane Doe", emailAddress: "jane@example.com" });
    expect(ok.body.avatarUrls["24x24"]).toBe(`${server.url}/secure/useravatar?size=small&ownerId=jdoe&avatarId=10122`);

    const bad = await call(`${server.url}/rest/api/2/myself`, { Authorization: "Bearer wrong" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("x-seraph-loginreason")).toBe("AUTHENTICATED_FAILED");
    expect(bad.body.errorMessages[0]).toMatch(/not authenticated/i);

    expect((await call(`${server.url}/rest/api/2/myself`)).status).toBe(401);
    expect((await call(`${server.url}/rest/api/3/myself`, PAT)).status).toBe(404);
  });

  it("answers serverInfo without auth and reports the configured version", async () => {
    const info = await call(`${server.url}/rest/api/2/serverInfo`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ baseUrl: server.url, version: "9.0.0", versionNumbers: [9, 0, 0], deploymentType: "Server", serverTitle: "Mock Jira" });

    const old = await startMockJira({ flavor: "server", version: "8.5.0", deploymentType: "DataCenter" }) as MockJira;
    try {
      const body = (await call(`${old.url}/rest/api/2/serverInfo`)).body;
      expect(body).toMatchObject({ version: "8.5.0", versionNumbers: [8, 5, 0], deploymentType: "DataCenter" });
      expect((await call(`${old.url}/rest/api/2/myself`, PAT)).status).toBe(200);
    } finally {
      await old.close();
    }
  });

  it("pages /search by startAt with a total", async () => {
    const q = `${server.url}/rest/api/2/search?jql=${jql("project = MOCK")}&fields=summary&maxResults=50`;
    const first = await call(q, PAT);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ startAt: 0, maxResults: 50, total: 79 });
    expect(first.body.issues).toHaveLength(50);
    const second = await call(`${q}&startAt=50`, PAT);
    expect(second.body).toMatchObject({ startAt: 50, total: 79 });
    expect(second.body.issues).toHaveLength(29);
    const keys = [...first.body.issues, ...second.body.issues].map((i: Json) => i.key);
    expect(new Set(keys).size).toBe(79);
  });

  it("returns the active sprint's own issues for assignee = currentUser(), in rank order", async () => {
    const res = await call(`${server.url}/rest/agile/1.0/board/1/sprint/13/issue?jql=${jql("assignee = currentUser()")}&fields=summary,assignee,parent`, PAT);
    expect(res.status).toBe(200);
    expect(res.body.issues.map((i: Json) => i.key)).toEqual(["MOCK-10", "MOCK-11", "MOCK-21", "MOCK-30", "MOCK-33"]);
    const mine21 = res.body.issues.find((i: Json) => i.key === "MOCK-21");
    expect(mine21.fields.parent.key).toBe("MOCK-20");
    const parent = await call(`${server.url}/rest/api/2/issue/MOCK-20?fields=assignee`, PAT);
    expect(parent.body.fields.assignee.name).toBe("amorgan");
  });

  it("refuses a kanban backlog and a broken JQL the way Jira does", async () => {
    const backlog = await call(`${server.url}/rest/agile/1.0/board/2/backlog`, PAT);
    expect(backlog.status).toBe(400);
    expect(backlog.body.errorMessages).toEqual(["Backlogs are not supported on this board"]);
    const broken = await call(`${server.url}/rest/api/2/search?jql=${jql("assignee = = x")}`, PAT);
    expect(broken.status).toBe(400);
    expect(broken.body.errorMessages[0]).toMatch(/^Error in the JQL Query: /);
  });

  it("requires auth for images and serves real image bytes", async () => {
    const icon = `${server.url}/images/icons/priorities/high.svg`;
    expect((await call(icon)).status).toBe(401);
    const svg = await call(icon, PAT);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    const png = await fetch(`${server.url}/secure/attachment/10001/screenshot.png`, { headers: PAT });
    const buf = Buffer.from(await png.arrayBuffer());
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(buf.length).toBe(2048);
  });

  it("forces 429 with Retry-After: 30 on every authenticated route", async () => {
    server.setMode("429");
    try {
      const res = await call(`${server.url}/rest/api/2/myself`, PAT);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("30");
    } finally {
      server.setMode("ok");
    }
    const viaControl = await call(`${server.url}/__mock/mode`, {}, { method: "POST", body: JSON.stringify({ mode: "500" }) });
    expect(viaControl.body).toEqual({ mode: "500" });
    expect((await call(`${server.url}/rest/api/2/myself`, PAT)).status).toBe(500);
    server.setMode("ok");
    expect((await call(`${server.url}/rest/api/2/myself`, PAT)).status).toBe(200);
  });

  it("logs requests without the raw token", async () => {
    await call(`${server.url}/rest/api/2/field`, PAT);
    const log = (await call(`${server.url}/__mock/requests`)).body as Json[];
    const last = log[log.length - 1];
    expect(last).toMatchObject({ origin: "site", method: "GET", path: "/rest/api/2/field", auth: "bearer", authOk: true, user: "jdoe" });
    expect(JSON.stringify(log)).not.toContain("mock-server-pat");
  });
});

describe("mock Jira Cloud", () => {
  it("accepts the classic token on the site", async () => {
    const res = await call(`${cloud.url}/rest/api/3/myself`, CLASSIC);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "Jane Doe", accountType: "atlassian", active: true });
    expect(Object.keys(res.body.avatarUrls)).toEqual(["16x16", "24x24", "32x32", "48x48"]);
  });

  it("refuses the scoped token on the site but takes it through the api origin", async () => {
    const site = await call(`${cloud.url}/rest/api/3/myself`, SCOPED);
    expect(site.status).toBe(401);
    expect(site.body.errorMessages).toEqual(["Client must be authenticated to access this resource."]);

    const tenant = await call(`${cloud.url}/_edge/tenant_info`);
    expect(tenant.body).toEqual({ cloudId: cloud.cloudId });
    const api = await call(`${cloud.apiUrl}/ex/jira/${tenant.body.cloudId}/rest/api/3/myself`, SCOPED);
    expect(api.status).toBe(200);
    expect(api.body.self).toContain(`${cloud.apiUrl}/ex/jira/${cloud.cloudId}/rest/api/3/user`);

    expect((await call(`${cloud.apiUrl}/ex/jira/00000000-0000-0000-0000-000000000000/rest/api/3/myself`, SCOPED)).status).toBe(404);
    expect((await call(`${cloud.apiUrl}/ex/jira/${cloud.cloudId}/rest/api/3/myself`, basic("wrong"))).status).toBe(401);
  });

  it("answers the removed /rest/api/3/search with 410 Gone", async () => {
    const res = await call(`${cloud.url}/rest/api/3/search?jql=${jql("project = MOCK")}`, CLASSIC);
    expect(res.status).toBe(410);
    expect(res.body.errorMessages[0]).toContain("/rest/api/3/search/jql");
  });

  it("pages /search/jql by nextPageToken, with no total", async () => {
    const base = `${cloud.url}/rest/api/3/search/jql?jql=${jql("project = MOCK AND sprint in openSprints()")}&fields=summary&maxResults=6`;
    const first = await call(base, CLASSIC);
    expect(first.status).toBe(200);
    expect(first.body).not.toHaveProperty("total");
    expect(first.body.isLast).toBe(false);
    expect(typeof first.body.nextPageToken).toBe("string");
    const keys: string[] = first.body.issues.map((i: Json) => i.key);
    let token: string | undefined = first.body.nextPageToken;
    let pages = 1;
    while (token) {
      const next = await call(`${base}&nextPageToken=${encodeURIComponent(token)}`, CLASSIC);
      keys.push(...next.body.issues.map((i: Json) => i.key));
      token = next.body.nextPageToken;
      pages++;
      if (!token) expect(next.body.isLast).toBe(true);
    }
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(keys).toEqual(["MOCK-10", "MOCK-11", "MOCK-12", "MOCK-20", "MOCK-21", "MOCK-22", "MOCK-30", "MOCK-31", "MOCK-32", "MOCK-33", "MOCK-34", "MOCK-40", "MOCK-41", "MOCK-42", "MOCK-43"]);

    const idsOnly = await call(`${cloud.url}/rest/api/3/search/jql?jql=${jql("key = MOCK-10")}`, CLASSIC);
    expect(idsOnly.body.issues).toEqual([{ id: "10010" }]);
  });

  it("pages 62 boards over two pages of 50", async () => {
    const first = await call(`${cloud.url}/rest/agile/1.0/board`, CLASSIC);
    expect(first.body).toMatchObject({ startAt: 0, maxResults: 50, total: 62, isLast: false });
    expect(first.body.values).toHaveLength(50);
    const second = await call(`${cloud.url}/rest/agile/1.0/board?startAt=50&maxResults=100`, CLASSIC);
    expect(second.body).toMatchObject({ startAt: 50, maxResults: 50, isLast: true });
    expect(second.body.values).toHaveLength(12);
    const named = await call(`${cloud.url}/rest/agile/1.0/board?name=two`, CLASSIC);
    expect(named.body.values.map((b: Json) => b.name)).toEqual(["TWO board"]);
  });

  it("filters sprints by state and has two active sprints on board 3", async () => {
    const all = await call(`${cloud.url}/rest/agile/1.0/board/1/sprint`, CLASSIC);
    expect(all.body.values.map((s: Json) => s.state)).toEqual([...Array(12).fill("closed"), "active", "future", "future"]);
    const open = await call(`${cloud.url}/rest/agile/1.0/board/1/sprint?state=active,future`, CLASSIC);
    expect(open.body.values.map((s: Json) => s.name)).toEqual(["MOCK Sprint 13", "MOCK Sprint 14", "MOCK Sprint 15"]);
    const two = await call(`${cloud.url}/rest/agile/1.0/board/3/sprint?state=active`, CLASSIC);
    expect(two.body.values.map((s: Json) => s.name)).toEqual(["TWO Sprint A", "TWO Sprint B"]);
    const kanban = await call(`${cloud.url}/rest/agile/1.0/board/2/sprint`, CLASSIC);
    expect(kanban.status).toBe(400);
  });

  it("serves images on both origins, only with credentials", async () => {
    const path = `/secure/useravatar?size=small&ownerId=5b10ac8d82e05b22cc7d4ef5&avatarId=10122`;
    expect((await call(`${cloud.url}${path}`)).status).toBe(401);
    expect((await call(`${cloud.url}${path}`, SCOPED)).status).toBe(401);
    const site = await fetch(`${cloud.url}${path}`, { headers: CLASSIC });
    expect(site.status).toBe(200);
    expect(site.headers.get("content-type")).toBe("image/png");
    const api = await fetch(`${cloud.apiUrl}/ex/jira/${cloud.cloudId}${path}`, { headers: SCOPED });
    expect(api.status).toBe(200);
  });
});
