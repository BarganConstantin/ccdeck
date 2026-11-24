// Install Codex from the deck (codex-install.mjs): `npm install -g @openai/codex`
// with the npm that came with the deck's Node, or the one on PATH, or the one
// the login shell's PATH has; npm.cmd by its full path through cmd.exe on
// Windows; counted done only when the deck's own lookup then finds `codex`,
// after asking npm's global prefix where it put it when PATH does not say.
//
// Nothing here runs npm, Codex or a shell: every spawn is a stand-in that
// prints what a test tells it to and exits with the code it is given, and
// the disk is a set of paths a test holds.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

// @ts-expect-error — plain .mjs module, no types
const install = await import("../../server/codex-install.mjs");
// @ts-expect-error — plain .mjs module, no types
const { GUARDED_READS, OPEN_MUTATIONS } = await import("../../server/request-gates.mjs");

const {
  CODEX_INSTALL_ROUTE, addToDeckPath, codexInPrefix, codexInstallCommand, createCodexInstaller,
  handleCodexInstallStart, handleCodexInstallStatus, npmArgv, prefixOf,
} = install;

afterEach(() => vi.restoreAllMocks());

const NPM_LINE = "npm install -g @openai/codex";
const HOME = "/home/alice";
const NODE = "/opt/node/bin/node";
/** The npm-cli.js that came with NODE, the first place npmCliLaunch looks. */
const NPM_CLI = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";
const GLOBAL = "/home/alice/.npm-global";

interface Ran { file: string; args: string[]; opts: Record<string, unknown> }
interface Plan { code?: number | null; output?: string; installs?: string }

/**
 * npm, as a stand-in: `install` for `npm install -g …` (it prints `output`,
 * puts `installs` on the disk, and exits `code`; null never exits until
 * killed), `prefix` for `npm prefix -g`. `fail`: cannot be spawned at all.
 */
function npmOf(disk: Set<string>, { install = {} as Plan, prefix = { output: `${GLOBAL}\n` } as Plan, fail = false } = {}) {
  const ran: Ran[] = [];
  const spawnImpl = vi.fn((file: string, args: string[], opts: Record<string, unknown>) => {
    ran.push({ file, args, opts });
    if (fail) throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const plan = args.join(" ").includes("prefix") ? prefix : install;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { setTimeout(() => child.emit("close", null, "SIGKILL"), 0); return true; },
    });
    setTimeout(() => {
      if (plan.output) child.stdout.write(plan.output);
      if (plan.installs) disk.add(plan.installs);
      const code = plan.code === undefined ? 0 : plan.code;
      if (code !== null) setTimeout(() => child.emit("close", code), 0);
    }, 0);
    return child;
  });
  return { spawnImpl, ran };
}

/** A Linux deck whose Node came with npm, and whose PATH is `path`. */
function linux(disk: Set<string>, over: Record<string, unknown> = {}, path = "/usr/bin:/bin") {
  const env: Record<string, string> = { PATH: path };
  const adopt = vi.fn(async () => ({ added: 0 }));
  const renewEngine = vi.fn(async () => true);
  const i = createCodexInstaller({
    platform: "linux", env, home: () => HOME, execPath: NODE,
    exists: (p: string) => disk.has(p), adopt, renewEngine, ...over,
  });
  return { i, env, adopt, renewEngine };
}

/** A response that records what was sent. */
function fakeRes() {
  const res = {
    headersSent: false, status: 0, body: "" as string,
    writeHead(status: number) { res.status = status; res.headersSent = true; return res; },
    end(body?: string) { res.body = body ?? ""; },
  };
  return res;
}
const fakeReq = (body = "{}") => { const req = new PassThrough(); req.end(body); return req; };

describe("an install", () => {
  it("runs `npm install -g @openai/codex` with the npm that came with the deck's Node, and is done when the deck finds codex", async () => {
    const disk = new Set([NPM_CLI]);
    const { spawnImpl, ran } = npmOf(disk, { install: { installs: "/opt/tools/bin/codex" } });
    const { i, adopt } = linux(disk, { spawnImpl }, "/usr/bin:/opt/tools/bin");
    expect(i.status()).toEqual({ state: "idle", command: NPM_LINE, shell: "terminal" });
    const started = i.start();
    expect(started).toMatchObject({ ok: true });
    expect(i.status()).toMatchObject({ state: "running", id: started.id });
    await i.settled();
    expect(i.status()).toMatchObject({ state: "done", id: started.id });
    expect(i.status().reason).toBeUndefined();
    // An argument vector: that Node, npm's own script, npm's words. No shell.
    expect(ran).toHaveLength(1);
    expect(ran[0].file).toBe(NODE);
    expect(ran[0].args).toEqual([NPM_CLI, "install", "-g", "@openai/codex"]);
    expect(ran[0].opts).toMatchObject({ shell: false, cwd: HOME, detached: true });
    // Found at once: npm's prefix is never asked, and no login shell is.
    expect(adopt).not.toHaveBeenCalled();
  });

  it("takes npm from PATH when the deck's Node came without one", async () => {
    const disk = new Set(["/usr/local/node/bin/npm"]);
    const { spawnImpl, ran } = npmOf(disk, { install: { installs: "/usr/local/node/bin/codex" } });
    const { i } = linux(disk, { spawnImpl }, "/usr/bin:/usr/local/node/bin");
    i.start();
    await i.settled();
    expect(i.status().state).toBe("done");
    expect(ran[0]).toMatchObject({ file: "/usr/local/node/bin/npm", args: ["install", "-g", "@openai/codex"] });
  });

  it("asks the login shell's PATH for npm when the deck finds none, and runs that one", async () => {
    const NVM = "/home/alice/.nvm/versions/node/v24.1.0/bin";
    const disk = new Set([`${NVM}/npm`]);
    const { spawnImpl, ran } = npmOf(disk, { install: { installs: `${NVM}/codex` } });
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    const adopt = vi.fn(async () => { env.PATH = `/usr/bin:/bin:${NVM}`; return { added: 1 }; });
    const i = createCodexInstaller({ platform: "darwin", env, home: () => HOME, execPath: "/Applications/ccdeck.app/Contents/MacOS/ccdeck", exists: (p: string) => disk.has(p), adopt, spawnImpl });
    i.start();
    await i.settled();
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(ran[0]).toMatchObject({ file: `${NVM}/npm`, args: ["install", "-g", "@openai/codex"] });
    // The merged PATH is what npm runs with, so its `env node` finds a node.
    expect((ran[0].opts.env as Record<string, string>).PATH).toContain(NVM);
    expect(i.status().state).toBe("done");
  });

  it("fails as npm-missing when no npm is anywhere, runs nothing, and still offers the command", async () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      const disk = new Set<string>();
      const { spawnImpl } = npmOf(disk);
      const adopt = vi.fn(async () => ({ added: 0 }));
      const i = createCodexInstaller({
        platform, env: { PATH: "/usr/bin", Path: "C:\\Windows" }, home: () => HOME,
        execPath: platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : NODE,
        exists: (p: string) => disk.has(p), adopt, spawnImpl,
      });
      i.start();
      await i.settled();
      expect(i.status(), platform).toMatchObject({ state: "failed", reason: "npm-missing", command: NPM_LINE });
      expect(i.status().detail, platform).toBeUndefined();
      expect(adopt, platform).toHaveBeenCalledTimes(1);
      expect(spawnImpl, platform).not.toHaveBeenCalled();
    }
  });

  it("fails with npm's last lines when it exits non-zero, home written as ~, and asks nothing after", async () => {
    const disk = new Set([NPM_CLI]);
    const output = "npm error code EACCES\nnpm error path /usr/lib/node_modules\nnpm error A complete log is in /home/alice/.npm/_logs/x.log\n";
    const { spawnImpl, ran } = npmOf(disk, { install: { code: 243, output } });
    const { i } = linux(disk, { spawnImpl });
    i.start();
    await i.settled();
    expect(i.status()).toMatchObject({ state: "failed", reason: "exit-failed" });
    expect(i.status().detail).toBe("npm error code EACCES\nnpm error path /usr/lib/node_modules\nnpm error A complete log is in ~/.npm/_logs/x.log");
    expect(ran, "no prefix asked of an install that failed").toHaveLength(1);
  });

  it("stops npm at its deadline and fails as timed out", async () => {
    const disk = new Set([NPM_CLI]);
    const { spawnImpl } = npmOf(disk, { install: { code: null, output: "fetching\n" } });
    const { i } = linux(disk, { spawnImpl, installTimeoutMs: 30 });
    i.start();
    await i.settled();
    expect(i.status()).toMatchObject({ state: "failed", reason: "timed-out", detail: "fetching" });
  });

  it("fails as start-failed when npm cannot be started", async () => {
    const disk = new Set([NPM_CLI]);
    const { spawnImpl } = npmOf(disk, { fail: true });
    const { i } = linux(disk, { spawnImpl });
    i.start();
    await i.settled();
    expect(i.status()).toMatchObject({ state: "failed", reason: "start-failed" });
  });

  it("is off where downloads are, saying so, and starts nothing", () => {
    for (const env of [{ AGENTS_DECK_NO_INSTALL: "1" }, { AGENTS_DECK_NO_DOWNLOAD: "1" }]) {
      const disk = new Set([NPM_CLI]);
      const { spawnImpl } = npmOf(disk);
      const i = createCodexInstaller({ platform: "linux", env, home: () => HOME, execPath: NODE, exists: (p: string) => disk.has(p), spawnImpl });
      expect(i.status()).toMatchObject({ state: "idle", blocked: "download-disabled", command: NPM_LINE });
      expect(i.start()).toEqual({ ok: false, code: "download-disabled" });
      expect(spawnImpl).not.toHaveBeenCalled();
    }
  });
});

describe("finding codex after npm put it where PATH does not reach", () => {
  it("asks npm's global prefix, finds codex in its bin folder, and adds that folder to the end of the deck's PATH", async () => {
    const disk = new Set([NPM_CLI]);
    const { spawnImpl, ran } = npmOf(disk, { install: { installs: `${GLOBAL}/bin/codex` } });
    const { i, env } = linux(disk, { spawnImpl });
    i.start();
    await i.settled();
    expect(i.status()).toMatchObject({ state: "done" });
    expect(ran.map(r => r.args.slice(1))).toEqual([["install", "-g", "@openai/codex"], ["prefix", "-g"]]);
    // The same npm, asked as an argument vector.
    expect(ran[1]).toMatchObject({ file: NODE, args: [NPM_CLI, "prefix", "-g"] });
    expect(ran[1].opts).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "ignore"] });
    // After the deck's own folders, never before.
    expect(env.PATH).toBe(`/usr/bin:/bin:${GLOBAL}/bin`);
  });

  it("lets the terminal engine go once the folder is added, before saying done, so the pane it starts next finds codex", async () => {
    const disk = new Set([NPM_CLI]);
    const { spawnImpl } = npmOf(disk, { install: { installs: `${GLOBAL}/bin/codex` } });
    const seen: string[] = [];
    const { i, env, renewEngine } = linux(disk, { spawnImpl });
    renewEngine.mockImplementation(async () => { seen.push(`${i.status().state} ${env.PATH}`); return true; });
    i.start();
    await i.settled();
    expect(renewEngine).toHaveBeenCalledTimes(1);
    // Asked with the folder already on the deck's PATH, and while the card still says installing.
    expect(seen).toEqual([`running /usr/bin:/bin:${GLOBAL}/bin`]);
    expect(i.status()).toMatchObject({ state: "done" });
  });

  it("is done even when letting the engine go fails: the deck's own lookup finds codex", async () => {
    const disk = new Set([NPM_CLI]);
    const { spawnImpl } = npmOf(disk, { install: { installs: `${GLOBAL}/bin/codex` } });
    const { i, renewEngine } = linux(disk, { spawnImpl });
    renewEngine.mockImplementation(async () => { throw new Error("engine gone"); });
    i.start();
    await i.settled();
    expect(renewEngine).toHaveBeenCalledTimes(1);
    expect(i.status()).toMatchObject({ state: "done" });
  });

  it("leaves the engine alone when the deck's PATH did not change", async () => {
    // Found where the deck already looks right after npm, or npm's bin folder already on PATH,
    // or not found at all: the engine started with this PATH already.
    const cases = [
      { installs: "/usr/bin/codex", path: "/usr/bin:/bin", state: "done" },
      { installs: `${GLOBAL}/bin/codex`, path: `/usr/bin:/bin:${GLOBAL}/bin`, state: "done" },
      { installs: "/somewhere/else/codex", path: "/usr/bin:/bin", state: "failed" },
    ];
    for (const c of cases) {
      const disk = new Set([NPM_CLI]);
      const { spawnImpl } = npmOf(disk, { install: { installs: c.installs } });
      const { i, renewEngine } = linux(disk, { spawnImpl }, c.path);
      i.start();
      await i.settled();
      expect(i.status().state, c.installs).toBe(c.state);
      expect(renewEngine, c.installs).not.toHaveBeenCalled();
    }
  });

  it("says installed but not found when the prefix has no codex, and leaves PATH as it was", async () => {
    const disk = new Set([NPM_CLI]);
    const { spawnImpl } = npmOf(disk, { install: { installs: "/somewhere/else/codex" } });
    const { i, env } = linux(disk, { spawnImpl });
    i.start();
    await i.settled();
    expect(i.status()).toMatchObject({ state: "failed", reason: "installed-but-not-found" });
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("says installed but not found when npm cannot say where its prefix is", async () => {
    for (const prefix of [{ code: 1, output: "" }, { output: "not a path\n" }, { output: "" }, { code: null }]) {
      const disk = new Set([NPM_CLI]);
      const { spawnImpl } = npmOf(disk, { install: { installs: `${GLOBAL}/bin/codex` }, prefix });
      const { i, env } = linux(disk, { spawnImpl, prefixTimeoutMs: 30 });
      i.start();
      await i.settled();
      expect(i.status(), JSON.stringify(prefix)).toMatchObject({ state: "failed", reason: "installed-but-not-found" });
      expect(env.PATH).toBe("/usr/bin:/bin");
    }
  });
});

describe("on Windows", () => {
  const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
  const NPM_CMD = "C:\\Program Files\\nodejs\\npm.cmd";
  const ROAMING = "C:\\Users\\alice\\AppData\\Roaming\\npm";

  it("runs npm.cmd by its full path through cmd.exe, and finds codex.cmd in npm's prefix", async () => {
    const disk = new Set([NPM_CMD]);
    const { spawnImpl, ran } = npmOf(disk, { install: { installs: `${ROAMING}\\codex.cmd` }, prefix: { output: `${ROAMING}\r\n` } });
    const env: Record<string, string> = { Path: "C:\\Windows\\system32;C:\\Program Files\\nodejs", SystemRoot: "C:\\Windows" };
    const renewEngine = vi.fn(async () => true);
    const i = createCodexInstaller({
      platform: "win32", env, home: () => "C:\\Users\\alice", execPath: NODE_EXE,
      exists: (p: string) => disk.has(p), adopt: async () => ({ added: 0 }), spawnImpl, renewEngine,
    });
    expect(i.status()).toMatchObject({ command: NPM_LINE, shell: "terminal" });
    i.start();
    await i.settled();
    expect(i.status()).toMatchObject({ state: "done" });
    // cmd.exe, which a batch file needs, with npm.cmd's full path quoted into
    // its line, so the shim finds its own folder and never the deck's.
    expect(ran[0].file).toMatch(/cmd(\.exe)?$/i);
    expect(ran[0].args).toEqual(["/d", "/s", "/c", `""${NPM_CMD}" "install" "-g" "@openai/codex""`]);
    expect(ran[0].opts).toMatchObject({ windowsVerbatimArguments: true, shell: false, detached: false });
    expect(ran[1].args).toEqual(["/d", "/s", "/c", `""${NPM_CMD}" "prefix" "-g""`]);
    expect(ran[1].opts).toMatchObject({ windowsVerbatimArguments: true });
    expect(env.Path).toBe(`C:\\Windows\\system32;C:\\Program Files\\nodejs;${ROAMING}`);
    // The engine there, too, started with the old Path: let go so the next pane sees this one.
    expect(renewEngine).toHaveBeenCalledTimes(1);
  });

  it("takes npm.cmd from PATH when node.exe has none beside it, and never a bare name", () => {
    const onPath = "D:\\tools\\node\\npm.cmd";
    const argv = npmArgv(["install", "-g", "@openai/codex"], {
      platform: "win32", env: { Path: "C:\\Windows;D:\\tools\\node" }, execPath: NODE_EXE, exists: (p: string) => p === onPath,
    });
    expect(argv.args[3]).toBe(`""${onPath}" "install" "-g" "@openai/codex""`);
    expect(npmArgv(["install"], { platform: "win32", env: { Path: "C:\\Windows" }, execPath: NODE_EXE, exists: () => false })).toBeNull();
  });
});

describe("the pieces", () => {
  it("names OpenAI's command for every platform", () => {
    expect(codexInstallCommand()).toBe(NPM_LINE);
  });

  it("finds npm beside the deck's Node first, then on PATH, and nothing else", () => {
    const has = (...paths: string[]) => (p: string) => paths.includes(p);
    expect(npmArgv(["prefix", "-g"], { platform: "linux", env: { PATH: "/x" }, execPath: NODE, exists: has(NPM_CLI, "/x/npm") }))
      .toEqual({ file: NODE, args: [NPM_CLI, "prefix", "-g"], opts: {} });
    expect(npmArgv(["prefix", "-g"], { platform: "linux", env: { PATH: "/x" }, execPath: NODE, exists: has("/x/npm") }))
      .toEqual({ file: "/x/npm", args: ["prefix", "-g"], opts: {} });
    expect(npmArgv(["prefix", "-g"], { platform: "darwin", env: { PATH: "/x" }, execPath: NODE, exists: () => false })).toBeNull();
  });

  it("reads the prefix as one absolute path on npm's last line", () => {
    expect(prefixOf("/usr/local\n", "linux")).toBe("/usr/local");
    expect(prefixOf("npm warn something\n/home/alice/.npm-global\n", "linux")).toBe("/home/alice/.npm-global");
    expect(prefixOf("C:\\Users\\alice\\AppData\\Roaming\\npm\r\n", "win32")).toBe("C:\\Users\\alice\\AppData\\Roaming\\npm");
    expect(prefixOf("\\\\server\\share\\npm\r\n", "win32")).toBe("\\\\server\\share\\npm");
    for (const [text, platform] of [["", "linux"], ["relative/path", "linux"], ["C:\\npm", "linux"], ["/usr/local", "win32"], ["/a\x07b", "linux"]]) {
      expect(prefixOf(text, platform), JSON.stringify(text)).toBeNull();
    }
  });

  it("knows where npm puts a global command under a prefix", () => {
    expect(codexInPrefix("/usr/local", "darwin")).toEqual({ folder: "/usr/local/bin", bin: "/usr/local/bin/codex" });
    expect(codexInPrefix("C:\\Users\\alice\\AppData\\Roaming\\npm", "win32"))
      .toEqual({ folder: "C:\\Users\\alice\\AppData\\Roaming\\npm", bin: "C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd" });
  });

  it("adds a folder to the end of PATH once, never before the deck's own", () => {
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    expect(addToDeckPath(env, "/opt/g/bin", "linux")).toBe(true);
    expect(addToDeckPath(env, "/opt/g/bin/", "linux")).toBe(false);
    expect(env.PATH).toBe("/usr/bin:/bin:/opt/g/bin");
    const empty: Record<string, string> = {};
    expect(addToDeckPath(empty, "/opt/g/bin", "linux")).toBe(true);
    expect(empty.PATH).toBe("/opt/g/bin");
    // Windows: whatever the variable is spelled, folders compared without case or a last `\`.
    const win: Record<string, string> = { Path: "C:\\Windows;C:\\Users\\Alice\\AppData\\Roaming\\npm\\;" };
    expect(addToDeckPath(win, "c:\\users\\alice\\appdata\\roaming\\npm", "win32")).toBe(false);
    expect(addToDeckPath(win, "D:\\npm", "win32")).toBe(true);
    expect(win).toEqual({ Path: "C:\\Windows;C:\\Users\\Alice\\AppData\\Roaming\\npm\\;D:\\npm" });
  });
});

describe("the routes", () => {
  it("answer the status, start one, and refuse a second start while it runs", async () => {
    const disk = new Set([NPM_CLI]);
    const { spawnImpl } = npmOf(disk, { install: { installs: "/opt/tools/bin/codex" } });
    const { i } = linux(disk, { spawnImpl }, "/usr/bin:/opt/tools/bin");
    const a = fakeRes();
    await handleCodexInstallStatus(fakeReq(), a, { installer: i });
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body)).toEqual({ ok: true, state: "idle", command: NPM_LINE, shell: "terminal" });

    const b = fakeRes();
    await handleCodexInstallStart(fakeReq(), b, { installer: i });
    expect(b.status).toBe(200);
    const { id } = JSON.parse(b.body);
    expect(id).toMatch(/^[0-9a-f]{16}$/);

    const c = fakeRes();
    await handleCodexInstallStart(fakeReq(), c, { installer: i });
    expect([c.status, JSON.parse(c.body)]).toEqual([409, { ok: false, code: "running" }]);

    await i.settled();
    const d = fakeRes();
    await handleCodexInstallStatus(fakeReq(), d, { installer: i });
    expect(JSON.parse(d.body)).toMatchObject({ ok: true, state: "done", id });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("stand behind the deck's gates, as Claude Code's install does: the status a guarded read, the start a mutation", () => {
    expect(CODEX_INSTALL_ROUTE).toBe("/api/codex-install");
    expect(GUARDED_READS.has(CODEX_INSTALL_ROUTE)).toBe(true);
    expect(OPEN_MUTATIONS.has(CODEX_INSTALL_ROUTE)).toBe(false);
  });

  it("are routed beside Claude Code's install, behind the same gates", () => {
    const index = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    const claude = index.indexOf('url.pathname === "/api/claude-install") return guard(handleClaudeInstallStart');
    const get = index.indexOf('url.pathname === "/api/codex-install") return guard(handleCodexInstallStatus');
    const post = index.indexOf('url.pathname === "/api/codex-install") return guard(handleCodexInstallStart');
    const gate = index.indexOf("!isAuthorizedMutation(req)");
    expect(claude).toBeGreaterThan(0);
    expect(get).toBeGreaterThan(claude);
    expect(post).toBeGreaterThan(claude);
    expect(gate, "the gates run before the routing table").toBeLessThan(claude);
  });
});
