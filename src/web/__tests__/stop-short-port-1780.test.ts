// #1780: `ccdeck --stop -p4317` stopped every deck on the machine.
//
// The short option with its value attached — `-p4317`, or `-p=4317` — was not
// read as a port. parseArgs split `name=value` only for tokens starting with
// `--` and matched `-p` only as a whole token, so the attached form landed in
// `unknown` and `flags.port` stayed undefined. `--stop` reads "no port" as
// "every deck", and refusesPort, which exists to make `--stop` fail closed on a
// port it cannot use, looked only at `incomplete` and a malformed `flags.port`,
// so it let the command through. Reproduced before the fix:
//
//     parseArgs(["--stop", "-p4317"])  -> { unknown: ["-p4317"], incomplete: [], stop: true }
//     parseArgs(["--stop", "-p=4317"]) -> { unknown: ["-p=4317"], incomplete: [], stop: true }
//
// and, end to end, `--stop -p<n>` beside a deck on another port asked that
// deck to shut down and exited 0.
//
// #1001 closed the same fail-open for `--port=4317`; this is the short spelling
// of it, and a port-shaped token the parser still does not know
// (`--port4499`), which now refuses instead of widening.
//
// THE DECK IS FAKE. The CLI is spawned for real with every path in a temp
// directory, and the "deck" it finds is a registry record naming a child
// process of this test, with a small server of this test's own answering the
// challenge `liveDecks` sends on a 44xx port and recording any shutdown it is
// asked for. Nothing here reads or writes the real registry.
import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { parseArgs } = await import("../../server/args.mjs");
// @ts-expect-error — plain .mjs module, no types
const { challengeProof } = await import("../../server/deck-probe.mjs");

const DECK = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));

describe("the short port option with its value attached", () => {
  it("reads `-p4317` as `-p 4317`", () => {
    expect(parseArgs(["--stop", "-p4317"])).toEqual({ stop: true, port: "4317", unknown: [], incomplete: [] });
  });

  it("reads `-p=4317` as `-p 4317`", () => {
    expect(parseArgs(["--stop", "-p=4317"])).toEqual({ stop: true, port: "4317", unknown: [], incomplete: [] });
  });

  it("calls `-p=` a missing value, the way `--port=` already is", () => {
    const out = parseArgs(["-p="]);
    expect(out.port).toBeUndefined();
    expect(out.incomplete).toEqual([{ flag: "-p", expects: "a port number" }]);
    expect(out.unknown).toEqual([]);
  });

  it("hands a malformed attached value to the port check rather than dropping it", () => {
    // `-p431x` is a port the user meant and mistyped: it has to reach the check
    // that names it, not vanish into `unknown` and widen a stop to every deck.
    expect(parseArgs(["-p431x"])).toEqual({ port: "431x", unknown: [], incomplete: [] });
  });

  it("leaves every other single-dash token alone", () => {
    expect(parseArgs(["-p", "4500"]).port).toBe("4500");
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["-x4317"]).unknown).toEqual(["-x4317"]);
    expect(parseArgs(["-"]).unknown).toEqual(["-"]);
  });
});

// ── the CLI, spawned ────────────────────────────────────────────────────────

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-stop-short-port-"));
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
  AGENT_DAG_PORT: "",
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
};

// A `--stop` outside the sandbox would end the developer's own deck.
for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
  if (!resolve(String(CHILD_ENV[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
}

afterAll(() => rmTempDir(SANDBOX));

let server: Server | null = null;
let deckPid: ChildProcess | null = null;
let deckPort = 0;
let shutdowns = 0;

/** Listen on the first free port of a few in the 44xx range. */
async function listen44(s: Server): Promise<number> {
  for (const port of [4486, 4487, 4488, 4489, 4491, 4493]) {
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

/** A process that stands for the deck's pid and a server that answers for its
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
      shutdowns++;
      res.end("{}");
      deckPid?.kill("SIGKILL");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  deckPort = await listen44(server);
  mkdirSync(REGISTRY, { recursive: true });
  writeFileSync(join(REGISTRY, `${deckPid.pid}.json`), JSON.stringify({ pid: deckPid.pid, port: deckPort, token: "t" }));
}

beforeEach(async () => {
  shutdowns = 0;
  rmSync(CFG, { recursive: true, force: true });
  await fakeDeck();
});

afterEach(async () => {
  deckPid?.kill("SIGKILL");
  deckPid = null;
  await new Promise<void>(done => (server ? server.close(() => done()) : done()));
  server = null;
});

function runCli(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done, fail) => {
    let out = "";
    let err = "";
    const c = spawn(process.execPath, [DECK, ...args], { stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV, cwd: SANDBOX });
    c.stdout!.on("data", d => { out += String(d); });
    c.stderr!.on("data", d => { err += String(d); });
    const timer = setTimeout(() => { c.kill("SIGKILL"); fail(new Error(`${args.join(" ")} did not exit:\n${out}${err}`)); }, 30_000);
    c.on("error", e => { clearTimeout(timer); fail(e); });
    c.on("exit", code => { clearTimeout(timer); done({ code, out, err }); });
  });
}

describe("`--stop` with the port attached to `-p`", () => {
  // 4499 is a port no deck here is on — the spawned runs never name 4317,
  // so nothing they do can reach a deck that is really running on it.
  for (const spelling of ["-p4499", "-p=4499"]) {
    it(`${spelling} leaves a deck on another port running`, async () => {
      const { code, out, err } = await runCli(["--stop", spelling]);
      expect(shutdowns, `${out}${err}`).toBe(0);
      expect(code, `${out}${err}`).toBe(0);
      expect(out).toContain("no deck is listening on 4499");
      expect(err).not.toContain("unknown option");
    }, 45_000);
  }

  it("`-p<port>` still stops the deck on that port", async () => {
    // The narrowing is real, not a stop that now matches nothing.
    const { code, out, err } = await runCli(["--stop", `-p${deckPort}`]);
    expect(code, `${out}${err}`).toBe(0);
    expect(shutdowns).toBe(1);
    expect(out).toContain(`port ${deckPort}`);
  }, 45_000);

  it("refuses a port-shaped token it cannot read, instead of stopping every deck", async () => {
    const { code, out, err } = await runCli(["--stop", "--port4499"]);
    expect(shutdowns, `${out}${err}`).toBe(0);
    expect(code).toBe(1);
    expect(err).toContain("unknown option");
    expect(err).toContain("refusing to stop every deck when you asked for one.");
  }, 45_000);
});
