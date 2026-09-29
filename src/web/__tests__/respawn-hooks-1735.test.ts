// A respawn onto a different version brings the hook forwarder with it.
//
// A global install updates in place: `npm i -g` rewrites the package, the
// deck exits RESTART_CODE and the supervisor relaunches the worker from disk
// with AGENTS_DECK_RESPAWN=1. A respawn skipped the whole of startupWork, and
// that is the only caller of installHooks — the only code that copies hook.js
// and its package.json into the Claude config dir and rewrites the entries in
// settings.json. So the deck came back on the new version while Claude Code
// went on running the previous version's forwarder on every tool call, until
// the supervisor itself restarted: for a background or login-item deck, the
// next login. A fix to the forwarder — #1172's package.json among them —
// reached nobody who updated that way.
//
// Now the supervisor hands each worker the version the session started on, in
// AGENTS_DECK_BOOT_VERSION, and a respawn that runs a different one installs
// the hooks again. One that runs the same version is still the same session
// continuing and installs nothing. A variable that is not there at all is a
// supervisor from before this change — which is exactly the supervisor that is
// running on the first update after it — so that installs too.
//
// The real bin/deck.js, spawned with an IPC channel as the supervisor spawns
// it, in a sandbox: HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and the XDG dirs all
// inside one temp directory, `--port 0` so the OS picks a free port, and no
// LAN, no installs, no browser.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { killTree } = await import("../../server/exec.mjs");

const PKG = fileURLToPath(new URL("../../../", import.meta.url));
const DECK = join(PKG, "bin", "deck.js");
const PACKAGED_HOOK = readFileSync(join(PKG, "hook", "hook.js"), "utf8");
const VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version as string;

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-respawn-hooks-"));
const CFG = join(SANDBOX, ".claude");
const INSTALL_DIR = join(CFG, "agent-dag");
const SETTINGS = join(CFG, "settings.json");

const CHILD_ENV: Record<string, string | undefined> = {
  ...process.env,
  HOME: SANDBOX,
  USERPROFILE: SANDBOX,
  CLAUDE_CONFIG_DIR: CFG,
  CODEX_HOME: join(SANDBOX, ".codex"),
  XDG_CONFIG_HOME: join(SANDBOX, "xdg-config"),
  XDG_DATA_HOME: join(SANDBOX, "xdg-data"),
  XDG_STATE_HOME: join(SANDBOX, "xdg-state"),
  CCDECK_HOME: join(SANDBOX, "deck-data"),
  AGENTS_DECK_RESPAWN: "1",
  AGENTS_DECK_NO_INSTALL: "1",
  AGENTS_DECK_NO_LAN: "1",
  AGENTS_DECK_NO_NOTIFY: "1",
  AGENTS_DECK_NO_MUSIC: "1",
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
  AGENTS_DECK_BOOT_VERSION: undefined,
};

// Belt and braces: a deck started outside the sandbox would rewrite the
// developer's own settings.json and register beside their own deck.
for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "CCDECK_HOME"]) {
  if (!resolve(String(CHILD_ENV[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
}

afterAll(() => rmTempDir(SANDBOX));

/** A config dir as the previous version left it: a hook.js that is not this
 *  package's, no package.json beside it, and no entries in settings.json. */
function staleInstall() {
  rmSync(INSTALL_DIR, { recursive: true, force: true });
  mkdirSync(INSTALL_DIR, { recursive: true });
  writeFileSync(join(INSTALL_DIR, "hook.js"), "// stale\n");
  writeFileSync(SETTINGS, "{}\n");
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

/** Respawn the worker the way the supervisor does, and wait for it to say it
 *  has finished booting. */
function respawn(bootVersion: string | undefined): Promise<string> {
  return new Promise((done, fail) => {
    let out = "";
    const c = spawn(process.execPath, [DECK, "--no-open", "--port", "0", "--no-persist", "--claude", "--no-codex"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...CHILD_ENV, AGENTS_DECK_BOOT_VERSION: bootVersion },
      cwd: SANDBOX,
    });
    child = c;
    c.stdout!.on("data", d => { out += String(d); });
    c.stderr!.on("data", d => { out += String(d); });
    const timer = setTimeout(() => fail(new Error(`no "booted" within 30s:\n${out}`)), 30_000);
    c.on("message", (m: { type?: string }) => {
      if (m?.type !== "booted") return;
      clearTimeout(timer);
      done(out);
    });
    c.on("exit", (code, signal) => {
      clearTimeout(timer);
      fail(new Error(`the deck exited (${code ?? signal}) before it booted:\n${out}`));
    });
  });
}

const settingsForwarders = () => {
  const hooks = JSON.parse(readFileSync(SETTINGS, "utf8")).hooks ?? {};
  return Object.values(hooks).flat() as { hooks?: { command?: string }[] }[];
};

describe("a respawn onto a different version", () => {
  it("installs this version's hook.js, its package.json and the settings entries", async () => {
    staleInstall();
    const out = await respawn("0.0.1");

    expect(readFileSync(join(INSTALL_DIR, "hook.js"), "utf8"), out).toBe(PACKAGED_HOOK);
    expect(readFileSync(join(INSTALL_DIR, "package.json"), "utf8"), out).toContain("commonjs");
    const groups = settingsForwarders();
    expect(groups.length, out).toBeGreaterThan(0);
    expect(JSON.stringify(groups)).toContain("--provider");
  }, 45_000);

  it("installs them too when the supervisor is too old to say which version it started on", async () => {
    // The supervisor running on the first update after this change is the
    // previous version's, and it sets no such variable.
    staleInstall();
    const out = await respawn(undefined);

    expect(readFileSync(join(INSTALL_DIR, "hook.js"), "utf8"), out).toBe(PACKAGED_HOOK);
    expect(existsSync(join(INSTALL_DIR, "package.json")), out).toBe(true);
  }, 45_000);
});

describe("a respawn on the version the session started on", () => {
  it("is the same session continuing, and installs nothing", async () => {
    staleInstall();
    const out = await respawn(VERSION);

    expect(readFileSync(join(INSTALL_DIR, "hook.js"), "utf8"), out).toBe("// stale\n");
    expect(existsSync(join(INSTALL_DIR, "package.json")), out).toBe(false);
    expect(readFileSync(SETTINGS, "utf8")).toBe("{}\n");
  }, 45_000);
});
