// Where the deck makes the Command Panel's engine, and when it stops it
// (command-panel-engine.mjs).
//
// Off — the switch's default — and off Linux and macOS (Windows), the deck does
// nothing for the panel at all: no look at the install folder, no client, no
// process, no network. On Linux or macOS with the switch on, it looks in one
// folder, reaches the engine only when its hello advertises a terminal backend, and trusts only
// the keys shipped in the file, which are none in this release: a missing
// folder is `not-installed`, a present one `not-verified`, and the executable
// is never read. The one client it makes is the only one told it may serve
// terminals (CCDECK_ENGINE_TERMINAL=1), and any value the deck inherited is
// removed first.
//
// The client module is the real one, wrapped to record every construction,
// and the deck's own engine is the real one, wrapped to record the switch-off
// prefs-routes reports; the file system is watched through fs.promises, which
// is what both the panel's engine and the installer read through.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, promises as fsp, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const made = vi.hoisted(() => ({ clients: [] as unknown[], switchedOff: 0 }));
vi.mock("../../server/pro-engine-client.mjs", async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, createProEngineClient: (options: unknown) => { made.clients.push(options); return real.createProEngineClient(options); } };
});
vi.mock("../../server/command-panel-engine.mjs", async (importOriginal) => {
  const real: any = await importOriginal();
  const panel = real.commandPanelEngine();
  const commandPanel = Object.freeze({
    get enabled() { return panel.enabled; },
    route: (method: string, body: unknown) => panel.route(method, body),
    attach: (handle: string, socket: unknown) => panel.attach(handle, socket),
    switchedOff: () => { made.switchedOff += 1; panel.switchedOff(); },
    stop: () => panel.stop(),
  });
  return { ...real, commandPanel, stopCommandPanelEngine: () => commandPanel.stop() };
});

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-panel-engine-"));
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
// What a shell may have exported: it must change nothing.
process.env.CCDECK_ENGINE_TERMINAL = "1";
delete process.env.CCDECK_TERMINAL;
mkdirSync(join(DIR, "deck"), { recursive: true });

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const cpe = await import("../../server/command-panel-engine.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { engineEnv, TERMINAL_OPT_IN } = await import("../../server/pro-engine-client.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { verifyEngineInstallation } = await import("../../server/pro-engine-install.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { engineRefusal } = await import("../../server/pro-engine-terminal.mjs");
const { PANEL_RECOVERING, PANEL_UNAVAILABLE } = await import("../terminal-api");
// @ts-expect-error — plain .mjs server module, no types
const { RUNNING_VERSION } = await import("../../server/running-version.mjs");

const ENGINE_DIR = join(DIR, "deck", "engine");
const fail = (code: string) => Object.assign(new Error(code), { code });

/** Every fs.promises read of `under` while `run` runs. */
async function reads(under: string, run: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const spies = (["lstat", "stat", "realpath", "open", "readFile", "readdir", "access"] as const).map(name => {
    const original = (fsp as any)[name].bind(fsp);
    return vi.spyOn(fsp as any, name).mockImplementation((...args: any[]) => {
      if (String(args[0]).startsWith(under)) seen.push(`${name} ${args[0]}`);
      return original(...args);
    });
  });
  try { await run(); } finally { for (const s of spies) s.mockRestore(); }
  return seen;
}

/** A client as createProEngineClient makes one, answering every route `answer`. */
function fakeClient(answer = { status: 200, body: { ok: true } }) {
  const client = {
    enabled: true, running: false, closed: 0,
    capabilities: { terminal: { backend: "tmux" } },
    start: async () => { client.running = true; },
    request: async () => answer,
    close: () => { client.closed += 1; client.running = false; return new Promise(() => {}); },
  };
  return client;
}

describe("the Command Panel's engine, made by the deck", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("trusts no key in this release, and nothing can add one", () => {
    expect(cpe.ENGINE_PUBLIC_KEYS).toEqual([]);
    expect(Object.isFrozen(cpe.ENGINE_PUBLIC_KEYS)).toBe(true);
    expect(() => cpe.ENGINE_PUBLIC_KEYS.push("k")).toThrow();
  });

  it("looks in one folder, the deck's own, and CCDECK_HOME moves it", () => {
    expect(cpe.engineInstallDir("linux", { CCDECK_HOME: "/x/deck" })).toBe("/x/deck/engine");
    expect(cpe.engineInstallDir()).toBe(ENGINE_DIR);
  });

  it("is supported on Linux and macOS only, and never on Windows", () => {
    expect(cpe.commandPanelSupported("linux")).toBe(true);
    expect(cpe.commandPanelSupported("darwin")).toBe(true);
    for (const platform of ["win32", "freebsd", "openbsd", "sunos", "aix", "android", "cygwin", "Darwin", "darwin ", ""]) {
      expect(cpe.commandPanelSupported(platform), platform).toBe(false);
    }
    expect(cpe.commandPanelSupported()).toBe(process.platform === "linux" || process.platform === "darwin");
  });

  it("is unsupported off Linux and macOS (Windows included), without looking at anything or making anything", async () => {
    for (const platform of ["win32", "freebsd"]) {
      const lstat = vi.fn(), createClient = vi.fn();
      const e = cpe.commandPanelEngine({ platform, keys: ["k"], lstat, createClient });
      for (const [method, body] of [["status", null], ["target", { sessionId: "s" }], ["launch", { agent: "claude" }], ["open", { sessionId: "s" }]] as const) {
        const got = await e.route(method, body);
        expect([got.status, got.body.code], `${platform} ${method}`).toEqual([409, "unsupported"]);
      }
      expect(await e.attach("ab".repeat(32), {})).toEqual({ ok: false, status: 503 });
      expect([lstat.mock.calls.length, createClient.mock.calls.length], platform).toEqual([0, 0]);
    }
  });

  it("on macOS, as on Linux, reaches the engine only when its hello advertises a terminal backend", async () => {
    for (const platform of ["darwin", "linux"]) {
      for (const backend of ["unavailable", undefined, null, ""]) {
        const client = fakeClient({ status: 200, body: { ok: true, platform } });
        (client.capabilities.terminal as { backend: unknown }).backend = backend;
        const asked = vi.spyOn(client, "request");
        const createClient = vi.fn(() => client);
        const e = cpe.commandPanelEngine({ platform, env: { CCDECK_HOME: "/x/deck" }, keys: ["K"], lstat: async () => ({}), createClient });
        for (const method of ["status", "launch"]) {
          const got = await e.route(method, method === "launch" ? { agent: "claude" } : null);
          expect([got.status, got.body.code], `${platform} ${String(backend)} ${method}`).toEqual([409, "no-terminal"]);
        }
        expect(asked, `${platform} ${String(backend)}: nothing asked of an engine that serves no terminal`).not.toHaveBeenCalled();
      }
      // Advertised: the same one client, made as on Linux, and every route asked of it.
      const client = fakeClient({ status: 200, body: { ok: true, platform } });
      const createClient = vi.fn(() => client);
      const e = cpe.commandPanelEngine({ platform, env: { CCDECK_HOME: "/x/deck" }, keys: ["K"], lstat: async () => ({}), createClient });
      const got = await e.route("status", null);
      expect([got.status, got.body], platform).toEqual([200, { ok: true, platform }]);
      expect(createClient.mock.calls, platform).toEqual([[{ enabled: true, directory: "/x/deck/engine", publicKey: ["K"], hostVersion: RUNNING_VERSION ?? "0.0.0", terminal: true }]]);
    }
  });

  it("on macOS, as on Linux, is not-installed with no folder and not-verified with one or with no key", async () => {
    const createClient = vi.fn();
    const cases: Array<[() => Promise<unknown>, string[], string]> = [
      [async () => { throw fail("ENOENT"); }, ["K"], "not-installed"],
      [async () => ({}), [], "not-verified"],
      [async () => { throw fail("EACCES"); }, ["K"], "not-verified"],
    ];
    for (const [lstat, keys, code] of cases) {
      const looked = vi.fn(lstat);
      const e = cpe.commandPanelEngine({ platform: "darwin", env: { CCDECK_HOME: "/x/deck" }, keys, lstat: looked, createClient });
      const got = await e.route("status", null);
      expect([got.status, got.body.code], code).toEqual([409, code]);
      expect(looked.mock.calls).toEqual([["/x/deck/engine"]]);
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("is not-installed with no folder and not-verified with one, with no key, and makes no client", async () => {
    const createClient = vi.fn();
    const cases: Array<[() => Promise<unknown>, string]> = [
      [async () => { throw fail("ENOENT"); }, "not-installed"],
      [async () => { throw fail("ENOTDIR"); }, "not-installed"],
      [async () => { throw fail("EACCES"); }, "not-verified"],
      [async () => ({}), "not-verified"],
    ];
    for (const [lstat, code] of cases) {
      const looked = vi.fn(lstat);
      const e = cpe.commandPanelEngine({ platform: "linux", env: { CCDECK_HOME: "/x/deck" }, lstat: looked, createClient });
      const got = await e.route("launch", { agent: "claude" });
      expect([got.status, got.body.code]).toEqual([409, code]);
      expect(looked.mock.calls).toEqual([["/x/deck/engine"]]);
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("makes one client, for the panel, on the first question, and asks it every route after", async () => {
    const client = fakeClient({ status: 200, body: { ok: true, platform: "linux" } });
    const createClient = vi.fn(() => client);
    const e = cpe.commandPanelEngine({ platform: "linux", env: { CCDECK_HOME: "/x/deck" }, keys: ["K"], lstat: async () => ({}), createClient });
    expect(createClient, "nothing before a question").not.toHaveBeenCalled();
    const [a, b] = await Promise.all([e.route("status", null), e.route("status", null)]);
    expect([a.status, b.body]).toEqual([200, { ok: true, platform: "linux" }]);
    await e.route("target", { sessionId: "s" });
    expect(createClient.mock.calls).toEqual([[{ enabled: true, directory: "/x/deck/engine", publicKey: ["K"], hostVersion: RUNNING_VERSION ?? "0.0.0", terminal: true }]]);
    expect(e.running).toBe(true);
  });

  it("stops a grace after the switch goes off, unless asked again, and at once at shutdown without waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clients: ReturnType<typeof fakeClient>[] = [];
    const e = cpe.commandPanelEngine({ platform: "linux", env: {}, keys: ["K"], lstat: async () => ({}), createClient: () => { const c = fakeClient(); clients.push(c); return c; } });
    await e.route("status", null);
    e.switchedOff();
    vi.advanceTimersByTime(cpe.STOP_GRACE_MS - 1);
    expect(clients[0].closed, "the panels are still closing").toBe(0);
    vi.advanceTimersByTime(1);
    expect([clients[0].closed, e.running]).toEqual([1, false]);
    // The next question starts a new one.
    await e.route("status", null);
    expect(clients).toHaveLength(2);
    // Switched back on inside the grace: the panel asks again, and it stays.
    e.switchedOff();
    vi.advanceTimersByTime(cpe.STOP_GRACE_MS / 2);
    await e.route("status", null);
    vi.advanceTimersByTime(cpe.STOP_GRACE_MS * 2);
    expect([clients[1].closed, e.running]).toEqual([0, true]);
    // Shutdown: closed now, and stop() returns while close() is still pending.
    expect(e.stop()).toBeUndefined();
    expect([clients[1].closed, e.running]).toEqual([1, false]);
    // A switch-off with nothing running starts no timer.
    e.switchedOff();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes no client for a question that was asked as the deck stopped", async () => {
    let looked!: () => void;
    const createClient = vi.fn(() => fakeClient());
    const e = cpe.commandPanelEngine({ platform: "linux", env: {}, keys: ["K"], lstat: () => new Promise<void>(r => { looked = r; }), createClient });
    const asked = e.route("launch", {});
    await vi.waitFor(() => expect(looked).toBeTypeOf("function"));
    e.stop();
    looked();
    expect((await asked).body.code).toBe("restarting");
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("the engine's environment and keys", () => {
  it("drops an inherited opt-in, in any case, and sets exactly 1 only for terminal: true", () => {
    const shell = { PATH: "/usr/bin", [TERMINAL_OPT_IN]: "1", ccdeck_engine_terminal: "1", Ccdeck_Engine_Terminal: "true" };
    expect(TERMINAL_OPT_IN).toBe("CCDECK_ENGINE_TERMINAL");
    expect(engineEnv(shell, false)).toEqual({ PATH: "/usr/bin" });
    for (const not of [undefined, "1", 1, "yes"]) expect(engineEnv(shell, not), String(not)).toEqual({ PATH: "/usr/bin" });
    expect(engineEnv(shell, true)).toEqual({ PATH: "/usr/bin", CCDECK_ENGINE_TERMINAL: "1" });
    expect(engineEnv({ CCDECK_ENGINE_TERMINAL: "0" }, true)).toEqual({ CCDECK_ENGINE_TERMINAL: "1" });
    expect(shell[TERMINAL_OPT_IN], "the deck's own is left as it was").toBe("1");
  });

  it("is the opt-in the host contract names, and each refusal the page reads is in its table at the status the deck sends", () => {
    const contract = readFileSync(new URL("../../../docs/contracts/pro-engine-host-v1.md", import.meta.url), "utf8");
    const optIn = contract.slice(contract.indexOf("## Terminal opt-in"), contract.indexOf("## Terminal routes"));
    expect(optIn.length, "a section of its own, before the routes").toBeGreaterThan(200);
    expect(optIn).toContain(`\`${TERMINAL_OPT_IN}\` set to\nexactly \`1\``);
    expect(optIn).toMatch(/not authentication material/);
    expect(optIn).toMatch(/the protocol stays 1/);
    for (const code of [...PANEL_UNAVAILABLE, ...PANEL_RECOVERING]) {
      const { status, body } = engineRefusal(code);
      expect(body.code, code).toBe(code);
      expect(contract, code).toContain(`| \`${code}\` | ${status} |`);
    }
  });

  it("verifies nothing against an empty key list, before reading anything", async () => {
    const seen = await reads(DIR, () => expect(verifyEngineInstallation({ directory: ENGINE_DIR, publicKey: [] })).rejects.toThrow("could not be verified"));
    expect(seen).toEqual([]);
  });

  it("reaches no network from any module the panel's engine is made of", () => {
    for (const file of ["command-panel-engine.mjs", "pro-engine-client.mjs", "pro-engine-install.mjs", "pro-engine-terminal.mjs"]) {
      const source = readFileSync(new URL(`../../server/${file}`, import.meta.url), "utf8");
      expect(source.match(/from ["']node:(?:net|http|https|http2|dns|tls|dgram)["']/g), file).toBeNull();
      expect(source.match(/\bfetch\(|\bimport\(/g), file).toBeNull();
    }
  });
});

describe("a deck's Command Panel engine, by its switch", () => {
  let server: Server;
  let port = 0;
  let on = false;
  beforeAll(async () => {
    server = await mod.startServer({ port: 0, persist: false, claude: false, codex: false, terminal: { enabled: () => on } });
    port = (server.address() as { port: number }).port;
  }, 30_000);
  afterAll(async () => {
    await new Promise(r => server.close(r));
    rmTempDir(DIR);
  });

  const ask = (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => new Promise((resolve_, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => { let parsed: any = null; try { parsed = JSON.parse(raw); } catch { /* not JSON */ } resolve_({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on("error", reject);
    req.end(payload);
  });
  const ROUTES: Array<[string, string, unknown?]> = [
    ["GET", "/api/terminal/status"],
    ["GET", "/api/terminal/target?session=0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f&provider=claude"],
    ["POST", "/api/terminal/launch", { agent: "claude", cwd: DIR }],
    ["POST", "/api/terminal/open", { sessionId: "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f", provider: "claude", cwd: DIR }],
  ];

  it("off, whatever the shell exported: every route a 404, and the install folder never looked at", async () => {
    on = false;
    expect(process.env.CCDECK_ENGINE_TERMINAL).toBe("1");
    const seen = await reads(join(DIR, "deck"), async () => {
      for (const [method, path, body] of ROUTES) expect((await ask(method, path, body)).status, path).toBe(404);
    });
    expect(seen.filter(s => s.includes(ENGINE_DIR))).toEqual([]);
    expect(made.clients).toEqual([]);
  });

  it("on, with no engine installed: not-installed on Linux and macOS, unsupported elsewhere, and no client", async () => {
    on = true;
    const supported = process.platform === "linux" || process.platform === "darwin";
    const seen = await reads(join(DIR, "deck"), async () => {
      for (const [method, path, body] of ROUTES) {
        const got = await ask(method, path, body);
        expect([got.status, got.body?.code], path).toEqual([409, supported ? "not-installed" : "unsupported"]);
      }
    });
    const looked = seen.filter(s => s.includes(ENGINE_DIR));
    if (supported) expect(looked).toEqual(ROUTES.map(() => `lstat ${ENGINE_DIR}`));
    else expect(looked).toEqual([]);
    expect(made.clients).toEqual([]);
    on = false;
  });

  it("reports the switch going off in Settings, so the engine stops once its panels have closed", async () => {
    const before = made.switchedOff;
    expect((await ask("POST", "/api/prefs", { terminal: true })).status).toBe(200);
    expect(made.switchedOff).toBe(before);
    expect((await ask("POST", "/api/prefs", { terminal: false })).status).toBe(200);
    expect(made.switchedOff).toBe(before + 1);
    // Off and off again is no switch-off.
    expect((await ask("POST", "/api/prefs", { terminal: false })).status).toBe(200);
    expect(made.switchedOff).toBe(before + 1);
  });

  it("is stopped beside closeAllTerminals at shutdown, never awaited", () => {
    expect(mod.stopCommandPanelEngine()).toBeUndefined();
    const deck = readFileSync(new URL("../../../bin/deck.js", import.meta.url), "utf8");
    const shutdown = deck.slice(deck.indexOf('closeAllTerminals("server-shutdown")'));
    expect(shutdown.slice(0, 200)).toMatch(/^closeAllTerminals\("server-shutdown"\); \} catch \{[^}]*\}\n\s*try \{ stopCommandPanelEngine\(\); \} catch/);
    expect(deck).not.toMatch(/await\s+stopCommandPanelEngine/);
  });
});
