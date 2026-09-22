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

interface Run { stdout: string; stderr: string; code: number | null }

/**
 * Run the installed-shape hook with its config dir pointed at a temp tree — the
 * real ~/.claude is never read or written, on any platform. `discovery` is the
 * record to leave in the discovery dir, or null to leave the dir empty.
 *
 * `files` are more entries for the same dir, by name, and `env` is laid over
 * the child's environment — `undefined` takes a variable out of it.
 */
async function runHook(
  input: string,
  discovery: Record<string, unknown> | null,
  { files = {}, env = {} }: {
    files?: Record<string, Record<string, unknown>>;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<Run> {
  const home = mkdtempSync(join(ROOT, "home-"));
  const dir = join(home, "agent-dag");
  mkdirSync(dir, { recursive: true });
  if (discovery) writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify(discovery), "utf8");
  for (const [name, record] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(record), "utf8");
  }

  const childEnv: Record<string, string | undefined> = {
    ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home, ...env,
  };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  const child = spawn(process.execPath, [COPY, "--provider", "claude"], {
    env: childEnv as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", c => { stdout += c; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", c => { stderr += c; });
  child.stdin.end(input);
  const code = await new Promise<number | null>((done, fail) => {
    child.on("error", fail);
    child.on("exit", c => done(c));
  });
  return { stdout, stderr, code };
}

/** An honest deck on a port of its own, and the record that registers it. */
async function startDeck() {
  const token = randomBytes(16).toString("hex");
  const deck = honestDeck(token);
  const server: Server = createServer(deck.handler);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    seen: deck.seen,
    record: { pid: process.pid, port, workspace: "", token, startedAt: new Date().toISOString() },
    close: () => new Promise<void>(done => {
      server.closeAllConnections?.();
      server.close(() => done());
    }),
  };
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

describe("a Claude Code run the deck started itself", () => {
  // The quota probe runs `claude --print /usage`, which is a whole Claude Code
  // invocation and fires these hooks like any other. quota.mjs marks that run
  // with AGENTS_DECK_INTERNAL=1 and the hook ends before it reads a byte;
  // without it, every quota poll drew itself on the canvas as a session with no
  // prompt and no tools, and went into events.jsonl as one. Only the variable's
  // name appeared anywhere in the suite, so a rename on either side left every
  // case green. The probe's half is in quota-quiet-failure.test.ts.
  it("is not reported to any deck, which is not even challenged", async () => {
    const deck = await startDeck();
    try {
      const run = await runHook(EVENT, deck.record, { env: { AGENTS_DECK_INTERNAL: "1" } });
      expect(deck.seen).toEqual([]);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe("");
    } finally {
      await deck.close();
    }
  });

  it("is told by the value, so a session with the variable unset or 0 still reports", async () => {
    for (const value of ["0", undefined]) {
      const deck = await startDeck();
      try {
        const run = await runHook(EVENT, deck.record, { env: { AGENTS_DECK_INTERNAL: value } });
        expect(deck.seen, `AGENTS_DECK_INTERNAL=${value}`).toEqual(["/api/event"]);
        expect(run.code).toBe(0);
      } finally {
        await deck.close();
      }
    }
  });
});

describe("an event the hook cannot handle", () => {
  // THE LAST RESORT, REACHED. main() installs an `uncaughtException` handler
  // that ends the process at 0 in silence, and since the record guard below went
  // in, no case in this file reached it: every throw it used to catch is
  // refused before it can happen. Two events still throw, both past the guard:
  //
  //   a cwd that is not a string     path.resolve: ERR_INVALID_ARG_TYPE
  //   nesting past JSON.stringify    RangeError: JSON.parse walks nesting
  //                                  iteratively and accepts it, stringify
  //                                  recurses and gives up near 4,000 levels
  //
  // Measured with the handler deleted: exit 1 and a Node stack trace on stderr,
  // which Claude Code puts in front of the user as `<event> hook error` on every
  // such tool call — and nothing else in the suite failed, because every payload
  // in it was flat. The deep one needs a deck registered to get that far: the
  // event is only serialised once there is somebody to send it to. 20,000 levels
  // is five times the depth stringify gives up at, so it throws on every leg
  // however deep that platform's stack goes.
  //
  // These assert that the hook stays out of the transcript, and no more. Where
  // the deep event should go is #1180: today it reaches no deck.
  const deep = (levels: number) =>
    `{"hook_event_name":"PostToolUse","session_id":"s1","cwd":${JSON.stringify(process.cwd())},"deep":`
    + '{"a":'.repeat(levels) + "1" + "}".repeat(levels) + "}";

  for (const [what, input] of [
    ["an event nested deeper than JSON.stringify goes", deep(20_000)],
    ["a cwd that is a number", '{"hook_event_name":"Stop","session_id":"s1","cwd":42}'],
    ["a cwd that is an object", '{"cwd":{}}'],
  ] as const) {
    it(`exits 0 and says nothing on ${what}`, async () => {
      const deck = await startDeck();
      try {
        const run = await runHook(input, deck.record);
        expect(run.code, run.stderr.split("\n")[0]).toBe(0);
        expect(run.stderr, "nothing reaches the host CLI's transcript").toBe("");
        expect(run.stdout).toBe("");
      } finally {
        await deck.close();
      }
    });
  }
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

  it("still hands the event to the deck registered beside it", async () => {
    // WHAT THE EIGHT ABOVE CANNOT SEE, and it is the half that matters.
    //
    // They assert silence, and silence is what main()'s `uncaughtException`
    // handler produces whether the guard refused the record or not: weaken the
    // guard back to `!d.port` and every one of them still passes, because the
    // TypeError is caught and the process still ends at 0 with an empty stderr.
    // What the guard buys, and the handler cannot, is the EVENT. A port of
    // `"http"` reaches http.request({ port }) while the targets are being
    // challenged and throws there, so the healthy deck sitting in the same
    // registry is never posted to — measured that way round, the difference is
    // one delivered event against none.
    //
    // It is also the half that had to be re-established when the registry reads
    // went asynchronous (#1018): the throw now comes out of an fs callback
    // rather than a loop in main(), so "the handler catches it" and "the deck
    // gets its event" came apart even further. The record has to be refused
    // where it is read.
    const token = randomBytes(16).toString("hex");
    const deck = honestDeck(token);
    const server: Server = createServer(deck.handler);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-hook-bad-plus-good-"));
    try {
      const reg = join(dir, "claude", "agent-dag");
      mkdirSync(reg, { recursive: true });
      writeFileSync(join(reg, "1.json"), '{"pid":1,"port":"http","workspace":""}', "utf8");
      writeFileSync(join(reg, `${process.pid}.json`), JSON.stringify({
        pid: process.pid, port, workspace: "", token, startedAt: new Date().toISOString(),
      }), "utf8");
      // `spawn`, not the `spawnSync` the shapes above use: this test's listener
      // has to ANSWER, and a synchronous spawn blocks the event loop that
      // listener is on — the hook then talks to a server that cannot reply and
      // the assertion fails for a reason that has nothing to do with the hook.
      const child = spawn(process.execPath, [COPY, "--provider", "claude"], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "claude"), HOME: dir, USERPROFILE: dir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", c => { stderr += c; });
      child.stdin.end(JSON.stringify({
        hook_event_name: "PreToolUse", session_id: "s1", cwd: dir,
        tool_name: "Bash", tool_use_id: "t1",
      }));
      const code = await new Promise<number | null>((done, fail) => {
        child.on("error", fail);
        child.on("exit", c => done(c));
      });
      expect(code, stderr.split("\n")[0]).toBe(0);
      expect(stderr).toBe("");
      expect(deck.seen, "the deck that is a deck was still posted to").toEqual(["/api/event"]);
    } finally {
      rmTempDir(dir);
      await new Promise<void>(done => {
        server.closeAllConnections?.();
        server.close(() => done());
      });
    }
  });

  it("reads only `${pid}.json`, however much another file looks like a record", async () => {
    // DIR is ~/.claude/agent-dag/, which is the deck's old home rather than a
    // registry: prefs.json lived there and deck-home.mjs's migration leaves the
    // original where it is. The filter keeps `${pid}.json` now, so the deck's
    // 0600 private-key file is not read on every tool call.
    //
    // This case used to write a prefs.json with no pid in it and check for
    // silence — which the record guard gives on its own, so it passed with the
    // filter deleted. Each file here is a record the guard would take, naming a
    // deck that answers its challenge: a prefs.json that happens to carry a
    // record's fields, a name with no pid in it, and the temp file an atomic
    // write leaves beside a record. The first deck is posted to only if one of
    // them is read.
    const decoy = await startDeck();
    const deck = await startDeck();
    try {
      const run = await runHook(EVENT, deck.record, {
        files: {
          "prefs.json": { ...decoy.record, lan: { secret: "PRIVATE" } },
          "deck-1.json": decoy.record,
          [`${process.pid}.json.tmp`]: decoy.record,
        },
      });
      expect(run.code, run.stderr.split("\n")[0]).toBe(0);
      expect(run.stderr).toBe("");
      expect(decoy.seen, "a file that is not `${pid}.json` was read as a record").toEqual([]);
      expect(deck.seen, "the record beside them was still posted to").toEqual(["/api/event"]);
    } finally {
      await decoy.close();
      await deck.close();
    }
  });
});
