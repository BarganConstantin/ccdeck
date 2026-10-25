// The Windows Command Panel preview: TEST-ONLY, never a production feature.
//
// On Windows the Command Panel is unsupported, and stays so for everything
// this package ships: the deck's own engine answers every route `unsupported`
// without looking, its installation check knows no Windows target, and
// Settings does not offer the switch. The one exception is a local test
// configuration for one Windows VM, and these cases pin what it takes and what
// it can never reach:
//
//   - the gate (command-panel-platform.mjs) turns the switch on only on win32,
//     only for a startServer caller that passes `terminal.windowsPreview ===
//     true` WITH an explicit engine, and only when it can load the test-only
//     module preview/command-panel-windows.mjs. Off Windows it is the
//     platform's answer and loads nothing, whatever it is handed;
//   - no production entry can ask for it: no file in bin, hook, desktop or
//     src/server but the gate says `windowsPreview`, and the one startServer
//     call they make passes no `terminal` at all;
//   - the published package and the desktop app leave the module out, so on
//     an install the gate refuses whatever it is asked;
//   - the deck's own verifier still refuses a Windows engine, with its own
//     (empty) keys, with a fresh key, and with the key that signed it;
//   - the preview's verifier, run here with the platform injected, accepts a
//     signed Windows installation and refuses everything else, and its client
//     is the deck's own client with that check in place of the deck's.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// startServer's one call to the gate, recorded on its way through, so "the
// deck asks it with its own option" is a fact about this run.
const asked = vi.hoisted(() => [] as Array<{ terminal: unknown; answer: unknown }>);
vi.mock("../../server/command-panel-platform.mjs", async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    commandPanelPlatform: async (terminal: unknown, at?: unknown) => {
      const answer = await real.commandPanelPlatform(terminal, at);
      asked.push({ terminal, answer });
      return answer;
    },
  };
});

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-cp-windows-preview-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.XDG_STATE_HOME = join(DIR, "state");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "claude-swap");
process.env.AGENTS_DECK_NO_LAN = "1";
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// The gate itself, not the recording wrapper above.
const gate: any = await vi.importActual("../../server/command-panel-platform.mjs");
// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { createTicketStore } = await import("../../server/terminal-socket.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { commandPanelSupported, ENGINE_PUBLIC_KEYS } = await import("../../server/command-panel-engine.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { handlePrefsRead } = await import("../../server/prefs-routes.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { createProEngineClient, ProEngineClient } = await import("../../server/pro-engine-client.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { verifyEngineInstallation } = await import("../../server/pro-engine-install.mjs");
// @ts-expect-error — plain .mjs test-only module, no types
const preview = await import("../../../preview/command-panel-windows.mjs");

/** An engine's terminal as engineTerminals shapes one, asked nothing here. */
const stubEngine = () => ({ get enabled() { return false; }, attach: () => ({ ok: false, status: 503 }), route: () => null });
const NOT_WIN32 = ["linux", "darwin", "freebsd", "sunos", "aix"];

// ── installations, signed with a fresh key ─────────────────────────────────

const pem = (key: KeyObject) => key.export({ type: "spki", format: "pem" }) as string;
let installs = 0;
/** A Windows engine installation in a folder of its own: the engine's bytes
 *  under `engineName`, and a manifest naming `entry` (its defaults are this
 *  engine's true values), signed by `signer`. */
function windowsInstall({ bytes = Buffer.from("MZ stand-in engine bytes"), engineName = "ccdeck-pro-engine-0.1.0.exe", entry = {}, manifest = {}, signer = generateKeyPairSync("ed25519") }: {
  bytes?: Buffer; engineName?: string; entry?: Record<string, unknown>; manifest?: Record<string, unknown>; signer?: { privateKey: KeyObject; publicKey: KeyObject };
} = {}) {
  const directory = join(DIR, `install-${++installs}`);
  mkdirSync(directory);
  writeFileSync(join(directory, engineName), bytes, { mode: 0o700 });
  const named = { file: engineName, protocol: 1, target: "x86_64-pc-windows-msvc", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, version: "0.1.0", ...entry };
  const payload = Buffer.from(JSON.stringify(named));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, signer.privateKey).toString("base64"), ...manifest }), { mode: 0o600 });
  return { directory, publicKey: pem(signer.publicKey), signer, entry: named, executable: join(directory, engineName) };
}
const WIN_X64 = { platform: "win32", arch: "x64" };
const REFUSED = "The installed terminal engine could not be verified.";
const NOT_HERE = "The Windows Command Panel preview runs on Windows only.";

/** `process.platform` reads `platform` for the duration of `fn`'s synchronous part. */
function withPlatform<T>(platform: string, fn: () => T): T {
  const own = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...own, value: platform });
  try { return fn(); } finally { Object.defineProperty(process, "platform", own); }
}

// ── the deck ──────────────────────────────────────────────────────────────

const terminal = { enabled: () => false, engine: stubEngine(), tickets: createTicketStore(), windowsPreview: true };
let server: Server;
let port = 0;
const logged: string[] = [];
beforeAll(async () => {
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  try {
    server = await mod.startServer({ port: 0, persist: false, claude: false, codex: false, terminal });
  } finally { spy.mockRestore(); }
  port = (server.address() as { port: number }).port;
}, 30_000);
afterAll(async () => {
  await new Promise(r => server.close(r));
  rmTempDir(DIR);
});

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    req.on("error", fail);
    req.end();
  });
}

describe("the Command Panel's platform gate", () => {
  it("off Windows is the platform's answer, and loads and logs nothing, whatever it is handed", async () => {
    let loads = 0;
    const lines: string[] = [];
    for (const platform of NOT_WIN32) {
      for (const handed of [undefined, {}, { windowsPreview: true }, { windowsPreview: true, engine: stubEngine() }]) {
        const answer = await gate.commandPanelPlatform(handed, { platform, load: async () => { loads += 1; return { WINDOWS_PREVIEW: true }; }, log: (l: string) => lines.push(l) });
        expect(answer, `${platform} ${JSON.stringify(handed)}`).toEqual({ supported: commandPanelSupported(platform), windowsPreview: false });
        expect(Object.isFrozen(answer)).toBe(true);
      }
    }
    expect(commandPanelSupported("linux") && commandPanelSupported("darwin") && !commandPanelSupported("freebsd")).toBe(true);
    expect([loads, lines]).toEqual([0, []]);
  });

  it("on Windows, without `windowsPreview === true`, is unsupported, and loads and logs nothing", async () => {
    let loads = 0;
    const lines: string[] = [];
    for (const handed of [undefined, null, {}, { engine: stubEngine() }, { windowsPreview: "true", engine: stubEngine() }, { windowsPreview: 1, engine: stubEngine() }, { windowsPreview: {}, engine: stubEngine() }]) {
      const answer = await gate.commandPanelPlatform(handed, { platform: "win32", load: async () => { loads += 1; return { WINDOWS_PREVIEW: true }; }, log: (l: string) => lines.push(l) });
      expect(answer, JSON.stringify(handed)).toEqual({ supported: false, windowsPreview: false });
    }
    expect([loads, lines]).toEqual([0, []]);
  });

  it("on Windows, asked without an explicit engine, refuses before loading anything and says so once per ask", async () => {
    let loads = 0;
    const lines: string[] = [];
    const engines = [undefined, null, "engine", {}, { route: () => null }, { attach: () => null }, { route: 1, attach: () => null }];
    for (const engine of engines) {
      const answer = await gate.commandPanelPlatform({ windowsPreview: true, engine }, { platform: "win32", load: async () => { loads += 1; return { WINDOWS_PREVIEW: true }; }, log: (l: string) => lines.push(l) });
      expect(answer).toEqual({ supported: false, windowsPreview: false });
    }
    expect(loads).toBe(0);
    expect(lines).toEqual(engines.map(() => gate.WINDOWS_PREVIEW_REFUSED["no-engine"]));
  });

  it("on Windows, asked with an engine, is supported only when the test-only module loads and is the preview", async () => {
    const cases: Array<[string, () => Promise<unknown>, object, string | null]> = [
      ["absent", async () => { throw Object.assign(new Error("Cannot find module"), { code: "ERR_MODULE_NOT_FOUND" }); }, { supported: false, windowsPreview: false }, gate.WINDOWS_PREVIEW_REFUSED.absent],
      ["empty", async () => ({}), { supported: false, windowsPreview: false }, gate.WINDOWS_PREVIEW_REFUSED["not-preview"]],
      ["string", async () => ({ WINDOWS_PREVIEW: "true" }), { supported: false, windowsPreview: false }, gate.WINDOWS_PREVIEW_REFUSED["not-preview"]],
      ["nothing", async () => undefined, { supported: false, windowsPreview: false }, gate.WINDOWS_PREVIEW_REFUSED["not-preview"]],
      ["preview", async () => ({ WINDOWS_PREVIEW: true }), { supported: true, windowsPreview: true }, null],
    ];
    for (const [name, load, expected, line] of cases) {
      const urls: string[] = [];
      const lines: string[] = [];
      const answer = await gate.commandPanelPlatform({ windowsPreview: true, engine: stubEngine() }, { platform: "win32", load: (url: URL) => { urls.push(url.href); return load(); }, log: (l: string) => lines.push(l) });
      expect(answer, name).toEqual(expected);
      expect(urls, name).toEqual([gate.WINDOWS_PREVIEW_MODULE.href]);
      expect(lines, name).toEqual(line ? [line] : []);
    }
  });

  it("looks for the module in preview/ beside the package's src, finds it in a checkout, and logs no path", async () => {
    expect(fileURLToPath(gate.WINDOWS_PREVIEW_MODULE)).toBe(join(REPO, "preview", "command-panel-windows.mjs"));
    // The one import the gate makes, by that literal name, and no other.
    const imports = readFileSync(join(REPO, "src", "server", "command-panel-platform.mjs"), "utf8").match(/import\(([^)]*)\)/g);
    expect(imports).toEqual(['import("../../preview/command-panel-windows.mjs")']);
    expect(new URL("../../preview/command-panel-windows.mjs", new URL("../../server/command-panel-platform.mjs", import.meta.url)).href).toBe(gate.WINDOWS_PREVIEW_MODULE.href);
    expect(preview.WINDOWS_PREVIEW).toBe(true);
    // The deck's own import, not an injected one: in this checkout the module is there.
    const lines: string[] = [];
    expect(await gate.commandPanelPlatform({ windowsPreview: true, engine: stubEngine() }, { platform: "win32", log: (l: string) => lines.push(l) })).toEqual({ supported: true, windowsPreview: true });
    expect(lines).toEqual([]);
    for (const line of Object.values(gate.WINDOWS_PREVIEW_REFUSED) as string[]) {
      expect(line).toMatch(/^the Windows Command Panel preview was asked for/);
      expect(line).toContain("the Command Panel is unavailable on this platform.");
      expect(line).not.toMatch(/[\\/]/);
    }
  });
});

describe("a deck handed the preview option", () => {
  it("asks the gate once, with its own `terminal` option, and Settings follows the answer", async () => {
    expect(asked).toHaveLength(1);
    expect(asked[0].terminal).toBe(terminal);
    const onWindows = process.platform === "win32";
    // In a checkout on Windows the module is there, so the preview holds; on
    // every other platform the option is ignored and the platform answers.
    expect(asked[0].answer).toEqual(onWindows ? { supported: true, windowsPreview: true } : { supported: commandPanelSupported(), windowsPreview: false });
    const prefs = await get("/api/prefs");
    expect(prefs.status).toBe(200);
    expect(prefs.body.terminalSupported).toBe(onWindows ? true : commandPanelSupported());
    expect(logged.filter(line => /preview/i.test(line))).toEqual([]);
  });

  it("answers /api/prefs from startServer's answer when it has one, and from the platform when not", () => {
    const read = (panel: unknown) => {
      let body = "";
      const res = { headersSent: false, writeHead: () => {}, end: (b: string) => { body = b; } };
      handlePrefsRead({}, res, panel);
      return JSON.parse(body).terminalSupported;
    };
    expect(read({ supported: false, windowsPreview: false })).toBe(false);
    expect(read({ supported: true, windowsPreview: true })).toBe(true);
    expect(read({ supported: "yes" })).toBe(false);
    expect(read(undefined)).toBe(commandPanelSupported());
  });
});

describe("no production entry can ask for the preview", () => {
  /** Source files under `dir`, without node_modules and build output. */
  const sources = (dir: string) => readdirSync(join(REPO, dir), { recursive: true }).map(String)
    .filter(f => /\.(?:m?js|cjs|ts|tsx)$/.test(f) && !/(?:^|[\\/])(?:node_modules|dist|__tests__)(?:[\\/]|$)/.test(f))
    .map(f => join(dir, f).split("\\").join("/"));
  const ENTRIES = ["bin", "hook", "desktop", "src/server", "src/web"];

  it("says `windowsPreview` and names the module only in the gate", () => {
    const files = ENTRIES.flatMap(sources);
    expect(files.length, "the scan sees the entries").toBeGreaterThan(100);
    const saying = (pattern: RegExp) => files.filter(f => pattern.test(readFileSync(join(REPO, f), "utf8"))).sort();
    expect(saying(/windowsPreview/)).toEqual(["src/server/command-panel-platform.mjs"]);
    expect(saying(/command-panel-windows/)).toEqual(["src/server/command-panel-platform.mjs"]);
    expect(saying(/WINDOWS_PREVIEW\b/)).toEqual(["src/server/command-panel-platform.mjs"]);
  });

  it("passes startServer no `terminal` from bin or the desktop app", () => {
    const calls: string[] = [];
    for (const file of ["bin", "desktop"].flatMap(sources)) {
      const source = readFileSync(join(REPO, file), "utf8");
      for (let at = source.indexOf("startServer("); at !== -1; at = source.indexOf("startServer(", at + 1)) {
        let depth = 0, end = at + "startServer".length;
        for (; end < source.length; end++) {
          if (source[end] === "(") depth++;
          else if (source[end] === ")" && --depth === 0) break;
        }
        calls.push(`${file}: ${source.slice(at, end + 1)}`);
      }
    }
    expect(calls.map(call => call.split(":")[0])).toEqual(["bin/deck.js"]);
    expect(calls[0]).not.toMatch(/\bterminal\b/);
  });

  it("reads no environment variable to decide, in the gate or the preview", () => {
    for (const file of ["src/server/command-panel-platform.mjs", "preview/command-panel-windows.mjs"]) {
      expect(readFileSync(join(REPO, file), "utf8"), file).not.toMatch(/process\.env|process\.argv|readFile|fetch\(/);
    }
  });
});

describe("the published package and the desktop app", () => {
  /** npm by the path the running npm gave, as tarball-install-smoke.test.ts does. */
  function npm(args: string[]) {
    const cli = process.env.npm_execpath;
    return cli
      ? spawnSync(process.execPath, [cli, ...args], { cwd: REPO, encoding: "utf8", timeout: 60_000 })
      : spawnSync("npm", args, { cwd: REPO, encoding: "utf8", timeout: 60_000, shell: process.platform === "win32" });
  }

  it("leave preview/ out, so on an install the gate refuses whatever it is asked", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.files.filter((f: string) => /preview/.test(f))).toEqual([]);
    const packed = npm(["pack", "--dry-run", "--json", "--ignore-scripts"]);
    expect(packed.status, packed.stderr).toBe(0);
    const paths: string[] = JSON.parse(packed.stdout)[0].files.map((f: { path: string }) => f.path.split("\\").join("/"));
    expect(paths).toContain("src/server/command-panel-platform.mjs");
    expect(paths).toContain("src/server/pro-engine-client.mjs");
    expect(paths.filter(p => /^preview\//.test(p) || /command-panel-windows/.test(p))).toEqual([]);
    const windowsWords = paths.filter(p => {
      const text = readFileSync(join(REPO, p), "latin1");
      return /x86_64-pc-windows-msvc|aarch64-pc-windows-msvc|verifyWindowsPreviewInstallation|createWindowsPreviewClient/.test(text);
    });
    expect(windowsWords, "no packed file knows a Windows engine target").toEqual([]);
    // The desktop app copies the deck's folders one by one; preview is not one.
    const config = createRequire(import.meta.url)(join(REPO, "desktop", "electron-builder.config.cjs"));
    const copied = [...config.extraResources.map((r: { from: string }) => r.from), ...config.files];
    expect(copied.filter((f: string) => /preview/.test(f))).toEqual([]);
    expect(config.extraResources.map((r: { from: string }) => r.from)).toContain("../src/server");
  }, 90_000);
});

describe("the deck's own verifier, asked about a Windows engine", () => {
  it("refuses it with the deck's keys, with a fresh key and with the key that signed it, on Windows and here", async () => {
    expect(ENGINE_PUBLIC_KEYS).toEqual([]);
    expect(Object.isFrozen(ENGINE_PUBLIC_KEYS)).toBe(true);
    const install = windowsInstall();
    const other = pem(generateKeyPairSync("ed25519").publicKey);
    for (const publicKey of [ENGINE_PUBLIC_KEYS, other, install.publicKey, [other, install.publicKey]]) {
      await expect(withPlatform("win32", () => verifyEngineInstallation({ directory: install.directory, publicKey }))).rejects.toThrow(REFUSED);
      await expect(verifyEngineInstallation({ directory: install.directory, publicKey })).rejects.toThrow(REFUSED);
    }
    // And the same folder, signed for this platform under the name the deck
    // accepts, is not what makes it refuse: the preview's verifier accepts it
    // only as Windows, and the deck's only as its own platform's target.
    await expect(preview.verifyWindowsPreviewInstallation({ directory: install.directory, publicKey: install.publicKey }, WIN_X64)).resolves.toMatchObject({ digest: install.entry.sha256 });
  });
});

describe("the preview's verifier, with the platform injected", () => {
  it("accepts a signed Windows installation, by one key or a list, as the deck's verifier answers", async () => {
    const install = windowsInstall();
    const other = pem(generateKeyPairSync("ed25519").publicKey);
    for (const publicKey of [install.publicKey, [install.publicKey], [other, install.publicKey]]) {
      const got = await preview.verifyWindowsPreviewInstallation({ directory: install.directory, publicKey }, WIN_X64);
      expect(got).toEqual({ executable: join(realpathSync(install.directory), "ccdeck-pro-engine-0.1.0.exe"), digest: install.entry.sha256, target: "x86_64-pc-windows-msvc", version: "0.1.0" });
      expect(Object.isFrozen(got)).toBe(true);
    }
    const arm = windowsInstall({ engineName: "ccdeck-pro-engine.exe", entry: { target: "aarch64-pc-windows-msvc", version: "1.2.3-rc.1" } });
    await expect(preview.verifyWindowsPreviewInstallation(arm, { platform: "win32", arch: "arm64" })).resolves.toMatchObject({ target: "aarch64-pc-windows-msvc", version: "1.2.3-rc.1" });
    await expect(preview.verifyWindowsPreviewInstallation(arm, WIN_X64)).rejects.toThrow(REFUSED);
  });

  it("refuses off Windows, before reading anything", async () => {
    const install = windowsInstall();
    for (const platform of NOT_WIN32) {
      await expect(preview.verifyWindowsPreviewInstallation(install, { platform, arch: "x64" })).rejects.toThrow(NOT_HERE);
    }
    await expect(preview.verifyWindowsPreviewInstallation({ directory: join(DIR, "nowhere"), publicKey: install.publicKey }, { platform: "linux", arch: "x64" })).rejects.toThrow(NOT_HERE);
  });

  it("refuses everything else with one sentence", async () => {
    const good = windowsInstall();
    const x25519 = pem(generateKeyPairSync("x25519").publicKey);
    const refused: Array<[string, Record<string, unknown>, object?]> = [
      ["the deck's own keys", { ...good, publicKey: ENGINE_PUBLIC_KEYS }],
      ["no key", { ...good, publicKey: undefined }],
      ["a null key", { ...good, publicKey: null }],
      ["another key", { ...good, publicKey: pem(generateKeyPairSync("ed25519").publicKey) }],
      ["a key that is not Ed25519", { ...good, publicKey: [x25519, good.publicKey] }],
      ["no folder", { directory: join(DIR, "nowhere"), publicKey: good.publicKey }],
      ["an empty folder name", { directory: "", publicKey: good.publicKey }],
      ["an arch with no Windows target", good, { platform: "win32", arch: "ia32" }],
      ["a Linux target", windowsInstall({ entry: { target: "x86_64-unknown-linux-gnu" } })],
      ["a macOS target", windowsInstall({ entry: { target: "aarch64-apple-darwin" } })],
      ["a name without .exe", windowsInstall({ engineName: "ccdeck-pro-engine-0.1.0" })],
      ["another program's name", windowsInstall({ engineName: "cmd.exe" })],
      ["a name with a folder in it", windowsInstall({ entry: { file: "..\\ccdeck-pro-engine.exe" } })],
      ["a name with a slash in it", windowsInstall({ entry: { file: "sub/ccdeck-pro-engine.exe" } })],
      ["other bytes", windowsInstall({ entry: { sha256: "0".repeat(64) } })],
      ["another size", windowsInstall({ entry: { size: 3 } })],
      ["a field too many", windowsInstall({ entry: { args: ["--x"] } })],
      ["another protocol", windowsInstall({ entry: { protocol: 2 } })],
      ["a version that is not one", windowsInstall({ entry: { version: "1.0" } })],
      ["a manifest field too many", windowsInstall({ manifest: { key: "x" } })],
      ["an engine of no bytes", windowsInstall({ bytes: Buffer.alloc(0), entry: { size: 1 } })],
    ];
    for (const [name, options, at] of refused) {
      await expect(preview.verifyWindowsPreviewInstallation(options, at ?? WIN_X64), name).rejects.toThrow(REFUSED);
    }
    // Bytes changed after signing.
    const tampered = windowsInstall();
    writeFileSync(tampered.executable, "MZ other engine bytes!!");
    await expect(preview.verifyWindowsPreviewInstallation(tampered, WIN_X64), "tampered").rejects.toThrow(REFUSED);
    // The engine a folder rather than a file.
    const folder = windowsInstall({ engineName: "ccdeck-pro-engine-x.exe" });
    unlinkSync(folder.executable);
    mkdirSync(folder.executable);
    await expect(preview.verifyWindowsPreviewInstallation(folder, WIN_X64), "a folder").rejects.toThrow(REFUSED);
  });

  it("refuses an engine or a manifest that is a link", async () => {
    // A file link needs a privilege on Windows; everywhere else it is made.
    const made: boolean[] = [];
    const link = (target: string, at: string) => { try { symlinkSync(target, at, "file"); made.push(true); return true; } catch { made.push(false); return false; } };
    const real = windowsInstall();
    const viaEngine = windowsInstall({ bytes: readFileSync(real.executable), engineName: "ccdeck-pro-engine-l.exe" });
    unlinkSync(viaEngine.executable);
    if (link(real.executable, viaEngine.executable)) await expect(preview.verifyWindowsPreviewInstallation(viaEngine, WIN_X64), "engine link").rejects.toThrow(REFUSED);
    const viaManifest = { directory: join(DIR, `install-${++installs}`), publicKey: real.publicKey };
    mkdirSync(viaManifest.directory);
    writeFileSync(join(viaManifest.directory, "ccdeck-pro-engine-0.1.0.exe"), readFileSync(real.executable));
    if (link(join(real.directory, "manifest.json"), join(viaManifest.directory, "manifest.json"))) await expect(preview.verifyWindowsPreviewInstallation(viaManifest, WIN_X64), "manifest link").rejects.toThrow(REFUSED);
    expect(made.every(Boolean) || process.platform === "win32", "the links were made").toBe(true);
  });

  it("builds the deck's own client around it, on Windows only and with a key only", () => {
    const install = windowsInstall();
    expect(() => preview.createWindowsPreviewClient({ directory: install.directory, publicKey: install.publicKey }, { platform: "linux", arch: "x64" })).toThrow(NOT_HERE);
    expect(() => preview.createWindowsPreviewClient({ directory: install.directory }, WIN_X64)).toThrow(REFUSED);
    expect(() => preview.createWindowsPreviewClient({ directory: install.directory, publicKey: [] }, WIN_X64)).toThrow(REFUSED);
    const client = preview.createWindowsPreviewClient({ directory: install.directory, publicKey: install.publicKey, hostVersion: "9.9.9", terminal: true }, WIN_X64);
    expect(client).toBeInstanceOf(ProEngineClient);
    expect([client.enabled, client.running]).toEqual([true, false]);
    expect(client.options).toMatchObject({ enabled: true, directory: install.directory, publicKey: [install.publicKey], hostVersion: "9.9.9", terminal: true });
    // `terminal` and `enabled` are true only when said so.
    expect(preview.createWindowsPreviewClient({ directory: install.directory, publicKey: install.publicKey, terminal: "yes", enabled: 1 }, WIN_X64).options).toMatchObject({ enabled: false, terminal: false });
    const { client: again, engine } = preview.windowsPreviewEngine({ directory: install.directory, publicKey: install.publicKey }, WIN_X64);
    expect(again).toBeInstanceOf(ProEngineClient);
    expect([typeof engine.route, typeof engine.attach]).toEqual(["function", "function"]);
  });
});

// The double started as a Windows engine: a script with a shebang under an
// `.exe` name, which macOS and Linux run and Windows cannot (it is not a PE
// file). The same client on Windows is the lead's VM run, not this suite's.
describe.skipIf(process.platform === "win32")("the preview's client against a signed double answering as a Windows engine", () => {
  it("starts it through the preview's check and the deck's own handshake, and the deck's own client refuses the same folder", async () => {
    const source = readFileSync(new URL("./fixtures/pro-engine-peer.cjs", import.meta.url), "utf8")
      .replace("const TERMINAL_BACKEND = 'unavailable';", "const TERMINAL_BACKEND = 'conpty';")
      .replace(/target: \(\{darwin:[^`]+`[^`]+`/, "target: 'x86_64-pc-windows-msvc'");
    expect(source).toContain("const TERMINAL_BACKEND = 'conpty';");
    expect(source).toContain("target: 'x86_64-pc-windows-msvc'");
    const install = windowsInstall({ bytes: Buffer.from(`#!${process.execPath}\n${source}`) });
    // A new executable's first exec is slow on macOS; run it once, untimed
    // (pro-engine-routes.test.ts says why). Stdin closed, the double exits 0.
    await new Promise<void>((done, fail) => {
      const child = spawn(install.executable, [], { stdio: "ignore" });
      child.on("error", fail);
      child.on("exit", (code, signal) => code === 0 ? done() : fail(new Error(`the double ended with ${code ?? signal}`)));
    });
    const client = preview.createWindowsPreviewClient({ directory: install.directory, publicKey: install.publicKey, hostVersion: "0.0.0" }, WIN_X64);
    try {
      const caps = await client.start();
      expect([caps.target, caps.buildDigest, caps.engineVersion, caps.terminal.backend]).toEqual(["x86_64-pc-windows-msvc", install.entry.sha256, "0.1.0", "conpty"]);
      expect(client.running).toBe(true);
    } finally { await client.close(); }
    const deckOwn = createProEngineClient({ enabled: true, directory: install.directory, publicKey: install.publicKey });
    try {
      await expect(deckOwn.start()).rejects.toThrow(REFUSED);
    } finally { await deckOwn.close(); }
  }, 30_000);
});
