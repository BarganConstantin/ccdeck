// A respawned worker puts GitHub Copilot CLI's hooks file and opencode's plugin
// in place, as the first boot does.
//
// Those two files are how a Copilot or opencode session reaches the deck: no
// file, no card on the Graph, however long the session runs. The first boot
// writes them in startupWork. A respawn — the supervisor relaunching the worker
// with AGENTS_DECK_RESPAWN=1 after an update or a restart — skipped startupWork
// and ran only Claude's hooks, so a forwarder the first boot never wrote stayed
// missing, and one an older package wrote stayed old, for as long as the
// supervisor lived. Seen on a Mac whose desktop app served a newer worker:
// both CLIs installed and answering in their own terminals, neither file there,
// and neither provider on the Graph.
//
// The real bin/deck.js, spawned with an IPC channel as the supervisor spawns
// it, in a sandbox: HOME, CLAUDE_CONFIG_DIR, COPILOT_HOME, CODEX_HOME and the
// XDG dirs all inside one temp directory, `--port 0`, and no LAN, no installs,
// no browser. Copilot and opencode are "installed" by their config folders,
// which is one of the two ways each installer detects them.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { killTree } = await import("../../server/exec.mjs");
// @ts-expect-error — plain .mjs module, no types
const { isOurHooksFile } = await import("../../server/copilot-hooks.mjs");
// @ts-expect-error — plain .mjs module, no types
const { PLUGIN_MARKER } = await import("../../server/opencode-plugin.mjs");

const PKG = fileURLToPath(new URL("../../../", import.meta.url));
const DECK = join(PKG, "bin", "deck.js");
const VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version as string;

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-respawn-forwarders-"));
const CFG = join(SANDBOX, ".claude");
const COPILOT = join(SANDBOX, ".copilot");
const XDG_CONFIG = join(SANDBOX, "xdg-config");
const OPENCODE = join(XDG_CONFIG, "opencode");
const COPILOT_FILE = join(COPILOT, "hooks", "ccdeck.json");
const OPENCODE_FILE = join(OPENCODE, "plugins", "ccdeck.js");

const CHILD_ENV: Record<string, string | undefined> = {
  ...process.env,
  HOME: SANDBOX,
  USERPROFILE: SANDBOX,
  CLAUDE_CONFIG_DIR: CFG,
  COPILOT_HOME: COPILOT,
  CODEX_HOME: join(SANDBOX, ".codex"),
  XDG_CONFIG_HOME: XDG_CONFIG,
  XDG_DATA_HOME: join(SANDBOX, "xdg-data"),
  XDG_STATE_HOME: join(SANDBOX, "xdg-state"),
  CCDECK_HOME: join(SANDBOX, "deck-data"),
  AGENTS_DECK_RESPAWN: "1",
  AGENTS_DECK_NO_INSTALL: "1",
  AGENTS_DECK_NO_LAN: "1",
  AGENTS_DECK_NO_NOTIFY: "1",
  AGENTS_DECK_NO_MUSIC: "1",
  AGENTS_DECK_NO_COPILOT: undefined,
  AGENTS_DECK_NO_OPENCODE: undefined,
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
  AGENTS_DECK_BOOT_VERSION: undefined,
  AGENTS_DECK_BOOT_HOOKS: undefined,
};

// Belt and braces: a deck started outside the sandbox would write into the
// developer's own Copilot and opencode folders and register beside their deck.
for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "COPILOT_HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "CCDECK_HOME"]) {
  if (!resolve(String(CHILD_ENV[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
}

afterAll(() => rmTempDir(SANDBOX));

/** Both CLIs present (their config folders), neither forwarder written. */
function freshProviders() {
  rmSync(COPILOT, { recursive: true, force: true });
  rmSync(OPENCODE, { recursive: true, force: true });
  mkdirSync(COPILOT, { recursive: true });
  mkdirSync(OPENCODE, { recursive: true });
}

let child: ChildProcess | null = null;

afterEach(async () => {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  const gone = new Promise<void>(done => c.once("exit", () => done()));
  killTree(c, "SIGTERM");
  const hard = setTimeout(() => killTree(c, "SIGKILL"), 5_000);
  await gone;
  clearTimeout(hard);
});

/** Respawn the worker the way the supervisor does, wait for it to say it has
 *  finished booting, and stop it. Answers everything it printed. */
async function respawn(
  bootVersion: string | undefined,
  { claude = true, env = {} }: { claude?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const out = await new Promise<string>((done, fail) => {
    let said = "";
    const c = spawn(process.execPath, [DECK, "--no-open", "--port", "0", "--no-persist", claude ? "--claude" : "--no-claude", "--no-codex"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...CHILD_ENV, AGENTS_DECK_BOOT_VERSION: bootVersion, ...env },
      cwd: SANDBOX,
    });
    child = c;
    c.stdout!.on("data", d => { said += String(d); });
    c.stderr!.on("data", d => { said += String(d); });
    const timer = setTimeout(() => fail(new Error(`no "booted" within 30s:\n${said}`)), 30_000);
    c.on("message", (m: { type?: string }) => {
      if (m?.type !== "booted") return;
      clearTimeout(timer);
      done(said);
    });
    c.on("exit", (code, signal) => {
      clearTimeout(timer);
      fail(new Error(`the deck exited (${code ?? signal}) before it booted:\n${said}`));
    });
  });
  const c = child;
  child = null;
  if (c && c.exitCode === null && c.signalCode === null) {
    const gone = new Promise<void>(done => c.once("exit", () => done()));
    killTree(c, "SIGTERM");
    const hard = setTimeout(() => killTree(c, "SIGKILL"), 5_000);
    await gone;
    clearTimeout(hard);
  }
  return out;
}

const read = (file: string) => readFileSync(file, "utf8");
const ours = () => ({ copilot: read(COPILOT_FILE), opencode: read(OPENCODE_FILE) });

describe("a respawn whose first boot never wrote the forwarders", () => {
  it("writes Copilot's hooks file and opencode's plugin, on the same package", async () => {
    freshProviders();
    const out = await respawn(VERSION);

    expect(existsSync(COPILOT_FILE), out).toBe(true);
    expect(isOurHooksFile(read(COPILOT_FILE)), out).toBe(true);
    expect(read(OPENCODE_FILE).startsWith(PLUGIN_MARKER), out).toBe(true);
    expect(out).not.toContain("will not show");
  }, 45_000);

  it("writes them on a machine without Claude Code too", async () => {
    freshProviders();
    const out = await respawn(VERSION, { claude: false });

    expect(isOurHooksFile(read(COPILOT_FILE)), out).toBe(true);
    expect(read(OPENCODE_FILE).startsWith(PLUGIN_MARKER), out).toBe(true);
  }, 45_000);
});

describe("a respawn that finds the forwarders in place", () => {
  it("writes nothing when they are already this package's", async () => {
    freshProviders();
    await respawn(VERSION);
    const before = ours();
    const mtimes = [statSync(COPILOT_FILE).mtimeMs, statSync(OPENCODE_FILE).mtimeMs];
    // Past any filesystem's timestamp resolution, so a rewrite would show.
    await new Promise(r => setTimeout(r, 1_100));

    const out = await respawn(VERSION);

    expect(ours(), out).toEqual(before);
    expect([statSync(COPILOT_FILE).mtimeMs, statSync(OPENCODE_FILE).mtimeMs], out).toEqual(mtimes);
  }, 60_000);

  it("brings an older package's forwarders up to this one after an update", async () => {
    freshProviders();
    await respawn(VERSION);
    const current = ours();

    // As an older package left them: still ccdeck's, by their own markers, but
    // not this package's bytes.
    const staleCopilot = JSON.stringify(JSON.parse(current.copilot));
    writeFileSync(COPILOT_FILE, staleCopilot);
    writeFileSync(OPENCODE_FILE, `${PLUGIN_MARKER}\n// an older package's plugin\n`);
    expect(isOurHooksFile(staleCopilot)).toBe(true);
    expect(read(COPILOT_FILE)).not.toBe(current.copilot);

    const out = await respawn("0.0.1");

    expect(ours(), out).toEqual(current);
  }, 60_000);

  it("leaves files the user wrote under those names exactly as they are", async () => {
    freshProviders();
    mkdirSync(join(COPILOT, "hooks"), { recursive: true });
    mkdirSync(join(OPENCODE, "plugins"), { recursive: true });
    const mine = { copilot: "{\"version\":1,\"hooks\":{}}\n", opencode: "// my own plugin\n" };
    writeFileSync(COPILOT_FILE, mine.copilot);
    writeFileSync(OPENCODE_FILE, mine.opencode);

    const out = await respawn("0.0.1");

    expect(ours(), out).toEqual(mine);
  }, 45_000);
});

describe("the off switches on a respawn", () => {
  it("take out ccdeck's forwarder for that provider only", async () => {
    freshProviders();
    await respawn(VERSION);

    let out = await respawn(VERSION, { env: { AGENTS_DECK_NO_COPILOT: "1" } });
    expect(existsSync(COPILOT_FILE), out).toBe(false);
    expect(read(OPENCODE_FILE).startsWith(PLUGIN_MARKER), out).toBe(true);

    out = await respawn(VERSION, { env: { AGENTS_DECK_NO_OPENCODE: "1" } });
    expect(existsSync(OPENCODE_FILE), out).toBe(false);
    expect(isOurHooksFile(read(COPILOT_FILE)), out).toBe(true);
  }, 90_000);
});

describe("a forwarder a respawn cannot write", () => {
  it("is one line naming the provider and the error code, with no path, and the deck still boots", async () => {
    freshProviders();
    // A folder where Copilot's hooks file goes: reading it fails, and the
    // installer answers "failed" instead of writing.
    mkdirSync(COPILOT_FILE, { recursive: true });

    const out = await respawn(VERSION);

    const line = out.split("\n").find(l => l.includes("GitHub Copilot CLI sessions will not show"));
    expect(line, out).toBeDefined();
    expect(line).toMatch(/hooks not written \([A-Z][A-Z0-9_]*\)/);
    expect(line).not.toContain(SANDBOX);
    expect(line).not.toContain(".copilot");
    // The other provider is not held up by it.
    expect(read(OPENCODE_FILE).startsWith(PLUGIN_MARKER), out).toBe(true);
  }, 45_000);
});
