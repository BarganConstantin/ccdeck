// `ccdeck --status` promised to open a deck that a bare `ccdeck` replaces.
//
// --status marked "`ccdeck` opens this one" on the first deck of the start's
// shape. A bare start attaches only to a deck that serves it, and serving also
// means not being older than the version starting (running-deck.mjs serves),
// so an older deck of that shape — the one still up after `npm i -g` of a new
// version — was marked as the deck the next `ccdeck` would open, and that
// `ccdeck` stopped it and started another. Reproduced before the fix:
//
//     record { version: "0.0.1", <the bare start's shape> }
//     $ ccdeck --status   -> "✓  v0.0.1 · pid … · up …   → `ccdeck` opens this one"
//
// Now the mark is the start's own rule, and an older deck of that shape says it
// is the one a bare start replaces.
//
// THE DECK IS FAKE. The CLI is spawned for real with every path in a temp
// directory, and the deck it finds is a registry record naming a child process
// of this test, with a server of this test's own answering the challenge.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { challengeProof } = await import("../../server/deck-probe.mjs");
// @ts-expect-error — plain .mjs module, no types
const { canonicalLogPath } = await import("../../server/log-election.mjs");

const DECK = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));
const OURS = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")).version;

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-status-older-"));
const CFG = join(SANDBOX, ".claude");
const REGISTRY = join(CFG, "agent-dag");
const DATA = join(SANDBOX, "deck-data");

const CHILD_ENV: Record<string, string | undefined> = {
  ...process.env,
  HOME: SANDBOX,
  USERPROFILE: SANDBOX,
  CLAUDE_CONFIG_DIR: CFG,
  CODEX_HOME: join(SANDBOX, ".codex"),
  CCDECK_HOME: DATA,
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
  AGENT_DAG_PORT: "",
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
};

for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
  if (!resolve(String(CHILD_ENV[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
}

afterAll(() => rmTempDir(SANDBOX));

let deckPid: ChildProcess | null = null;
let server: Server | null = null;

afterEach(async () => {
  deckPid?.kill("SIGKILL");
  deckPid = null;
  const s = server;
  server = null;
  if (s) await new Promise(done => s.close(done));
});

/** A deck of the bare start's shape at `version`: a process of ours for its
 *  pid, and a server of ours that answers the challenge for its port. */
async function deckAt(version: string): Promise<void> {
  rmSync(CFG, { recursive: true, force: true });
  mkdirSync(REGISTRY, { recursive: true });
  mkdirSync(DATA, { recursive: true });
  // Claude Code's own state file: the bare start's shape has Claude on, and no
  // Codex, since the sandbox has no Codex tree.
  writeFileSync(join(SANDBOX, ".claude.json"), "{}\n");
  deckPid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/hook-challenge") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ proof: challengeProof("t", url.searchParams.get("nonce") ?? "") }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  writeFileSync(join(REGISTRY, `${deckPid.pid}.json`), JSON.stringify({
    pid: deckPid.pid, parent: null, port, token: "t",
    workspace: "", persist: canonicalLogPath(join(DATA, "events.jsonl")), codex: false, claude: true,
    version, startedAt: new Date(Date.now() - 60_000).toISOString(),
  }));
}

function status(): Promise<{ code: number | null; out: string }> {
  return new Promise((done, fail) => {
    let out = "";
    const c = spawn(process.execPath, [DECK, "--status"], { stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV, cwd: SANDBOX });
    c.stdout!.on("data", d => { out += String(d); });
    c.stderr!.on("data", d => { out += String(d); });
    const timer = setTimeout(() => { c.kill("SIGKILL"); fail(new Error(`--status did not exit:\n${out}`)); }, 30_000);
    c.on("error", e => { clearTimeout(timer); fail(e); });
    c.on("exit", code => { clearTimeout(timer); done({ code, out }); });
  });
}

describe("the deck `--status` says a bare start opens", () => {
  it("is a deck of the start's shape and version", async () => {
    await deckAt(OURS);
    const { code, out } = await status();
    expect(code, out).toBe(0);
    expect(out).toContain(`v${OURS}`);
    expect(out).toContain("opens this one");
  }, 45_000);

  it("is never an older deck of that shape, which the start replaces", async () => {
    await deckAt("0.0.1");
    const { code, out } = await status();
    expect(code, out).toBe(0);
    expect(out).toContain("v0.0.1");
    expect(out).not.toContain("opens this one");
    expect(out).toContain("replaces this one");
  }, 45_000);
});
