// The README says the deck cannot steer your agent. This is the file that makes
// that a property of the code rather than an intention.
//
// Claude Code's hook protocol gives a hook two channels to answer on, and both
// of them are decisions. A JSON object on STDOUT can allow, deny, defer or
// rewrite the tool call the event describes — `permissionDecision`,
// `hookSpecificOutput`, `continue: false` — and a NON-ZERO EXIT feeds stderr
// back as a block. hook.js takes neither: it POSTs the event to whichever decks
// are listening and ends. Nothing it does can change what the agent was about
// to do, which is the whole of what a reader is being asked to trust when they
// let a dashboard install a hook that runs on every tool call.
//
// Nothing else in the suite asserted it. One console.log left in from debugging,
// or one `process.exit(1)` on an error path, turns a read-only observer into a
// participant in every tool call on the machine — and silently, because a hook
// that prints unparseable text is ignored until the day it prints something
// parseable, and a hook that exits non-zero blocks the call it was reporting.
//
// So both halves are pinned twice. Once over the source, which fails on the line
// the moment it is written and names it; and once by running the real script
// through its whole happy path against a deck that answers the handshake, which
// covers anything a grep cannot see. The install path is somebody else's case:
// hook-script-atomic.test.ts pins that the file installed into the user's config
// dir is this one, byte for byte.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");
const SRC = readFileSync(HOOK, "utf8");

// hook.js is CommonJS inside a "type": "module" package, so it only loads as
// itself once outside that tree — which is also the only way it ever runs, the
// installer having copied it into the Claude config dir. Same .cjs copy
// hook-handshake.test.ts makes, and for the same reason.
const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-readonly-"));
const COPY = join(ROOT, "hook.cjs");
copyFileSync(HOOK, COPY);

// Its own challenge function, so the listener below can answer like a deck
// without importing the server. Whether the two derivations agree is
// hook-handshake.test.ts's question, not this file's.
const { challengeProof } = createRequire(import.meta.url)(COPY) as {
  challengeProof: (token: string, nonce: string) => string;
};

afterAll(() => rmTempDir(ROOT));

describe("the source names no way to speak on either channel", () => {
  it("cannot write to stdout at all", () => {
    // The decision channel. `console.log` is stdout with a different name, and
    // `fs.writeSync(1, …)` is stdout with no name at all, so all three spellings
    // are refused rather than the obvious one.
    expect(SRC).not.toMatch(/\bprocess\s*\.\s*stdout\b/);
    expect(SRC).not.toMatch(/\bconsole\s*\./);
    expect(SRC).not.toMatch(/\bwriteSync\s*\(/);
  });

  it("writes to exactly one thing, and it is an outbound request", () => {
    // The one `.write(` in the file, quoted, so a second one has to be looked at
    // by a human rather than slipping in beside it.
    const writes = SRC.split("\n").map(l => l.trim()).filter(l => /\.write\(/.test(l));
    expect(writes).toEqual(["req.write(body);"]);
  });

  it("ends every path with exit 0", () => {
    // The block channel. A hook that exits non-zero has its stderr handed back
    // as a refusal of the call it was reporting, so "always 0" is the other half
    // of "cannot steer" — and `process.exitCode` is the same thing set from a
    // distance, which is why it is banned outright rather than checked for a
    // value.
    const codes = [...SRC.matchAll(/process\s*\.\s*exit\s*\(([^)]*)\)/g)].map(m => m[1].trim());
    expect(codes.length).toBeGreaterThan(0);
    expect([...new Set(codes)]).toEqual(["0"]);
    expect(SRC).not.toMatch(/process\s*\.\s*exitCode/);
  });
});

/** A listener that answers the handshake the way a real deck does, and records
 *  what it was told. */
function honestDeck(token: string) {
  const seen: string[] = [];
  return {
    seen,
    handler(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/hook-challenge") {
        const proof = challengeProof(token, url.searchParams.get("nonce") ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ proof }));
      }
      seen.push(url.pathname);
      req.resume();
      req.on("end", () => res.writeHead(200).end());
    },
  };
}

interface Run { stdout: string; code: number | null }

/**
 * Run the installed-shape hook with its config dir pointed at a temp tree — the
 * real ~/.claude is never read or written, on any platform. `discovery` is the
 * record to leave in the discovery dir, or null to leave the dir empty.
 */
async function runHook(input: string, discovery: Record<string, unknown> | null): Promise<Run> {
  const home = mkdtempSync(join(ROOT, "home-"));
  const dir = join(home, "agent-dag");
  mkdirSync(dir, { recursive: true });
  if (discovery) writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify(discovery), "utf8");

  const child = spawn(process.execPath, [COPY, "--provider", "claude"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", c => { stdout += c; });
  child.stdin.end(input);
  const code = await new Promise<number | null>((done, fail) => {
    child.on("error", fail);
    child.on("exit", c => done(c));
  });
  return { stdout, code };
}

const EVENT = JSON.stringify({
  cwd: process.cwd(),
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /" },
});

describe("the script itself, run the way Claude Code runs it", () => {
  it("delivers the event and still says nothing back", async () => {
    // The happy path, end to end: a listener that proves it is a deck, an event
    // it accepts, and a silent hook. The delivery is asserted too — silence from
    // a hook that did nothing at all would prove nothing about the hook that
    // does the work.
    const token = randomBytes(16).toString("hex");
    const deck = honestDeck(token);
    const server: Server = createServer(deck.handler);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    try {
      const run = await runHook(EVENT, {
        pid: process.pid, port, workspace: "", token, startedAt: new Date().toISOString(),
      });
      expect(deck.seen).toEqual(["/api/event"]);
      expect(run.stdout).toBe("");
      expect(run.code).toBe(0);
    } finally {
      await new Promise<void>(done => {
        server.closeAllConnections?.();
        server.close(() => done());
      });
    }
  });

  it("says nothing on the paths where it gives up either", async () => {
    // Every early return in main(), which is where a diagnostic would be added
    // by somebody trying to work out why their deck was empty. A tool call must
    // not be decided differently because no deck was listening.
    for (const [why, input] of [
      ["no deck to post to", EVENT],
      ["a payload it cannot parse", "not json at all"],
      ["a payload with no cwd", JSON.stringify({ hook_event_name: "Stop" })],
    ] as const) {
      const run = await runHook(input, null);
      expect(run.stdout, why).toBe("");
      expect(run.code, why).toBe(0);
    }
  });
});

// THE PROPERTY THIS FILE ASSERTS, ASSERTED BY RUNNING IT.
//
// The sweep above greps for `process.exit(N)` literals, and a grep cannot see a
// throw. Four malformed discovery records each crashed the hook with exit 1 and
// a Node stack trace on stderr:
//
//   null                                   exit=1  hook.js:496 TypeError
//   {"pid":1,"port":"http","workspace":""} exit=1  ERR_SOCKET_BAD_PORT
//   {"pid":1,"port":-1,"workspace":""}     exit=1  ERR_SOCKET_BAD_PORT
//   {"pid":1,"port":{},"workspace":""}     exit=1  ERR_INVALID_ARG_TYPE
//
// `d.workspace` was read outside the try, so `null` threw on the property
// access; and `!d.port` admitted any truthy non-port, which reached
// http.request({ port }) and threw synchronously inside the forEach — before a
// single socket opened, so a healthy deck registered alongside was never even
// challenged. pid 1 is init, so isAlive is true forever and nothing removes the
// record: Claude Code surfaces the non-zero exit as `<hook> hook error` with the
// first stderr line, on every tool call, permanently.
describe("a registry holding something that is not a deck record", () => {
  const shapes: Array<[string, string]> = [
    ["a null record", "null"],
    ["a string port", '{"pid":1,"port":"http","workspace":""}'],
    ["a negative port", '{"pid":1,"port":-1,"workspace":""}'],
    ["an object port", '{"pid":1,"port":{},"workspace":""}'],
    ["a port out of range", '{"pid":1,"port":70000,"workspace":""}'],
    ["a pid that is not a number", '{"pid":"init","port":4317,"workspace":""}'],
    ["a top-level array", "[1,2,3]"],
    ["a record with no workspace", '{"pid":1,"port":4317}'],
  ];

  for (const [name, record] of shapes) {
    it(`exits 0 and says nothing on ${name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "ccdeck-hook-bad-record-"));
      try {
        const reg = join(dir, "claude", "agent-dag");
        mkdirSync(reg, { recursive: true });
        writeFileSync(join(reg, "99.json"), record, "utf8");
        const r = spawnSync(process.execPath, [COPY, "--provider", "claude"], {
          input: JSON.stringify({
            hook_event_name: "PreToolUse", session_id: "s1", cwd: dir,
            tool_name: "Bash", tool_use_id: "t1",
          }),
          env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "claude"), HOME: dir, USERPROFILE: dir },
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(r.status, `${name}: ${String(r.stderr).split("\n")[0]}`).toBe(0);
        expect(String(r.stderr), "nothing reaches the host CLI's transcript").toBe("");
        expect(String(r.stdout)).toBe("");
      } finally {
        rmTempDir(dir);
      }
    });
  }

  it("ignores a .json in the deck's home that is not a record at all", () => {
    // DIR is ~/.claude/agent-dag/, which is the deck's old home rather than a
    // registry: prefs.json lived there and deck-home.mjs's migration leaves the
    // original where it is. The filter keeps `${pid}.json` now, so the deck's
    // 0600 private-key file is not read on every tool call.
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-hook-prefs-"));
    try {
      const reg = join(dir, "claude", "agent-dag");
      mkdirSync(reg, { recursive: true });
      writeFileSync(join(reg, "prefs.json"), JSON.stringify({ lan: { secret: "PRIVATE" } }), "utf8");
      const r = spawnSync(process.execPath, [COPY, "--provider", "claude"], {
        input: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: dir }),
        env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "claude"), HOME: dir, USERPROFILE: dir },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(r.status).toBe(0);
      expect(String(r.stderr)).toBe("");
    } finally {
      rmTempDir(dir);
    }
  });
});
