import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { windowsNpmCliVersion } from "../../../desktop/terminal-cli.mjs";
import { outdatedTerminalCli, TerminalCliWarningRow } from "../components/TerminalCliNotice";

const root = "C:\\Users\\tester\\AppData\\Roaming\\npm";
const shim = win32.join(root, "ccdeck.ps1");
const manifest = win32.join(root, "node_modules", "ccdeck", "package.json");

function detect({ path = root, shimAt = shim, manifestData = { name: "ccdeck", version: "3.26.1" }, files = [shimAt] }: {
  path?: string; shimAt?: string; manifestData?: unknown; files?: string[];
} = {}) {
  const exists = vi.fn((name: string) => files.includes(name));
  const read = vi.fn((name: string) => {
    if (name !== manifest) throw new Error("missing package manifest");
    return JSON.stringify(manifestData);
  });
  return { version: windowsNpmCliVersion({ env: { Path: path }, exists, read }), exists, read };
}

describe("Windows desktop detects only a verified npm CLI", () => {
  it("reads the first npm shim on Windows PATH, without executing it", () => {
    expect(detect().version).toBe("3.26.1");
    expect(detect({ files: [win32.join(root, "ccdeck.cmd")] }).version).toBe("3.26.1");
    expect(detect({ path: `"${root}";C:\\other` }).version).toBe("3.26.1");
    expect(windowsNpmCliVersion({ env: { PATH: root }, exists: name => name === shim, read: () => '{"name":"ccdeck","version":"3.26.1"}' })).toBe("3.26.1");
  });

  it("does not report a shadowed or unidentified CLI", () => {
    expect(detect({ files: [] }).version).toBeNull();
    expect(detect({ files: [win32.join(root, "ccdeck.exe"), shim] }).version).toBeNull();
    expect(detect({ manifestData: { name: "other-cli", version: "1.0.0" } }).version).toBeNull();
    expect(detect({ manifestData: { name: "ccdeck", version: "invalid" } }).version).toBeNull();
    expect(detect({ path: `C:\\custom;${root}`, files: [win32.join("C:\\custom", "ccdeck.cmd"), shim] }).version).toBeNull();
    expect(windowsNpmCliVersion({ env: {} })).toBeNull();
  });

  it("offers the explicit npm update only for a CLI older than the desktop", () => {
    expect(outdatedTerminalCli({ version: "3.26.1", desktopVersion: "3.48.1" })).toBe(true);
    expect(outdatedTerminalCli({ version: "3.48.1", desktopVersion: "3.48.1" })).toBe(false);
    expect(outdatedTerminalCli({ version: "3.50.0", desktopVersion: "3.48.1" })).toBe(false);
    expect(outdatedTerminalCli({ version: "unknown", desktopVersion: "3.48.1" })).toBe(false);
    expect(outdatedTerminalCli(null)).toBe(false);
    const html = renderToStaticMarkup(createElement(TerminalCliWarningRow, { info: { version: "3.26.1", desktopVersion: "3.48.1" } }));
    expect(html).toContain("The npm CLI on Windows PATH is v3.26.1");
    expect(html).toContain("desktop app is v3.48.1");
    expect(html).toContain("npm install -g ccdeck@latest");
    expect(html).toContain("ccdeck tui");
  });
});

it("limits desktop CLI version IPC to the deck main frame on Windows", () => {
  const source = readFileSync(new URL("../../../desktop/main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function installTerminalCliIpc() {");
  const body = source.slice(start, source.indexOf("function installNotificationAudioIpc()", start));
  expect(start).toBeGreaterThan(0);
  const handlers = new Map<string, (event: unknown) => unknown>();
  const frame = {};
  const event = { senderFrame: frame, sender: { mainFrame: frame } };
  const context = {
    ipcMain: { handle: (name: string, callback: (event: unknown) => unknown) => handlers.set(name, callback) },
    fromDeckPage: () => true, process: { platform: "win32" },
    windowsNpmCliVersion: () => "3.26.1", app: { getVersion: () => "3.48.1" },
  };
  runInNewContext(`${body}\ninstallTerminalCliIpc();`, context);
  const read = handlers.get("ccdeck:cli:version")!;
  expect(read(event)).toEqual({ version: "3.26.1", desktopVersion: "3.48.1" });
  expect(read({ senderFrame: {}, sender: { mainFrame: frame } })).toBeNull();
  context.fromDeckPage = () => false;
  expect(read(event)).toBeNull();
  context.fromDeckPage = () => true;
  context.process.platform = "linux";
  expect(read(event)).toBeNull();
});

it("packages and exposes only a read-only desktop CLI version bridge", async () => {
  const config = await import("../../../desktop/electron-builder.config.cjs");
  expect(config.default.files).toContain("terminal-cli.mjs");
  const exposed = new Map<string, unknown>();
  const calls: string[] = [];
  const preload = readFileSync(new URL("../../../desktop/preload.cjs", import.meta.url), "utf8");
  runInNewContext(preload, {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name: string, value: unknown) => exposed.set(name, value) },
      ipcRenderer: { invoke: (name: string) => { calls.push(name); return Promise.resolve(null); } },
    }),
    process: { argv: [], platform: "win32" },
  });
  const bridge = exposed.get("ccdeckTerminalCli") as { version: () => Promise<unknown> };
  expect(Object.keys(bridge)).toEqual(["version"]);
  await bridge.version();
  expect(calls).toEqual(["ccdeck:cli:version"]);
});
