// `--uninstall` stops the decks that are still running.
//
// Since 3.20 the deck runs in the background by default, and `--uninstall` took
// the hooks out and left it running. On an npx install the next release then
// undid the uninstall on its own: the idle auto-update relaunches through
// `npx -y ccdeck@latest`, that is a whole new supervisor and a full first boot,
// and a first boot installs every hook again. With `--purge` the running deck
// also kept the LAN key it had just been told was deleted, in memory, and went
// on pairing and answering under it until it stopped.
//
// Now the uninstall ends every live deck with `--stop`'s own ladder, one line
// per deck, and exits 1 when one would not go. It does so after the hooks are
// out — so nothing is left that a stopping deck could still be reached through
// — and before `--purge` deletes the key files, so no deck is left to write
// them back.
//
// The CLI is driven for real, in a child process, with every path in a temp
// directory. The "deck" is this file: a small HTTP server that answers the
// challenge `liveDecks` sends and records the shutdown `stopDeck` posts, behind
// a registry record naming a live child process of this test.
import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { challengeProof } = await import("../../server/deck-probe.mjs");
// @ts-expect-error — plain .js module, no types
const { stopLiveDecks } = await import("../../../bin/cli/uninstall.js");

const DECK = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-uninstall-stops-"));
const CFG = join(SANDBOX, ".claude");
const REGISTRY = join(CFG, "agent-dag");
const SETTINGS = join(CFG, "settings.json");
const DATA = join(SANDBOX, "deck-data");
const PREFS = join(DATA, "prefs.json");

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
  AGENTS_DECK_NO_LAN: "1",
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
};

// Belt and braces: an uninstall outside the sandbox would stop the developer's
// own deck and take the hooks out of their own settings.json.
for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
  if (!resolve(String(CHILD_ENV[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
}

afterAll(() => rmTempDir(SANDBOX));

const FORWARDER = `node ${join(REGISTRY, "hook.js")} --provider claude`;
const OURS = { "__agent-dag": true, hooks: [{ type: "command", command: FORWARDER, timeout: 3 }] };
const THEIRS = { hooks: [{ type: "command", command: "afplay x" }] };

type Seen = { token: string; settings: string; prefsThere: boolean };

let server: Server | null = null;
let deckPid: ChildProcess | null = null;
let seen: Seen[] = [];

/** A process that stands for the deck's pid, and a server that answers for its
 *  port. The shutdown ends the process, as a deck's own shutdown would. */
async function fakeDeck(): Promise<void> {
  deckPid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/hook-challenge") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ proof: challengeProof("t", url.searchParams.get("nonce") ?? "") }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/shutdown") {
      // What the disk looked like when the deck was asked to stop — the order
      // the uninstall does things in is half of what is under test.
      seen.push({
        token: String(req.headers["x-ccdeck-token"] ?? ""),
        settings: readFileSync(SETTINGS, "utf8"),
        prefsThere: existsSync(PREFS),
      });
      res.end("{}");
      deckPid?.kill("SIGKILL");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>(done => server!.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  mkdirSync(REGISTRY, { recursive: true });
  writeFileSync(join(REGISTRY, `${deckPid.pid}.json`), JSON.stringify({ pid: deckPid.pid, port, token: "t" }));
}

beforeEach(async () => {
  seen = [];
  rmSync(CFG, { recursive: true, force: true });
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(CFG, { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify({ hooks: { Stop: [THEIRS, OURS], PreToolUse: [OURS] } }, null, 2) + "\n");
  await fakeDeck();
});

afterEach(async () => {
  deckPid?.kill("SIGKILL");
  deckPid = null;
  await new Promise<void>(done => (server ? server.close(() => done()) : done()));
  server = null;
});

function runCli(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((done, fail) => {
    let out = "";
    const c = spawn(process.execPath, [DECK, ...args], { stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV, cwd: SANDBOX });
    c.stdout!.on("data", d => { out += String(d); });
    c.stderr!.on("data", d => { out += String(d); });
    const timer = setTimeout(() => { c.kill("SIGKILL"); fail(new Error(`--uninstall did not exit:\n${out}`)); }, 30_000);
    c.on("error", e => { clearTimeout(timer); fail(e); });
    c.on("exit", code => { clearTimeout(timer); done({ code, out }); });
  });
}

describe("`--uninstall` with a deck still running", () => {
  it("stops it, with the token out of its record, and says so", async () => {
    const { code, out } = await runCli(["--uninstall"]);

    expect(code, out).toBe(0);
    expect(seen.map(s => s.token), out).toEqual(["t"]);
    expect(out).toMatch(/stopped the deck on port \d+/);
    const after = readFileSync(SETTINGS, "utf8");
    expect(after).not.toContain("__agent-dag");
    expect(JSON.parse(after).hooks.Stop).toEqual([THEIRS]);
  }, 45_000);

  it("stops it only once the hooks are out", async () => {
    await runCli(["--uninstall"]);

    expect(seen).toHaveLength(1);
    expect(seen[0].settings).not.toContain("__agent-dag");
  }, 45_000);

  it("with --purge, stops it before the key files go, and they are gone after", async () => {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(PREFS, JSON.stringify({ lan: { secret: "s3cret" } }));

    const { code, out } = await runCli(["--uninstall", "--purge"]);

    expect(code, out).toBe(0);
    expect(seen).toHaveLength(1);
    // Still there when the deck was asked to stop, so the stop came first; and
    // gone now, so nothing running could have written it back.
    expect(seen[0].prefsThere).toBe(true);
    expect(existsSync(PREFS)).toBe(false);
  }, 45_000);
});

describe("stopping the decks, and what a deck that would not stop does to the exit", () => {
  type Rec = { pid: number; port: number; token: string };
  const say = () => {
    const lines: string[] = [];
    return { lines, out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`) };
  };

  it("answers false, and names the deck, when one could not be stopped", async () => {
    const log = say();
    const decks: Rec[] = [{ pid: 11, port: 4317, token: "a" }, { pid: 12, port: 4318, token: "b" }];
    const ok = await stopLiveDecks({
      list: async () => decks,
      stop: async (d: Rec) => (d.pid === 11 ? { ok: true, how: "asked" } : { ok: false, how: "stuck", reason: "timeout" }),
      out: log.out, err: log.err,
    });

    expect(ok).toBe(false);
    expect(log.lines).toHaveLength(2);
    expect(log.lines[0]).toMatch(/stopped the deck on port 4317/);
    expect(log.lines[1]).toMatch(/^ERR .*could NOT stop the deck on port 4318.*timeout/);
  });

  it("answers true and says nothing when no deck is running", async () => {
    const log = say();
    expect(await stopLiveDecks({ list: async () => [], stop: async () => ({ ok: true }), out: log.out, err: log.err })).toBe(true);
    expect(log.lines).toEqual([]);
  });

  it("reads a stop that threw as one that failed, rather than dying over it", async () => {
    const log = say();
    const ok = await stopLiveDecks({
      list: async () => [{ pid: 11, port: 4317, token: "a" }],
      stop: async () => { throw new Error("boom"); },
      out: log.out, err: log.err,
    });
    expect(ok).toBe(false);
    expect(log.lines[0]).toMatch(/^ERR .*could NOT stop/);
  });
});
