// The account client's two feedback additions (feedback conversations, design
// 4.2): a per-call answer cap, so a thread page of 50 long messages can be read
// while every other answer stays held to 256 KB, and `postForm`, which sends a
// conversation started with screenshots on a connection of its own — the
// status frames keep the kept socket — with two minutes to get there, the
// account's headers and nothing of the usage reports'.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs server module, no types
import { CLIENT_TIMEOUT_MS, createAccountClient, FEEDBACK_READ_MAX, UPLOAD_TIMEOUT_MS } from "../../server/account-client.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { upstreamForm } from "../../server/feedback-form.mjs";

const TOKEN = "ccdd_9QmN2fX0aLr7tYc3Kp8VbWzE1uHs6jDg4oRiTe5yAqM";
let server: Server;
let base = "";
const seen: { sockets: unknown[]; headers: Record<string, unknown>[]; bodies: Buffer[] } = { sockets: [], headers: [], bodies: [] };
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      seen.sockets.push(req.socket);
      seen.headers.push(req.headers);
      seen.bodies.push(Buffer.concat(chunks));
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ text: "x".repeat(300 * 1024) }));
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); });

const reset = () => { seen.sockets.length = 0; seen.headers.length = 0; seen.bodies.length = 0; };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const form = () => upstreamForm(
  { fields: { kind: "bug", title: "The panel is empty", body: "It was fine." }, images: [{ data: PNG, format: "png" }] },
  { appVersion: "3.49.1", platform: "linux-x64" },
);

describe("postForm", () => {
  it("goes on a connection of its own, while the JSON calls keep theirs", async () => {
    const c = createAccountClient({ apiBase: base, version: "3.49.1" });
    reset();
    await c.get("/a");
    await c.get("/b");
    expect(await c.postForm("/form", form(), { token: TOKEN })).toMatchObject({ status: 201, ok: true, body: { ok: true } });
    await c.get("/c");
    const [a, b, upload, after] = seen.sockets;
    expect(a).toBe(b);
    expect(after, "the kept socket outlived the upload").toBe(a);
    expect(upload).not.toBe(a);
    c.close();
  });

  it("asks the transport for a fresh connection, 120 seconds and the 256 KB cap", async () => {
    const calls: any[] = [];
    const c = createAccountClient({
      apiBase: "https://api.example", version: "3.49.1",
      request: async (opts: unknown) => { calls.push(opts); return { status: 201, headers: { "content-type": "application/json" }, text: "{}" }; },
    });
    await c.postForm("/v1/device/feedback/threads", form(), { token: TOKEN });
    await c.get("/v1/device/feedback/threads?limit=50", { token: TOKEN, maxBody: FEEDBACK_READ_MAX });
    await c.post("/v1/device/status", {}, { token: TOKEN });
    expect(UPLOAD_TIMEOUT_MS).toBe(120_000);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.example/v1/device/feedback/threads", timeoutMs: 120_000, maxBody: 256 * 1024, fresh: true });
    expect(Buffer.isBuffer(calls[0].body)).toBe(true);
    expect(calls[1]).toMatchObject({ method: "GET", timeoutMs: CLIENT_TIMEOUT_MS, maxBody: FEEDBACK_READ_MAX });
    expect(calls[1].fresh).toBeUndefined();
    expect(calls[2]).toMatchObject({ maxBody: 256 * 1024 });
    expect(calls[2].fresh).toBeUndefined();
  });

  it("sends the account's headers with the form's own type: no cookie, no install id, no fingerprint", async () => {
    const c = createAccountClient({ apiBase: base, version: "3.49.1" });
    reset();
    const blob = form();
    await c.postForm("/form", blob, { token: TOKEN });
    const h = seen.headers[0];
    expect(Object.keys(h).sort()).toEqual(["accept", "authorization", "connection", "content-length", "content-type", "host", "user-agent"]);
    expect(h["content-type"]).toBe(blob.type);
    expect(h["content-type"]).toMatch(/^multipart\/form-data; boundary=ccdeck-[0-9a-f]{32}$/);
    expect(h["user-agent"]).toBe("ccdeck/3.49.1");
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(Number(h["content-length"])).toBe(seen.bodies[0].length);
    // The form went as the bytes upstreamForm wrote: the image whole.
    expect(seen.bodies[0].includes(Buffer.from(PNG))).toBe(true);
    expect(seen.bodies[0].toString("latin1")).not.toMatch(/deviceId|contact|installId/);
    c.close();
  });

  it("passes the same gate: switched off, nothing goes", async () => {
    let on = false;
    const c = createAccountClient({ apiBase: base, enabled: () => on });
    reset();
    expect(await c.postForm("/form", form(), { token: TOKEN })).toMatchObject({ ok: false, network: true, disabled: true });
    expect(seen.headers).toHaveLength(0);
    on = true;
    expect((await c.postForm("/form", form(), { token: TOKEN })).status).toBe(201);
    c.close();
  });
});

describe("the answer cap", () => {
  it("is 256 KB unless a call asks for more, and a call's own cap is its alone", async () => {
    const c = createAccountClient({ apiBase: base });
    expect(await c.get("/big")).toMatchObject({ status: 0, network: true });
    const big = await c.get("/big", { maxBody: FEEDBACK_READ_MAX });
    expect(big.status).toBe(200);
    expect(big.body.text).toHaveLength(300 * 1024);
    expect(await c.get("/big"), "the next call is back to the default").toMatchObject({ network: true });
    c.close();
  });
});

describe("the account's modules and the reports", () => {
  it("never import either reports module — not reports.mjs, not reports-routes.mjs", () => {
    const dir = fileURLToPath(new URL("../../server/", import.meta.url));
    const files = readdirSync(dir).filter(n => /^(account-(client|connect|status|sync|service|store|token-store|ui-fields|flag)|ccdeck-account-routes|session-counts|feedback-form)\.mjs$/.test(n));
    for (const f of ["account-service.mjs", "ccdeck-account-routes.mjs", "account-client.mjs", "feedback-form.mjs"]) expect(files).toContain(f);
    for (const f of files) {
      const src = readFileSync(dir + f, "utf8").split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(src, f).not.toMatch(/from "\.\/reports(-routes)?\.mjs"|import\("\.\/reports(-routes)?\.mjs"\)/);
    }
  });
});
