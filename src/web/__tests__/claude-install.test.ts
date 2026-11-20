// Install Claude Code from the deck (claude-install.mjs): the official script,
// downloaded over https under a deadline and a cap into a 0600 file inside a
// fresh 0700 folder, run as an argument vector, never logged, and counted done
// only when the deck's own resolver then finds `claude`.
//
// Nothing here reaches the network or runs a script: the download is a stand-in
// `fetch`, the installer a stand-in `spawn` that prints what a test tells it to
// and exits with the code it is given.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const install = await import("../../server/claude-install.mjs");
// @ts-expect-error — plain .mjs module, no types
const { GUARDED_READS, OPEN_MUTATIONS, isAuthorizedMutation } = await import("../../server/request-gates.mjs");

const {
  CLAUDE_INSTALL_ROUTE, INSTALL_SCRIPTS, INSTALL_SCRIPT_MAX, claudeInstallCommand, createClaudeInstaller, deckFindsClaude,
  handleClaudeInstallStart, handleClaudeInstallStatus, installerArgv, outputTail,
} = install;

const SCRATCH = mkdtempSync(join(tmpdir(), "ccdeck-claude-install-test-"));
afterAll(() => rmTempDir(SCRATCH));
afterEach(() => vi.restoreAllMocks());

const SCRIPT = "#!/bin/bash\necho installing\n";
const HOME = "/home/alice";

/** A download that answers `body` with `status`. */
const fetchOf = (body: string | Uint8Array = SCRIPT, init: { status?: number; url?: string; headers?: Record<string, string> } = {}) =>
  vi.fn(async () => {
    const res = new Response(body, { status: init.status ?? 200, headers: init.headers });
    if (init.url) Object.defineProperty(res, "url", { value: init.url });
    return res;
  });

interface Ran { file: string; args: string[]; opts: Record<string, unknown>; script: string; fileMode: number; dirMode: number; dir: string }

/** An installer that prints `output` and exits `code` (null: never exits until killed). */
function spawnOf({ output = "", code = 0 as number | null, fail = false } = {}) {
  const ran: Ran[] = [];
  const spawnImpl = vi.fn((file: string, args: string[], opts: Record<string, unknown>) => {
    if (fail) throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const script = args.at(-1)!;
    ran.push({
      file, args, opts, script: readFileSync(script, "utf8"),
      fileMode: statSync(script).mode & 0o777, dirMode: statSync(String(opts.cwd)).mode & 0o777, dir: String(opts.cwd),
    });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { setTimeout(() => child.emit("close", null, "SIGKILL"), 0); return true; },
    });
    setTimeout(() => {
      if (output) child.stdout.write(output);
      if (code !== null) setTimeout(() => child.emit("close", code), 0);
    }, 0);
    return child;
  });
  return { spawnImpl, ran };
}

function installer(over: Record<string, unknown> = {}) {
  return createClaudeInstaller({
    platform: "linux", env: {}, home: () => HOME, tmp: () => SCRATCH,
    fetchImpl: fetchOf(), exists: () => true, found: () => true, ...over,
  });
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
const leftovers = () => readdirSync(SCRATCH).filter(n => n.startsWith("ccdeck-claude-install-"));

describe("an install", () => {
  it("downloads the official script over https, runs it as a 0600 file in a 0700 folder, and is done when the deck finds claude", async () => {
    const fetchImpl = fetchOf();
    const { spawnImpl, ran } = spawnOf({ output: "Claude Code installed\n" });
    const i = installer({ fetchImpl, spawnImpl });
    expect(i.status().state).toBe("idle");
    const started = i.start();
    expect(started).toMatchObject({ ok: true });
    expect(i.status()).toMatchObject({ state: "running", id: started.id });
    await i.settled();
    expect(i.status()).toMatchObject({ state: "done", id: started.id });
    expect(i.status().reason).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe("https://claude.ai/install.sh");
    expect(ran).toHaveLength(1);
    // An argument vector, the script by its path: never a shell string.
    expect(ran[0].file).toMatch(/(^|\/)bash$/);
    expect(ran[0].args).toEqual([join(ran[0].dir, "install.sh")]);
    expect(ran[0].opts.shell).toBe(false);
    expect(ran[0].script).toBe(SCRIPT);
    expect(ran[0].fileMode).toBe(0o600);
    expect(ran[0].dirMode).toBe(0o700);
    // And the folder is gone afterwards.
    expect(existsSync(ran[0].dir)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("downloads the PowerShell script on Windows and runs it with Windows PowerShell by its full path", async () => {
    const fetchImpl = fetchOf("Write-Output 'hi'\n");
    const { spawnImpl, ran } = spawnOf();
    const i = installer({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, fetchImpl, spawnImpl });
    i.start();
    await i.settled();
    expect(i.status().state).toBe("done");
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe("https://claude.ai/install.ps1");
    expect(ran[0].file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(ran[0].args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
    expect(ran[0].args.at(-1)).toMatch(/install\.ps1$/);
    expect(leftovers()).toEqual([]);
  });

  it("fails as a download when the script cannot be fetched, and runs nothing", async () => {
    for (const fetchImpl of [
      vi.fn(async () => { throw new TypeError("fetch failed"); }),
      fetchOf("not found", { status: 404 }),
      fetchOf(SCRIPT, { url: "http://claude.ai/install.sh" }),
      fetchOf("<!DOCTYPE html><html><body>sign in</body></html>"),
      fetchOf(""),
      fetchOf(SCRIPT, { headers: { "content-length": String(INSTALL_SCRIPT_MAX + 1) } }),
      fetchOf(new Uint8Array(INSTALL_SCRIPT_MAX + 1).fill(0x23)),
    ]) {
      const { spawnImpl } = spawnOf();
      const i = installer({ fetchImpl, spawnImpl });
      i.start();
      await i.settled();
      expect(i.status()).toMatchObject({ state: "failed", reason: "download-failed" });
      expect(spawnImpl).not.toHaveBeenCalled();
      expect(leftovers()).toEqual([]);
    }
  });

  it("fails with the installer's last lines when it exits non-zero, the home folder as ~ and no escapes", async () => {
    const lines = Array.from({ length: 8 }, (_, k) => `line ${k + 1}`);
    const output = `${lines.join("\n")}\n\x1b[31mError: could not write ${HOME}/.local/bin/claude\x1b[0m\r\n`;
    const { spawnImpl } = spawnOf({ output, code: 1 });
    const i = installer({ spawnImpl });
    i.start();
    await i.settled();
    const s = i.status();
    expect(s).toMatchObject({ state: "failed", reason: "exit-failed" });
    expect(s.detail).toBe(["line 5", "line 6", "line 7", "line 8", "Error: could not write ~/.local/bin/claude"].join("\n"));
    expect(s.detail).not.toContain(HOME);
    expect(leftovers()).toEqual([]);
  });

  it("fails as installed but not found when the installer exits 0 and the deck still finds no claude", async () => {
    const found = vi.fn(() => false);
    const { spawnImpl } = spawnOf();
    const i = installer({ spawnImpl, found });
    i.start();
    await i.settled();
    expect(i.status()).toMatchObject({ state: "failed", reason: "installed-but-not-found" });
    expect(found).toHaveBeenCalled();
  });

  it("fails as not started when the installer cannot be spawned", async () => {
    const { spawnImpl } = spawnOf({ fail: true });
    const i = installer({ spawnImpl });
    i.start();
    await i.settled();
    expect(i.status()).toMatchObject({ state: "failed", reason: "start-failed" });
    expect(leftovers()).toEqual([]);
  });

  it("stops an installer that runs past its deadline", async () => {
    const { spawnImpl } = spawnOf({ code: null, output: "Downloading…\n" });
    const i = installer({ spawnImpl, installTimeoutMs: 30 });
    i.start();
    await i.settled();
    expect(i.status()).toMatchObject({ state: "failed", reason: "timed-out", detail: "Downloading…" });
    expect(leftovers()).toEqual([]);
  });

  it("logs neither the script nor anything it printed", async () => {
    const said = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    const { spawnImpl } = spawnOf({ output: "secret-ish output\n", code: 2 });
    const i = installer({ spawnImpl });
    i.start();
    await i.settled();
    for (const spy of said) expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a download where the deck may not download, and offers the command instead", () => {
    for (const env of [{ AGENTS_DECK_NO_INSTALL: "1" }, { AGENTS_DECK_NO_DOWNLOAD: "1" }]) {
      const { spawnImpl } = spawnOf();
      const fetchImpl = fetchOf();
      const i = installer({ env, spawnImpl, fetchImpl });
      expect(i.status()).toMatchObject({ state: "idle", blocked: "download-disabled", command: claudeInstallCommand("linux") });
      expect(i.start()).toEqual({ ok: false, code: "download-disabled" });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});

describe("the manual command", () => {
  it("is the one Anthropic's setup page recommends for the deck's platform", () => {
    expect(claudeInstallCommand("darwin")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(claudeInstallCommand("linux")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(claudeInstallCommand("win32")).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(INSTALL_SCRIPTS).toEqual({ posix: "https://claude.ai/install.sh", win32: "https://claude.ai/install.ps1" });
    expect(installer({ platform: "win32" }).status()).toMatchObject({ command: "irm https://claude.ai/install.ps1 | iex", shell: "powershell" });
    expect(installer({ platform: "darwin" }).status()).toMatchObject({ shell: "terminal" });
  });

  it("runs bash by its path when the machine has one, and asks PATH only when it does not", () => {
    expect(installerArgv("linux", "/t/install.sh", { exists: (p: string) => p === "/bin/bash" })).toEqual({ file: "/bin/bash", args: ["/t/install.sh"] });
    expect(installerArgv("linux", "/t/install.sh", { exists: () => false })).toEqual({ file: "bash", args: ["/t/install.sh"] });
  });
});

describe("the output a failure shows", () => {
  it("keeps the last five lines, reads a progress line's carriage returns as its last state, and writes home as ~ on Windows in any case", () => {
    expect(outputTail("a\nb\n\n\nc\nd\ne\nf\ng\n", { home: HOME, platform: "linux" })).toBe("c\nd\ne\nf\ng");
    expect(outputTail("10%\r50%\r100%\ndone\n", { home: HOME, platform: "linux" })).toBe("100%\ndone");
    expect(outputTail("Installed to C:\\Users\\Alice\\.local\\bin", { home: "C:\\Users\\alice", platform: "win32" })).toBe("Installed to ~\\.local\\bin");
    expect(outputTail("\x1b]8;;https://x\x07link\x1b]8;;\x07 \x00bell\x07", { home: HOME, platform: "linux" })).toBe("link bell");
  });
});

describe("whether the deck finds claude afterwards", () => {
  it("asks the deck's own resolver: the native installer's path, or PATH", () => {
    expect(deckFindsClaude({ platform: "linux", env: { PATH: "/usr/bin" }, home: HOME, exists: (p: string) => p === `${HOME}/.local/bin/claude` })).toBe(true);
    expect(deckFindsClaude({ platform: "linux", env: { PATH: "/opt/x" }, home: HOME, exists: (p: string) => p === "/opt/x/claude" })).toBe(true);
    expect(deckFindsClaude({ platform: "linux", env: { PATH: "/usr/bin" }, home: HOME, exists: () => false })).toBe(false);
    expect(deckFindsClaude({ platform: "win32", env: { Path: "C:\\Windows" }, home: "C:\\Users\\alice", exists: (p: string) => p === "C:\\Users\\alice\\.local\\bin\\claude.exe" })).toBe(true);
  });
});

describe("the routes", () => {
  it("answer the status, start one, and refuse a second start while it runs", async () => {
    const { spawnImpl } = spawnOf();
    const i = installer({ spawnImpl });
    const a = fakeRes();
    await handleClaudeInstallStatus(fakeReq(), a, { installer: i });
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body)).toEqual({ ok: true, state: "idle", command: claudeInstallCommand("linux"), shell: "terminal" });

    const b = fakeRes();
    await handleClaudeInstallStart(fakeReq(), b, { installer: i });
    expect(b.status).toBe(200);
    const { id } = JSON.parse(b.body);
    expect(id).toMatch(/^[0-9a-f]{16}$/);

    const c = fakeRes();
    await handleClaudeInstallStart(fakeReq(), c, { installer: i });
    expect([c.status, JSON.parse(c.body)]).toEqual([409, { ok: false, code: "running" }]);

    await i.settled();
    const d = fakeRes();
    await handleClaudeInstallStatus(fakeReq(), d, { installer: i });
    expect(JSON.parse(d.body)).toMatchObject({ ok: true, state: "done", id });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("stand behind the deck's gates: the status a guarded read, the start a mutation that needs the deck's page or token", () => {
    expect(CLAUDE_INSTALL_ROUTE).toBe("/api/claude-install");
    expect(GUARDED_READS.has(CLAUDE_INSTALL_ROUTE)).toBe(true);
    expect(OPEN_MUTATIONS.has(CLAUDE_INSTALL_ROUTE)).toBe(false);
    // A paired deck's browser, a page on another site, and a local process with nothing to show.
    expect(isAuthorizedMutation({ headers: { host: "192.168.1.20:4317", origin: "http://192.168.1.20:4317", "sec-fetch-site": "same-origin" } })).toBe(false);
    expect(isAuthorizedMutation({ headers: { host: "127.0.0.1:4317", origin: "https://example.com", "sec-fetch-site": "cross-site" } })).toBe(false);
    expect(isAuthorizedMutation({ headers: {} })).toBe(false);
    expect(isAuthorizedMutation({ headers: { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317", "sec-fetch-site": "same-origin" } })).toBe(true);
  });

  it("are routed beside the engine's install, behind the same gates", () => {
    const index = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    const engine = index.indexOf('url.pathname.startsWith("/api/terminal/engine/")');
    const get = index.indexOf('url.pathname === "/api/claude-install") return guard(handleClaudeInstallStatus');
    const post = index.indexOf('url.pathname === "/api/claude-install") return guard(handleClaudeInstallStart');
    const gate = index.indexOf("!isAuthorizedMutation(req)");
    expect(engine).toBeGreaterThan(0);
    expect(get).toBeGreaterThan(engine);
    expect(post).toBeGreaterThan(engine);
    expect(gate, "the gates run before the routing table").toBeLessThan(engine);
  });
});
