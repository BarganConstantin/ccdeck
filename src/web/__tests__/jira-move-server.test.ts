// Server-only contract/security tests; all Jira traffic is an injected fetch.
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
// @ts-expect-error plain server module
import { createJiraClient, jiraRoutes, normaliseIssue } from "../../server/integrations/jira.mjs";
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
    writes: [], calls: [], writeResponses: [], writeError: null, onRead: null, issuePageSize: 100, ...options.state,
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
      const reverseRank = u.searchParams.get("jql") === "ORDER BY Rank DESC";
      const matched = state.issues.filter(i => (reverseRank || keys.includes(i.key)) && (!group || state.groups[i.key] === group));
      if (reverseRank) matched.reverse();
      const startAt = Number(u.searchParams.get("startAt") ?? 0);
      const max = Math.min(Number(u.searchParams.get("maxResults") ?? 100), state.issuePageSize);
      return json({ issues: matched.slice(startAt, startAt + max), total: Object.hasOwn(state, "issueTotal") ? state.issueTotal : matched.length });
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
  it("rejects a renamed hierarchy-level epic before any write", async () => {
    const r = rig();
    r.state.issues[0].fields.issuetype = { name: "Feature", subtask: false, hierarchyLevel: 1 };
    assert.equal(normaliseIssue(r.conn, r.state.issues[0]).type.epic, true);
    const result = await r.move();
    assert.equal(result.status, 400);
    assert.match(result.body.error.message, /non-epic/);
    assert.equal(r.state.writes.length, 0);
  });

  for (const hierarchyLevel of [0, 2, "1"]) it(`keeps the normalizer's exact epic hierarchy semantics: ${JSON.stringify(hierarchyLevel)}`, async () => {
    const r = rig();
    r.state.issues[0].fields.issuetype = { name: "Feature", subtask: false, hierarchyLevel };
    assert.equal(normaliseIssue(r.conn, r.state.issues[0]).type.epic, false);
    assert.equal((await r.move()).status, 200);
    assert.equal(r.state.writes.length, 2);
  });

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
  it("moves to the actual end even when the visible list is incomplete", async () => {
    const r = rig({ state: { issuePageSize: 1 } });
    const result = await r.move({ issueKey: "MOCK-1", target: input.target, atEnd: true });
    assert.equal(result.status, 200);
    assert.equal(r.state.writes[1].json.rankAfterIssue, "MOCK-3");
  });
  it("skips the selected tail and ranks after the previous issue", async () => {
    const r = rig({ state: { issuePageSize: 1 } });
    const result = await r.move({ issueKey: "MOCK-3", target: input.target, atEnd: true });
    assert.equal(result.status, 200);
    assert.equal(r.state.writes[0].json.rankAfterIssue, "MOCK-2");
  });
  it("moves to an empty destination without a rank request", async () => {
    const r = rig();
    const result = await r.move({ issueKey: "MOCK-1", target: { kind: "sprint", sprintId: 14 }, atEnd: true });
    assert.equal(result.status, 200);
    assert.deepEqual(r.state.writes.map(w => w.method), ["POST"]);
  });
  it("does not write when the destination order cannot be read", async () => {
    const r = rig({ state: { onRead: u => u.searchParams.get("jql") === "ORDER BY Rank DESC" ? json({}) : null } });
    const result = await r.move({ issueKey: "MOCK-1", target: input.target, atEnd: true });
    assert.equal(result.status, 400);
    assert.equal(r.state.writes.length, 0);
  });
  it("preserves a batch's requested order in an empty destination", async () => {
    const r = rig();
    const result = await r.move({ issueKeys: ["MOCK-3", "MOCK-2"], target: { kind: "sprint", sprintId: 14 }, atEnd: true });
    assert.equal(result.status, 200);
    assert.deepEqual(r.state.writes.map(w => w.method), ["POST", "PUT"]);
    assert.deepEqual(r.state.writes[1].json, { issues: ["MOCK-2"], rankCustomFieldId: 10020, rankAfterIssue: "MOCK-3" });
  });
  it("reports a failed rank after moving a batch to an empty destination", async () => {
    const r = rig({ state: { writeResponses: [new Response(null, { status: 204 }), new Response(null, { status: 403 })] } });
    const result = await r.move({ issueKeys: ["MOCK-3", "MOCK-2"], target: { kind: "sprint", sprintId: 14 }, atEnd: true });
    assert.equal(result.status, 403);
    assert.deepEqual(result.body.outcomes.map(o => [o.issueKey, o.membership, o.rank]), [
      ["MOCK-3", "moved", "unchanged"], ["MOCK-2", "moved", "failed"],
    ]);
  });
  it("rejects a conflicting explicit position before writing", async () => {
    const r = rig();
    const result = await r.move({ ...input, atEnd: true });
    assert.equal(result.status, 400);
    assert.equal(r.state.writes.length, 0);
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
  it("moves a done issue", async () => {
    const r = rig();
    r.state.issues[0].fields.status.statusCategory.key = "done";
    assert.equal((await r.move()).status, 200);
    assert.ok(r.state.writes.length > 0);
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
  for (const scenario of ["subtask", "anchor-subtask", "epic", "unknown-status", "closed", "off-board", "wrong-anchor-group", "closed-source-missing", "multiple-sprints"])
    it(`rejects ${scenario} without writing`, async () => {
      const r = rig();
      const f = r.state.issues[0].fields;
      if (scenario === "subtask") f.issuetype.subtask = true;
      if (scenario === "anchor-subtask") r.state.issues[1].fields.issuetype.subtask = true;
      if (scenario === "epic") f.issuetype.name = "Epic";
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

const batchInput = { issueKeys: ["MOCK-3", "MOCK-1"], target: { kind: "sprint", sprintId: 13 }, beforeIssue: "MOCK-2" };
const multiStatus = entries => new Response(JSON.stringify({ entries }), { status: 207 });
function bothNeedMove(r) {
  r.state.issues[2].fields.sprint = r.state.sprints[1];
  r.state.groups["MOCK-3"] = "sprint:14";
  return r;
}
function fiftyIssues(r) {
  const keys = Array.from({ length: 50 }, (_, i) => `MOCK-${i + 10}`);
  for (const key of keys) {
    const issue = structuredClone(r.state.issues[0]);
    issue.key = key;
    r.state.issues.push(issue);
    r.state.groups[key] = "backlog";
  }
  return keys.reverse();
}

describe("bounded ordered Jira batches", () => {
  it("rejects a renamed epic later in the batch before writing any earlier issue", async () => {
    const r = bothNeedMove(rig());
    // Both keys need assignment, and the eligible key is first. A validator
    // that starts writing before checking the later key would partially move it.
    r.state.issues[0].fields.issuetype = { name: "Feature", subtask: false, hierarchyLevel: 1 };
    assert.equal(normaliseIssue(r.conn, r.state.issues[0]).type.epic, true);
    const result = await r.move(batchInput);
    assert.equal(result.status, 400);
    assert.match(result.body.error.message, /non-epic/);
    assert.equal(r.state.writes.length, 0);
  });

  it("assigns only issues that need moving, then ranks the full batch in input order", async () => {
    const r = rig();
    const result = await r.move(batchInput);
    assert.deepEqual(result.body, { ok: true, issueKeys: ["MOCK-3", "MOCK-1"], target: batchInput.target, refresh: true });
    assert.deepEqual(r.state.writes.map(w => w.json), [
      { issues: ["MOCK-1"] },
      { issues: ["MOCK-3", "MOCK-1"], rankCustomFieldId: 10020, rankBeforeIssue: "MOCK-2" },
    ]);
  });
  it("accepts mixed backlog/active/future sources and assigns them once", async () => {
    const r = bothNeedMove(rig());
    assert.equal((await r.move(batchInput)).status, 200);
    assert.deepEqual(r.state.writes[0].json, { issues: ["MOCK-3", "MOCK-1"] });
    assert.equal(r.state.writes.length, 2);
  });
  it("supports a future target with a target anchor", async () => {
    const r = rig();
    r.state.issues[1].fields.sprint = r.state.sprints[1];
    r.state.groups["MOCK-2"] = "sprint:14";
    assert.equal((await r.move({ ...batchInput, target: { kind: "sprint", sprintId: 14 } })).status, 200);
    assert.ok(r.state.writes[0].url.endsWith("/sprint/14/issue"));
    assert.deepEqual(r.state.writes[0].json.issues, batchInput.issueKeys);
  });
  it("supports backlog moves and ranks the ordered batch after its anchor", async () => {
    const r = bothNeedMove(rig());
    const body = { issueKeys: ["MOCK-3", "MOCK-2"], target: { kind: "backlog" }, afterIssue: "MOCK-1" };
    assert.equal((await r.move(body)).status, 200);
    assert.ok(r.state.writes[0].url.endsWith("/backlog/issue"));
    assert.deepEqual(r.state.writes[1].json.issues, body.issueKeys);
    assert.equal(r.state.writes[1].json.rankAfterIssue, "MOCK-1");
  });
  it("reorders a batch already in the target with no membership write", async () => {
    const r = rig();
    r.state.issues[0].fields.sprint = r.state.sprints[0];
    r.state.groups["MOCK-1"] = "sprint:13";
    assert.equal((await r.move(batchInput)).status, 200);
    assert.deepEqual(r.state.writes.map(w => w.method), ["PUT"]);
    assert.deepEqual(r.state.writes[0].json.issues, batchInput.issueKeys);
  });
  it("preserves the no-anchor membership-only contract", async () => {
    const r = bothNeedMove(rig());
    assert.equal((await r.move({ issueKeys: batchInput.issueKeys, target: batchInput.target })).status, 200);
    assert.equal(r.state.writes.length, 1);
    assert.deepEqual(r.state.writes[0].json.issues, batchInput.issueKeys);
  });
  it("validates 50 keys plus an anchor across capped pages, preserving order", async () => {
    const r = rig({ state: { issuePageSize: 7 } });
    const keys = fiftyIssues(r);
    const body = { ...batchInput, issueKeys: keys };
    await withHost(r, async post => {
      const result = await post(body);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.issueKeys, keys);
    });
    assert.equal(r.state.writes.length, 2);
    assert.deepEqual(r.state.writes[0].json.issues, keys);
    assert.deepEqual(r.state.writes[1].json.issues, keys);
    const firstWrite = r.state.calls.findIndex(c => c.method !== "GET");
    assert.ok(firstWrite > 10);
    assert.ok(r.state.calls.slice(firstWrite).every(c => c.method !== "GET"));
  });
  it("validates capped pages even when Jira omits a total", async () => {
    const r = rig({ state: { issuePageSize: 1, issueTotal: null } });
    assert.equal((await r.move(batchInput)).status, 200);
    assert.equal(r.state.writes.length, 2);
  });
  for (const patch of [
    { issueKey: "MOCK-1" }, { issueKeys: [] }, { issueKeys: ["MOCK-1"] }, { issueKeys: Array.from({ length: 51 }, (_, i) => `MOCK-${i + 10}`) },
    { issueKeys: ["MOCK-1", "MOCK-1"] }, { issueKeys: ["MOCK-1", "mock-3"] }, { issueKeys: ["MOCK-1", null] },
    { issueKeys: "MOCK-1,MOCK-3" }, { issueKeys: ["MOCK-1", "MOCK-3\n"] }, { beforeIssue: "MOCK-3" },
    { beforeIssue: "MOCK-1" }, { beforeIssue: undefined, afterIssue: "MOCK-3" }, { afterIssue: "MOCK-2" },
    { target: { kind: "sprint", sprintId: 15 } }, { target: { kind: "sprint", sprintId: 99 } },
  ]) it(`rejects invalid batch ${JSON.stringify(patch)} before any write`, async () => {
    const r = rig();
    assert.equal((await r.move({ ...batchInput, ...patch })).status, 400);
    assert.equal(r.state.writes.length, 0);
  });
  for (const problem of ["epic", "subtask", "closed", "off-board", "wrong-source", "anchor-subtask", "anchor-wrong-group"])
    it(`validates the entire batch before writes: ${problem}`, async () => {
      const r = rig();
      // The invalid issue is last in the ordered batch. Earlier keys must not
      // have been assigned while later validation is still pending.
      const f = r.state.issues[0].fields;
      if (problem === "epic") f.issuetype.name = "Epic";
      if (problem === "subtask") f.issuetype.subtask = true;
      if (problem === "closed") f.sprint = r.state.sprints[2];
      if (problem === "off-board") r.state.issues.shift();
      if (problem === "wrong-source") r.state.groups["MOCK-1"] = "sprint:15";
      if (problem === "anchor-subtask") r.state.issues[1].fields.issuetype.subtask = true;
      if (problem === "anchor-wrong-group") r.state.groups["MOCK-2"] = "backlog";
      assert.equal((await r.move(batchInput)).status, 400);
      assert.equal(r.state.writes.length, 0);
    });
  it("refuses incomplete validation pages instead of silently moving a subset", async () => {
    const r = rig({ state: { onRead: u => /\/board\/1\/issue$/.test(u.pathname) ? json({ issues: [], total: 3 }) : null } });
    assert.equal((await r.move(batchInput)).status, 400);
    assert.equal(r.state.writes.length, 0);
  });
  it("bounds validation if a provider ignores pagination", async () => {
    const r = rig();
    r.state.onRead = u => /\/board\/1\/issue$/.test(u.pathname) ? json({ issues: [r.state.issues[0]], total: 3 }) : null;
    assert.equal((await r.move(batchInput)).status, 400);
    assert.equal(r.state.calls.filter(c => /\/board\/1\/issue\?/.test(c.url)).length, 2);
    assert.equal(r.state.writes.length, 0);
  });
});

describe("batch 207 and uncertain-write outcomes", () => {
  it("accepts 207 only when every requested key is explicitly successful, regardless of response order", async () => {
    const r = bothNeedMove(rig({ state: { writeResponses: [
      multiStatus([{ issueKey: "MOCK-1", status: 204 }, { issueKey: "MOCK-3", status: 200 }]),
      multiStatus([{ issueKey: "MOCK-1", status: 200 }, { issueKey: "MOCK-3", status: 204 }]),
    ] } }));
    assert.equal((await r.move(batchInput)).body.ok, true);
    assert.equal(r.state.writes.length, 2);
  });
  it("keeps mixed membership outcomes, stops before rank and invalidates caches", async () => {
    const r = bothNeedMove(rig({ state: { writeResponses: [multiStatus([
      { issueKey: "MOCK-3", status: 200 }, { issueKey: "MOCK-1", status: 403 },
    ])] } }));
    const old = r.client.cache;
    const result = await r.move(batchInput);
    assert.equal(result.body.ok, false);
    assert.equal(result.status, 502);
    assert.equal(result.body.outcome.membership, "partial");
    assert.deepEqual(result.body.outcomes, [
      { issueKey: "MOCK-3", membership: "moved", rank: "unchanged" },
      { issueKey: "MOCK-1", membership: "unchanged", rank: "unchanged" },
    ]);
    assert.match(result.body.error.message, /some issues were updated/i);
    assert.equal(r.state.writes.length, 1);
    assert.notEqual(r.client.cache, old);
  });
  it("reports partial rank after membership succeeds without pretending all ranks failed", async () => {
    const r = bothNeedMove(rig({ state: { writeResponses: [new Response(null, { status: 204 }), multiStatus([
      { issueKey: "MOCK-3", status: 200 }, { issueKey: "MOCK-1", status: 403 },
    ])] } }));
    const result = await r.move(batchInput);
    assert.equal(result.body.ok, false);
    assert.deepEqual(result.body.outcome, { membership: "moved", rank: "partial" });
    assert.deepEqual(result.body.outcomes.map(o => o.rank), ["ranked", "failed"]);
    assert.equal(r.state.writes.length, 2);
  });
  for (const [name, entries] of [
    ["missing", [{ issueKey: "MOCK-3", status: 200 }]],
    ["duplicate", [{ issueKey: "MOCK-3", status: 200 }, { issueKey: "MOCK-3", status: 200 }, { issueKey: "MOCK-1", status: 200 }]],
    ["unexpected", [{ issueKey: "MOCK-3", status: 200 }, { issueKey: "MOCK-1", status: 200 }, { issueKey: "MOCK-99", status: 200 }]],
    ["malformed-status", [{ issueKey: "MOCK-3", status: 200 }, { issueKey: "MOCK-1", status: "200" }]],
    ["uncertain", [{ issueKey: "MOCK-3", status: 200 }, { issueKey: "MOCK-1", status: 503 }]],
    ["empty", []],
  ]) it(`never treats ${name} 207 entries as whole-batch success`, async () => {
    const r = bothNeedMove(rig({ state: { writeResponses: [multiStatus(entries)] } }));
    const result = await r.move(batchInput);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.refresh, true);
    assert.equal(result.body.outcome.membership, "unknown");
    assert.equal(r.state.writes.length, 1);
    if (["missing", "malformed-status", "uncertain"].includes(name)) assert.equal(result.body.outcomes[0].membership, "moved");
  });
  for (const status of [403, 429, 500]) it(`never retries a batch refused at ${status}`, async () => {
    const r = bothNeedMove(rig({ state: { writeResponses: [new Response(null, { status, headers: { "retry-after": "45" } })] } }));
    const result = await r.move(batchInput);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.outcome.membership, status < 500 ? "unchanged" : "unknown");
    assert.equal(result.body.outcomes.length, 2);
    assert.equal(r.state.writes.length, 1);
  });
  it("preserves unchanged membership for issues already in target on a lost batch response", async () => {
    const r = rig({ state: { writeError: new Error("synthetic network failure") } });
    const result = await r.move(batchInput);
    assert.deepEqual(result.body.outcomes.map(o => o.membership), ["unchanged", "unknown"]);
    assert.equal(result.body.outcome.membership, "unknown");
    assert.equal(r.state.writes.length, 1);
  });
  it("reports lost rank response after a confirmed batch move without replay", async () => {
    const r = bothNeedMove(rig({ state: { writeResponses: [new Response(null, { status: 204 }), () => { throw new Error("synthetic lost rank response"); }] } }));
    const result = await r.move(batchInput);
    assert.equal(result.body.ok, false);
    assert.deepEqual(result.body.outcome, { membership: "moved", rank: "unknown" });
    assert.equal(r.state.writes.length, 2);
  });
  it("uses the same scoped Cloud transport for a batch", async () => {
    const r = bothNeedMove(rig({ conn: { meta: { deployment: "cloud", apiBase: "https://api.atlassian.com/ex/jira/mock-cloud" }, allowedOrigins: ["https://jira.example.com", "https://api.atlassian.com"] } }));
    assert.equal((await r.move(batchInput)).status, 200);
    assert.equal(r.state.writes.length, 2);
    for (const w of r.state.writes) {
      assert.ok(w.url.startsWith("https://api.atlassian.com/ex/jira/mock-cloud/rest/agile/1.0/"));
      assert.equal(w.redirect, "manual");
      assert.ok(w.headers.Authorization.startsWith("Basic "));
    }
  });
});
