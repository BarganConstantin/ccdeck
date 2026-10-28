// The deck's five feedback routes (feedback conversations, design 4.4), end to
// end inside one deck: the deck the product boots, CCDECK_ACCOUNT=1, and
// CCDECK_ACCOUNT_API at the fake API. Connected through /api/account/connect,
// the page's own calls go to /api/account/feedback/threads* and the deck makes
// them to the API with its token, which the page never holds.
//
// What is pinned: every route against the fake API (a new conversation as JSON
// and as a form with an image — without the contact the dialog may hold, with
// no device fingerprint, and with this deck's own version and system — the list
// and its pages, a thread and the page before it, a reply, read); every way the
// API can refuse, mapped to its `reason` and status; a bad id or cursor that
// never leaves the deck; `not_connected` while disconnected; and a 401 that ends
// the device.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { startFakeApi, type FakeApi } from "./account-fake-api";
import { until } from "./account-test-kit";
// @ts-expect-error — plain .mjs server module, no types
import { deckFacts } from "../../server/account-service.mjs";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-account-feedback-"));
for (const [k, v] of Object.entries({
  HOME: DIR, USERPROFILE: DIR, CLAUDE_CONFIG_DIR: join(DIR, "claude"), CODEX_HOME: join(DIR, "codex"),
  CCDECK_HOME: join(DIR, "deck"), XDG_CONFIG_HOME: join(DIR, "config"), XDG_DATA_HOME: join(DIR, "data"),
  XDG_STATE_HOME: join(DIR, "state"), CLAUDE_SWAP_BACKUP: join(DIR, "claude-swap"),
})) process.env[k] = v;
if (!resolve(process.env.CLAUDE_CONFIG_DIR!).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
delete process.env.AGENTS_DECK_NO_ACCOUNT;
delete process.env.AGENTS_DECK_NO_INSTALL;

const ACCOUNT = "0199e1c0-0d5b-7d02-8a51-3f6e2c9b1a77";
const OTHER = "0199e1c0-0d5b-7d02-8a51-3f6e2c9b1a99";
let api: FakeApi;
let server: Server;
let port = 0;

beforeAll(async () => {
  api = await startFakeApi();
  api.interval = 1;
  process.env.CCDECK_ACCOUNT = "1";
  process.env.CCDECK_ACCOUNT_API = api.url;
  // @ts-expect-error — plain .mjs server module, no types
  const mod = await import("../../server/index.mjs");
  server = await mod.startServer({
    port: 0, persist: false, claude: false, codex: false,
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

function ask(method: string, path: string, body?: unknown, { headers = page(), type }: { headers?: Record<string, string>; type?: string } = {}): Promise<{ status: number; json: any; body: string }> {
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: { ...headers, ...(payload ? { "content-type": type ?? "application/json", "content-length": String(payload.length) } : {}) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } done({ status: res.statusCode ?? 0, json, body: raw }); });
    });
    req.on("error", fail);
    req.end(payload);
  });
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 160, 0, 0, 3, 132];
const file = (head: number[] | string, size = 64) => {
  const bytes = typeof head === "string" ? [...head].map(c => c.charCodeAt(0)) : head;
  const out = new Uint8Array(Math.max(size, bytes.length));
  out.set(bytes);
  return out;
};

/** The body and content type the dialog's FormData posts. */
async function multipart(parts: [string, string | Uint8Array][]) {
  const form = new FormData();
  for (const [name, value] of parts) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, new Blob([value], { type: "image/png" }), "alice-desk.png");
  }
  const r = new Request("http://127.0.0.1/", { method: "POST", body: form });
  return { type: r.headers.get("content-type")!, bytes: Buffer.from(await r.arrayBuffer()) };
}

const feedbackRequests = () => api.requests.filter(r => r.path.startsWith("/v1/device/feedback"));
const MESSAGE = { kind: "bug", title: "Usage panel shows 0 after the laptop sleeps", body: "Usage panel shows 0 after the laptop sleeps.\nIt comes back after a minute." };

describe("before the deck is connected", () => {
  it("answers not_connected and sends nothing", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/account/feedback/threads"],
      ["POST", "/api/account/feedback/threads", MESSAGE],
      ["GET", "/api/account/feedback/threads/0199f3b1-2c4d-7e5f-8a6b-1c2d3e4f5a6b"],
      ["POST", "/api/account/feedback/threads/0199f3b1-2c4d-7e5f-8a6b-1c2d3e4f5a6b/replies", { body: "hi" }],
      ["POST", "/api/account/feedback/threads/0199f3b1-2c4d-7e5f-8a6b-1c2d3e4f5a6b/read", { seq: 1 }],
    ] as const) {
      const got = await ask(method, path, body);
      expect([got.status, got.json], `${method} ${path}`).toEqual([409, { ok: false, reason: "not_connected" }]);
    }
    expect(feedbackRequests()).toEqual([]);
  });
});

describe("a connected deck", () => {
  let threadId = "";

  it("connects", async () => {
    const got = await ask("POST", "/api/account/connect", { name: "laptop-a" });
    api.approve(got.json.connect.userCode, ACCOUNT);
    await until(async () => (await ask("GET", "/api/account")).json?.state === "connected", 8_000, "connected");
  });

  it("starts a conversation as JSON, with this deck's version and system and without a contact", async () => {
    const got = await ask("POST", "/api/account/feedback/threads", { ...MESSAGE, contact: "me@example.com", deviceId: "fp_123", appVersion: "9.9.9" });
    expect(got.status).toBe(201);
    expect(got.json.thread).toMatchObject({ kind: "bug", title: MESSAGE.title, status: { code: "received", label: "Received" }, lastSeq: 0 });
    expect(got.json.items).toEqual([expect.objectContaining({ seq: 0, type: "message", side: "user", text: MESSAGE.body, via: "deck", images: [] })]);
    threadId = got.json.thread.id;
    const sent = api.feedback.created.at(-1)!;
    expect(sent.via).toBe("json");
    expect(sent.fields.sort()).toEqual(["appVersion", "body", "kind", "platform", "title"]);
    const facts = deckFacts();
    expect(sent.values).toMatchObject({ appVersion: facts.version, platform: `${facts.os}-${facts.arch}` });
    const post = feedbackRequests().at(-1)!;
    expect(post.headers.authorization).toMatch(/^Bearer ccdd_/);
    expect(post.raw).not.toMatch(/contact|deviceId|me@example\.com|fp_123/);
  });

  it("starts one as a form with an image, on its own connection, still without a contact or a fingerprint", async () => {
    const { type, bytes } = await multipart([["kind", "idea"], ["title", "Pin a session"], ["body", "Pin a session to the top."], ["contact", "me@example.com"], ["images", file(PNG)]]);
    const got = await ask("POST", "/api/account/feedback/threads", bytes, { type });
    expect(got.status).toBe(201);
    expect(got.json.items[0].images).toEqual([expect.objectContaining({ type: "image/png", width: 1440, height: 900 })]);
    expect(got.json.thread.images).toBe(1);
    const sent = api.feedback.created.at(-1)!;
    expect(sent).toMatchObject({ via: "form", images: 1 });
    expect(sent.fields.sort()).toEqual(["appVersion", "body", "images", "kind", "platform", "title"]);
    const post = feedbackRequests().at(-1)!;
    // The file's own name never leaves: it can say whose machine it was on.
    expect(post.bytes.toString("latin1")).not.toMatch(/alice-desk|me@example\.com|deviceId/);
    expect(post.headers.connection).toBe("close");
  });

  it("refuses an image the API would refuse, before anything leaves", async () => {
    const before = feedbackRequests().length;
    const { type, bytes } = await multipart([["kind", "bug"], ["title", "A GIF"], ["body", "A GIF."], ["images", file("GIF89a")]]);
    const got = await ask("POST", "/api/account/feedback/threads", bytes, { type });
    expect(got.status).toBe(400);
    expect(got.json).toEqual({ ok: false, reason: "invalid", errors: { images: ["Image 1 is not a PNG or a JPEG."] } });
    expect(feedbackRequests().length).toBe(before);
  });

  it("passes the API's field errors on", async () => {
    const got = await ask("POST", "/api/account/feedback/threads", { kind: "feature", title: "Hi", body: "  " });
    expect(got.status).toBe(400);
    expect(got.json).toMatchObject({ ok: false, reason: "invalid" });
    expect(Object.keys(got.json.errors).sort()).toEqual(["body", "kind", "title"]);
  });

  it("refuses a body over 64 KB itself, as too_large", async () => {
    const before = feedbackRequests().length;
    const got = await ask("POST", "/api/account/feedback/threads", { ...MESSAGE, body: "x".repeat(70 * 1024) });
    expect([got.status, got.json]).toEqual([413, { ok: false, reason: "too_large" }]);
    expect(feedbackRequests().length).toBe(before);
  });

  it("lists the conversations, latest first, with the account's summary", async () => {
    const got = await ask("GET", "/api/account/feedback/threads");
    expect(got.status).toBe(200);
    expect(got.json.threads.map((t: any) => t.title)).toEqual(["Pin a session", MESSAGE.title]);
    expect(got.json).toMatchObject({ next: null, unread: 0, latestAt: null });
    expect(feedbackRequests().at(-1)!.path).toBe("/v1/device/feedback/threads?limit=50");
  });

  it("pages the list with the API's own cursor", async () => {
    for (let i = 0; i < 50; i++) api.feedback.seed(ACCOUNT, { title: `Seeded ${i}` });
    const first = await ask("GET", "/api/account/feedback/threads");
    expect(first.json.threads).toHaveLength(50);
    expect(first.json.next).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const second = await ask("GET", `/api/account/feedback/threads?before=${first.json.next}`);
    expect(second.status).toBe(200);
    expect(second.json.threads).toHaveLength(2);
    expect(second.json.next).toBeNull();
    expect(feedbackRequests().at(-1)!.path).toBe(`/v1/device/feedback/threads?limit=50&before=${first.json.next}`);
  });

  it("opens a thread, and the page before it", async () => {
    const t = api.feedback.thread(threadId);
    for (let i = 0; i < 59; i++) api.feedback.teamReply(threadId, `Reply ${i + 1}`);
    const got = await ask("GET", `/api/account/feedback/threads/${threadId}`);
    expect(got.status).toBe(200);
    expect(got.json.items).toHaveLength(50);
    expect(got.json.items[0].seq).toBe(10);
    expect(got.json.earlier).toBe(10);
    const earlier = await ask("GET", `/api/account/feedback/threads/${threadId}?before=10`);
    expect(earlier.json.items.map((i: any) => i.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(earlier.json.earlier).toBeNull();
    expect(t.readSeq, "opening marks nothing read").toBe(0);
  });

  it("replies, and reads", async () => {
    const got = await ask("POST", `/api/account/feedback/threads/${threadId}/replies`, { body: "Still happens on 3.48.1." });
    expect(got.status).toBe(201);
    expect(got.json.item).toMatchObject({ type: "message", side: "user", text: "Still happens on 3.48.1.", via: "deck" });
    expect(got.json.thread.preview).toEqual({ side: "user", text: "Still happens on 3.48.1." });
    // The fifty seeded conversations hold unread replies too; this one is the
    // fifty-first, until it is read.
    expect((await ask("GET", "/api/account/feedback/threads")).json.unread).toBe(51);
    const read = await ask("POST", `/api/account/feedback/threads/${threadId}/read`, { seq: got.json.item.seq });
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ unread: 50, latestAt: expect.any(String) });
    expect(api.feedback.thread(threadId).readSeq).toBe(got.json.item.seq);
    // And the view says so at once: the dot does not wait for a frame.
    expect((await ask("GET", "/api/account")).json.feedback).toEqual(read.json);
  });

  it("reopens a Won't do on a reply, as the API does", async () => {
    api.feedback.teamStatus(threadId, "wont_do", { reason: "The system stops the network while it sleeps." });
    const got = await ask("POST", `/api/account/feedback/threads/${threadId}/replies`, { body: "Please reconsider." });
    expect(got.json.thread.status).toMatchObject({ code: "received" });
    expect(api.feedback.thread(threadId).items.at(-1)).toMatchObject({ type: "reopened", side: "user", text: "Reopened by your reply." });
  });

  it("answers another account's thread as not found", async () => {
    const theirs = api.feedback.seed(OTHER);
    for (const [method, path, body] of [
      ["GET", `/api/account/feedback/threads/${theirs.id}`],
      ["POST", `/api/account/feedback/threads/${theirs.id}/replies`, { body: "hi" }],
      ["POST", `/api/account/feedback/threads/${theirs.id}/read`, { seq: 1 }],
    ] as const) {
      const got = await ask(method, path, body);
      expect([got.status, got.json], path).toEqual([404, { ok: false, reason: "not_found" }]);
    }
  });

  it("never sends a bad id, cursor or item number", async () => {
    const before = feedbackRequests().length;
    for (const [method, path, body] of [
      ["GET", "/api/account/feedback/threads/not-a-thread"],
      ["GET", "/api/account/feedback/threads/0199F3B1-2C4D-7E5F-8A6B-1C2D3E4F5A6B"],
      ["GET", "/api/account/feedback/threads/..%2Fstatus"],
      ["GET", `/api/account/feedback/threads?before=${encodeURIComponent("a b")}`],
      ["GET", `/api/account/feedback/threads?before=${"a".repeat(65)}`],
      ["GET", `/api/account/feedback/threads/${threadId}?before=x`],
      ["GET", `/api/account/feedback/threads/${threadId}?before=-1`],
      ["POST", "/api/account/feedback/threads/1234/replies", { body: "hi" }],
      ["POST", `/api/account/feedback/threads/${threadId}/read`, { seq: -1 }],
      ["POST", `/api/account/feedback/threads/${threadId}/read`, { seq: "3" }],
      ["POST", `/api/account/feedback/threads/${threadId}/replies`, { body: 3 }],
      ["POST", "/api/account/feedback/threads", "not json"],
      ["POST", "/api/account/feedback/threads", [1, 2]],
    ] as const) {
      const got = await ask(method, path, body);
      expect([got.status, got.json], `${method} ${path}`).toEqual([400, { ok: false, reason: "bad_request" }]);
    }
    for (const [method, path] of [
      ["GET", `/api/account/feedback/threads/${threadId}/replies`],
      ["POST", `/api/account/feedback/threads/${threadId}`],
      ["GET", `/api/account/feedback/threads/${threadId}/other`],
    ] as const) {
      expect((await ask(method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(404);
    }
    expect(feedbackRequests().length).toBe(before);
  });

  it("says when today's limit is reached, with the limit and when to try again", async () => {
    // Two conversations were opened above; eight more reach the ten.
    for (let i = 0; i < 8; i++) expect((await ask("POST", "/api/account/feedback/threads", MESSAGE)).status).toBe(201);
    const got = await ask("POST", "/api/account/feedback/threads", MESSAGE);
    expect(got.status).toBe(429);
    expect(got.json).toEqual({ ok: false, reason: "too_many", limit: 10, retryAfterSec: expect.any(Number) });
    expect(got.json.retryAfterSec).toBeGreaterThan(86_000);
    // And a reply's: fifty a day, two of them sent above.
    let last: any = null;
    for (let i = 0; i < 48; i++) last = await ask("POST", `/api/account/feedback/threads/${threadId}/replies`, { body: `Again ${i}` });
    expect(last.status).toBe(201);
    const over = await ask("POST", `/api/account/feedback/threads/${threadId}/replies`, { body: "One too many" });
    expect([over.status, over.json.reason, over.json.limit]).toEqual([429, "too_many", 50]);
  });

  it("maps the request policy's 429, a server error and an API with accounts off", async () => {
    api.override("GET /v1/device/feedback/threads", () => ({ status: 429, body: { error: "rate_limited" }, headers: { "content-type": "application/problem+json", "retry-after": "120" } }));
    expect((await ask("GET", "/api/account/feedback/threads")).json).toEqual({ ok: false, reason: "too_many", retryAfterSec: 120 });
    api.override("GET /v1/device/feedback/threads", () => ({ status: 503, body: { error: "unavailable" } }));
    expect(await ask("GET", "/api/account/feedback/threads")).toMatchObject({ status: 502, json: { ok: false, reason: "unavailable" } });
    api.override("GET /v1/device/feedback/threads", () => ({ status: 404, body: { error: "not_found" } }));
    expect(await ask("GET", "/api/account/feedback/threads")).toMatchObject({ status: 502, json: { ok: false, reason: "unavailable" } });
    api.override("GET /v1/device/feedback/threads", () => ({ status: 413, body: { error: "too_large" } }));
    expect(await ask("GET", "/api/account/feedback/threads")).toMatchObject({ status: 413, json: { ok: false, reason: "too_large" } });
    api.override("GET /v1/device/feedback/threads", null);
  });

  it("ends the device on a final 401", async () => {
    api.revoke(undefined, "device_revoked");
    const got = await ask("GET", "/api/account/feedback/threads");
    expect([got.status, got.json]).toEqual([409, { ok: false, reason: "revoked" }]);
    expect((await ask("GET", "/api/account")).json).toMatchObject({ state: "revoked", revokedReason: "device_revoked", feedback: null });
    expect((await ask("GET", "/api/account/feedback/threads")).json).toEqual({ ok: false, reason: "not_connected" });
  });
});
