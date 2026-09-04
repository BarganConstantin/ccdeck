// The `Last-Event-ID` catch-up loop wrote the whole ring buffer to the new
// client with bare `res.write` calls, so the one burst guaranteed to be large
// was the one burst MAX_CLIENT_BUFFER_BYTES did not cover: measured against a
// full ring of 2000 modest events, a single client that never read had 39MB of
// frames queued for it — ten times the cap by the cap's own accounting — and
// never fired 'close' to release any of it.
//
// The fix is flow control rather than a blind drop, and the difference matters
// in both directions. A client that reads must still receive every replayed
// event and the replay-end sentinel however far past the cap the ring is: the
// burst is the server's own doing, so hanging up the moment the buffer fills
// would hang up on healthy clients — repeatedly, since EventSource reconnects
// with the same Last-Event-ID and would meet the same oversized replay. A
// client that reads nothing is held at the cap and then hung up on, exactly as
// the live fan-out treats it.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { get, request, type IncomingMessage, type Server } from "node:http";
import { rmTempDir } from "./rm-temp-dir";
import { mkdtempSync } from "node:fs";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Everything lives under this temp directory; the real ~/.claude and ~/.codex
// are never read or written. Resolved at module import time, hence before the
// dynamic import below.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-resume-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
// The production budget for a stalled resumer is 30s, which is the right
// number for a real `ssh -L` tunnel and the wrong one to sit through here.
//
// Not as small as it was, though, and the margin is the point. This budget is
// what a client gets to flush everything queued ahead of one frame, and what
// that is, by construction, is a full MAX_CLIENT_BUFFER_BYTES — so shortening
// it here shortens it relative to the cap. #588 doubled the cap in practice by
// fixing the accounting that had been halving it, which doubled the flush this
// has to cover; measured on loopback that is about a quarter of a second
// against the 500ms this used to be. Two-to-one is not margin. It would not
// have failed honestly either: overrunning drops the HEALTHY resumer
// mid-replay, so it surfaces as "timed out waiting for the replay-end
// sentinel", which reads as a hung server rather than as a budget a hair too
// short. 1.5s is six times the measured flush.
const DRAIN_MS = 1_500;
process.env.AGENTS_DECK_REPLAY_DRAIN_MS = String(DRAIN_MS);

// @ts-expect-error — .mjs server module, no types
const { startServer, MAX_CLIENT_BUFFER_BYTES, hookToken } = await import("../../server/index.mjs");

let server: Server;
let port = 0;
const sockets: Socket[] = [];
const streams: IncomingMessage[] = [];

// 1MB each, comfortably under the 5,000,000-character ingest cap; forty of
// them is a 40MB ring, five times the per-client cap, so the replay loop has
// to stop partway through it rather than happening to fit.
const BLOB = "x".repeat(1024 * 1024);
const FAT_EVENTS = 40;
// What a stalled resumer is handed cannot be asserted as a byte count at all
// from out here, and the attempt is what kept windows-latest red from #602
// until this commit: `AssertionError: expected 19929388 to be less than
// 9441280`.
//
// Two reasons, and the second is the one that decides what this case can be.
//
// First, `queuedBytes` reports what has NOT yet reached the OS. Every byte the
// kernel accepts leaves that reading immediately, so the replay loop is free to
// write the next frame however little the peer has actually read; the cap
// bounds the deck's own heap and nothing else.
//
// Second: `dropSse` DESTROYS the socket, which discards everything still
// queued in userland. So what eventually reaches a paused client is not the
// deck's queue — it is the sender's send buffer plus the receiver's receive
// window, a property of the platform. Measured: 1,523,433 bytes on macOS
// loopback against 23,072,484 on a windows-latest runner, whose loopback
// window auto-tunes into the megabytes under a sustained push. A 15x spread,
// and neither number moves when the cap moves, which is the whole problem: a
// reading that does not track the thing it claims to measure cannot fail for
// the reason it exists, and can only fail for the reason it did — a platform
// whose buffers are bigger than the author's.
//
// Calibrating the platform term was tried and is not sound either. A probe that
// writes until the kernel refuses a chunk reports 2 MiB on Windows, because it
// stops at the window's opening size while the real replay spends four and a
// half seconds letting auto-tuning grow it to ten times that.
//
// So no byte assertion. What a live socket can see is the half of the fix that
// belongs here, and it is the half the report was about: a client that reads
// nothing IS hung up on. droppedStalledResumer does not return until it is, and
// before the fix it never was — the loop queued the whole ring and went on
// serving it. The case below it pins the opposite direction, a client that does
// read still receiving all of it, and the two together are what "flow control
// rather than a blind drop" means.
//
// The quantitative half — that the number the loop stops at is the cap, to the
// byte — is asserted in sse-buffer-accounting.test.ts, on a stub, where no
// kernel sits between the assertion and the thing it measures.
const primed: number[] = [];


beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
  for (let i = 0; i < FAT_EVENTS; i++) {
    primed.push(await post({
      hook_event_name: "PostToolUse", session_id: "sid-fat", cwd: DIR,
      tool_use_id: `t${i}`, tool_name: "Read", tool_response: BLOB,
    }));
  }
}, 60_000);

afterAll(async () => {
  for (const s of sockets) s.destroy();
  for (const s of streams) s.destroy();
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AGENTS_DECK_REPLAY_DRAIN_MS"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

/** Post one event and return the seq the server assigned it. `agent: false`
 *  keeps no keep-alive socket alive afterwards, which would otherwise show up
 *  in the connection counts below. */
function post(body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1", port, path: "/api/event", method: "POST", agent: false,
        headers: { "Content-Type": "application/json" },
      },
      res => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", c => { out += c; });
        res.on("end", () => { try { resolve(JSON.parse(out).seq); } catch (e) { reject(e); } });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function health(): Promise<{ clients: number }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/api/health", agent: false }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

/** Sockets the server currently holds open — the handle side of "did the drop
 *  actually let go of it". */
function connections(): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((err, n) => (err ? reject(err) : resolve(n)));
  });
}

/** Pending Timeout handles in this worker, the timer side of the same
 *  question. Counted as a delta so whatever the runner keeps running is
 *  common to both readings. */
function timers(): number {
  const info = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
  return info ? info.call(process).filter(r => r === "Timeout").length : 0;
}

async function waitUntil(pred: () => Promise<boolean> | boolean, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * A resuming subscriber that never reads a byte, held that way for longer than
 * the drain budget and then allowed to read whatever it was sent. Raw TCP
 * rather than http.get: pausing a parsed response still lets Node drain the
 * socket, and it is the socket standing still that reproduces the report.
 * `Last-Event-ID: 0` asks for the whole ring, which is the resume a tab makes
 * after a suspend.
 *
 * Returns once the server has hung up — which a paused socket only learns when
 * it reads again, the close arriving behind the bytes already queued for it, so
 * the stall has to be timed rather than watched. Returning at all is the
 * assertion: it throws if the hang-up never comes.
 */
async function droppedStalledResumer(): Promise<void> {
  const sock = connect(port, "127.0.0.1");
  sockets.push(sock);
  let ended = false;
  sock.on("error", () => {});
  sock.on("end", () => { ended = true; });
  sock.on("close", () => { ended = true; });
  // Read and discard: the socket has to be draining for the close to arrive.
  sock.on("data", () => {});
  sock.write(
    `GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
    `Accept: text/event-stream\r\nLast-Event-ID: 0\r\n\r\n`,
  );
  sock.pause();
  await new Promise(r => setTimeout(r, DRAIN_MS * 3));
  sock.resume();
  await waitUntil(() => ended, "the stalled resumer to be hung up on");
}

describe("SSE resume backpressure", () => {
  it("hangs up on a resuming client that stops reading", async () => {
    // The call is the assertion: it waits for the server to hang up and throws
    // if that never comes. Before the fix it never did — the loop handed the
    // socket all 40MB with bare res.write calls and went on serving it.
    await droppedStalledResumer();

    // And it was never in the fan-out set to begin with, so hanging up on it
    // cost the live stream nothing.
    expect((await health()).clients).toBe(0);
  }, 30_000);

  // The other half of the fix, and the half a blunter one would have broken:
  // the replay burst fills any client's buffer, because nothing has had the
  // chance to drain it yet, so hanging up at the cap here would hang up on a
  // client doing everything right — over and over, since it reconnects with
  // the same Last-Event-ID and meets the same oversized ring.
  it("still delivers the whole replay and the sentinel to a client that reads", async () => {
    const subscribedBefore = (await health()).clients;
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      get({ host: "127.0.0.1", port, path: "/events", agent: false, headers: { "Last-Event-ID": "0", "x-ccdeck-token": hookToken() } }, resolve)
        .on("error", reject);
    });
    streams.push(res);

    const ids = new Set<number>();
    let sentinel = false;
    let carry = "";
    res.setEncoding("utf8");
    res.on("error", () => {});
    res.on("data", (c: string) => {
      // Frames are split across chunks at arbitrary offsets, so each scan
      // starts with the tail of the last one.
      const s = carry + c;
      for (const m of s.matchAll(/(?:^|\n)id: (\d+)\n/g)) ids.add(Number(m[1]));
      if (s.includes("event: replay-end")) sentinel = true;
      carry = s.slice(-32);
    });

    await waitUntil(() => sentinel, "the replay-end sentinel");
    // Every event in the ring, none skipped by the flow control that carried
    // this client past the cap several times over.
    for (const seq of primed) expect(ids.has(seq)).toBe(true);
    // And it is live: still subscribed, and fed by the fan-out.
    await waitUntil(
      async () => (await health()).clients === subscribedBefore + 1,
      "the reader to be subscribed",
    );
    const live = await post({ hook_event_name: "Stop", session_id: "sid-fat", cwd: DIR });
    await waitUntil(() => ids.has(live), "the live event after the sentinel");
  }, 30_000);

  it("leaves no handle and no timer behind when it drops a resumer", async () => {
    const baseConns = await connections();
    const baseTimers = timers();
    const baseClients = (await health()).clients;

    await droppedStalledResumer();

    // The socket is gone from the server's own books, the drain timer is
    // cleared on the way out, and the ping interval belongs to clients that
    // made it to the fan-out — this one never did. Each is given a moment,
    // because a socket's bookkeeping unwinds after the close it announces; a
    // leaked handle or interval would still be there long after this deadline.
    await waitUntil(async () => (await connections()) <= baseConns, "the dropped socket to be released", 80);
    await waitUntil(() => timers() <= baseTimers, "the drop to leave no timer behind", 80);
    expect((await health()).clients).toBe(baseClients);
  }, 30_000);
});
