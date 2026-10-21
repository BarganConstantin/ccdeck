// SIGHUP ended the deck without its shutdown.
//
// Closing the terminal of a `--foreground` deck hangs it up, and on Windows
// Node reports a closed console window the same way. The worker's only SIGHUP
// handler put the cursor back and died of the signal, so none of shutdown()
// ran: the event-log appends already acknowledged to the hook were dropped,
// the discovery record stayed behind for the hooks to keep finding, the LAN
// heard no goodbye and the children the deck had started were not reaped.
// Reproduced before the fix, on a sandboxed deck:
//
//     kill -HUP <deck>   -> killed by SIGHUP, <config>/agent-dag/<pid>.json still there
//
// Now a hangup takes the same way out SIGINT and SIGTERM take, and the deck
// still exits with the hangup's code, so its supervisor reads what it read.
//
// THE DECK IS REAL AND OURS: bin/deck.js, spawned by this test with every path
// in a temp directory and a port the OS handed out, and ended by it. POSIX
// only: Windows cannot send a process SIGHUP.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

const DECK = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-hangup-"));
const CFG = join(SANDBOX, ".claude");
const REGISTRY = join(CFG, "agent-dag");
// A PATH with this node on it and the system's tools, and nothing of the
// developer's: no claude, no claude-swap, no ccusage for the deck to run.
const BIN = join(SANDBOX, "bin");
mkdirSync(BIN, { recursive: true });
if (process.platform !== "win32") symlinkSync(process.execPath, join(BIN, "node"));

const CHILD_ENV: Record<string, string | undefined> = {
  ...process.env,
  PATH: [BIN, "/usr/bin", "/bin"].join(delimiter),
  HOME: SANDBOX,
  USERPROFILE: SANDBOX,
  CLAUDE_CONFIG_DIR: CFG,
  CODEX_HOME: join(SANDBOX, ".codex"),
  CCDECK_HOME: join(SANDBOX, "deck-data"),
  XDG_CONFIG_HOME: join(SANDBOX, "xdg-config"),
  XDG_DATA_HOME: join(SANDBOX, "xdg-data"),
  XDG_STATE_HOME: join(SANDBOX, "xdg-state"),
  XDG_CACHE_HOME: join(SANDBOX, "xdg-cache"),
  AGENTS_DECK_NO_INSTALL: "1",
  AGENTS_DECK_NO_LAN: "1",
  AGENTS_DECK_NO_NOTIFY: "1",
  AGENTS_DECK_NO_MUSIC: "1",
  AGENTS_DECK_NO_UPDATE_CHECK: "1",
  AGENTS_DECK_NO_DOWNLOAD: "1",
  AGENTS_DECK_NO_REPORTS: "1",
  AGENTS_DECK_NO_STATUS: "1",
  CLAUDE_SWAP_BACKUP: join(SANDBOX, "claude-swap"),
  AGENT_DAG_PORT: "",
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
};

for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLAUDE_SWAP_BACKUP"]) {
  if (!resolve(String(CHILD_ENV[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
}

let deck: ChildProcess | null = null;
const held: ChildProcess[] = [];

afterAll(() => {
  for (const c of [deck, ...held]) {
    if (c && c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }
  rmTempDir(SANDBOX);
});

/** A port nothing is listening on, well away from the decks' own range. */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((done, fail) => {
      const s = createServer();
      s.once("error", fail);
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => done(p));
      });
    });
    if (port < 4300 || port > 4410) return port;
  }
}

async function until(ok: () => boolean, ms: number, what: string, log: () => string) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}:\n${log()}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

describe.skipIf(process.platform === "win32")("a deck that is hung up", () => {
  it("runs its shutdown and still exits with the hangup's code", async () => {
    const port = await freePort();
    let out = "";
    deck = spawn(process.execPath, [DECK, "--port", String(port), "--no-open", "--no-codex"], {
      stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV, cwd: SANDBOX,
    });
    deck.stdout!.on("data", d => { out += String(d); });
    deck.stderr!.on("data", d => { out += String(d); });
    const exited = new Promise<{ code: number | null; signal: string | null }>(done =>
      deck!.on("exit", (code, signal) => done({ code, signal })));
    const record = join(REGISTRY, `${deck.pid}.json`);

    await until(() => existsSync(record), 60_000, "the deck to register", () => out);
    deck.kill("SIGHUP");
    const { code, signal } = await exited;

    expect(existsSync(record), `the record was left behind\n${out}`).toBe(false);
    expect(code === 129 || signal === "SIGHUP", `exit ${code} ${signal}`).toBe(true);
  }, 90_000);
});

// ── a signal before the boot is over ──────────────────────────────────────────
//
// The record is written some way before the end of the boot — the login item
// and, without --no-open, the browser are still to come — and SIGINT, SIGTERM
// and SIGHUP were handed to shutdown only after those. A signal in between found
// no handler, the deck died of it, and the record stayed for the hooks to find.
// That is the test above failing now and then on a loaded machine.
//
// HELD THERE, so it is the same answer every run. A preload, put in front of
// the deck with --require, stalls the one call that finishes the record's first
// write — the chmod after the rename, so the record is whole and on disk — until
// the test lets it go. Only that file's chmod, and only as a timer: the deck's
// event loop runs on, so a handler it has can run. The deck is signalled once
// it has said it is stalled there, and let go of straight after. With
// HOLD_UNLINK set, the shutdown's unlink of the same record is held the same way.
const HELD = join(SANDBOX, "held");
const HOLD = join(SANDBOX, "hold-record.cjs");
mkdirSync(HELD, { recursive: true });
writeFileSync(HOLD, [
  `const { existsSync, writeFileSync } = require("node:fs");`,
  `const { join, sep } = require("node:path");`,
  `const fsp = require("node:fs/promises");`,
  `const HELD = ${JSON.stringify(HELD)};`,
  `const ours = (path) => String(path).endsWith(sep + "agent-dag" + sep + process.pid + ".json");`,
  `const hold = (what) => new Promise(done => {`,
  `  writeFileSync(join(HELD, process.pid + "." + what), "");`,
  `  const t = setInterval(() => {`,
  `    if (existsSync(join(HELD, process.pid + "." + what + ".go"))) { clearInterval(t); done(); }`,
  `  }, 20);`,
  `});`,
  `const { chmod, unlink } = fsp;`,
  `fsp.chmod = async (path, mode) => { if (ours(path)) await hold("chmod"); return chmod(path, mode); };`,
  `if (process.env.HOLD_UNLINK) fsp.unlink = async (path) => { if (ours(path)) await hold("unlink"); return unlink(path); };`,
  // discovery.mjs takes both as named imports, which are copies of these.
  `require("node:module").syncBuiltinESMExports();`,
].join("\n"));

const isHeld = (pid: number | undefined, what: string) => existsSync(join(HELD, `${pid}.${what}`));
const letGo = (pid: number | undefined, what: string) => writeFileSync(join(HELD, `${pid}.${what}.go`), "");

/** A deck spawned behind the preload, with its own registry and data: a record
 *  the deck before it left behind must not be what this one is judged by. */
async function heldDeck(name: string, { ipc = false, holdUnlink = false } = {}) {
  const cfg = join(SANDBOX, name, ".claude");
  const env = {
    ...CHILD_ENV, CLAUDE_CONFIG_DIR: cfg, CCDECK_HOME: join(SANDBOX, name, "deck-data"),
    HOLD_UNLINK: holdUnlink ? "1" : undefined,
  };
  for (const k of ["CLAUDE_CONFIG_DIR", "CCDECK_HOME"] as const) {
    if (!resolve(String(env[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
  }
  const port = await freePort();
  let out = "";
  const said: string[] = [];
  const c = spawn(process.execPath, ["--require", HOLD, DECK, "--port", String(port), "--no-open", "--no-codex"], {
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"], env, cwd: SANDBOX,
  });
  held.push(c);
  c.stdout!.on("data", d => { out += String(d); });
  c.stderr!.on("data", d => { out += String(d); });
  c.on("message", (m: { type?: string }) => { if (m?.type) said.push(m.type); });
  const exited = new Promise<{ code: number | null; signal: string | null }>(done =>
    c.on("exit", (code, signal) => done({ code, signal })));
  const record = join(cfg, "agent-dag", `${c.pid}.json`);
  await until(() => isHeld(c.pid, "chmod") && existsSync(record), 60_000,
    "the deck to write its record and stall", () => out);
  return { c, record, exited, said, out: () => out };
}

describe.skipIf(process.platform === "win32")("a deck signalled between writing its record and the end of its boot", () => {
  it.each([["SIGHUP", 129], ["SIGTERM", 0], ["SIGINT", 0]] as const)(
    "runs its shutdown on %s and exits %i", async (sig, want) => {
      const { c, record, exited, out } = await heldDeck(sig);
      c.kill(sig);
      // A deck that is shutting down waits for that write to finish before it
      // removes the record — see discovery.stop() — so it has to be let go of.
      letGo(c.pid, "chmod");
      const { code, signal } = await exited;

      expect(existsSync(record), `the record was left behind\n${out()}`).toBe(false);
      expect({ code, signal }, out()).toEqual({ code: want, signal: null });
    }, 90_000);

  // The boot is still running when its shutdown starts, and from here on it
  // must not get any further: no browser, no login item, no pulse, no
  // "booted" to a launcher waiting to hand the prompt back, no held restart.
  // The shutdown is held at the record's unlink, which it reaches only after the
  // boot has had its turn; a boot that carried on would say "booted" in there.
  it("goes no further with its boot once the shutdown has begun", async () => {
    const { c, record, exited, said, out } = await heldDeck("no-further", { ipc: true, holdUnlink: true });
    c.kill("SIGTERM");
    letGo(c.pid, "chmod");
    // Or for the deck to be gone, which is what a deck with no handler does.
    await until(() => isHeld(c.pid, "unlink") || c.exitCode !== null || c.signalCode !== null, 30_000,
      "the shutdown to reach the record", out);
    // Long enough for a boot that carried on to load one module and say so.
    await new Promise(r => setTimeout(r, 1_000));
    letGo(c.pid, "unlink");
    const { code, signal } = await exited;

    expect(said, out()).toContain("listening");
    expect(said, out()).not.toContain("booted");
    expect(existsSync(record), `the record was left behind\n${out()}`).toBe(false);
    expect({ code, signal }, out()).toEqual({ code: 0, signal: null });
  }, 90_000);
});
