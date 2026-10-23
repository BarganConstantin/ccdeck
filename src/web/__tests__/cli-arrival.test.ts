// Claude Code installed while the deck runs (src/server/cli-arrival.mjs).
//
// The deck decides at boot whether it serves Claude Code, and a first run is
// the boot most likely to be wrong a few minutes later: on a clean Windows VM
// the desktop app was opened, Claude Code was installed after it, and the deck
// stayed on "Waiting for Claude Code or Codex" with no hooks installed until
// the app was quit and opened again. Now the deck keeps asking while a CLI is
// neither served nor switched off, restarts itself the moment one appears, and
// the respawn runs the Claude setup the first boot skipped.
//
// The watch is driven here with timers of the test's own. The two cases after
// it run the real bin/deck.js in a sandbox the way respawn-hooks-1735 does:
// HOME, the Claude config dir, CODEX_HOME and the XDG dirs inside one temp
// directory, `--port 0`, and no LAN, no installs, no browser.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { CLI_POLL_MS, cliPollMs, watchForClis } = await import("../../server/cli-arrival.mjs");
// @ts-expect-error — plain .mjs module, no types
const { killTree } = await import("../../server/exec.mjs");
// @ts-expect-error — plain .mjs module, no types
const { hasClaudeInstalled } = await import("../../server/claude-dir.mjs");
// @ts-expect-error — plain .mjs module, no types
const { RESTART_CODE } = await import("../../server/supervisor.mjs");

/** Timers the test turns by hand: `beat()` runs one interval. */
function handTimers() {
  let fn: (() => void) | null = null;
  const t = {
    started: 0,
    cleared: 0,
    setInterval: (f: () => void) => { fn = f; t.started++; return { unref() {} }; },
    clearInterval: () => { fn = null; t.cleared++; },
    beat: () => fn?.(),
  };
  return t;
}

describe("the watch", () => {
  it("restarts once, for the first CLI that appears", () => {
    const timers = handTimers();
    let claude = false;
    const arrived: string[] = [];
    watchForClis({
      clis: [
        { name: "Claude Code", want: false, off: false, installed: () => claude },
        { name: "Codex", want: false, off: false, installed: () => false },
      ],
      onArrive: (name: string) => arrived.push(name),
      timers,
    });
    timers.beat();
    timers.beat();
    expect(arrived).toEqual([]);
    claude = true;
    timers.beat();
    timers.beat();
    expect(arrived).toEqual(["Claude Code"]);
    expect(timers.cleared).toBe(1);
  });

  it("starts no timer when every CLI is already served or switched off", () => {
    const timers = handTimers();
    watchForClis({
      clis: [
        { name: "Claude Code", want: true, off: false, installed: () => true },
        { name: "Codex", want: false, off: true, installed: () => true },
      ],
      onArrive: () => { throw new Error("nothing should arrive"); },
      timers,
    });
    expect(timers.started).toBe(0);
  });

  it("leaves a CLI switched off with --no-claude alone, however installed it becomes", () => {
    const timers = handTimers();
    const arrived: string[] = [];
    watchForClis({
      clis: [
        { name: "Claude Code", want: false, off: true, installed: () => true },
        { name: "Codex", want: false, off: false, installed: () => false },
      ],
      onArrive: (name: string) => arrived.push(name),
      timers,
    });
    timers.beat();
    expect(arrived).toEqual([]);
  });

  it("reads a presence check that throws as a no, and keeps watching", () => {
    const timers = handTimers();
    let calls = 0;
    const arrived: string[] = [];
    watchForClis({
      clis: [{ name: "Codex", want: false, off: false, installed: () => { if (++calls === 1) throw new Error("EACCES"); return true; } }],
      onArrive: (name: string) => arrived.push(name),
      timers,
    });
    timers.beat();
    expect(arrived).toEqual([]);
    timers.beat();
    expect(arrived).toEqual(["Codex"]);
  });

  it("looks every fifteen seconds unless a test asks for less", () => {
    expect(cliPollMs({})).toBe(CLI_POLL_MS);
    expect(CLI_POLL_MS).toBe(15_000);
    expect(cliPollMs({ AGENTS_DECK_CLI_POLL_MS: "200" })).toBe(200);
    expect(cliPollMs({ AGENTS_DECK_CLI_POLL_MS: "5" })).toBe(CLI_POLL_MS);
    expect(cliPollMs({ AGENTS_DECK_CLI_POLL_MS: "soon" })).toBe(CLI_POLL_MS);
  });
});

// ── the real deck ───────────────────────────────────────────────────────────

const PKG = fileURLToPath(new URL("../../../", import.meta.url));
const DECK = join(PKG, "bin", "deck.js");
const PACKAGED_HOOK = readFileSync(join(PKG, "hook", "hook.js"), "utf8");
const VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version as string;

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-cli-arrival-"));
const CFG = join(SANDBOX, ".claude");
const INSTALL_DIR = join(CFG, "agent-dag");
const SETTINGS = join(CFG, "settings.json");
// The machine running the suite may have Claude Code on its PATH, and then the
// deck would find it at boot and never watch. A PATH with nothing on it is the
// machine this is about; the deck itself is started by absolute path.
const BARE_PATH = join(SANDBOX, "bin");
mkdirSync(BARE_PATH, { recursive: true });

const CHILD_ENV: Record<string, string | undefined> = {
  ...process.env,
  HOME: SANDBOX,
  USERPROFILE: SANDBOX,
  PATH: BARE_PATH,
  Path: undefined,
  CLAUDE_CONFIG_DIR: CFG,
  CODEX_HOME: join(SANDBOX, ".codex"),
  XDG_CONFIG_HOME: join(SANDBOX, "xdg-config"),
  XDG_DATA_HOME: join(SANDBOX, "xdg-data"),
  XDG_STATE_HOME: join(SANDBOX, "xdg-state"),
  CCDECK_HOME: join(SANDBOX, "deck-data"),
  AGENTS_DECK_NO_INSTALL: "1",
  AGENTS_DECK_NO_LAN: "1",
  AGENTS_DECK_NO_NOTIFY: "1",
  AGENTS_DECK_NO_MUSIC: "1",
  AGENTS_DECK_CLI_POLL_MS: "200",
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
  AGENTS_DECK_RESPAWN: undefined,
  AGENTS_DECK_BOOT_VERSION: undefined,
  AGENTS_DECK_BOOT_HOOKS: undefined,
};

for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "CCDECK_HOME"]) {
  if (!resolve(String(CHILD_ENV[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
}

/** The sandbox has to start as a machine WITHOUT Claude Code, or the deck finds
 *  it at boot and the watch has nothing to do. Asserted rather than used as a
 *  skip: a machine with `claude` at a fixed system path fails here, saying so,
 *  instead of quietly not running these cases (see skip-gate-inventory). */
const expectNoClaudeYet = () =>
  expect(hasClaudeInstalled({ env: CHILD_ENV, home: SANDBOX, configDir: CFG }),
    "this machine has Claude Code at a system path the sandbox cannot hide").toBe(false);

afterAll(() => rmTempDir(SANDBOX));

let child: ChildProcess | null = null;

afterEach(async () => {
  const c = child;
  child = null;
  if (c && c.exitCode === null && c.signalCode === null) {
    const gone = new Promise<void>(done => c.once("exit", () => done()));
    killTree(c, "SIGTERM");
    const hard = setTimeout(() => killTree(c, "SIGKILL"), 5_000);
    await gone;
    clearTimeout(hard);
  }
  rmSync(join(SANDBOX, ".claude.json"), { force: true });
  rmSync(CFG, { recursive: true, force: true });
});

/** Start the worker the way the supervisor does, with an IPC channel, and
 *  resolve once it says it has booted. `exited` settles with its exit code. */
function startDeck(env: Record<string, string | undefined>) {
  let out = "";
  let exited!: Promise<number | null>;
  const booted = new Promise<string>((done, fail) => {
    const c = spawn(process.execPath, [DECK, "--no-open", "--port", "0", "--no-persist", "--no-codex"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...CHILD_ENV, ...env },
      cwd: SANDBOX,
    });
    child = c;
    c.stdout!.on("data", d => { out += String(d); });
    c.stderr!.on("data", d => { out += String(d); });
    exited = new Promise(r => c.on("exit", code => r(code)));
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
  return { booted, exited: () => exited, output: () => out };
}

describe("a deck that booted without Claude Code", () => {
  it("restarts itself once Claude Code is installed", async () => {
    expectNoClaudeYet();
    const deck = startDeck({});
    await deck.booted;
    // Claude Code's own state file, which its installer leaves on the first run.
    writeFileSync(join(SANDBOX, ".claude.json"), "{}\n");
    const code = await Promise.race([
      deck.exited(),
      new Promise(r => setTimeout(() => r("still running"), 10_000)),
    ]);
    expect(code, deck.output()).toBe(RESTART_CODE);
    expect(deck.output()).toMatch(/Claude Code found/);
  }, 45_000);
});

describe("the respawn that restart brings", () => {
  it("installs the hooks the first boot skipped", async () => {
    mkdirSync(CFG, { recursive: true });
    writeFileSync(SETTINGS, "{}\n");
    writeFileSync(join(SANDBOX, ".claude.json"), "{}\n");
    const deck = startDeck({ AGENTS_DECK_RESPAWN: "1", AGENTS_DECK_BOOT_VERSION: VERSION, AGENTS_DECK_BOOT_HOOKS: "off" });
    const out = await deck.booted;

    expect(readFileSync(join(INSTALL_DIR, "hook.js"), "utf8"), out).toBe(PACKAGED_HOOK);
    expect(JSON.stringify(JSON.parse(readFileSync(SETTINGS, "utf8")).hooks ?? {})).toContain("--provider");
    expect(out).toMatch(/Claude hooks/);
  }, 45_000);

  it("is an ordinary respawn when the first boot already had Claude Code", async () => {
    mkdirSync(CFG, { recursive: true });
    writeFileSync(SETTINGS, "{}\n");
    writeFileSync(join(SANDBOX, ".claude.json"), "{}\n");
    const deck = startDeck({ AGENTS_DECK_RESPAWN: "1", AGENTS_DECK_BOOT_VERSION: VERSION, AGENTS_DECK_BOOT_HOOKS: "ok" });
    const out = await deck.booted;

    expect(existsSync(join(INSTALL_DIR, "hook.js")), out).toBe(false);
    expect(readFileSync(SETTINGS, "utf8")).toBe("{}\n");
  }, 45_000);
});
