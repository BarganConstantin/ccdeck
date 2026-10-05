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
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
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

afterAll(() => {
  if (deck && deck.exitCode === null && deck.signalCode === null) deck.kill("SIGKILL");
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
