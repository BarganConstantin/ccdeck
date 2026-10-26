// Server-only contract/security tests; all Jira traffic is an injected fetch.
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
// @ts-expect-error plain server module
import { createJiraClient, jiraRoutes } from "../../server/integrations/jira.mjs";
// @ts-expect-error plain server module
import { handleIntegrations, forgetConnection } from "../../server/integrations/routes.mjs";
// @ts-expect-error plain server module
import { createProxy } from "../../server/integrations/proxy.mjs";
// @ts-expect-error plain server module
import { isTrustedMutation } from "../../server/request-gates.mjs";

let sequence = 0;
const json = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const input = { issueKey: "MOCK-1", target: { kind: "sprint", sprintId: 13 }, beforeIssue: "MOCK-2" };
function rig(options = {}) {
  const site = "https://jira.example.com";
  const conn = { id: `move-test-${++sequence}`, kind: "jira", baseUrl: site, allowedOrigins: [site], account: {}, meta: { deployment: "server" }, ...options.conn };
  const token = ["synthetic", "jira", "move", String(sequence).padStart(8, "0")].join("-");
  const secret = conn.meta.deployment === "cloud" ? { auth: "basic", email: "jane@example.com", token } : { auth: "bearer", token };
  const sprints = [{ id: 13, state: "active" }, { id: 14, state: "future" }, { id: 15, state: "closed" }];
  const issue = (key, sprint = null) => ({ key, fields: { issuetype: { name: "Story", subtask: false }, status: { statusCategory: { key: "new" } }, sprint } });
  const state = {
    boardType: "scrum", rank: 10020, jql: "project = MOCK ORDER BY Rank ASC", filterReadable: true,
    sprints, issues: [issue("MOCK-1"), issue("MOCK-2", sprints[0]), issue("MOCK-3", sprints[0])],
    groups: { "MOCK-1": "backlog", "MOCK-2": "sprint:13", "MOCK-3": "sprint:13" },
    writes: [], calls: [], writeResponses: [], writeError: null, onRead: null, ...options.state,
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = init.method ?? "GET";
    state.calls.push({ url, method, ...init });
    if (method !== "GET") {
      state.writes.push({ url, ...init, json: JSON.parse(init.body) });
      if (state.writeError) throw state.writeError;
      const response = state.writeResponses.shift();
      return typeof response === "function" ? response() : response ?? new Response(null, { status: 204 });
    }
    const extra = state.onRead?.(u);
    if (extra) return extra;
    if (/\/board\/1\/configuration$/.test(path)) return json({ type: state.boardType, ranking: { rankCustomFieldId: state.rank }, filter: { id: "7" }, columnConfig: { columns: [] } });
    if (/\/board\/1$/.test(path)) return json({ id: 1, name: "Mock", type: state.boardType });
    if (/\/filter\/7$/.test(path)) return state.filterReadable ? json({ jql: state.jql }) : new Response(null, { status: 403 });
    if (/\/board\/1\/sprint$/.test(path)) return json({ values: state.sprints, isLast: true });
    if (/\/board\/1\/(?:issue|backlog|sprint\/\d+\/issue)$/.test(path)) {
      const keys = (u.searchParams.get("jql") ?? "").match(/MOCK-\d+/g) ?? [];
      const group = path.endsWith("/backlog") ? "backlog" : /\/sprint\/(\d+)\/issue$/.test(path) ? `sprint:${path.match(/\/sprint\/(\d+)\/issue$/)[1]}` : null;
      return json({ issues: state.issues.filter(i => keys.includes(i.key) && (!group || state.groups[i.key] === group)), total: keys.length });
    }
    if (/\/board\/1\/quickfilter$/.test(path)) return json({ values: [], isLast: true });
    if (/\/configuration$/.test(path)) return json({});
    if (/\/field$/.test(path)) return json([]);
    return new Response(null, { status: 404 });
  };
  const client = createJiraClient(conn, secret, { fetchImpl });
  return { client, state, conn, secret, fetchImpl,
    move: (body = input, extra = {}) => jiraRoutes(client, "POST", "board/1/move", new URLSearchParams(), null, { moveBody: body, ...extra }),
  };
}

describe("the bounded Jira move", () => {
  it("moves once then ranks once, using only the board's rank field", async () => {
    const r = rig();
    assert.deepEqual((await r.move()).body, { ok: true, issueKey: "MOCK-1", target: input.target, refresh: true });
    assert.deepEqual(r.state.writes.map(w => [w.method, new URL(w.url).pathname, w.json]), [
      ["POST", "/rest/agile/1.0/sprint/13/issue", { issues: ["MOCK-1"] }],
      ["PUT", "/rest/agile/1.0/issue/rank", { issues: ["MOCK-1"], rankCustomFieldId: 10020, rankBeforeIssue: "MOCK-2" }],
    ]);
    for (const w of r.state.writes) {
      assert.equal(w.redirect, "manual");
      assert.equal(w.headers.Authorization, `Bearer ${r.secret.token}`);
    }
  });
  it("reorders within a sprint without assigning membership again", async () => {
    const r = rig();
    assert.equal((await r.move({ ...input, issueKey: "MOCK-3", beforeIssue: undefined, afterIssue: "MOCK-2" })).status, 400);
    const result = await r.move({ issueKey: "MOCK-3", target: input.target, afterIssue: "MOCK-2" });
    assert.equal(result.status, 200);
    assert.deepEqual(r.state.writes.map(w => w.method), ["PUT"]);
    assert.equal(r.state.writes[0].json.rankAfterIssue, "MOCK-2");
  });
  it("moves to backlog then ranks relative to a backlog issue", async () => {
    const r = rig();
    assert.equal((await r.move({ issueKey: "MOCK-2", target: { kind: "backlog" }, afterIssue: "MOCK-1" })).status, 200);
    assert.equal(new URL(r.state.writes[0].url).pathname, "/rest/agile/1.0/backlog/issue");
    assert.equal(r.state.writes[1].json.rankAfterIssue, "MOCK-1");
  });
  it("moves to a future sprint with no anchor and preserves rank", async () => {
    const r = rig();
    assert.equal((await r.move({ issueKey: "MOCK-1", target: { kind: "sprint", sprintId: 14 } })).status, 200);
    assert.equal(r.state.writes.length, 1);
    assert.deepEqual(r.state.writes[0].json, { issues: ["MOCK-1"] });
  });
  it("allows a done top-level issue as a stationary rank anchor", async () => {
    const r = rig();
    r.state.issues[1].fields.status.statusCategory.key = "done";
    assert.equal((await r.move()).status, 200);
    assert.equal(r.state.writes[1].json.rankBeforeIssue, "MOCK-2");
  });
  it("reorders within backlog without posting membership", async () => {
    const r = rig();
    r.state.groups["MOCK-2"] = "backlog";
    r.state.issues[1].fields.sprint = null;
    assert.equal((await r.move({ issueKey: "MOCK-1", target: { kind: "backlog" }, beforeIssue: "MOCK-2" })).status, 200);
    assert.deepEqual(r.state.writes.map(w => w.method), ["PUT"]);
  });
  for (const body of [null, [], {}, { ...input, issueKey: "MOCK-1 OR 1=1" }, { ...input, issueKey: "mock-1" },
    { ...input, issueKey: "MOCK-0" }, { ...input, issueKey: "MOCK-1\n" }, { ...input, target: { kind: "sprint", sprintId: "13" } },
    { ...input, target: { kind: "sprint", sprintId: -1 } }, { ...input, target: { kind: "sprint", sprintId: 1.5 } },
    { ...input, target: { kind: "backlog", sprintId: 13 } }, { ...input, target: { kind: "kanban" } },
    { ...input, rankCustomFieldId: 22 }, { ...input, url: "https://other.example" },
    { ...input, beforeIssue: "MOCK-1" }, { ...input, beforeIssue: "MOCK-2", afterIssue: "MOCK-3" },
    { ...input, beforeIssue: null }, { ...input, target: { kind: "sprint", sprintId: 15 } },
    { ...input, target: { kind: "sprint", sprintId: 999 } }, { ...input, beforeIssue: "MOCK-99" },
  ]) it(`rejects invalid input without writing: ${JSON.stringify(body)}`, async () => {
    const r = rig();
    assert.equal((await r.move(body)).status, 400);
    assert.equal(r.state.writes.length, 0);
  });
  for (const scenario of ["subtask", "anchor-subtask", "epic", "done", "unknown-status", "closed", "off-board", "wrong-anchor-group", "closed-source-missing", "multiple-sprints"])
    it(`rejects ${scenario} without writing`, async () => {
      const r = rig();
      const f = r.state.issues[0].fields;
      if (scenario === "subtask") f.issuetype.subtask = true;
      if (scenario === "anchor-subtask") r.state.issues[1].fields.issuetype.subtask = true;
      if (scenario === "epic") f.issuetype.name = "Epic";
      if (scenario === "done") f.status.statusCategory.key = "done";
      if (scenario === "unknown-status") f.status.statusCategory.key = "unknown";
      if (scenario === "closed") f.sprint = { id: 15, state: "closed" };
      if (scenario === "off-board") r.state.issues.shift();
      if (scenario === "wrong-anchor-group") r.state.groups["MOCK-2"] = "backlog";
      if (scenario === "closed-source-missing") r.state.groups["MOCK-1"] = "sprint:15";
      if (scenario === "multiple-sprints") f.sprint = r.state.sprints.slice(0, 2);
      assert.equal((await r.move()).status, 400);
      assert.equal(r.state.writes.length, 0);
    });
  for (const patch of [{ boardType: "kanban" }, { rank: null }, { rank: "10020" }, { jql: "project = MOCK ORDER BY updated DESC" },
    { jql: "project = MOCK ORDER BY Rank ASC, updated DESC" }]) it(`rejects unsupported board ordering ${JSON.stringify(patch)}`, async () => {
    const r = rig({ state: patch });
    assert.equal((await r.move()).status, 400);
    assert.equal(r.state.writes.length, 0);
  });
  it("accepts the configured rank field's JQL id", async () => {
    assert.equal((await rig({ state: { jql: "project = MOCK ORDER BY cf[10020] ASC" } }).move()).status, 200);
  });
});

describe("Jira write outcomes and caches", () => {
  for (const status of [400, 401, 403, 429, 500]) it(`reports refused/uncertain first write ${status} without retry`, async () => {
    const r = rig({ state: { writeResponses: [new Response(null, { status, headers: { "retry-after": "45" } })] } });
    const old = r.client.cache;
    old.set("board:1", { stale: true });
    const result = await r.move();
    assert.equal(result.body.ok, false);
    assert.equal(result.body.refresh, true);
    assert.equal(result.body.outcome.membership, status < 500 ? "unchanged" : "unknown");
    assert.equal(r.state.writes.length, 1);
    assert.notEqual(r.client.cache, old);
    assert.equal(r.client.cache.peek("board:1", 10000), undefined);
    if (status === 403) assert.equal(result.body.error.kind, "permission");
    if (status === 429) assert.equal(result.body.error.retryAfter, 45);
  });
  it("reports a confirmed move followed by denied rank as failure, not success", async () => {
    const r = rig({ state: { writeResponses: [new Response(null, { status: 204 }), new Response(null, { status: 403 })] } });
    const result = await r.move();
    assert.equal(result.status, 403);
    assert.equal(result.body.ok, false);
    assert.deepEqual(result.body.outcome, { membership: "moved", rank: "failed" });
    assert.match(result.body.error.message, /issue moved.*position.*not confirmed/i);
    assert.equal(r.state.writes.length, 2);
  });
  it("reports a lost write response as unknown, never retries or exposes its raw error", async () => {
    const r = rig();
    r.state.writeError = new Error(`lost ${r.secret.token}`);
    const result = await r.move();
    assert.equal(result.status, 502);
    assert.equal(result.body.outcome.membership, "unknown");
    assert.equal(r.state.writes.length, 1);
    assert.ok(!JSON.stringify(result).includes(r.secret.token));
  });
  it("reports timeout/abort as unknown and invalidates without retry", async () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const r = rig({ state: { writeError: Object.assign(new Error("interrupted"), { name }) } });
      const old = r.client.cache;
      const result = await r.move();
      assert.equal(result.status, 502);
      assert.equal(result.body.outcome.membership, "unknown");
      assert.equal(r.state.writes.length, 1);
      assert.notEqual(r.client.cache, old);
    }
  });
  it("does not write or invalidate after a validation permission/rate failure", async () => {
    for (const status of [403, 429]) {
      const r = rig({ state: { onRead: () => new Response(null, { status }) } });
      const old = r.client.cache;
      const result = await r.move();
      assert.equal(result.status, status);
      assert.equal(r.state.writes.length, 0);
      assert.equal(r.client.cache, old);
    }
  });
  it("does not replay same-origin or external redirects", async () => {
    for (const location of ["/other", "https://other.example/write"]) {
      const r = rig({ state: { writeResponses: [new Response(null, { status: 307, headers: { location } })] } });
      const result = await r.move();
      assert.equal(result.body.ok, false);
      assert.equal(result.body.outcome.membership, "unknown");
      assert.equal(r.state.writes.length, 1);
    }
  });
  for (const status of [200, 403, 503, null]) it(`checks the single-issue 207 entry: ${status}`, async () => {
    const r = rig({ state: { writeResponses: [new Response(null, { status: 204 }),
      new Response(JSON.stringify({ entries: status === null ? [] : [{ issueKey: "MOCK-1", status }] }), { status: 207 })] } });
    const result = await r.move();
    assert.equal(result.body.ok, status === 200);
    if (status !== 200) assert.equal(result.body.outcome.membership, "moved");
  });
  it("rejects oversized and malformed 207 results without a false success", async () => {
    for (const body of ["x".repeat(33000), "invalid JSON", JSON.stringify({ entries: [{ issueKey: "MOCK-99", status: 200 }] })]) {
      const r = rig({ state: { writeResponses: [new Response(null, { status: 204 }), new Response(body, { status: 207 })] } });
      assert.equal((await r.move()).body.ok, false);
    }
  });
  it("invalidates on success and does not let an old in-flight load refill the new cache", async () => {
    const r = rig();
    const old = r.client.cache;
    let resolve;
    const pending = old.remember("late", 10000, () => new Promise(r => { resolve = r; }));
    await r.move();
    resolve("stale");
    await pending;
    assert.equal(r.client.cache.peek("late", 10000), undefined);
  });
  it("revalidates fresh ordering instead of trusting cached overview capability", async () => {
    const r = rig();
    r.client.cache.set("move-capability:1", { enabled: true });
    r.state.jql = "project = MOCK ORDER BY updated DESC";
    assert.equal((await r.move()).status, 400);
    assert.equal(r.state.writes.length, 0);
  });
});

describe("capabilities and transport boundaries", () => {
  it("advertises rank support, with a reason when ordering cannot be verified", async () => {
    for (const state of [{}, { jql: "project = MOCK ORDER BY updated DESC" }, { filterReadable: false }]) {
      const r = rig({ state });
      const result = await jiraRoutes(r.client, "GET", "board/1", new URLSearchParams(), null);
      assert.equal(result.status, 200);
      assert.equal(result.body.moves.enabled, !Object.keys(state).length);
      if (Object.keys(state).length) assert.ok(result.body.moves.reason);
    }
  });
  it("signs Cloud basic writes on the validated gateway, including its context path", async () => {
    const r = rig({ conn: { meta: { deployment: "cloud", apiBase: "https://api.atlassian.com/ex/jira/mock-cloud" }, allowedOrigins: ["https://jira.example.com", "https://api.atlassian.com"] } });
    assert.equal((await r.move()).status, 200);
    for (const w of r.state.writes) {
      assert.ok(w.url.startsWith("https://api.atlassian.com/ex/jira/mock-cloud/rest/agile/1.0/"));
      assert.equal(w.headers.Authorization, `Basic ${Buffer.from(`${r.secret.email}:${r.secret.token}`).toString("base64")}`);
    }
  });
  it("does not sign or send reads/writes to an unvalidated apiBase", async () => {
    const r = rig({ conn: { meta: { deployment: "cloud", apiBase: "https://other.example/ex/jira/mock" } } });
    assert.equal((await r.move()).status, 403);
    assert.equal(r.state.calls.length, 0);
  });
  it("keeps the generic proxy GET-only even when passed a method/body", async () => {
    const r = rig();
    const proxy = createProxy({ conn: r.conn, secret: r.secret, sign: () => ({ Authorization: "synthetic" }), fetchImpl: r.fetchImpl });
    await proxy.json("https://jira.example.com/rest/agile/1.0/board/1", { method: "POST", body: "ignored" });
    assert.equal(r.state.calls[0].method, "GET");
    assert.equal(r.state.writes.length, 0);
  });
});

async function withHost(r, run) {
  const store = { get: async id => id === r.conn.id ? r.conn : null, secret: async () => r.secret };
  const server = createServer((req, res) => {
    // Same mutation gate used by index.mjs, before the integrations handler.
    if (req.method === "POST" && !isTrustedMutation({ origin: req.headers.origin, host: req.headers.host, secFetchSite: req.headers["sec-fetch-site"] })) {
      res.writeHead(403); res.end(); return;
    }
    handleIntegrations(req, res, new URL(req.url, "http://localhost"), { store, fetchImpl: r.fetchImpl }).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const post = (body, { path = `jira/${r.conn.id}/board/1/move`, method = "POST", headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/api/integrations/${path}`, method,
      headers: { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers } }, res => {
      let data = ""; res.setEncoding("utf8"); res.on("data", chunk => { data += chunk; });
      res.on("end", () => { let json; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, body: json }); });
    });
    req.on("error", reject); req.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  try { await run(post); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); forgetConnection(r.conn.id); }
}

describe("the HTTP move allowlist", () => {
  it("accepts exactly the JSON POST contract", async () => {
    const r = rig();
    await withHost(r, async post => { const result = await post(input); assert.equal(result.status, 200); assert.equal(result.body.ok, true); });
  });
  it("rejects malformed JSON, wrong content type, extra query parameters and oversized UTF-8 bodies", async () => {
    const r = rig();
    await withHost(r, async post => {
      assert.equal((await post("{" )).status, 400);
      assert.equal((await post(input, { headers: { "content-type": "text/plain" } })).status, 400);
      assert.equal((await post(input, { path: `jira/${r.conn.id}/board/1/move?rank=1` })).status, 400);
      assert.equal((await post(JSON.stringify({ padding: "💧".repeat(1100) }))).status, 413);
    });
    assert.equal(r.state.writes.length, 0);
  });
  it("rejects generic provider writes and cross-origin POSTs before Jira is called", async () => {
    const r = rig();
    await withHost(r, async post => {
      for (const path of [`jira/${r.conn.id}/issue/MOCK-1`, `jira/${r.conn.id}/board/1/move/extra`, `gitlab/${r.conn.id}/board/1/move`]) {
        assert.equal((await post(input, { path })).status, 405);
      }
      assert.equal((await post(input, { method: "PUT" })).status, 405);
      assert.equal((await post(input, { headers: { origin: "https://other.example", "sec-fetch-site": "cross-site" } })).status, 403);
    });
    assert.equal(r.state.calls.length, 0);
  });
});
