// The third ending post() can report, and the only one nothing ran into.
//
// #1019 gave the election a second place: a writer that does not take the event
// hands the log to the next deck in its group. #1133 then took ONE ending back
// out of that hand-on — a writer that read the whole body and let the POST
// deadline pass may still be about to append the line, and asking a second deck
// to append it as well is how one event became two. The line that sorts the two
// apart is the whole of it:
//
//     req.on("error", () => finish(false, timedOut && sent ? "deadline" : null));
//
// `sent` is the 'finish' event — the kernel taking the last byte of the body —
// so `timedOut && sent` reads as "we gave up on a writer that HAS the event",
// while a deadline with the body still half out is a writer that STOPPED
// READING. It cannot have logged what it never received, so that one is a
// refusal and hands the log on.
//
// elected-writer-answers-1019.test.ts covers the 500, the mid-body hang-up and
// the writer that goes silent after reading everything; writer-answers-late-1133
// covers the late 200. In none of them does the writer stall with the body still
// going out — so nothing ran that branch, and it turned out not to work.
//
// WHAT IT DID. `sent` was read in the 'error' handler, and by the time that runs
// the answer is always yes: destroying a request that has been end()ed finalises
// its writable, which emits 'finish', so `sent` flips on the way out of
// req.destroy() one tick before the 'error' that destroy causes. Measured on
// Node 22 against a listener that takes the headers and stops reading, 256MB
// still queued:
//
//   TIMEOUT  sent=false  writableLength=268435608
//   FINISH   writableFinished=true  pending=0
//   ERROR    ECONNRESET  sent=true          <- verdict "deadline"
//
// Every deadline was a "deadline", the whole `&& sent` half was unreachable,
// and a writer wedged mid-read kept a log it had never received while the deck
// behind it — which could have written the line — was never asked. The fix is
// in this branch and is one snapshot: the body's state is read WHEN THE
// DEADLINE FIRES. See post() in hook/hook.js.
//
// WHY THE STATE IS INJECTED. This case needs one state — the deadline fires
// while the body is still going out, and 'finish' then arrives on the way out
// of req.destroy() — and no machine will hold it still on three operating
// systems.
//
// A listener that takes the headers and stops reading was the obvious way in,
// and it fails from both ends. On macOS the kernel goes on absorbing the body
// into its own buffers for seconds, and POST_TIMEOUT_MS is an IDLE timeout, so
// the deadline never arrives at all: measured with a real hook and payloads of
// 2, 3, 5 and 16MB, the hook ran to CAP_MS every time and no hand-on could have
// fitted inside it whatever post() decided (a second defect and a timing trade
// of its own — #1195). On Windows the opposite: a 16MB body was off the sender
// inside 400ms although the peer had stopped reading, because pausing a socket
// there does not stop libuv reading into memory — so `sent` was true by any
// deadline worth waiting for and the case could not be produced at all. A
// bigger payload buys one platform and costs the other.
//
// So the preload below plays back only the measured stalled-send state rather
// than waiting for a kernel to volunteer it, the way liveness's EACCES is
// injected in hook-handshake.test.ts and a stalled filesystem is in
// hook-budget.test.ts. It holds the body in this process; post()'s own send
// deadline must now detect that stall. Destroy then emits 'finish' before the
// error, preserving the measured ordering. Everything the assertions read is
// the hook's: when its real deadline fires, what verdict it produces, whether
// the log is handed on, and which deck is asked next. Only the writer's POST is
// touched; its challenge is answered and proved for real.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "..", "..", "hook", "hook.js");

// hook.js is CommonJS inside a "type": "module" package, so it only loads as
// itself outside that tree — which is also the only way it ever runs, the
// installer having copied it into the Claude config dir. Same .cjs copy
// elected-writer-answers-1019.test.ts makes, for the same reason. The copy also
// hands back the hook's own challenge derivation, so the listeners below can
// answer without importing the server.
const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-midbody-"));
const HOOK_COPY = join(ROOT, "hook.cjs");
copyFileSync(HOOK, HOOK_COPY);
const { challengeProof } = createRequire(import.meta.url)(HOOK_COPY) as {
  challengeProof: (token: string, nonce: string) => string;
};

/** The timeout the installer declares in the user's settings.json, read from the
 *  file that states it — the number the host CLI kills the hook at, and the one
 *  a hand-on has to fit inside rather than a wall clock chosen here. */
const DECLARED_MS = (() => {
  const src = readFileSync(join(HERE, "..", "..", "server", "installer.mjs"), "utf8");
  const m = /hooks: \[\{ type: "command", command, timeout: (\d+) \}\]/.exec(src);
  expect(m, "installer.mjs states the declared timeout in buildHookEntry").toBeTruthy();
  return Number(m![1]) * 1000;
})();

/**
 * The `-r` preload that puts the writer's POST into the one state this case is
 * about, and then plays back the ordering Node gives it.
 *
 * Only POSTs to `port` are touched, so the challenge to that same port is real,
 * answered and proved. For those POSTs: the headers go out on their own — the
 * writer must be ASKED, or nothing under test happened — and the body is then
 * handed to a socket that writes nothing more, so the request is ended with its
 * body still pending and post()'s `sent` is false. The hook's own send deadline
 * is left untouched; when it destroys the request, 'finish' follows before the
 * error, which is what a real wedged request does.
 *
 * The body has to be held back until after the headers are on the wire:
 * _flushOutput corks the socket, writes every queued entry and uncorks, so a
 * body written before the socket exists — which is when post() writes it —
 * leaves WITH the headers and cannot be separated from them there.
 */
const wedgeWriter = (port: number) => `
const http = require("http");
const request = http.request;
http.request = function (options, ...rest) {
  const req = request.call(http, options, ...rest);
  if (!options || options.port !== ${port} || options.method !== "POST") return req;

  let body = null;
  const write = req.write.bind(req);
  const end = req.end.bind(req);
  req.write = (chunk) => { body = chunk; return true; };
  req.end = () => {};
  req.flushHeaders();

  // Destroying a request that has been end()ed with its body still queued
  // emits 'finish' on the way out, one tick before the 'error' it causes. That
  // is the measured ordering and the whole reason the defect existed.
  const destroy = req.destroy.bind(req);
  req.destroy = (...args) => { const r = destroy(...args); req.emit("finish"); return r; };

  req.on("socket", (s) => s.on("connect", () => process.nextTick(() => {
    s._write = () => {};
    if (s._writev) s._writev = () => {};
    write(body);
    end();
  })));
  return req;
};
`;

const listeners: Server[] = [];
afterAll(async () => {
  await Promise.all(listeners.map(s => new Promise<void>(done => {
    s.closeAllConnections?.();
    s.close(() => done());
  })));
  rmTempDir(ROOT);
});

/**
 * A listener that proves itself the way a deck does and records every path it
 * was asked for, with its query — `?persist=0` is how a deck that is only
 * drawing the event is told apart from the one asked to keep it.
 *
 * It answers on `end`, so the one whose body never arrives never answers, which
 * is what a writer wedged mid-read looks like from the outside. Nothing here
 * knows which of the two that is.
 */
async function stub() {
  const token = randomBytes(32).toString("hex");
  const seen: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The hook hangs up on the wedged request when its deadline passes; an
    // unhandled stream error would take the whole test worker down with it.
    req.on("error", () => {});
    res.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/hook-challenge") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ proof: challengeProof(token, url.searchParams.get("nonce") ?? "") }));
    }
    // Recorded on the headers rather than on `end`: the wedged request never
    // reaches one, and that it was ASKED is the premise of the whole case.
    seen.push(url.pathname + url.search);
    req.resume();
    req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end("{}"));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  listeners.push(server);
  return { token, seen, port: (server.address() as AddressInfo).port };
}

interface Run { code: number | null; signal: string | null; stderr: string; wallMs: number }

/** Run the installed-shape hook against a registry of our own, behind a preload. */
async function fireHook(home: string, preload: string, payload: Record<string, unknown>): Promise<Run> {
  const file = join(home, "preload.cjs");
  writeFileSync(file, preload, "utf8");
  const t0 = Date.now();
  const child = spawn(process.execPath, ["-r", file, HOOK_COPY, "--provider", "claude"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", c => { stderr += c; });
  // A hook that ends with a body still going out leaves this end of the pipe
  // with nobody reading it.
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(payload));
  return new Promise<Run>((done, fail) => {
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      child.stdin.destroy();
      done({ code, signal, stderr, wallMs: Date.now() - t0 });
    });
  });
}

describe("an elected writer that stops reading before the body is all out", () => {
  it("is handed on from, because it cannot have logged an event it never took", async () => {
    const a = await stub();
    const b = await stub();
    // Lowest port first is electWriters' own order, so the wedged listener has
    // to be the lower of the two to be the elected writer at all.
    const [writer, backup] = [a, b].sort((x, y) => x.port - y.port);

    const home = mkdtempSync(join(ROOT, "home-"));
    const dir = join(home, "agent-dag");
    mkdirSync(dir, { recursive: true });
    // ONE LOG, TWO DECKS: `persist` is the group the election is decided within,
    // so both records naming one path is what puts the backup in line behind the
    // writer. Nothing writes to it — neither listener is a deck — it is only the
    // group key. Both records carry this process's pid, the one pid certain to
    // be alive, or the hook sweeps them before the election sees them.
    const log = join(home, "events.jsonl");
    const record = (port: number, token: string) => JSON.stringify({
      pid: process.pid, port, workspace: "", token, persist: log,
      startedAt: new Date().toISOString(),
    });
    writeFileSync(join(dir, `${process.pid}.json`), record(writer.port, writer.token), "utf8");
    writeFileSync(join(dir, `${process.pid}0.json`), record(backup.port, backup.token), "utf8");

    // A `tool_input` of a few hundred KB, which is what the real trigger looks
    // like — a body larger than the socket buffers is how a writer that stops
    // reading leaves one half sent. The size is not what produces the state
    // here (see the preload), so it is an ordinary one rather than one chosen
    // to beat a kernel, and both listeners are stubs because a real deck
    // refuses a body past 5MB outright (#1014), which is a 413 and a different
    // ending altogether.
    const run = await fireHook(home, wedgeWriter(writer.port), {
      cwd: home, session_id: "s1", hook_event_name: "PreToolUse",
      tool_name: "Write", tool_use_id: "t1", tool_input: { content: "x".repeat(256 * 1024) },
    });

    // The premise, stated rather than assumed: this listener has to have been
    // the elected writer, or the case never happened. `/api/event` with no query
    // is the unflagged path — `?persist=0` is what the losers are told.
    expect(writer.seen, `the wedged listener was not elected (stderr: ${run.stderr})`)
      .toEqual(["/api/event"]);
    expect(run.signal, "the hook had to be killed").toBe(null);
    expect(run.code, run.stderr.split("\n")[0]).toBe(0);
    expect(run.stderr).toBe("");
    // Drawn first with ?persist=0 like every non-writer, then handed the log.
    expect(backup.seen, "the log was not handed to the deck behind the wedged writer")
      .toEqual(["/api/event?persist=0", "/api/event"]);
    // And it fits the budget: a hand-on that only completes past the timeout the
    // installer declared is one the host CLI kills, with the event lost and the
    // whole of it charged to the tool call that was waiting on it.
    expect(run.wallMs, `the hand-on ran past the declared ${DECLARED_MS}ms`).toBeLessThan(DECLARED_MS);
  }, 30_000);
});
