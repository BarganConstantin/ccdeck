// /api/devices: behind the same gates as every other route, local to this
// deck, and answering a typed result rather than a sentence.
//
// Two halves. The first boots a real deck in a temporary home and asks it as a
// stranger, as the deck's own page and as a client holding the token — only
// saving and removing, so no ssh is ever started. The second runs the handlers
// with a stand-in for the connections, to pin what a test hands the
// connection layer and how its answer comes back.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-device-routes-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.AGENTS_DECK_NO_INSTALL = "1";
for (const p of [process.env.HOME, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME, process.env.CCDECK_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs module, no types
const { GUARDED_READS } = await import("../../server/request-gates.mjs");
const {
  handleDeviceAdd, handleDeviceDisconnect, handleDeviceList, handleDeviceSessions, handleDeviceTest, handleDeviceTrust, DEVICE_BODY_LIMIT,
// @ts-expect-error — plain .mjs module, no types
} = await import("../../server/device-routes.mjs");
// @ts-expect-error — plain .mjs module, no types
const { createDeviceStore } = await import("../../server/device-store.mjs");

type Answer = { status: number; body: any };
function ask(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve_, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
        resolve_({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => { req.destroy(); resolve_({ status: 0, body: null }); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("the device routes on a running deck", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = await startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
    port = (server.address() as AddressInfo).port;
  }, 30_000);
  afterAll(async () => {
    await new Promise(r => server.close(r));
    rmTempDir(DIR);
  });

  const token = () => ({ "x-ccdeck-token": hookToken() as string });
  const page = () => ({ host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
  const pagePost = () => ({ ...page(), origin: `http://127.0.0.1:${port}`, "content-type": "application/json" });

  it("lists both reads with the guarded ones", () => {
    expect(GUARDED_READS.has("/api/devices")).toBe(true);
    expect(GUARDED_READS.has("/api/devices/sessions")).toBe(true);
  });

  it("answers no read to a caller that presents nothing", async () => {
    expect((await ask(port, "GET", "/api/devices")).status).toBe(401);
    expect((await ask(port, "GET", "/api/devices/sessions?id=x")).status).toBe(401);
  });

  it("answers the deck's own page and the token", async () => {
    const r = await ask(port, "GET", "/api/devices", page());
    expect(r).toEqual({ status: 200, body: { ok: true, minimumVersion: "3.44.0", devices: [] } });
    expect((await ask(port, "GET", "/api/devices", token())).status).toBe(200);
    expect((await ask(port, "GET", "/api/devices/sessions?id=nope", token())).status).toBe(404);
  });

  it("acts for no stranger, and turns a page on another site away as a page", async () => {
    for (const path of ["/api/devices/add", "/api/devices/remove", "/api/devices/test", "/api/devices/trust", "/api/devices/disconnect"]) {
      expect((await ask(port, "POST", path, {}, "{\"alias\":\"studio\"}")).status, path).toBe(401);
      expect((await ask(port, "POST", path, { host: `127.0.0.1:${port}`, origin: "https://evil.example", "sec-fetch-site": "cross-site" }, "{}")).status, path).toBe(403);
      expect((await ask(port, "POST", path, { host: "attacker.example:4317", origin: "http://attacker.example:4317", "sec-fetch-site": "same-origin" }, "{}")).status, path).toBe(403);
    }
  });

  it("saves, refuses a twin and a hostile alias, and removes", async () => {
    const added = await ask(port, "POST", "/api/devices/add", pagePost(), JSON.stringify({ name: "Studio", alias: "studio", password: "hunter2" }));
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ ok: true, device: { name: "Studio", alias: "studio", link: { state: "offline" } } });
    expect(added.body.device).not.toHaveProperty("password");
    expect(added.body.device).not.toHaveProperty("launcher");

    expect(await ask(port, "POST", "/api/devices/add", token(), JSON.stringify({ alias: "studio" })))
      .toEqual({ status: 409, body: { ok: false, error: "duplicate", field: "alias" } });
    expect(await ask(port, "POST", "/api/devices/add", token(), JSON.stringify({ alias: "-oProxyCommand=touch /tmp/x" })))
      .toEqual({ status: 400, body: { ok: false, error: "invalid", field: "alias" } });
    expect(await ask(port, "POST", "/api/devices/test", token(), JSON.stringify({ draft: { host: "-oProxyCommand=x", user: "ana" } })))
      .toEqual({ status: 400, body: { ok: false, error: "invalid", field: "host" } });

    const file = join(DIR, "deck", "devices.json");
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("hunter2");

    const list = await ask(port, "GET", "/api/devices", token());
    expect(list.body.devices.map((d: { name: string }) => d.name)).toEqual(["Studio"]);
    const id = list.body.devices[0].id;
    expect(await ask(port, "POST", "/api/devices/remove", token(), JSON.stringify({ id }))).toEqual({ status: 200, body: { ok: true } });
    expect((await ask(port, "POST", "/api/devices/remove", token(), JSON.stringify({ id }))).status).toBe(404);
    expect((await ask(port, "POST", "/api/devices/test", token(), JSON.stringify({ id }))).status).toBe(404);
    expect((await ask(port, "POST", "/api/devices/disconnect", token(), JSON.stringify({ id }))).status).toBe(404);
  });

  it("refuses a body it cannot read, and one too big", async () => {
    expect(await ask(port, "POST", "/api/devices/add", token(), "{ nope")).toEqual({ status: 400, body: { ok: false, error: "bad_body" } });
    expect(await ask(port, "POST", "/api/devices/add", token(), "[1]")).toEqual({ status: 400, body: { ok: false, error: "bad_body" } });
    expect((await ask(port, "POST", "/api/devices/add", token(), JSON.stringify({ alias: "x".repeat(DEVICE_BODY_LIMIT) }))).status).toBe(413);
  });
});

describe("the device handlers, with a stand-in for the connections", () => {
  const STORE_DIR = mkdtempSync(join(tmpdir(), "ccdeck-device-handlers-"));
  afterAll(() => rmTempDir(STORE_DIR));
  const store = createDeviceStore({ dir: () => STORE_DIR });
  const seen: any[] = [];
  let answer: any = { type: "ok", version: "4.5.0", deckVersion: "4.5.0", sessions: 0 };
  const links = {
    check: async (device: any) => { seen.push(["check", device]); return answer; },
    sessions: async (device: any) => { seen.push(["sessions", device]); return answer; },
    trust: async (confirm: string) => { seen.push(["trust", confirm]); return answer; },
    disconnect: (device: any) => { seen.push(["disconnect", device]); },
    forget: () => {},
    status: () => ({ state: "offline", checkedAt: null, last: null }),
  };
  const deps = { store, links };
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const routes: Record<string, () => Promise<unknown>> = {
        "/list": () => handleDeviceList(req, res, deps),
        "/add": () => handleDeviceAdd(req, res, deps),
        "/test": () => handleDeviceTest(req, res, deps),
        "/trust": () => handleDeviceTrust(req, res, deps),
        "/disconnect": () => handleDeviceDisconnect(req, res, deps),
        "/sessions": () => handleDeviceSessions(req, res, url, deps),
      };
      routes[url.pathname]?.();
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });

  it("hands a draft to the connections as the validator reduced it, never with extra fields", async () => {
    seen.length = 0;
    const r = await ask(port, "POST", "/test", {}, JSON.stringify({ draft: { host: "Mac.Home", user: "ana", port: "2222", identityFile: "~/.ssh/id", proxyCommand: "nc" } }));
    expect(r).toEqual({ status: 200, body: { ok: true, type: "ok", version: "4.5.0", deckVersion: "4.5.0", sessions: 0 } });
    expect(seen).toEqual([["check", { name: "mac.home", host: "mac.home", user: "ana", port: 2222, launcher: null }]]);
    expect(await store.list()).toEqual([]);
  });

  it("answers every outcome as 200 with its type, ok only for ok", async () => {
    const { device } = await store.add({ alias: "studio" });
    for (const outcome of [
      { type: "host_key_unknown", keys: [{ keyType: "ssh-ed25519", fingerprint: "SHA256:x" }], confirm: "c" },
      { type: "host_key_changed", fingerprint: "SHA256:y" },
      { type: "auth_failed" },
      { type: "unreachable", detail: "refused" },
      { type: "no_remote_ccdeck", detail: "not_installed" },
      { type: "version_too_old", version: "3.0.0", minimum: "3.44.0" },
    ]) {
      answer = outcome;
      expect(await ask(port, "POST", "/test", {}, JSON.stringify({ id: device.id }))).toEqual({ status: 200, body: { ...outcome, ok: false } });
      expect(await ask(port, "GET", `/sessions?id=${device.id}`)).toEqual({ status: 200, body: { ...outcome, ok: false } });
    }
    answer = { type: "trust_expired" };
    expect(await ask(port, "POST", "/trust", {}, JSON.stringify({ confirm: 42 }))).toEqual({ status: 200, body: { type: "trust_expired", ok: false } });
    expect(seen.at(-1)).toEqual(["trust", ""]);
  });

  it("disconnects a saved device and nothing else", async () => {
    const { device } = await store.add({ alias: "other" });
    seen.length = 0;
    expect(await ask(port, "POST", "/disconnect", {}, JSON.stringify({ id: device.id })))
      .toEqual({ status: 200, body: { ok: true, link: { state: "offline", checkedAt: null, last: null } } });
    expect(seen).toEqual([["disconnect", device]]);
    expect((await ask(port, "POST", "/disconnect", {}, JSON.stringify({ id: "x".repeat(100) }))).status).toBe(404);
  });
});
