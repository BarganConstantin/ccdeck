// `--uninstall` takes Codex's terminal selection out of the shell profiles.
//
// Enable terminal selection hands the person a command that writes a block,
// between "ccdeck Codex accounts" markers, into their shell profile: a `codex`
// function that runs ccdeck's helper. `--uninstall` used to leave it there, so
// after ccdeck was gone `codex` in a new terminal still went through a helper
// the desktop app's removal had taken away, and did not start.
//
// Every path here is in a temp directory. The function is given its home, its
// environment and its platform, and PowerShell is faked, so no profile of the
// machine running the tests is ever read or written.
import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { removeCodexTerminalEverywhere } = await import("../../server/codex-terminal.mjs");

const BEGIN = "# >>> ccdeck Codex accounts >>>";
const END = "# <<< ccdeck Codex accounts <<<";
const BLOCK = `${BEGIN}\ncodex() { ELECTRON_RUN_AS_NODE=1 command '/gone/ccdeck' '/data/codex-terminal/codex-terminal-runner.mjs' "$@"; }\n${END}\n`;

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmTempDir(root); });
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "ccdeck-uninstall-codex-terminal-"));
  roots.push(root);
  const home = join(root, "home");
  const store = join(root, "data");
  await mkdir(home, { recursive: true });
  await mkdir(join(store, "codex-terminal"), { recursive: true });
  await writeFile(join(store, "codex-terminal", "codex-terminal-runner.mjs"), "// helper\n");
  return { root, home, store };
}

describe("removeCodexTerminalEverywhere", () => {
  it("takes the block out of every profile that has one, keeps the rest of each, and removes the helper", async () => {
    const s = await sandbox();
    const zdot = join(s.root, "zdot");
    await mkdir(zdot);
    await writeFile(join(zdot, ".zshrc"), `export A=1\n${BLOCK}alias ll='ls -l'\n`);
    await writeFile(join(s.home, ".bashrc"), `PS1='$ '\n${BLOCK}`);
    await writeFile(join(s.home, ".profile"), `${BLOCK}`);
    await writeFile(join(s.home, ".bash_profile"), "source ~/.bashrc\n");

    const res = await removeCodexTerminalEverywhere({ home: s.home, store: s.store, env: { ZDOTDIR: zdot }, platform: "linux" });

    expect(res.refused).toEqual([]);
    expect([...res.removed].sort()).toEqual([join(zdot, ".zshrc"), join(s.home, ".bashrc"), join(s.home, ".profile")].sort());
    expect(await readFile(join(zdot, ".zshrc"), "utf8")).toBe("export A=1\nalias ll='ls -l'\n");
    expect(await readFile(join(s.home, ".bashrc"), "utf8")).toBe("PS1='$ '\n");
    expect(await readFile(join(s.home, ".profile"), "utf8")).toBe("");
    // A profile without the block is not rewritten.
    expect(await readFile(join(s.home, ".bash_profile"), "utf8")).toBe("source ~/.bashrc\n");
    expect(res.helper).toBe(true);
    expect(existsSync(join(s.store, "codex-terminal"))).toBe(false);
  });

  it("leaves a file with incomplete markers untouched, names it, and keeps the helper it may still call", async () => {
    const s = await sandbox();
    const broken = `x=1\n${BEGIN}\ncodex() { :; }\n`;
    await writeFile(join(s.home, ".zshrc"), broken);
    await writeFile(join(s.home, ".bashrc"), BLOCK);

    const res = await removeCodexTerminalEverywhere({ home: s.home, store: s.store, env: {}, platform: "darwin" });

    expect(res.refused.map((f: { path: string }) => f.path)).toEqual([join(s.home, ".zshrc")]);
    expect(await readFile(join(s.home, ".zshrc"), "utf8")).toBe(broken);
    expect(res.removed).toEqual([join(s.home, ".bashrc")]);
    expect(res.kept).toBe(true);
    expect(res.helper).toBe(false);
    expect(existsSync(join(s.store, "codex-terminal", "codex-terminal-runner.mjs"))).toBe(true);
  });

  it("does nothing on a machine that never had it", async () => {
    const s = await sandbox();
    await writeFile(join(s.home, ".zshrc"), "export A=1\n");
    const store = join(s.root, "fresh-data");
    const res = await removeCodexTerminalEverywhere({ home: s.home, store, env: {}, platform: "linux" });
    expect(res).toMatchObject({ removed: [], refused: [], helper: false });
    expect(await readFile(join(s.home, ".zshrc"), "utf8")).toBe("export A=1\n");
  });

  it("on Windows also cleans both PowerShell profiles, and skips a PowerShell that is not installed", async () => {
    const s = await sandbox();
    const pwsh = join(s.root, "Documents", "PowerShell", "profile.ps1");
    await mkdir(join(s.root, "Documents", "PowerShell"), { recursive: true });
    await writeFile(pwsh, `Set-Alias g git\n${BEGIN}\nfunction global:codex { }\n${END}\n`);
    const powershellProfile = async (shell: string) => {
      if (shell === "powershell") return pwsh;
      throw Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
    };

    const res = await removeCodexTerminalEverywhere({ home: s.home, store: s.store, env: {}, platform: "win32", powershellProfile });

    expect(res.removed).toEqual([pwsh]);
    expect(res.refused).toEqual([]);
    expect(await readFile(pwsh, "utf8")).toBe("Set-Alias g git\n");
    expect(res.helper).toBe(true);
  });

  it("names a PowerShell whose profile could not be asked for, and keeps the helper", async () => {
    const s = await sandbox();
    const powershellProfile = async () => { throw new Error("timed out"); };
    const res = await removeCodexTerminalEverywhere({ home: s.home, store: s.store, env: {}, platform: "win32", powershellProfile });
    expect(res.refused.map((f: { path: string }) => f.path)).toEqual(["the PowerShell profile", "the Windows PowerShell profile"]);
    expect(res.helper).toBe(false);
    expect(existsSync(join(s.store, "codex-terminal"))).toBe(true);
  });
});

describe("`ccdeck --uninstall`", () => {
  // The CLI for real, in a child process, every path in a temp directory.
  it.skipIf(process.platform === "win32")("removes the block from the shell profile and says so", async () => {
    const s = await sandbox();
    const zdot = join(s.root, "zdot");
    await mkdir(zdot);
    await writeFile(join(s.home, ".bashrc"), `PS1='$ '\n${BLOCK}`);
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: s.home,
      USERPROFILE: s.home,
      ZDOTDIR: zdot,
      CLAUDE_CONFIG_DIR: join(s.home, ".claude"),
      CODEX_HOME: join(s.home, ".codex"),
      CCDECK_HOME: s.store,
      XDG_CONFIG_HOME: join(s.root, "xdg-config"),
      XDG_DATA_HOME: join(s.root, "xdg-data"),
      XDG_STATE_HOME: join(s.root, "xdg-state"),
      AGENTS_DECK_NO_LAN: "1",
      AGENTS_DECK_NO_REPORTS: "1",
      NO_COLOR: "1",
      FORCE_COLOR: undefined,
    };
    for (const k of ["HOME", "USERPROFILE", "ZDOTDIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
      if (!resolve(String(env[k])).startsWith(resolve(s.root))) throw new Error(`sandbox escaped: ${k}`);
    }
    const deck = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));
    const { code, out } = await new Promise<{ code: number | null; out: string }>((done, fail) => {
      let out = "";
      const c = spawn(process.execPath, [deck, "--uninstall"], { stdio: ["ignore", "pipe", "pipe"], env, cwd: s.root });
      c.stdout!.on("data", d => { out += String(d); });
      c.stderr!.on("data", d => { out += String(d); });
      const timer = setTimeout(() => { c.kill("SIGKILL"); fail(new Error(`--uninstall did not exit:\n${out}`)); }, 30_000);
      c.on("error", e => { clearTimeout(timer); fail(e); });
      c.on("exit", code => { clearTimeout(timer); done({ code, out }); });
    });

    expect(await readFile(join(s.home, ".bashrc"), "utf8")).toBe("PS1='$ '\n");
    expect(out).toContain(`Codex terminal selection removed from ${join(s.home, ".bashrc")}`);
    expect(out).toContain("removed the Codex terminal helper");
    expect(existsSync(join(s.store, "codex-terminal"))).toBe(false);
    expect(code).toBe(0);
  }, 40_000);
});
