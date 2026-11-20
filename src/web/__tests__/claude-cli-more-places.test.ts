// Where else `claude` lives, for a deck started where PATH never read the
// shell's startup files — the desktop app, a service: user feedback showed
// Accounts › Add › Sign in failing in the desktop app with "the claude CLI
// could not be run: not on PATH" on a machine that had Claude Code.
//
// claudeCliCandidates keeps every place it had, in the order it had them, and
// adds the older local install (~/.claude/local/claude, which its installer
// reached through a shell alias), the `claude` beside the node running the
// deck (npm's global bin under nvm), npm's ~/.npm-global prefix, Homebrew on
// Linux, and on Windows WinGet's Links, Scoop's shims and the claude.cmd npm
// puts beside node.exe. A place where nothing is installed stays invisible to
// every reader of the list.
//
// And the terminal engine, which finds `claude` by itself in the places the
// list had before, is told AGENTS_DECK_CLAUDE only when the deck's `claude` is
// in one of the added places, never over the user's own value.
import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { claudeCliCandidates, claudeCodeInstalls, engineClaudeHint, hasClaudeInstalled } = await import("../../server/claude-dir.mjs");
// @ts-expect-error — plain .mjs module, no types
const { adminClaudeBin } = await import("../../server/claude-identity.mjs");
// @ts-expect-error — plain .mjs module, no types
const { quotaClaudeBin } = await import("../../server/quota-cli.mjs");
// @ts-expect-error — plain .mjs module, no types
const { detectCliVersions } = await import("../../server/cli-versions.mjs");
// @ts-expect-error — plain .mjs module, no types
const { engineEnv } = await import("../../server/pro-engine-client.mjs");

const HOME_NIX = "/home/alice";
const HOME_WIN = "C:\\Users\\alice";
const NVM_NODE = `${HOME_NIX}/.nvm/versions/node/v22.14.0/bin/node`;
const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";

/** A disk on which exactly these paths exist and nothing else does. */
const disk = (...files: string[]) => (p: string) => files.includes(String(p));

describe("the list", () => {
  it("keeps today's POSIX places first and in order, then adds the ones a desktop app's PATH misses", () => {
    expect(claudeCliCandidates("linux", {}, HOME_NIX, NVM_NODE)).toEqual([
      "claude",
      `${HOME_NIX}/.local/bin/claude`,
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
      `${HOME_NIX}/.claude/local/claude`,
      `${HOME_NIX}/.nvm/versions/node/v22.14.0/bin/claude`,
      `${HOME_NIX}/.npm-global/bin/claude`,
      "/home/linuxbrew/.linuxbrew/bin/claude",
    ]);
    expect(claudeCliCandidates("darwin", {}, HOME_NIX, NVM_NODE)).toEqual(claudeCliCandidates("linux", {}, HOME_NIX, NVM_NODE));
  });

  it("names a place once, where node's own folder is one of them already", () => {
    const list = claudeCliCandidates("linux", {}, HOME_NIX, "/usr/local/bin/node");
    expect(list.filter((c: string) => c === "/usr/local/bin/claude")).toHaveLength(1);
    expect(list.indexOf("/usr/local/bin/claude")).toBe(2);
  });

  it("keeps today's Windows places first and in order, then WinGet, Scoop and npm beside node.exe", () => {
    const env = { APPDATA: `${HOME_WIN}\\AppData\\Roaming`, LOCALAPPDATA: "D:\\Local", USERPROFILE: "E:\\Profiles\\alice" };
    expect(claudeCliCandidates("win32", env, HOME_WIN, WIN_NODE)).toEqual([
      `${HOME_WIN}\\.local\\bin\\claude.exe`,
      `${HOME_WIN}\\AppData\\Roaming\\npm\\claude.cmd`,
      "claude",
      "D:\\Local\\Microsoft\\WinGet\\Links\\claude.exe",
      "E:\\Profiles\\alice\\scoop\\shims\\claude.exe",
      "C:\\Program Files\\nodejs\\claude.cmd",
    ]);
    // Without the variables, the home directory's own folders.
    expect(claudeCliCandidates("win32", {}, HOME_WIN, WIN_NODE).slice(3, 5)).toEqual([
      `${HOME_WIN}\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe`,
      `${HOME_WIN}\\scoop\\shims\\claude.exe`,
    ]);
  });
});

describe("every reader of the list", () => {
  const NO_PATH = { PATH: "/usr/bin:/bin" };

  it("finds ~/.claude/local/claude when PATH misses it, on a real disk", () => {
    // A scratch home with the file really there, and nothing outside it counts:
    // the machine running the suite may have a claude of its own.
    const home = mkdtempSync(join(tmpdir(), "ccdeck-claude-local-"));
    try {
      mkdirSync(join(home, ".claude", "local"), { recursive: true });
      writeFileSync(join(home, ".claude", "local", "claude"), "#!/bin/sh\n");
      chmodSync(join(home, ".claude", "local", "claude"), 0o755);
      // The list's own spelling for a POSIX machine, whatever the host is.
      const local = posix.join(home, ".claude", "local", "claude");
      const exists = (p: string) => String(p).startsWith(home) && existsSync(p);
      expect(adminClaudeBin("linux", NO_PATH, home, exists)).toBe(local);
      expect(quotaClaudeBin("linux", NO_PATH, home, exists)).toBe(local);
      expect(hasClaudeInstalled({ platform: "linux", env: NO_PATH, home, configDir: join(home, "nowhere"), exists })).toBe(true);
    } finally {
      rmTempDir(home);
    }
  });

  it("finds each added place, and still prefers every place it had before", () => {
    for (const added of [
      `${HOME_NIX}/.claude/local/claude`,
      `${HOME_NIX}/.npm-global/bin/claude`,
      "/home/linuxbrew/.linuxbrew/bin/claude",
    ]) {
      expect(adminClaudeBin("linux", NO_PATH, HOME_NIX, disk(added)), added).toBe(added);
      expect(adminClaudeBin("linux", NO_PATH, HOME_NIX, disk(added, `${HOME_NIX}/.local/bin/claude`)), added).toBe(`${HOME_NIX}/.local/bin/claude`);
      expect(adminClaudeBin("linux", { PATH: "/opt/x" }, HOME_NIX, disk(added, "/opt/x/claude")), added).toBe("claude");
    }
    const winget = `${HOME_WIN}\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe`;
    expect(adminClaudeBin("win32", { Path: "C:\\Windows" }, HOME_WIN, disk(winget))).toBe(winget);
    expect(quotaClaudeBin("win32", { Path: "C:\\Windows" }, HOME_WIN, disk(winget))).toBe(winget);
    expect(adminClaudeBin("win32", { Path: "C:\\tools" }, HOME_WIN, disk(winget, "C:\\tools\\claude.exe"))).toBe("claude");
  });

  it("sees nothing where nothing is installed", () => {
    expect(adminClaudeBin("linux", NO_PATH, HOME_NIX, () => false)).toBe("claude");
    expect(quotaClaudeBin("darwin", NO_PATH, HOME_NIX, () => false)).toBe("claude");
    expect(hasClaudeInstalled({ platform: "linux", env: NO_PATH, home: HOME_NIX, configDir: `${HOME_NIX}/.claude`, exists: () => false })).toBe(false);
    expect(claudeCodeInstalls({ platform: "linux", env: NO_PATH, home: HOME_NIX, exists: () => false })).toEqual([]);
  });

  it("asks a version only of a claude that answers: a place with nothing there gives none", async () => {
    const asked: string[] = [];
    const runImpl = async (cmd: string) => {
      asked.push(cmd);
      return cmd === `${HOME_NIX}/.npm-global/bin/claude`
        ? { ok: true, stdout: "2.1.300 (Claude Code)\n", stderr: "" }
        : { ok: false, code: "ENOENT", stdout: "", stderr: "" };
    };
    const out = await detectCliVersions({
      runImpl, claudeCandidates: () => claudeCliCandidates("linux", {}, HOME_NIX, NVM_NODE), claudePresent: () => true, codexPresent: () => false,
    });
    expect(out).toEqual({ claudeVersion: "2.1.300" });
    expect(asked.at(-1)).toBe(`${HOME_NIX}/.npm-global/bin/claude`);
  });
});

describe("the claude the terminal engine is told about", () => {
  const NO_PATH = { PATH: "/usr/bin:/bin" };
  const hint = (over: Record<string, unknown>) => engineClaudeHint({ platform: "linux", env: NO_PATH, home: HOME_NIX, execPath: NVM_NODE, exists: () => false, ...over });

  it("is nothing where the engine's own search finds one: PATH, or the installers' folders", () => {
    expect(hint({})).toBeNull();
    expect(hint({ env: { PATH: "/opt/x" }, exists: disk("/opt/x/claude", `${HOME_NIX}/.claude/local/claude`) })).toBeNull();
    for (const known of [`${HOME_NIX}/.local/bin/claude`, "/usr/local/bin/claude", "/opt/homebrew/bin/claude"]) {
      expect(hint({ exists: disk(known, `${HOME_NIX}/.claude/local/claude`) }), known).toBeNull();
    }
  });

  it("is the deck's own claude where only an added place has one", () => {
    expect(hint({ exists: disk(`${HOME_NIX}/.claude/local/claude`) })).toBe(`${HOME_NIX}/.claude/local/claude`);
    expect(hint({ exists: disk(`${HOME_NIX}/.nvm/versions/node/v22.14.0/bin/claude`) })).toBe(`${HOME_NIX}/.nvm/versions/node/v22.14.0/bin/claude`);
    expect(hint({ exists: disk("/home/linuxbrew/.linuxbrew/bin/claude") })).toBe("/home/linuxbrew/.linuxbrew/bin/claude");
  });

  it("never stands over the user's own AGENTS_DECK_CLAUDE", () => {
    expect(hint({ env: { ...NO_PATH, AGENTS_DECK_CLAUDE: "/mine/claude" }, exists: disk(`${HOME_NIX}/.claude/local/claude`) })).toBeNull();
    expect(engineEnv({ PATH: "/usr/bin", AGENTS_DECK_CLAUDE: "/mine/claude" }, true, "/found/claude"))
      .toEqual({ PATH: "/usr/bin", AGENTS_DECK_CLAUDE: "/mine/claude", CCDECK_ENGINE_TERMINAL: "1" });
  });

  it("is passed to the engine as AGENTS_DECK_CLAUDE, and nothing is added without one", () => {
    expect(engineEnv({ PATH: "/usr/bin" }, true, "/found/claude")).toEqual({ PATH: "/usr/bin", AGENTS_DECK_CLAUDE: "/found/claude", CCDECK_ENGINE_TERMINAL: "1" });
    expect(engineEnv({ PATH: "/usr/bin" }, true, null)).toEqual({ PATH: "/usr/bin", CCDECK_ENGINE_TERMINAL: "1" });
    expect(engineEnv({ PATH: "/usr/bin" }, false)).toEqual({ PATH: "/usr/bin" });
    // The engine's spawn asks for it each time it starts.
    const client = readFileSync(new URL("../../server/pro-engine-client.mjs", import.meta.url), "utf8");
    expect(client).toMatch(/env: engineEnv\(process\.env, this\.options\.terminal, engineClaudeHint\(\)\)/);
  });

  it("is a program on Windows: a WinGet or Scoop claude.exe, never the claude.cmd beside node", () => {
    const win = (exists: (p: string) => boolean) => engineClaudeHint({ platform: "win32", env: { Path: "C:\\Windows" }, home: HOME_WIN, execPath: WIN_NODE, exists });
    const winget = `${HOME_WIN}\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe`;
    expect(win(disk(winget))).toBe(winget);
    expect(win(disk("C:\\Program Files\\nodejs\\claude.cmd"))).toBeNull();
    expect(win(disk(winget, `${HOME_WIN}\\.local\\bin\\claude.exe`))).toBeNull();
  });
});
