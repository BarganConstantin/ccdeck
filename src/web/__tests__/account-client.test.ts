// The account's channel to the API (account-client.mjs): one keep-alive
// connection, a six-second ceiling, a Retry-After read and handed back, every
// call answered rather than thrown — and nothing from the usage reports' channel
// on it, ever.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs server module, no types
import { createAccountClient, retryAfterMs, RETRY_AFTER_MAX_MS } from "../../server/account-client.mjs";

let server: Server;
let base = "";
const seen: { sockets: Set<unknown>; headers: Record<string, unknown>[] } = { sockets: new Set(), headers: [] };
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.sockets.add(req.socket);
    seen.headers.push(req.headers);
    if (req.url === "/slow") return; // never answers
    if (req.url === "/limited") { res.writeHead(429, { "retry-after": "7", "content-type": "application/problem+json" }); return res.end('{"error":"rate_limited"}'); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); });

describe("the account client", () => {
  it("keeps one connection for every request", async () => {
    const c = createAccountClient({ apiBase: base, version: "3.43.0" });
    seen.sockets.clear();
    for (let i = 0; i < 5; i++) expect((await c.get("/x")).status).toBe(200);
    expect(seen.sockets.size).toBe(1);
    c.close();
  });

  it("answers a failure instead of throwing: unreachable, and too slow", async () => {
    const dead = createAccountClient({ apiBase: "http://127.0.0.1:1" });
    expect(await dead.get("/x")).toMatchObject({ status: 0, ok: false, network: true });
    const slow = createAccountClient({ apiBase: base, timeoutMs: 200 });
    const started = Date.now();
    expect(await slow.get("/slow")).toMatchObject({ network: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    slow.close();
  });

  it("sends nothing at all once the account is switched off", async () => {
    let on = true;
    const c = createAccountClient({ apiBase: base, enabled: () => on });
    seen.headers.length = 0;
    expect((await c.get("/x")).status).toBe(200);
    on = false;
    expect(await c.post("/x", {})).toMatchObject({ ok: false, network: true, disabled: true });
    expect(seen.headers).toHaveLength(1);
    c.close();
  });

  it("hands back the problem's error and the Retry-After", async () => {
    const c = createAccountClient({ apiBase: base });
    expect(await c.post("/limited", {})).toMatchObject({ status: 429, error: "rate_limited", retryAfterMs: 7_000 });
    c.close();
  });

  it("reads a Retry-After in seconds or as a date, and caps it at a day", () => {
    const at = Date.parse("2026-10-18T09:00:00Z");
    expect(retryAfterMs("30", at)).toBe(30_000);
    expect(retryAfterMs("Sun, 18 Oct 2026 09:01:00 GMT", at)).toBe(60_000);
    expect(retryAfterMs("999999999", at)).toBe(RETRY_AFTER_MAX_MS);
    for (const none of ["", null, undefined, "soon", "-5", "0"]) expect(retryAfterMs(none, at)).toBeNull();
  });

  it("sends a bearer, the version's user agent and JSON — no cookie, no install id, no fingerprint", async () => {
    const c = createAccountClient({ apiBase: base, version: "3.43.0" });
    seen.headers.length = 0;
    await c.post("/x", { a: 1 }, { token: "ccdd_9QmN2fX0aLr7tYc3Kp8VbWzE1uHs6jDg4oRiTe5yAqM" });
    expect(Object.keys(seen.headers[0]).sort()).toEqual(["accept", "authorization", "connection", "content-length", "content-type", "host", "user-agent"]);
    expect(seen.headers[0]["user-agent"]).toBe("ccdeck/3.43.0");
    c.close();
  });
});

describe("the account's modules and the reports' identity", () => {
  it("never import the reporter, nor name its install id or device fingerprint", () => {
    const dir = fileURLToPath(new URL("../../server/", import.meta.url));
    const files = readdirSync(dir).filter(n => /^(account-(client|connect|status|sync|service|store|token-store|ui-fields|flag)|ccdeck-account-routes|session-counts)\.mjs$/.test(n));
    expect(files.length).toBe(11);
    for (const f of files) {
      const src = readFileSync(dir + f, "utf8").split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(src, f).not.toMatch(/from "\.\/reports\.mjs"|import\("\.\/reports\.mjs"\)/);
      expect(src, f).not.toMatch(/installId|deviceIdToken|machineTraits/);
    }
  });
});
