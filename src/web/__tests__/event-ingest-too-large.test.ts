// POST /api/event past its 5 MB cap answered with nothing at all.
//
// handleEventIngest called `req.destroy()` inside its `data` handler and then
// returned. Destroying an IncomingMessage destroys the socket under it, so the
// poster did not hang — it got a connection reset, which is worse in the way
// that matters: it is exactly what a deck that crashed, or that was never there,
// looks like. There is no status code anywhere in that exchange to tell the two
// apart. `end` never fires on a destroyed request either, so the handler had no
// second chance to say anything.
//
// readBody (64 KB, everywhere else) was believed to get this right by
// rejecting into a caller that replies. It did not: it called `req.destroy()`
// BEFORE the reject, so the caller's `send(res, 400, ...)` had no socket left
// and all eleven of those routes answered an oversized body with the same bare
// reset. It answers 413 and drains now, in the shape this route worked out —
// the cases at the bottom of this file are that fix.
//
// This route answers 413 first and drops the socket only once the reply has
// flushed, since destroying a socket discards whatever is still queued on it.
//
// hook/hook.js is the only client that posts here. It reads the response and
// then calls its finish callback, and it holds a 1-second timeout over the
// whole thing — so it survived the reset and survives the 413; what it gains is
// a status code that says which of the two happened.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-event-too-large-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { startServer, hookToken, challengeProof } = await import("../../server/index.mjs");

let server: Server;
let port: number;

beforeAll(async () => {
  // persist: null so nothing under test writes an event log.
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

/**
 * POST a body of `bytes` and report what came back — a status, or the socket
 * error that arrived instead.
 *
 * Written the long way on purpose. The server answers and hangs up while the
 * body is still being written, so the write side fails with EPIPE/ECONNRESET
 * and a naive `req.on("error", reject)` would report the refusal it is meant to
 * be measuring as a test failure. A response, if one arrives, is the answer;
 * the error only speaks when nothing else does.
 */
function postBytes(bytes: number, path = "/api/event", extra: Record<string, string> = {}): Promise<{ status: number | null; body: string; err: string | null }> {
  return new Promise((done) => {
    let answered = false;
    const headers = { "Content-Type": "application/json", ...extra };
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, res => {
      answered = true;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; });
      res.on("end", () => done({ status: res.statusCode ?? null, body, err: null }));
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (!answered) done({ status: null, body: "", err: e.code ?? e.message });
    });
    // A megabyte at a time, so the cap is crossed mid-upload rather than in one
    // write the server never gets to interrupt — which is the shape a real
    // oversized post has.
    const chunk = "x".repeat(1 << 20);
    let sent = 0;
    const pump = () => {
      while (sent < bytes) {
        sent += chunk.length;
        if (!req.write(chunk, () => {})) return req.once("drain", pump);
      }
      req.end();
    };
    // The body is never valid JSON; the cap is crossed long before anything
    // would try to parse it.
    req.write('{"pad":"');
    pump();
  });
}

describe("POST /api/event past the 5 MB cap", () => {
  it("answers 413 instead of dropping the connection", async () => {
    const r = await postBytes(6 << 20);
    expect(r.err).toBeNull();
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body)).toEqual({ error: "event too large" });
  }, 20_000);

  it("does not then answer a second time on the way down", async () => {
    // Destroying the request raises `error` on it, and the handler for that
    // used to reply 400 — a second writeHead on a response already sent, thrown
    // out of an error handler with nothing waiting to catch it. The server
    // being alive for the next request is the assertion.
    await postBytes(6 << 20);
    const ok = await new Promise<number>((resolveStatus, rejectStatus) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/health", method: "GET" }, res => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      });
      req.on("error", rejectStatus);
      req.end();
    });
    expect(ok).toBe(200);
  }, 20_000);

  it("leaves an ordinary event alone", async () => {
    const body = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: DIR });
    const r = await new Promise<{ status: number; body: string }>((doneOne, fail) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/event", method: "POST",
        headers: { "Content-Type": "application/json" } }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", c => { text += c; });
        res.on("end", () => doneOne({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", fail);
      req.end(body);
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
  });
});

// The eleven routes that go through readBody's 64 KB cap. `/api/prefs` stands
// for them: the path is the shared helper, not the handler.
//
// `/api/lan/sync` is the one that made this worth fixing rather than noting —
// its caller is another deck, not a person, and a reset is indistinguishable
// from a deck that died, so a peer reported a network error where the answer
// was "too big".
describe("a body past readBody's 64 KB cap", () => {
  // A request the mutation guard admits: a same-origin POST from the deck's own
  // page is what these routes exist for, and without it the 401 lands before
  // readBody ever runs.
  const asPage = (path: string, bytes: number) => postBytes(bytes, path, {
    Origin: `http://127.0.0.1:${port}`,
  });

  it("answers 413 rather than resetting the connection", async () => {
    const r = await asPage("/api/prefs", 128 << 10);
    expect(r.err, "a reset here is the bug this closes").toBeNull();
    expect(r.status).toBe(413);
    expect(r.body).toContain("body too large");
  });

  it("answers once, not twice, though the caller replies too", async () => {
    // readBody sends the 413 and still rejects, so the caller's own
    // `send(res, 400, ...)` runs. `send` is a no-op once the headers have gone
    // out — without that guard this throws ERR_HTTP_HEADERS_SENT and the route
    // becomes a 500.
    const r = await asPage("/api/prefs", 128 << 10);
    expect(r.status).toBe(413);
    expect(r.body.trim().endsWith("}"), "one JSON document, not two").toBe(true);
  });

  it("leaves the server healthy afterwards", async () => {
    await asPage("/api/prefs", 128 << 10);
    const health = await new Promise<number | null>(done => {
      request({ host: "127.0.0.1", port, path: "/api/health", method: "GET" }, res => {
        res.resume();
        res.on("end", () => done(res.statusCode ?? null));
      }).on("error", () => done(null)).end();
    });
    expect(health).toBe(200);
  });
});

// THE REFUSALS ON THE ROUTES THAT ASK FOR NOTHING (#1168). /api/event and
// /api/hook-challenge answer any local process with no credential, and the
// router's own first line answers anything at all — so each of these is a
// request somebody who holds nothing can send, and none of them had ever been
// sent to a real server.
describe("what the credential-free routes refuse", () => {
  function call(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((done, fail) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", c => { text += c; });
        res.on("end", () => done({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", fail);
      req.end(body);
    });
  }
  const seqNow = async () => JSON.parse((await call("GET", "/api/health")).body).seq as number;

  it("answers a body that is not JSON with 400, and the deck is still there to say so again", async () => {
    // `end` is a listener the event loop calls after the route has returned, so
    // `guard` cannot reach it: the try around JSON.parse is the only thing that
    // stops one garbage POST from being an uncaughtException — the whole deck,
    // its stream, its ingest and its log, for one request from any process.
    const before = await seqNow();
    for (const garbage of ["{not json", "", "undefined"]) {
      const r = await call("POST", "/api/event", garbage, { "Content-Type": "application/json" });
      expect(r.status, JSON.stringify(garbage)).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ error: "invalid json" });
    }
    // Nothing was pushed for any of them.
    expect(await seqNow()).toBe(before);
  });

  it("takes any JSON value as an event, and the ring still reads back as JSON", async () => {
    // Valid JSON that is not an object is still a body the hook's route has to
    // survive: the parse succeeds and everything past it has to cope.
    for (const value of ["null", "42", '"str"', "[]"]) {
      const r = await call("POST", "/api/event", value, { "Content-Type": "application/json" });
      expect(r.status, value).toBe(200);
      const out = JSON.parse(r.body);
      expect(out.ok, value).toBe(true);
      expect(Number.isInteger(out.seq), value).toBe(true);
    }
    const ring = await call("GET", "/api/events?since=0", undefined, { "x-ccdeck-token": hookToken() });
    expect(ring.status).toBe(200);
    expect(Array.isArray(JSON.parse(ring.body))).toBe(true);
  });

  it("refuses a nonce that is missing or longer than the handshake ever sends", async () => {
    // The proof oracle answers anybody by design, so the bound on its input is
    // the one thing it asks of the caller.
    for (const path of ["/api/hook-challenge", "/api/hook-challenge?nonce=", `/api/hook-challenge?nonce=${"x".repeat(257)}`]) {
      const r = await call("GET", path);
      expect(r.status, path.slice(0, 40)).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ error: "bad nonce" });
    }
    // And the longest one it takes is answered with the proof itself.
    const nonce = "x".repeat(256);
    const ok = await call("GET", `/api/hook-challenge?nonce=${nonce}`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).proof).toBe(challengeProof(hookToken(), nonce));
  });

  it("answers a request target no URL parser takes with 400, and stays up", async () => {
    // `GET // HTTP/1.1` gets through Node's parser and throws in `new URL`
    // against any base. requestUrl answers null for it (request-url.test.ts);
    // this is the router doing something with that null. Over a raw socket,
    // because node:http will not send a path it considers malformed.
    const reply = await new Promise<string>((done, fail) => {
      const sock = connect(port, "127.0.0.1");
      let text = "";
      sock.setEncoding("utf8");
      sock.on("data", c => { text += c; });
      sock.on("end", () => done(text));
      sock.on("error", fail);
      sock.write(`GET // HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    // Read as text rather than parsed: the answer is chunked on the wire.
    expect(reply).toContain(JSON.stringify({ error: "bad request target" }));
    expect((await call("GET", "/api/health")).status).toBe(200);
  });
});
