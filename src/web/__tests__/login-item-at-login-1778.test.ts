// #1778: setting up the login item started a second, default deck at once, and
// that deck stopped the scoped deck the user had just launched.
//
// The first start of a global install adds a login item, and on Linux and
// macOS registering it also starts it: `systemctl --user enable --now`, and
// `launchctl load -w` on a plist with RunAtLoad. The job runs
// `agent-dag.js --no-open`, a deck of the default shape, and a deck of the
// default shape that finds a `--workspace`, `--no-codex` or `--no-persist` deck
// running replaces it — the newest start wins, and a start nobody typed beat
// the one the user just had. Reproduced before the fix:
//
//     secondStart({ live: [<a deck scoped to /home/u/proj>], want: { workspace: "" , … }, ours })
//       -> { act: "replace", stop: [<that deck>] }
//
// and the job's command line carried nothing that could tell it apart.
//
// Now the job carries `--at-login`, and a start with it never stops anything:
// beside a deck that is already up it leaves that deck alone, because nobody
// asked for this one.
//
// NOTHING HERE REGISTERS A LOGIN ITEM. installService is handed an `fs` that
// records what it would write and a `run` that records the service-manager
// command instead of executing it. The one spawned deck runs with every path in
// a temp directory, AGENTS_DECK_NO_INSTALL=1 (so it never offers a login item
// either), and a 44xx port; the "running deck" beside it is a registry record
// naming a child process of this test, answered by a server of this test's own.
import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { installService } = await import("../../server/login-service.mjs");
// @ts-expect-error — plain .mjs module, no types
const { parseArgs } = await import("../../server/args.mjs");
// @ts-expect-error — plain .mjs module, no types
const { secondStart } = await import("../../server/running-deck.mjs");
// @ts-expect-error — plain .mjs module, no types
const { challengeProof } = await import("../../server/deck-probe.mjs");

const DECK = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));
const PKG_VERSION = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")).version;

type Call = { file: string; args: string[] };

/** What installService would write and run on `platform`, with nothing done. */
function install(platform: "linux" | "darwin" | "win32") {
  const written: string[] = [];
  const calls: Call[] = [];
  const home = platform === "win32" ? "C:\\Users\\u" : platform === "darwin" ? "/Users/u" : "/home/u";
  const out = installService({
    platform, home,
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    execPath: platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/bin/node",
    script: platform === "win32" ? "C:\\npm\\ccdeck\\bin\\agent-dag.js" : "/s/agent-dag.js",
    logPath: platform === "win32" ? "C:\\Users\\u\\AppData\\Local\\ccdeck\\Log\\deck.log" : `${home}/logs/deck.log`,
    fs: {
      mkdirSync() {},
      writeFileSync: (_p: string, b: string | Buffer) => { written.push(String(b)); },
    },
    run: (file: string, args: string[]) => { calls.push({ file, args }); return { status: 0 }; },
  });
  return { out, body: written.join("\n"), calls };
}

/** The job's own argv after the script, read back out of what was written. */
function jobArgs(platform: "linux" | "darwin" | "win32", body: string): string[] {
  if (platform === "darwin") {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(body)?.[1] ?? "";
    return [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]).slice(2);
  }
  if (platform === "linux") {
    const line = /^ExecStart=(.*)$/m.exec(body)?.[1] ?? "";
    return line.split(" ").slice(2);
  }
  const line = /<Arguments>([^<]*)<\/Arguments>/.exec(body)?.[1] ?? "";
  return line.split(" ").slice(1);
}

describe("the login item's job says it was started at login", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    it(`carries --at-login on ${platform}, and the parser reads it`, () => {
      const { out, body, calls } = install(platform);
      expect(out.ok).toBe(true);
      // Recorded, never run.
      expect(calls).toHaveLength(1);
      const args = jobArgs(platform, body);
      expect(args).toContain("--at-login");
      expect(args).toContain("--no-open");
      const flags = parseArgs(args);
      expect(flags.atLogin).toBe(true);
      expect(flags.noOpen).toBe(true);
      expect(flags.unknown).toEqual([]);
    });
  }
});

describe("a start at login never replaces a deck that is already running", () => {
  const scoped = { pid: 1, port: 4401, token: "t", workspace: "/p", persist: "/l", codex: true, claude: true, version: "3.32.0" };
  const want = { workspace: "", persist: "/l", codex: true, claude: true };

  it("replaces it without the marker, which is the rule for a start somebody typed", () => {
    expect(secondStart({ live: [scoped], want, ours: "3.32.0" })).toEqual({ act: "replace", stop: [scoped] });
  });

  it("leaves it alone with the marker", () => {
    const plan = secondStart({ live: [scoped], want, ours: "3.32.0", atLogin: true });
    expect(["attach", "yield"]).toContain(plan.act);
    expect(plan.deck).toBe(scoped);
    expect(plan.stop).toEqual([]);
  });

  it("leaves an older deck alone too, and every deck when there are several", () => {
    const older = { ...scoped, version: "3.1.0" };
    const other = { ...scoped, pid: 2, port: 4402, workspace: "" };
    const plan = secondStart({ live: [older, other], want, ours: "3.32.0", atLogin: true });
    expect(plan.stop).toEqual([]);
    expect(["attach", "yield"]).toContain(plan.act);
  });

  it("still starts when nothing is running, which is what a login is for", () => {
    expect(secondStart({ live: [], want, ours: "3.32.0", atLogin: true })).toEqual({ act: "start", stop: [] });
  });
});

// ── the deck, spawned ───────────────────────────────────────────────────────

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-at-login-"));
const CFG = join(SANDBOX, ".claude");
const REGISTRY = join(CFG, "agent-dag");

const CHILD_ENV: Record<string, string | undefined> = {
  ...process.env,
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
  AGENTS_DECK_RESPAWN: "",
  AGENT_DAG_PORT: "",
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
};

for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
  if (!resolve(String(CHILD_ENV[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
}

const spawned = new Set<ChildProcess>();
afterAll(() => {
  for (const c of spawned) c.kill("SIGKILL");
  rmTempDir(SANDBOX);
});

let server: Server | null = null;
let deckPid: ChildProcess | null = null;
let shutdowns = 0;

async function listen44(s: Server): Promise<number> {
  for (const port of [4481, 4482, 4483, 4484, 4485]) {
    const ok = await new Promise<boolean>(done => {
      const onError = () => { s.off("listening", onUp); done(false); };
      const onUp = () => { s.off("error", onError); done(true); };
      s.once("error", onError);
      s.once("listening", onUp);
      s.listen(port, "127.0.0.1");
    });
    if (ok) return port;
  }
  throw new Error("no free 44xx port for the fake deck");
}

/** The deck the user launched: scoped to a workspace, so a default start is
 *  not its shape, and the same version as this checkout, so it is not older. */
beforeEach(async () => {
  shutdowns = 0;
  rmSync(CFG, { recursive: true, force: true });
  deckPid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  spawned.add(deckPid);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/hook-challenge") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ proof: challengeProof("t", url.searchParams.get("nonce") ?? "") }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/shutdown") {
      shutdowns++;
      res.end("{}");
      deckPid?.kill("SIGKILL");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const port = await listen44(server);
  mkdirSync(REGISTRY, { recursive: true });
  writeFileSync(join(REGISTRY, `${deckPid.pid}.json`), JSON.stringify({
    pid: deckPid.pid, port, token: "t",
    workspace: join(SANDBOX, "proj"), persist: null, codex: false, claude: false, version: PKG_VERSION,
  }));
});

afterEach(async () => {
  deckPid?.kill("SIGKILL");
  deckPid = null;
  await new Promise<void>(done => (server ? server.close(() => done()) : done()));
  server = null;
});

/** Run bin/deck.js until it exits, or until it has plainly gone on to boot. */
function runDeck(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((done, fail) => {
    let out = "";
    const c = spawn(process.execPath, [DECK, ...args], { stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV, cwd: SANDBOX });
    spawned.add(c);
    const finish = (code: number | null) => { clearTimeout(timer); c.kill("SIGKILL"); spawned.delete(c); done({ code, out }); };
    const seen = (d: Buffer) => {
      out += String(d);
      // Past the second start and into a boot of its own: the replace happened.
      if (/stopped the deck on|server ready/.test(out)) finish(null);
    };
    c.stdout!.on("data", seen);
    c.stderr!.on("data", seen);
    const timer = setTimeout(() => { c.kill("SIGKILL"); fail(new Error(`${args.join(" ")} did not settle:\n${out}`)); }, 40_000);
    c.on("error", e => { clearTimeout(timer); fail(e); });
    c.on("exit", code => finish(code));
  });
}

describe("the login item's deck beside the deck the user launched", () => {
  it("leaves that deck running, and does not start a second", async () => {
    const { code, out } = await runDeck(["--no-open", "--at-login", "--no-codex", "--no-claude", "--no-persist", "--port", "4499"]);
    expect(shutdowns, out).toBe(0);
    expect(code, out).toBe(0);
    expect(out).toContain("deck already running");
    expect(out).not.toContain("unknown option");
  }, 60_000);
});
