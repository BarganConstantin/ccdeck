// THE HOOK'S TIMING PROMISE, AND THE TWO WAYS IT WAS NOT ONE.
//
// hook/hook.js runs on every Claude Code and Codex event, under a `timeout`
// the installer declares in the user's own settings.json. That timeout is a
// KILL: when it expires the host CLI takes the hook down where it stands, the
// deck gets a truncated body, and because PreToolUse blocks the tool call until
// every matching hook returns, the user pays the whole of it on that turn. So
// the hook caps itself well under the declared value and ends itself rather
// than being killed. Both halves of that were false (#1018).
//
// ONE. The cap was `setTimeout(… , 1900)` on the same thread as every `fs` call
// it was written to bound. fs.readdirSync, fs.readFileSync and
// fs.realpathSync.native do not yield: while one of them is in the kernel the
// timer cannot run. Measured against a registry holding one record the
// filesystem never answers for, with a healthy deck registered beside it:
//
//   STILL ALIVE after 12008ms — cap never fired
//   deck saw: []            — the healthy deck was never even challenged
//
// and the realistic trigger is not exotic: $HOME on NFS/autofs/SMB, a
// CLAUDE_CONFIG_DIR on a network share, or the session's own cwd on a FUSE
// mount — a directory this process is handed rather than one it picked.
//
// TWO. The cap was armed at the top of main(), so everything before main() —
// the `sh -c` the host CLI runs the command through, Node's own startup — was
// spent outside the budget and charged to it anyway. Measured through the exact
// installed command shape, one ghost record stalling the challenge and a deck
// that answers the handshake and then never answers the POST:
//
//   idle, 16 cores, 134-byte payload:  1.847s  1.837s  1.836s
//   48 busy workers:                   1.978s  2.010s  2.190s   ← past timeout: 2
//   48 busy workers + 2MB payload:     2.160s  2.126s  2.165s   ← past timeout: 2
//
// A 2MB `tool_response` is an ordinary Read or Grep result, and a loaded box is
// the one the challenge retry exists for in the first place.
//
// The slow filesystem here is INJECTED rather than real — a `-r` preload that
// patches the fs module in front of the hook — so these assertions are about
// what the hook does, not about how slow this machine happens to be today. A
// real stalled mount is not something a test suite can arrange on three
// platforms, and a wall clock on CI is not evidence of anything.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "..", "..", "hook", "hook.js");
const INSTALLER = join(HERE, "..", "..", "server", "installer.mjs");

// hook.js is CommonJS inside a "type": "module" package, so it only runs as
// itself outside that tree — which is also the only way it ever runs, the
// installer having copied it into the Claude config dir. Same .cjs copy
// hook-read-only.test.ts and hook-handshake.test.ts make, for the same reason.
const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-budget-"));
const HOOK_COPY = join(ROOT, "hook.cjs");
copyFileSync(HOOK, HOOK_COPY);

afterAll(() => rmTempDir(ROOT));

/** The two numbers that have to stay in a fixed relation, read from the files
 *  that state them rather than restated here.
 *
 *  The cap is looked for in both spellings it has had — the named constant, and
 *  the bare literal that used to sit inside the setTimeout in main(). Not for
 *  history's sake: a check that can only see one spelling stops checking the
 *  moment somebody moves the number, and stops silently. */
function declaredBudget() {
  const hook = readFileSync(HOOK, "utf8");
  const installer = readFileSync(INSTALLER, "utf8");
  const cap = /^const CAP_MS = (\d+);$/m.exec(hook)
    ?? /setTimeout\(\(\) => process\.exit\(0\), (\d+)\)/.exec(hook);
  const declared = /hooks: \[\{ type: "command", command, timeout: (\d+) \}\]/.exec(installer);
  expect(cap, "hook.js states its own cap as `const CAP_MS = <n>;`").toBeTruthy();
  expect(declared, "installer.mjs states the declared timeout in buildHookEntry").toBeTruthy();
  return { capMs: Number(cap![1]), declaredMs: Number(declared![1]) * 1000 };
}

const DECK_TOKEN = "0".repeat(64);
const proofFor = (nonce: string) =>
  createHash("sha256").update(`${DECK_TOKEN}:${nonce}`).digest("hex");

/** A listener standing in for a deck. `answerPost: false` accepts the POST body
 *  and never replies, which is the shape that makes the hook spend its whole
 *  POST deadline. */
async function deckListener({ answerPost = true } = {}) {
  const seen: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    req.on("error", () => {});
    res.on("error", () => {});
    req.resume();
    req.on("end", () => {
      if (url.pathname === "/api/hook-challenge") {
        seen.push("challenge");
        return res.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ proof: proofFor(url.searchParams.get("nonce") ?? "") }));
      }
      seen.push(url.pathname);
      if (answerPost) res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  return { seen, port, close };
}

/**
 * The preload that stands in for a filesystem that does not answer.
 *
 * Every fs entry point the hook reaches a path through, patched to hang on any
 * path containing `mark` and to pass everything else straight through. The
 * SYNCHRONOUS ones block the thread the way the kernel would — Atomics.wait,
 * which parks it with no timer, no IO and no event loop — and the asynchronous
 * ones simply never call back, which is what a threadpool request that never
 * completes looks like from the event loop's side.
 *
 * It is the sync half that is the whole experiment: a hook that reaches a
 * blocking call on a path like this cannot run its own exit timer, and there is
 * no wall clock in the assertion below, only "did it come back at all".
 */
function stallingFs(mark: string) {
  return `
const fs = require("fs");
const MARK = ${JSON.stringify(mark)};
const hit = p => typeof p === "string" && p.includes(MARK);
const forever = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);

const readFileSync = fs.readFileSync;
fs.readFileSync = function (p, ...rest) { if (hit(p)) forever(); return readFileSync.call(fs, p, ...rest); };
const readFile = fs.readFile;
fs.readFile = function (p, ...rest) { if (hit(p)) return; return readFile.call(fs, p, ...rest); };

const realpathSyncNative = fs.realpathSync.native;
fs.realpathSync.native = function (p, ...rest) { if (hit(p)) forever(); return realpathSyncNative.call(fs, p, ...rest); };
const realpathNative = fs.realpath.native;
fs.realpath.native = function (p, ...rest) { if (hit(p)) return; return realpathNative.call(fs, p, ...rest); };
`;
}

/** Burn `ms` of startup before the hook's first line runs, without a timer and
 *  without touching the disk — a stand-in for the shell fork/exec plus Node
 *  startup on a box running 335 test files at once. */
function slowStart(ms: number) {
  return `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});\n`;
}

interface Run { code: number | null; signal: string | null; wallMs: number; stderr: string }

/**
 * Run the installed-shape hook against a registry of our own, optionally behind
 * a `-r` preload. Never reads or writes the real ~/.claude: CLAUDE_CONFIG_DIR,
 * HOME and USERPROFILE all point into the temp tree.
 *
 * `limitMs` is a backstop for a hook that never returns — the failure this file
 * exists to catch — and killing it is the RED signal, not a flake.
 */
async function runHook(opts: {
  records: Record<string, Array<Record<string, unknown>> | Record<string, unknown>>;
  cwd?: string;
  preload?: string;
  limitMs?: number;
  /** Written to stdin in place of the event, which is then never closed. */
  openStdin?: string;
}): Promise<Run> {
  const home = mkdtempSync(join(ROOT, "home-"));
  const dir = join(home, "agent-dag");
  mkdirSync(dir, { recursive: true });
  for (const [name, record] of Object.entries(opts.records)) {
    writeFileSync(join(dir, name), JSON.stringify({ token: DECK_TOKEN, ...record }), "utf8");
  }

  const args = [HOOK_COPY, "--provider", "claude"];
  if (opts.preload) {
    const pre = join(home, "preload.cjs");
    writeFileSync(pre, opts.preload, "utf8");
    args.unshift("-r", pre);
  }

  const t0 = Date.now();
  const child = spawn(process.execPath, args, {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", c => { stderr += c; });
  // A hook that ends while its stdin is still open leaves this end of the pipe
  // with nobody reading it.
  child.stdin.on("error", () => {});
  if (opts.openStdin !== undefined) child.stdin.write(opts.openStdin);
  else child.stdin.end(JSON.stringify({
    hook_event_name: "PreToolUse", session_id: "s1", cwd: opts.cwd ?? home,
    tool_name: "Bash", tool_use_id: "t1",
  }));

  return await new Promise<Run>(done => {
    const kill = setTimeout(() => child.kill("SIGKILL"), opts.limitMs ?? 8_000);
    child.on("exit", (code, signal) => {
      clearTimeout(kill);
      child.stdin.destroy();
      done({ code, signal, wallMs: Date.now() - t0, stderr });
    });
  });
}

describe("a registry entry the filesystem never answers for", () => {
  it("does not take the event away from the deck that is up", async () => {
    // The reported shape: one record whose read hangs, one healthy deck beside
    // it. Every read used to be synchronous, so the hang was the whole process:
    // the exit timer never got a turn, the healthy deck was never challenged,
    // and the hook was still running twelve seconds later. Nothing about that
    // is visible from the deck, which goes on saying it is connected.
    //
    // The assertion is not a duration. It is that the hook came back at all and
    // that the healthy deck was handed the event while the stalled read was
    // still outstanding — neither of which can happen on one thread.
    const deck = await deckListener();
    // `<pid>0.json` rather than a number picked out of the air: a discovery
    // record is named for the deck's pid, this one has to be a name the live
    // record cannot also have, and it must not be a substring of it either —
    // the preload decides what to stall by matching the path.
    const stalled = `${process.pid}0.json`;
    try {
      const run = await runHook({
        records: {
          [stalled]: { pid: process.pid, port: 1, workspace: "" },
          [`${process.pid}.json`]: { pid: process.pid, port: deck.port, workspace: "" },
        },
        preload: stallingFs(stalled),
      });
      expect(run.signal, "the hook never returned: a blocking fs call outran its own cap").toBe(null);
      expect(run.code, run.stderr.split("\n")[0]).toBe(0);
      expect(deck.seen, "the deck that answered was handed the event").toContain("/api/event");
    } finally {
      await deck.close();
    }
  }, 30_000);
});

describe("a session whose own cwd will not canonicalise", () => {
  it("falls back to the resolved spelling rather than dropping the event", async () => {
    // The widest surface of the three, because this path is not the deck's and
    // not the user's config: it is wherever the agent happens to be running,
    // which is routinely a network or FUSE mount. It used to be
    // fs.realpathSync.native on the main thread, ahead of everything else the
    // hook does, so a mount that would not answer for it ended the run before
    // the registry was even listed.
    //
    // Downgrading rather than giving up is the deliberate half: path.resolve of
    // the cwd is the same answer normPath gives for a path that does not
    // resolve at all, and it is exactly what a machine-wide deck — the default
    // — needs in order to be posted to.
    const deck = await deckListener();
    const cwd = join(ROOT, "stalled-mount-cwd", "proj");
    mkdirSync(cwd, { recursive: true });
    try {
      const run = await runHook({
        records: { [`${process.pid}.json`]: { pid: process.pid, port: deck.port, workspace: "" } },
        cwd,
        preload: stallingFs("stalled-mount-cwd"),
      });
      expect(run.signal, "the hook never returned: realpathSync.native outran its own cap").toBe(null);
      expect(run.code, run.stderr.split("\n")[0]).toBe(0);
      expect(deck.seen, "the machine-wide deck was still posted to").toContain("/api/event");
    } finally {
      await deck.close();
    }
  }, 30_000);
});

describe("the budget the host CLI is asked to allow for", () => {
  it("is strictly larger than the budget the hook allows itself", () => {
    // The arithmetic that was wrong in the file rather than in any one run:
    // 400 + 400 for the challenge plus 1000 for the POST, capped at 1900, under
    // a declared 2000 — which leaves 100ms for a shell fork, an interpreter
    // start and reading a megabyte of stdin, and they do not fit. Both numbers
    // are read from the files that state them, so raising one without the other
    // fails here instead of on somebody's machine.
    const { capMs, declaredMs } = declaredBudget();
    expect(declaredMs).toBeGreaterThan(capMs);
    // And with room for the startup that is still outside the cap. Half a
    // second is not a measurement, it is the smallest headroom worth declaring:
    // the gap used to be 100ms and a loaded box ate it three times over.
    expect(declaredMs - capMs).toBeGreaterThanOrEqual(500);
  });

  it("holds even when the interpreter took most of the cap to start", async () => {
    // The cap now runs from Node's start, not from main()'s — so a slow start
    // eats the budget instead of being added to it. 1800ms of startup in front
    // of a deck that answers the handshake and then never answers the POST: the
    // old timer would have added its own 1900 on top of that and come back at
    // ~3.7s, past any timeout anyone would declare. The bound asserted is the
    // declared timeout itself, read from the installer, because that is the
    // number that decides whether the host kills the hook.
    const { declaredMs } = declaredBudget();
    const deck = await deckListener({ answerPost: false });
    try {
      const run = await runHook({
        records: { [`${process.pid}.json`]: { pid: process.pid, port: deck.port, workspace: "" } },
        preload: slowStart(1800),
        limitMs: 12_000,
      });
      expect(run.signal).toBe(null);
      expect(run.code, run.stderr.split("\n")[0]).toBe(0);
      expect(deck.seen, "it still did the work — a hook that exits early proves nothing")
        .toContain("/api/event");
      expect(run.wallMs, `startup + cap must fit under the declared ${declaredMs}ms`)
        .toBeLessThan(declaredMs);
    } finally {
      await deck.close();
    }
  }, 30_000);
});

describe("the exit timer, on the two runs that lean on it hardest", () => {
  it("ends the hook when the host never closes stdin, because it is armed before the read", async () => {
    // Every other case in the suite ends stdin at once, so nothing said WHEN the
    // timer is armed relative to the read. It is armed first. Armed in the
    // `end` handler instead, a host that writes part of an event and never
    // closes the pipe holds the hook until the host's own kill — the full
    // declared timeout — and on a PreToolUse the tool call waits all of it.
    const { declaredMs } = declaredBudget();
    const run = await runHook({ records: {}, openStdin: '{"cwd":', limitMs: 12_000 });
    expect(run.signal, "the hook waited on an open stdin past its own cap").toBe(null);
    expect(run.code, run.stderr.split("\n")[0]).toBe(0);
    expect(run.wallMs, `an open stdin must still end under the declared ${declaredMs}ms`)
      .toBeLessThan(declaredMs);
  }, 30_000);

  it("still posts when the interpreter took longer than the whole cap to start", async () => {
    // The floor, which the 1800ms case above cannot see: that one leaves the
    // cap about 100ms, which is still positive, and a loopback delivery fits in
    // it with or without a floor. Here startup alone runs past CAP_MS, so
    // `CAP_MS - uptime` is negative and only `Math.max(200, …)` keeps the timer
    // from firing before a socket is open. That is the machine under real load
    // — the one a deck is most worth posting to — and exiting there would drop
    // the event to save nothing.
    const { capMs, declaredMs } = declaredBudget();
    const deck = await deckListener();
    try {
      const run = await runHook({
        records: { [`${process.pid}.json`]: { pid: process.pid, port: deck.port, workspace: "" } },
        preload: slowStart(capMs + 400),
        limitMs: 12_000,
      });
      expect(run.signal).toBe(null);
      expect(run.code, run.stderr.split("\n")[0]).toBe(0);
      expect(deck.seen, "the timer fired before the event went out").toContain("/api/event");
      expect(run.wallMs, `startup + floor must fit under the declared ${declaredMs}ms`)
        .toBeLessThan(declaredMs);
    } finally {
      await deck.close();
    }
  }, 30_000);
});
