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

const made = vi.hoisted(() => ({ clients: [] as unknown[], switchedOff: 0, switchedOn: 0, routes: [] as string[] }));
vi.mock("../../server/pro-engine-client.mjs", async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, createProEngineClient: (options: unknown) => { made.clients.push(options); return real.createProEngineClient(options); } };
});
vi.mock("../../server/command-panel-engine.mjs", async (importOriginal) => {
  const real: any = await importOriginal();
  const panel = real.commandPanelEngine();
  const commandPanel = Object.freeze({
    get enabled() { return panel.enabled; },
    route: (method: string, body: unknown) => { made.routes.push(method); return panel.route(method, body); },
    attach: (handle: string, socket: unknown) => panel.attach(handle, socket),
    switchedOff: () => { made.switchedOff += 1; panel.switchedOff(); },
    switchedOn: () => { made.switchedOn += 1; panel.switchedOn?.(); },
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
// @ts-expect-error — plain .mjs server module, no types
const { createTicketStore } = await import("../../server/terminal-socket.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { TERMINAL_TURNED_OFF } = await import("../../server/prefs-routes.mjs");
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

/** A client as createProEngineClient makes one, answering every route `answer`. Its close() answers once the
 *  engine's process has exited, as the real one's does: at once, or when `exit` settles. */
function fakeClient(answer: unknown = { status: 200, body: { ok: true } }, { exit }: { exit?: Promise<void> } = {}) {
  const client = {
    enabled: true, running: false, closed: 0,
    capabilities: { terminal: { backend: "tmux" } },
    start: async () => { client.running = true; },
    request: async (..._args: unknown[]): Promise<unknown> => answer,
    close: () => { client.closed += 1; client.running = false; return exit ?? Promise.resolve(); },
  };
  return client;
}
/** Under fake timers: `ms` of time, with every promise that settles on the way let run. */
const pass = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const HANDLE = "ab".repeat(32);

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

  it("stops an engine whose client was being made when the switch went off, and makes none once the grace is out", async () => {
    const clients: ReturnType<typeof fakeClient>[] = [];
    const createClient = vi.fn(() => { const c = fakeClient(); clients.push(c); return c; });
    let looked!: () => void;
    const lstat = () => new Promise<void>(r => { looked = r; });
    // The folder looked at, the switch goes off, then the client is made: the question was asked while on and
    // is answered, and the engine it started stops a grace after the switch-off, as one already running does.
    const e = cpe.commandPanelEngine({ platform: "linux", env: {}, keys: ["K"], lstat, createClient });
    const asked = e.route("status", null);
    await vi.waitFor(() => expect(looked).toBeTypeOf("function"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    e.switchedOff();
    looked();
    expect((await asked).status).toBe(200);
    expect([clients.length, e.running]).toEqual([1, true]);
    vi.advanceTimersByTime(cpe.STOP_GRACE_MS - 1);
    expect(clients[0].closed, "the panels are still closing").toBe(0);
    vi.advanceTimersByTime(1);
    expect([clients[0].closed, e.running]).toEqual([1, false]);
    vi.useRealTimers();
    // The folder still being looked at when the grace runs out: no client is made after it.
    looked = undefined as unknown as () => void;
    const late = e.route("launch", {});
    await vi.waitFor(() => expect(looked).toBeTypeOf("function"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    e.switchedOff();
    vi.advanceTimersByTime(cpe.STOP_GRACE_MS);
    looked();
    expect((await late).body.code).toBe("restarting");
    expect([createClient.mock.calls.length, e.running]).toEqual([1, false]);
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

  it("never stops the engine under a question it is answering: the stop waits for the answer, then follows", async () => {
    let answer!: (a: unknown) => void;
    const client = fakeClient();
    client.request = () => new Promise(r => { answer = r; });
    const e = cpe.commandPanelEngine({ platform: "linux", env: {}, keys: ["K"], lstat: async () => ({}), createClient: () => client });
    // A launch asked while on, inside the engine (its tmux still starting the session) when the switch goes off.
    const launch = e.route("launch", { agent: "claude", cwd: "/p", key: "k-in-flight" });
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    e.switchedOff();
    await pass(cpe.STOP_GRACE_MS * 4);
    expect([client.closed, e.running], "stopped under the launch it was running").toEqual([0, true]);
    // The engine answers: the session is made and labelled with its key, and the route has its answer.
    const started = { status: 200, body: { ok: true, sessionId: "s", name: "ccdeck-claude-1", ticket: null }, handle: HANDLE };
    answer(started);
    expect(await launch).toEqual(started);
    await pass();
    expect([client.closed, e.running], "stopped once it had answered").toEqual([1, false]);
  });

  it("stops it once a question it was answering has failed, as one does at the client's deadline", async () => {
    let failIt!: (e: unknown) => void;
    const client = fakeClient();
    client.request = () => new Promise((_, reject) => { failIt = reject; });
    const e = cpe.commandPanelEngine({ platform: "linux", env: {}, keys: ["K"], lstat: async () => ({}), createClient: () => client });
    const launch = e.route("launch", { agent: "claude", key: "k-deadline" });
    launch.catch(() => {});
    await vi.waitFor(() => expect(failIt).toBeTypeOf("function"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    e.switchedOff();
    await pass(cpe.STOP_GRACE_MS);
    expect(client.closed, "still answering").toBe(0);
    failIt(fail("timeout"));
    // A mutation that went unanswered is the deck's 500 and is never asked again (routeThroughEngine).
    await expect(launch).rejects.toMatchObject({ code: "timeout" });
    await pass();
    expect([client.closed, e.running]).toEqual([1, false]);
  });

  it("keeps the engine when the switch goes back on before its stop has begun, with or without a question", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = fakeClient();
    const e = cpe.commandPanelEngine({ platform: "linux", env: {}, keys: ["K"], lstat: async () => ({}), createClient: () => client });
    await e.route("status", null);
    // Back on inside the grace, and the page asks nothing: the stop is called off by the switch itself.
    e.switchedOff();
    await pass(cpe.STOP_GRACE_MS - 1);
    e.switchedOn?.();
    await pass(cpe.STOP_GRACE_MS * 4);
    expect([client.closed, e.running], "stopped with the switch back on").toEqual([0, true]);
    // Back on while the stop waits for a question to be answered: called off there too.
    let answer!: (a: unknown) => void;
    client.request = () => new Promise(r => { answer = r; });
    const launch = e.route("launch", { agent: "claude", key: "k-on-again" });
    await pass();
    e.switchedOff();
    await pass(cpe.STOP_GRACE_MS);
    e.switchedOn?.();
    answer({ status: 200, body: { ok: true, sessionId: "s", name: "n", ticket: null }, handle: HANDLE });
    expect((await launch).status).toBe(200);
    await pass(cpe.STOP_GRACE_MS * 4);
    expect([client.closed, e.running], "stopped with the switch back on, once the launch was answered").toEqual([0, true]);
    // Off again: stopped a grace later, as ever.
    e.switchedOff();
    await pass(cpe.STOP_GRACE_MS);
    expect([client.closed, e.running]).toEqual([1, false]);
  });

  it("starts no engine beside one that is stopping: the next question waits for it to exit, a bounded time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const exits: Array<() => void> = [];
    const clients: ReturnType<typeof fakeClient>[] = [];
    const createClient = vi.fn(() => {
      let exit!: () => void;
      const c = fakeClient(undefined, { exit: new Promise<void>(r => { exit = r; }) });
      exits.push(exit);
      clients.push(c);
      return c;
    });
    const e = cpe.commandPanelEngine({ platform: "linux", env: {}, keys: ["K"], lstat: async () => ({}), createClient });
    await e.route("status", null);
    e.switchedOff();
    await pass(cpe.STOP_GRACE_MS);
    expect(clients[0].closed, "its stop has begun").toBe(1);
    // On again, and the page asks at once, while the first engine is still on its way out.
    e.switchedOn?.();
    let answered: { status: number; body: { code?: string } } | null = null;
    void e.route("status", null).then(a => { answered = a; });
    await pass(1);
    expect(createClient, "a second engine started beside the one stopping").toHaveBeenCalledTimes(1);
    expect(answered).toBeNull();
    exits[0]();
    await pass();
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(answered!.status).toBe(200);
    // One that does not exit in time: the question is answered `restarting` (the page waits that out), and
    // still no second engine is started.
    e.switchedOff();
    await pass(cpe.STOP_GRACE_MS);
    expect(clients[1].closed).toBe(1);
    answered = null;
    void e.route("status", null).then(a => { answered = a; });
    await pass(cpe.EXIT_WAIT_MS - 1);
    expect(answered, "answered before the wait was out").toBeNull();
    await pass(1);
    expect([answered!.status, answered!.body.code]).toEqual([503, "restarting"]);
    expect(createClient).toHaveBeenCalledTimes(2);
    // Once it has exited, the next question starts the next engine.
    exits[1]();
    await pass();
    expect((await e.route("status", null)).status).toBe(200);
    expect(createClient).toHaveBeenCalledTimes(3);
  });

  it("over ten toggles (back on inside the grace, as the stop begins, and after the engine has gone) runs one engine at a time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // An engine is alive from its start until its process has exited, which takes EXIT_MS after its close.
    const EXIT_MS = 40;
    let alive = 0;
    let peak = 0;
    const createClient = vi.fn(() => {
      const c = fakeClient();
      let up = false;
      c.start = async () => { c.running = true; if (!up) { up = true; alive += 1; peak = Math.max(peak, alive); } };
      c.close = () => { c.closed += 1; c.running = false; return new Promise<void>(r => setTimeout(() => { if (up) { up = false; alive -= 1; } r(); }, EXIT_MS)); };
      return c;
    });
    const e = cpe.commandPanelEngine({ platform: "linux", env: {}, keys: ["K"], lstat: async () => ({}), createClient });
    await e.route("status", null);
    const kinds = ["inside the grace", "as the stop begins", "after it has gone"];
    const offFor = [cpe.STOP_GRACE_MS / 2, cpe.STOP_GRACE_MS + EXIT_MS / 2, cpe.STOP_GRACE_MS + EXIT_MS * 2];
    for (let i = 0; i < 10; i++) {
      // The deck: the switch in Settings tells the engine (prefs-routes.mjs), and the page asks once it is on.
      e.switchedOff();
      await pass(offFor[i % 3]);
      e.switchedOn?.();
      const asked = e.route("status", null);
      await pass(EXIT_MS * 2);
      expect((await asked).status, `cycle ${i}, back on ${kinds[i % 3]}`).toBe(200);
    }
    expect(peak, "two engines at once").toBe(1);
    expect(alive).toBe(1);
    // Back on inside the grace keeps the engine; the other six cycles each start one after the last has gone.
    expect(createClient).toHaveBeenCalledTimes(1 + 6);
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

describe("a question the engine answers after the switch went off", () => {
  // A deck handed an engine whose every answer the test gives, once the switch has gone off under the
  // question: the moment a launch asked while on is inside the engine when the switch goes off, and the engine
  // (which is stopped only once it has answered) answers it.
  let server: Server;
  let port = 0;
  let on = true;
  const pending: Array<{ method: string; answer: (a: unknown) => void }> = [];
  const asked: string[] = [];
  const engine = {
    get enabled() { return true; },
    attach: async () => ({ ok: false, status: 503 }),
    route: (method: string) => { asked.push(method); return new Promise(r => { pending.push({ method, answer: r }); }); },
  };
  const tickets = createTicketStore();
  beforeAll(async () => {
    server = await mod.startServer({ port: 0, persist: false, claude: false, codex: false, terminal: { enabled: () => on, engine, tickets } });
    port = (server.address() as { port: number }).port;
  }, 30_000);
  afterAll(async () => { await new Promise(r => server.close(r)); });

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
  const SID = "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
  const ref = { sessionId: SID, provider: "claude", cwd: DIR };
  const target = { kind: "A", label: "Running in a deck pane." };
  /** Asked while on; the switch goes off while the engine works on it; then the engine answers `said`. */
  async function offWhileAnswering(method: string, path: string, body: unknown, said: unknown) {
    on = true;
    const minted = tickets.size;
    const got = ask(method, path, body);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    on = false;
    pending.shift()!.answer(said);
    const r = await got;
    return { ...r, ticketsMinted: tickets.size - minted };
  }

  it("says what a launch, an adopt, an open or a claim did, mints no ticket, and is a 409 the page shows", async () => {
    const started = "The session was started, but the Command Panel was turned off in Settings. Switch it on to open the session.";
    const cases: Array<[string, string, unknown, unknown, string]> = [
      ["launch", "/api/terminal/launch", { agent: "claude", cwd: DIR, key: "k-1" }, { status: 200, body: { ok: true, sessionId: SID, name: "ccdeck-claude-1", ticket: null }, handle: HANDLE }, started],
      ["adopt", "/api/terminal/adopt", ref, { status: 200, body: { ok: true, ticket: null, target }, handle: HANDLE }, started],
      ["open", "/api/terminal/open", ref, { status: 200, body: { ok: true, ticket: null, target }, handle: HANDLE }, TERMINAL_TURNED_OFF],
      ["claim", "/api/terminal/claim", { key: "k-1", ...ref }, { status: 200, body: { ok: true, claimed: true, target } }, TERMINAL_TURNED_OFF],
    ];
    for (const [name, path, body, said, sentence] of cases) {
      const r = await offWhileAnswering("POST", path, body, said);
      expect([r.status, r.body, r.ticketsMinted], name).toEqual([409, { ok: false, error: sentence, code: "turned-off" }, 0]);
    }
    expect(asked.splice(0)).toEqual(["launch", "adopt", "open", "claim"]);
  });

  it("answers anything else the engine said after the switch-off as the no-route 404 a request after it gets", async () => {
    const cases: Array<[string, string, unknown, unknown]> = [
      ["GET", "/api/terminal/status", undefined, { status: 200, body: { ok: true, platform: "linux", tmux: { ok: true } } }],
      ["GET", `/api/terminal/target?session=${SID}&provider=claude`, undefined, { status: 200, body: { ok: true, target } }],
      ["POST", "/api/terminal/launch", { agent: "claude", cwd: DIR, key: "k-2" }, engineRefusal("busy")],
      ["POST", "/api/terminal/adopt", ref, { status: 409, body: { ok: false, error: "still-running" } }],
      ["POST", "/api/terminal/open", ref, { status: 200, body: { ok: false, target } }],
      ["POST", "/api/terminal/claim", { key: "k-2", ...ref }, { status: 200, body: { ok: true, claimed: false, target } }],
    ];
    for (const [method, path, body, said] of cases) {
      const r = await offWhileAnswering(method, path, body, said);
      expect([r.status, r.body, r.ticketsMinted], path).toEqual([404, { error: "not found" }, 0]);
    }
    asked.splice(0);
  });

  it("says an end of an older host's sessions that went through was done, and answers the hosts read and a refused end as the 404", async () => {
    const order = { generation: 1, sessions: ["a".repeat(32)] };
    const ended = await offWhileAnswering("POST", "/api/terminal/hosts/end", order, { status: 200, body: { ok: true, ended: 1 } });
    const sentence = "The sessions were ended, but the Command Panel was turned off in Settings.";
    expect([ended.status, ended.body, ended.ticketsMinted]).toEqual([409, { ok: false, error: sentence, code: "turned-off" }, 0]);
    const listed = { status: 200, body: { ok: true, hosts: [], launchesRefused: null } };
    expect((await offWhileAnswering("GET", "/api/terminal/hosts", undefined, listed)).status, "a read changed nothing").toBe(404);
    const outdated = { status: 409, body: { ok: false, error: "The sessions on that session host changed. Review them again.", code: "consent-outdated" } };
    expect((await offWhileAnswering("POST", "/api/terminal/hosts/end", order, outdated)).status, "nothing was ended").toBe(404);
    expect(asked.splice(0)).toEqual(["endHosts", "hosts", "endHosts"]);
  });

  it("answers as the engine said while the switch stays on, the ticket minted over its handle", async () => {
    on = true;
    const minted = tickets.size;
    const got = ask("POST", "/api/terminal/launch", { agent: "claude", cwd: DIR, key: "k-3" });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()!.answer({ status: 200, body: { ok: true, sessionId: SID, name: "ccdeck-claude-3", ticket: null }, handle: HANDLE });
    const r = await got;
    expect([r.status, r.body.ok, typeof r.body.ticket, tickets.size - minted]).toEqual([200, true, "string", 1]);
    asked.splice(0);
  });
});

describe("a deck's Command Panel engine, by its switch", () => {
  let server: Server;
  let port = 0;
  let on = false;
  // How many more looks at the switch see it on before it goes off by itself: the moment a switch-off lands
  // between a route's own look and its answer, without a race to win.
  let looksLeft = Infinity;
  const look = () => {
    const was = on;
    if (on && --looksLeft <= 0) on = false;
    return was;
  };
  beforeAll(async () => {
    server = await mod.startServer({ port: 0, persist: false, claude: false, codex: false, terminal: { enabled: look } });
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

  it("answers a request whose body was still arriving when the switch went off as one that came after: a 404, and the engine is never asked", async () => {
    const sid = "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
    const posts: Array<[string, unknown]> = [
      ["/api/terminal/launch", { agent: "claude", cwd: DIR, key: "k-late-1" }],
      ["/api/terminal/open", { sessionId: sid, provider: "claude", cwd: DIR }],
      ["/api/terminal/adopt", { sessionId: sid, provider: "claude", cwd: DIR }],
      ["/api/terminal/claim", { key: "k-late-1", sessionId: sid, provider: "claude", cwd: DIR }],
    ];
    for (const [path, body] of posts) {
      // The upgrade's look, ahead of every request, then the route's own: on for both, off from then on, while
      // the body is read.
      on = true;
      looksLeft = 2;
      const asked = made.routes.length;
      const got = await ask("POST", path, body);
      const wentOff = !on;
      on = false;
      looksLeft = Infinity;
      expect(wentOff, `${path}: the switch went off during the request`).toBe(true);
      expect([got.status, got.body], path).toEqual([404, { error: "not found" }]);
      expect(made.routes.slice(asked), `${path}: nothing reached the engine`).toEqual([]);
    }
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

  it("reports the switch going back on, so a stop that has not begun is called off", async () => {
    expect((await ask("POST", "/api/prefs", { terminal: false })).status).toBe(200);
    const [offs, ons] = [made.switchedOff, made.switchedOn];
    expect((await ask("POST", "/api/prefs", { terminal: true })).status).toBe(200);
    expect([made.switchedOff, made.switchedOn]).toEqual([offs, ons + 1]);
    // On and on again is no switch-on.
    expect((await ask("POST", "/api/prefs", { terminal: true })).status).toBe(200);
    expect(made.switchedOn).toBe(ons + 1);
    expect((await ask("POST", "/api/prefs", { terminal: false })).status).toBe(200);
    expect([made.switchedOff, made.switchedOn]).toEqual([offs + 1, ons + 1]);
  });

  it("is stopped beside closeAllTerminals at shutdown, never awaited", () => {
    expect(mod.stopCommandPanelEngine()).toBeUndefined();
    const deck = readFileSync(new URL("../../../bin/deck.js", import.meta.url), "utf8");
    const shutdown = deck.slice(deck.indexOf('closeAllTerminals("server-shutdown")'));
    expect(shutdown.slice(0, 200)).toMatch(/^closeAllTerminals\("server-shutdown"\); \} catch \{[^}]*\}\n\s*try \{ stopCommandPanelEngine\(\); \} catch/);
    expect(deck).not.toMatch(/await\s+stopCommandPanelEngine/);
  });
});
