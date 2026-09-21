// A deck started by the desktop app (#1160), and the app's side of starting it.
//
// Inside the app three things the deck does for itself belong to the app —
// updates, start at login, and the program the Claude Code hook runs with —
// and doing them anyway goes wrong in ways a terminal deck never sees: an
// `npm i -g` of a copy the app never runs, a login item that starts a deck with
// no app around it, and a hook command that opens the app instead of running a
// script. What is pinned here is each one handed over, and the launcher the
// hook runs through.
import { describe, it, expect } from "vitest";
import { inApp, hookRuntime, APP_ENV, HOOK_RUNTIME_ENV } from "../../server/app-host.mjs";
import { hookCommand } from "../../server/installer.mjs";
import { shouldOfferService } from "../../server/login-service.mjs";
// @ts-expect-error — plain .mjs, no types
import { claudeDir, launcherScript, shellPath } from "../../../desktop/deck-host.mjs";

describe("knowing the app is the host", () => {
  it("is told by the environment the supervisor and the worker both inherit", () => {
    expect(inApp({ [APP_ENV]: "1" })).toBe(true);
    expect(inApp({})).toBe(false);
    expect(inApp({ [APP_ENV]: "yes" })).toBe(false);
  });

  it("runs the hook through the app's launcher, and through its own Node otherwise", () => {
    expect(hookRuntime({ [HOOK_RUNTIME_ENV]: "/u/.claude/agent-dag/ccdeck-node" }, "/app/ccdeck")).toBe("/u/.claude/agent-dag/ccdeck-node");
    expect(hookRuntime({}, "/usr/local/bin/node")).toBe("/usr/local/bin/node");
    expect(hookRuntime({ [HOOK_RUNTIME_ENV]: "  " }, "/usr/local/bin/node")).toBe("/usr/local/bin/node");
  });

  it("writes that launcher into the hook command, quoted like any path", () => {
    expect(hookCommand("/u/.claude/agent-dag/hook.js", "claude", "/u/.claude/agent-dag/ccdeck-node", "darwin"))
      .toBe("'/u/.claude/agent-dag/ccdeck-node' '/u/.claude/agent-dag/hook.js' --provider 'claude'");
  });

  it("never offers its own login item — the app owns that switch", () => {
    expect(shouldOfferService({ env: { [APP_ENV]: "1" } })).toBe(false);
    expect(shouldOfferService({ env: {} })).toBe(true);
  });
});

describe("the hook launcher", () => {
  it("prefers the system node, and falls back to the app's binary as Node", () => {
    const sh = launcherScript("/Applications/ccdeck.app/Contents/MacOS/ccdeck", "darwin");
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain('if command -v node >/dev/null 2>&1; then exec node "$@"; fi');
    expect(sh).toContain("ELECTRON_RUN_AS_NODE=1 exec '/Applications/ccdeck.app/Contents/MacOS/ccdeck' \"$@\"");
  });

  it("keeps a path with a quote in it as one argument", () => {
    const sh = launcherScript("/Users/o'neil/Apps/ccdeck.app/Contents/MacOS/ccdeck", "darwin");
    expect(sh).toContain(`'/Users/o'\\''neil/Apps/ccdeck.app/Contents/MacOS/ccdeck'`);
  });

  it("is a cmd script on Windows", () => {
    const cmd = launcherScript("C:\\Program Files\\ccdeck\\ccdeck.exe", "win32");
    expect(cmd.split("\r\n")[0]).toBe("@echo off");
    expect(cmd).toContain("where node >nul 2>nul && (node %* & exit /b)");
    expect(cmd).toContain('"C:\\Program Files\\ccdeck\\ccdeck.exe" %*');
  });

  it("lives in the Claude config directory, which CLAUDE_CONFIG_DIR moves", () => {
    expect(claudeDir({ CLAUDE_CONFIG_DIR: "/x/claude" }, "/home/u")).toBe("/x/claude");
    expect(claudeDir({}, "/home/u")).toMatch(/[\\/]home[\\/]u[\\/]\.claude$/);
  });
});

describe("the PATH an app started from the Dock is given", () => {
  it("reads the login shell's, ignoring whatever a profile prints", () => {
    const run = () => "Welcome back!\n__CCDECK_PATH__/opt/homebrew/bin:/usr/bin";
    expect(shellPath({ env: { SHELL: "/bin/zsh", PATH: "/usr/bin" }, platform: "darwin", run })).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("keeps the current one when the shell cannot be asked", () => {
    const run = () => { throw new Error("timed out"); };
    expect(shellPath({ env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" }, platform: "darwin", run })).toBe("/usr/bin:/bin");
  });

  it("does not ask on Windows, where GUI apps get the full PATH", () => {
    expect(shellPath({ env: { PATH: "C:\\a" }, platform: "win32", run: () => { throw new Error("not called"); } })).toBe("C:\\a");
  });
});
