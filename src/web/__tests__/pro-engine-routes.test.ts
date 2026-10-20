// The terminal panel's six routes answered by the optional local engine, on a
// real deck (startServer), against the signed test double started as the
// engine (fixtures/pro-engine-peer.cjs, docs/contracts/pro-engine-host-v1.md,
// "Terminal routes").
//
// What is pinned: the deck asks each route's question as `terminal.<method>`
// with `{ body }` and nothing else, after its own flag, gates and body cap;
// sends the engine's status and body as they are; mints the ticket where the
// engine answered a handle, bound to `{ handle, origin }`, in the same store
// with the same single use, and the upgrade relays exactly that ticket to the
// engine; keeps the engine's log line off the page; and runs its own download
// branch for a status the engine calls fixable. And where the engine did not
// take a question — not running, no terminal, a refusal before it ran, a read
// it could not answer — the deck's own route answers, while a mutation that may
// have reached the engine is never asked again of either side.
//
// One deck for the file. Its `terminal.engine` is engineTerminals(client) for
// whichever client the case switched to, through a box the deck was given at
// boot; the routes' other stand-ins are terminal-routes.test.ts's.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { rmTempDir } from "./rm-temp-dir";
import { json, openWs } from "./ws-test-client";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-engine-routes-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.XDG_STATE_HOME = join(DIR, "state");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "claude-swap");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
const PROJECT = join(DIR, "project");
mkdirSync(PROJECT);

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { createTicketStore } = await import("../../server/terminal-socket.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { createProEngineClient } = await import("../../server/pro-engine-client.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { engineTerminals } = await import("../../server/pro-engine-terminal.mjs");

const SID = "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
const TMUX_OK = Object.freeze({ ok: true, path: "/secret/bin/tmux", version: [3, 6], raw: "tmux 3.6a" });
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── the double as an installed, signed engine ────────────────────────────────

const roots: string[] = [], clients: any[] = [];
async function installed({ backend = "tmux", ...options }: Record<string, any> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ccpro-routes-")); roots.push(directory); await chmod(directory, 0o700);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const source = (await readFile(new URL("./fixtures/pro-engine-peer.cjs", import.meta.url), "utf8")).replace("const TERMINAL_BACKEND = 'unavailable';", `const TERMINAL_BACKEND = '${backend}';`);
  const bytes = Buffer.from(`#!${process.execPath}\n${source}`);
  await writeFile(join(directory, "ccdeck-pro-engine"), bytes, { mode: 0o700 });
  const entry = { file: "ccdeck-pro-engine", protocol: 1, target: `${process.arch === "x64" ? "x86_64" : "aarch64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, version: "0.1.0" };
  const payload = Buffer.from(JSON.stringify(entry));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") }), { mode: 0o600 });
  const client = createProEngineClient({ enabled: true, directory, publicKey: publicKey.export({ type: "spki", format: "pem" }), heartbeatMs: 60_000, ...options });
  clients.push(client);
  return client;
}
const answers = (client: any, set: Record<string, object>) => client.request("terminal.answers", { answers: set });
const engineLog = async (client: any): Promise<any[]> => (await client.request("terminal.log")).log;
const routeCalls = async (client: any) => (await engineLog(client)).filter(x => x.route);

// ── the deck ──────────────────────────────────────────────────────────────────

let enabled: boolean;
let tmuxAnswer: any;
let found: number;
let launches: any[];
let resolved: any[];
let downloadBlocked: string | null;
let downloadResult: Promise<any>;
let progress: any;
let recentFailure: { reason: string; at: number } | null;
let forgot: number;
const tickets = createTicketStore();
const box: { current: any } = { current: null };

beforeEach(() => {
  enabled = true;
  tmuxAnswer = TMUX_OK;
  found = 0;
  launches = [];
  resolved = [];
  downloadBlocked = "not_published";
  downloadResult = Promise.resolve({ ok: true });
  progress = null;
  recentFailure = null;
  forgot = 0;
  box.current = null;
});

let server: Server;
let port = 0;
beforeAll(async () => {
  server = await mod.startServer({
    port: 0, persist: false, claude: false, codex: false,
    terminal: {
      enabled: () => enabled,
      deckSocket: { name: "ccdeck-test-engine-routes" },
      tickets,
      findTmux: async () => { found += 1; return tmuxAnswer; },
      resolveTarget: async (q: any) => { resolved.push(q); return { kind: "A", socket: { name: "ccdeck-test-engine-routes" }, pane: "%12", name: "ccdeck-claude-0a1b2c3d" }; },
      launchSession: async (o: any) => { launches.push(o); return { name: "ccdeck-claude-feedf00d", sessionId: SID, pane: "%40" }; },
      listDeckSessions: async () => [],
      labelDeckSession: async () => true,
      killDeckSession: async () => true,
      pruneDeadDeckSessions: async () => [],
      downloadBlocked: () => downloadBlocked,
      downloadTmux: () => downloadResult,
      downloadProgress: () => progress,
      recentDownloadFailure: () => recentFailure,
      forgetTmux: () => { forgot += 1; },
      engine: {
        get enabled() { return box.current?.enabled === true; },
        attach: (handle: string, socket: unknown) => box.current.attach(handle, socket),
        route: (method: string, body: unknown) => box.current.route(method, body),
        forgetTmux: () => box.current.forgetTmux(),
      },
    },
  });
  port = (server.address() as { port: number }).port;
}, 30_000);
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
});
afterAll(async () => {
  await new Promise(r => server.close(r));
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
  rmTempDir(DIR);
});

async function useEngine(options: Record<string, any> = {}) {
  const client = await installed(options);
  box.current = engineTerminals(client);
  return client;
}

const page = () => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });

function ask(method: string, path: string, body?: unknown, headers: Record<string, string> = page()): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve_, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: { ...headers, ...(payload !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
        resolve_({ status: res.statusCode ?? 0, body: parsed, raw });
      });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error(`${method} ${path} timed out`)); });
    req.end(payload);
  });
}

const session = (extra: Record<string, unknown> = {}) => ({ sessionId: SID, provider: "claude", cwd: PROJECT, ...extra });
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const launched = { status: 200, body: { ok: true, sessionId: SID, name: "ccdeck-claude-feedf00d", ticket: null }, handle: "mint" };

describe.skipIf(!['darwin', 'linux'].includes(process.platform))("the terminal routes with the optional local engine", () => {
  it("asks each route's question as terminal.<method> with { body } only, and sends the engine's status and body as they are", async () => {
    const client = await useEngine();
    const status = { ok: true, platform: "engine-says", tmux: { ok: true, version: "3.8" } };
    await answers(client, {
      "terminal.status": { data: { status: 200, body: status } },
      "terminal.target": { data: { status: 200, body: { ok: true, target: { kind: "A", label: "from the engine" } } } },
      "terminal.claim": { data: { status: 200, body: { ok: true, claimed: false, target: { kind: "gone" } } } },
      "terminal.open": { data: { status: 400, body: { ok: false, error: "The request did not name a session." } } },
      "terminal.adopt": { data: { status: 409, body: { ok: false, error: "still-running" } } },
    });
    const got = await ask("GET", "/api/terminal/status");
    expect([got.status, got.body]).toEqual([200, status]);
    expect((await ask("GET", `/api/terminal/target?session=${SID}&provider=claude`)).body.target.label).toBe("from the engine");
    expect((await ask("POST", "/api/terminal/claim", { key: "k1", ...session() })).body.claimed).toBe(false);
    const open = await ask("POST", "/api/terminal/open", "{not json");
    expect([open.status, open.body]).toEqual([400, { ok: false, error: "The request did not name a session." }]);
    const adopt = await ask("POST", "/api/terminal/adopt", [session()]);
    expect([adopt.status, adopt.body]).toEqual([409, { ok: false, error: "still-running" }]);
    expect((await routeCalls(client)).map(c => [c.route, c.params])).toEqual([
      ["terminal.status", { body: null }],
      // The query's three values, each "" when absent, as the route reads them.
      ["terminal.target", { body: { sessionId: SID, provider: "claude", cwd: "" } }],
      ["terminal.claim", { body: { key: "k1", ...session() } }],
      // Not a JSON object: the engine is asked with null and answers the 400.
      ["terminal.open", { body: null }],
      ["terminal.adopt", { body: null }],
    ]);
    expect([found, resolved.length, launches.length], "the deck's own route was not asked").toEqual([0, 0, 0]);
  });

  it("mints the ticket over the engine's handle, bound to the page's origin, and the upgrade relays it to the engine once", async () => {
    const client = await useEngine();
    await answers(client, { "terminal.launch": { data: launched } });
    const held = tickets.size;
    const got = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT, key: "k-1" });
    expect(got.status).toBe(200);
    expect(Object.keys(got.body), "the ticket where the engine's null was").toEqual(["ok", "sessionId", "name", "ticket"]);
    expect(got.body.ticket).toMatch(TICKET);
    const minted = (await engineLog(client)).find(x => x.minted)!.minted;
    expect(got.raw, "the handle stays between the deck and the engine").not.toContain(minted);
    expect(tickets.size).toBe(held + 1);
    expect(launches, "the deck launched nothing itself").toEqual([]);

    const path = `/api/terminal/attach?ticket=${encodeURIComponent(got.body.ticket)}`;
    const c = await openWs({ port, path, headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(c.status).toBe(101);
    expect(json(await c.next())).toEqual({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    expect((await engineLog(client)).filter(x => x.attach !== undefined).map(x => x.handle)).toEqual([minted]);
    c.sendClose();
    await c.closed;

    const replay = await openWs({ port, path, headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(replay.status, "single use").toBe(401);
    // A ticket the page at one origin asked for, opened by a page at another
    // that names its own host: refused before the engine hears of it.
    const other = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT, key: "k-1" });
    const elsewhere = await openWs({ port, path: `/api/terminal/attach?ticket=${encodeURIComponent(other.body.ticket)}`, headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } });
    expect(elsewhere.status).toBe(403);
    expect((await engineLog(client)).filter(x => x.attach !== undefined), "one attach in all").toHaveLength(1);
  });

  it("writes the engine's log line to the deck's log and never to the page", async () => {
    const client = await useEngine();
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await answers(client, { "terminal.launch": { data: { status: 500, body: { ok: false, error: "tmux could not start the session.", code: "tmux-failed" }, log: "tmux could not start the session. (no server at /secret/tmp/sock)" } } });
      const got = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT });
      expect([got.status, got.body]).toEqual([500, { ok: false, error: "tmux could not start the session.", code: "tmux-failed" }]);
      expect(got.raw).not.toContain("/secret");
      expect(said.mock.calls.map(c => String(c[0])).filter(l => l.includes("terminal:"))).toEqual(["ccdeck: terminal: tmux could not start the session. (no server at /secret/tmp/sock)"]);
    } finally {
      said.mockRestore();
    }
  });

  it("runs the deck's download branch for a status the engine calls fixable, and a build that lands is forgotten on both sides", async () => {
    const client = await useEngine();
    const missing = { ok: false, reason: "missing", install: "sudo apt install tmux" };
    await answers(client, {
      "terminal.status": { data: { status: 200, body: { ok: true, platform: process.platform, tmux: missing }, fixable: true } },
      "terminal.forgetTmux": { data: { forgot: true } },
    });
    expect((await ask("GET", "/api/terminal/status")).body.tmux, "fetching is switched off here").toEqual(missing);
    downloadBlocked = null;
    recentFailure = { reason: "download_failed", at: Date.now() };
    expect((await ask("GET", "/api/terminal/status")).body).toEqual({ ok: true, platform: process.platform, tmux: { ...missing, download: "download_failed" } });
    recentFailure = null;
    let land!: (r: unknown) => void;
    downloadResult = new Promise(r => { land = r; });
    progress = { stage: "downloading", received: 1, total: 2 };
    expect((await ask("GET", "/api/terminal/status")).body.tmux).toEqual({ ok: false, reason: "installing", progress });
    expect(forgot).toBe(0);
    land({ ok: true });
    await vi.waitFor(async () => expect((await routeCalls(client)).filter(c => c.route === "terminal.forgetTmux").map(c => c.params)).toEqual([{ body: null }]));
    expect(forgot).toBe(1);
    expect(found, "the deck never looked for tmux itself").toBe(0);
  });

  it("lets the deck's own route answer what the engine turned away before running it, and a read it did not answer", async () => {
    const client = await useEngine({ timeoutMs: 300 });
    await answers(client, {
      "terminal.launch": { error: "unavailable" },
      "terminal.status": { error: "busy" },
      "terminal.target": { data: { status: 200, body: {} }, delayMs: 2_000 },
    });
    const got = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT });
    expect([got.status, got.body.name]).toEqual([200, "ccdeck-claude-feedf00d"]);
    expect(launches).toHaveLength(1);
    // A ticket of the deck's own, bound to its pane: the upgrade takes it to
    // the bridge in this process, never to the engine.
    expect(got.body.ticket).toMatch(TICKET);
    expect((await ask("GET", "/api/terminal/status")).body.tmux).toEqual({ ok: true, version: "3.6" });
    expect((await ask("GET", `/api/terminal/target?session=${SID}&provider=claude&cwd=${encodeURIComponent(PROJECT)}`)).body.ok).toBe(true);
    expect(resolved).toHaveLength(1);
    expect((await routeCalls(client)).map(c => c.route)).toEqual(["terminal.launch", "terminal.status", "terminal.target"]);
  });

  it("never asks a mutation again once it may have reached the engine: the deck's own 500, and its own route is not asked", async () => {
    let client = await useEngine({ timeoutMs: 300 });
    await answers(client, { "terminal.launch": { data: launched, delayMs: 2_000 }, "terminal.open": { error: "internal" }, "terminal.target": { error: "internal" } });
    expect((await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT })).status, "no answer in time").toBe(500);
    expect((await ask("POST", "/api/terminal/open", session())).status, "internal").toBe(500);
    expect((await ask("GET", `/api/terminal/target?session=${SID}&provider=claude`)).status, "internal, for a read too").toBe(500);
    client = await useEngine();
    await answers(client, { "terminal.adopt": { crash: true } });
    expect((await ask("POST", "/api/terminal/adopt", session())).status, "the engine went away under it").toBe(500);
    expect([launches.length, resolved.length]).toEqual([0, 0]);
    // A read meanwhile: the engine is in its restart backoff, so the deck answers.
    expect((await ask("GET", "/api/terminal/status")).body.tmux).toEqual({ ok: true, version: "3.6" });
    expect(found).toBe(1);
  });

  it("refuses an answer that is not a route answer with the deck's own 500", async () => {
    const client = await useEngine();
    const bad = [
      { status: 200, body: {}, extra: true },
      { status: 99, body: {} },
      { status: 200 },
      { status: 200, body: { ok: true, ticket: null }, handle: "not-hex" },
      { status: 200, body: { ok: true, ticket: "already" }, handle: "mint" },
      { status: 200, body: { ok: true }, fixable: true },
      { status: 200, body: {}, log: 7 },
    ];
    for (const data of bad) {
      await answers(client, { "terminal.status": { data } });
      const got = await ask("GET", "/api/terminal/status");
      expect(got.status, JSON.stringify(data)).toBe(500);
      expect(got.raw).not.toContain("already");
    }
    expect(found).toBe(0);
  });

  it("asks nothing of an engine whose hello said it has no terminal, nor of any with the panel off or a body over the cap", async () => {
    const none = await useEngine({ backend: "unavailable" });
    await answers(none, { "terminal.status": { data: { status: 200, body: {} } } });
    expect((await ask("GET", "/api/terminal/status")).body.tmux).toEqual({ ok: true, version: "3.6" });
    expect(await routeCalls(none)).toEqual([]);
    const client = await useEngine();
    await answers(client, { "terminal.launch": { data: launched }, "terminal.status": { data: { status: 200, body: {} } } });
    enabled = false;
    for (const [method, path] of [["GET", "/api/terminal/status"], ["POST", "/api/terminal/launch"]]) {
      expect((await ask(method, path, method === "POST" ? { agent: "claude", cwd: PROJECT } : undefined)).status).toBe(404);
    }
    enabled = true;
    const big = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT, pad: "x".repeat(9 * 1024) });
    expect(big.status).toBe(413);
    // The gates are in front of the engine too: a cross-site page is refused.
    expect((await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT }, { host: `127.0.0.1:${port}`, origin: "http://evil.example" })).status).toBe(403);
    await delay(50);
    expect(await routeCalls(client)).toEqual([]);
    expect(launches).toEqual([]);
  });
});
