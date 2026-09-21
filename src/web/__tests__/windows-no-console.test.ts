// No console window flashes up on Windows while the deck runs.
//
// On Windows a console program started by a process that has no console is
// given a new one, and with Windows Terminal as the default terminal that new
// console is a window on the user's screen. The deck runs with no console of
// its own whenever it is detached — after `npx ccdeck`, or inside the desktop
// app — so every console program it starts has to be started without one.
// Measured on a Windows 10 box with a window watcher, two chains broke that:
//
//   the supervisor started the deck's own node.exe with inherited stdio and no
//   windowsHide — a second Windows Terminal window after the one `npx` ran in;
//
//   ccusage's cli.js started its native binary without windowsHide — a
//   Windows Terminal window on every usage read.
//
// Both were gone in the same measurement after the changes pinned here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nativeCcusage } from "../../server/ccusage.mjs";

const supervisor = readFileSync(fileURLToPath(new URL("../../../bin/agent-dag.js", import.meta.url)), "utf8");

describe("the deck's own process", () => {
  it("gets no console at all when the supervisor is detached on Windows", () => {
    // DETACHED_PROCESS, not windowsHide alone: with inherited stdio libuv only
    // asks for a hidden window, which the default-terminal handoff ignores.
    expect(supervisor).toMatch(/const NO_CONSOLE = DETACHED && process\.platform === "win32"\s*\?\s*\{ detached: true, windowsHide: true \}\s*:\s*\{\};/);
  });

  it("is started with it, and so is an upgrade's replacement", () => {
    expect(supervisor).toMatch(/const worker = spawn\(process\.execPath, args, \{\s*\.\.\.NO_CONSOLE,/);
    expect(supervisor).toMatch(/spawn\(file, argv, \{ stdio: \["inherit", "inherit", "pipe"\], \.\.\.NO_CONSOLE, \.\.\.opts \}\)/);
  });
});

describe("ccusage's native binary", () => {
  const entry = "C:\\Users\\u\\.agents-deck\\ccusage\\node_modules\\ccusage\\src\\cli.js";
  const found = (id: string) => `C:\\Users\\u\\.agents-deck\\ccusage\\node_modules\\${id.replace(/\//g, "\\")}`;

  it("is run directly on Windows, resolved as cli.js resolves it", () => {
    expect(nativeCcusage(entry, "win32", "x64", found))
      .toBe("C:\\Users\\u\\.agents-deck\\ccusage\\node_modules\\@ccusage\\ccusage-win32-x64\\bin\\ccusage.exe");
    expect(nativeCcusage(entry, "win32", "arm64", found)).toMatch(/ccusage-win32-arm64\\bin\\ccusage\.exe$/);
  });

  it("falls back to the wrapper when the binary is not installed", () => {
    const missing = () => { throw new Error("Cannot find module"); };
    expect(nativeCcusage(entry, "win32", "x64", missing)).toBeNull();
    expect(nativeCcusage(entry, "win32", "ia32", found)).toBeNull();
  });

  it("leaves every other platform on the wrapper, where nothing flashes", () => {
    expect(nativeCcusage(entry, "darwin", "arm64", found)).toBeNull();
    expect(nativeCcusage(entry, "linux", "x64", found)).toBeNull();
  });
});
