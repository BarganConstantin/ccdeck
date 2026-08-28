// The event ring buffer was bounded by a count of events and by nothing else,
// so ordinary large tool responses exhausted the heap and the deck died with a
// fatal OOM.
//
// `MAX_BUFFER = 2000` was the whole eviction rule, and `POST /api/event` admits
// a body of 5,000,000 characters, so the ring's real ceiling was the product of
// the two — about 10 GB, which is larger than the heap V8 gives itself on any
// machine. Measured against a real server on loopback, posting 4,900,000-
// character bodies and reading process.memoryUsage() after a forced GC: 4.69 MB
// of heap retained per buffered event, flat from 20 events to 200. Under
// `--max-old-space-size=2048` — roughly the heap an 8 GB laptop picks — the
// process aborted at 429 events with `FATAL ERROR: Reached heap limit`, 1571
// short of its own cap. That abort is not catchable, so the SSE stream, the
// hook ingest and the event log stop together; and `/api/event` is a deliberate
// open mutation, so those 430 posts need no credential at all.
//
// The fix is a second bound, MAX_BUFFER_CHARS, evicting oldest-first until both
// hold. What this file has to pin is three separate things, because each of
// them can be broken without touching the other two:
//
//   1. The CHARGE. A byte budget is only a budget if the number it adds up
//      tracks what an event actually retains. Charging string lengths alone
//      looks right and is not: an array of small numbers holds 4.67 MB and
//      charges ZERO, so a ring bounded that way is the same OOM behind a
//      different payload shape.
//   2. The BUDGET. The number has to clear the largest event ingest admits, by
//      enough that a burst of them does not collapse the ring, while staying a
//      bounded fraction of a small heap. Asserted against the ingest cap it
//      protects against rather than against itself — the treatment
//      MAX_CLIENT_BUFFER_BYTES already gets a few hundred lines above it.
//   3. The EVICTION, through a real server: the total stops growing, what
//      leaves is a prefix and never an interior run, `/api/clear` empties the
//      running total along with the array, and a client resuming from an id the
//      budget has evicted is served the same way a too-old id has always been
//      served — everything still held, contiguously, ending in the sentinel —
//      rather than being handed a hole or hung up on.
//
// Case 3 is the expensive one and it is bounded deliberately. It posts exactly
// as many maximum-size events as the exported constant says are needed to fill
// the budget, plus four, from a single pre-encoded Buffer that is reused for
// every post — so the test allocates one body, not a hundred and sixty
// megabytes of them, to prove the ring does not keep them. The only full replay
// it reads is against a ring that has just been cleared, so the contiguity half
// costs a few hundred bytes rather than the whole budget.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { get, request, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Everything lives under this temp directory; the real ~/.claude and ~/.codex
// are never read or written. Resolved at module import time, hence before the
// dynamic import below.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-ring-bytes-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const mod = await import("../../server/index.mjs");
const startServer = mod.startServer as (o: unknown) => Promise<Server>;
const payloadChars = mod.payloadChars as (raw: unknown) => number;
const eventBufferStats = mod.eventBufferStats as () => {
  events: number; chars: number; oldestSeq: number; newestSeq: number;
};
const MAX_BUFFER: number = mod.MAX_BUFFER;
const MAX_BUFFER_CHARS: number = mod.MAX_BUFFER_CHARS;
// `/api/clear` is a protected mutation; the hook route is not, because hooks
// post with no Origin at all. So only the clear below carries the header.
const hookToken = mod.hookToken as () => string;

// What `handleEventIngest` admits, in characters of request body — the ceiling
// the budget exists to be measured against, exactly as it is the ceiling
// MAX_CLIENT_BUFFER_BYTES is measured against.
const INGEST_LIMIT_CHARS = 5_000_000;

// The mean serialized event on a real deck: 5 KB, measured over 4.7k payloads
// out of a 21 MB events.jsonl — the sample redactDeckToken's note quotes. A
// completely full count-capped ring of ordinary traffic is this times
// MAX_BUFFER, and the budget has to sit well above it or the fix would have
// cost every user replay depth to protect against traffic none of them have.
const MEAN_EVENT_CHARS = 5_000;

// The worst ratio measured between what an event actually retains and what
// payloadChars charges it, across six payload shapes: an object of a quarter-
// million distinct keys, at 2.5x. The budget's real cost in heap is this times
// the budget, and that product is what has to stay small against a laptop heap.
const WORST_UNDERCHARGE = 2.5;

// The heap Node picks for itself on an 8 GB machine, which is the machine the
// report died on. Not read from this process — it is the number the budget was
// chosen against, and a test that read the local heap limit would assert
// something different on every runner.
const SMALL_LAPTOP_HEAP = 2 * 1024 * 1024 * 1024;

let server: Server;
let port = 0;
const sockets: Socket[] = [];
const streams: IncomingMessage[] = [];

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  for (const s of sockets) s.destroy();
  for (const s of streams) s.destroy();
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

/** Post a body already encoded, and return the seq the server assigned it.
 *  `agent: false` leaves no keep-alive socket behind to show up in the
 *  connection counts. */
function postRaw(body: Buffer | string): Promise<number> {
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
        res.on("end", () => {
          try {
            const parsed = JSON.parse(out);
            if (typeof parsed.seq !== "number") reject(new Error(`ingest refused the body: ${out.slice(0, 200)}`));
            else resolve(parsed.seq);
          } catch (e) { reject(e); }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function post(body: unknown): Promise<number> {
  return postRaw(JSON.stringify(body));
}

function postClear(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1", port, path: "/api/clear", method: "POST", agent: false,
        headers: { "x-ccdeck-token": hookToken() },
      },
      res => {
        if (res.statusCode !== 200) reject(new Error(`/api/clear answered ${res.statusCode}`));
        res.resume();
        res.on("end", () => resolve());
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitUntil(pred: () => Promise<boolean> | boolean, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** One maximum-size PostToolUse, pre-encoded once. Every post below sends this
 *  same Buffer: the seq comes back in the ack, so nothing here needs the bodies
 *  to differ, and re-encoding a 4.9 MB body thirty-two times would cost more
 *  than the thing being measured. */
const bigPayload = {
  hook_event_name: "PostToolUse", session_id: "sid-ring", cwd: DIR,
  tool_name: "Read", tool_use_id: "ring",
  // Just under the ingest cap once the rest of the envelope is around it.
  tool_response: "x".repeat(INGEST_LIMIT_CHARS - 100_000),
};
const bigBody = Buffer.from(JSON.stringify(bigPayload), "utf8");
// What the ring will charge one of those. Read from the exported charge rather
// than assumed, so the arithmetic below follows the implementation instead of a
// number that happens to be right today.
const BIG_EVENT_CHARS = payloadChars(bigPayload);

describe("event ring byte budget", () => {
  // The charge, at the layer it lives at: no server, no socket, no tolerance.
  describe("payloadChars", () => {
    it("charges a large string what it costs", () => {
      const raw = { tool_response: "x".repeat(1_000_000) };
      const charged = payloadChars(raw);
      expect(charged).toBeGreaterThanOrEqual(1_000_000);
      // And does not wildly over-charge it, which would cost replay depth for
      // the shape the ring is mostly made of.
      expect(charged).toBeLessThan(1_000_100);
    });

    it("is not blind to a payload that holds no strings at all", () => {
      // The shape that makes a string-length charge useless. Measured: twenty
      // copies of a 4.9M-character body of small numbers retain 4.67 MB each,
      // while their string content is zero characters. A ring that charged
      // strings alone would hold two thousand of these — the same OOM, reached
      // through `[1,2,3,…]` instead of through a Read.
      const N = 200_000;
      const raw = { a: Array.from({ length: N }, (_, i) => i) };
      const charged = payloadChars(raw);
      expect(
        charged,
        `an array of ${N} numbers retains about ${(N * 8 / 1048576).toFixed(1)}MB and must not be charged as free`,
      ).toBeGreaterThanOrEqual(N * 8);
    });

    it("is not blind to a payload made of many tiny objects", () => {
      // The worst shape measured: 222k `{k,v}` objects retained 10.20 MB while
      // their strings came to 0.85 MB, a twelvefold under-charge. With the
      // per-value charge the same body comes to 5.95 M, which is 1.7x under —
      // inside the 2.5x the budget is sized against.
      const N = 50_000;
      const raw = { a: Array.from({ length: N }, (_, i) => ({ k: i % 100, v: "ab" })) };
      // Three values per entry (the array slot and the two properties) plus the
      // two one-character keys and the two-character string.
      expect(payloadChars(raw)).toBeGreaterThanOrEqual(N * 8 * 3);
    });

    it("charges keys, which are retained as surely as values are", () => {
      const raw: Record<string, number> = {};
      for (let i = 0; i < 20_000; i++) raw[`key${String(i).padStart(8, "0")}`] = 1;
      expect(payloadChars(raw)).toBeGreaterThanOrEqual(20_000 * (8 + 11));
    });

    it("walks a payload nested deeper than the stack could recurse", () => {
      // A body from JSON.parse is free to nest as deeply as it likes, and this
      // runs inside the request listener where nothing catches a RangeError.
      // The same reason redactDeckToken is iterative.
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 100_000; i++) {
        const next: Record<string, unknown> = {};
        cursor.n = next;
        cursor = next;
      }
      expect(() => payloadChars(deep)).not.toThrow();
      expect(payloadChars(deep)).toBeGreaterThanOrEqual(100_000 * 8);
    });

    it("charges a top-level primitive, which is a legal body here", () => {
      expect(payloadChars("hello")).toBe(5);
      expect(payloadChars(7)).toBeGreaterThan(0);
      expect(payloadChars(null)).toBeGreaterThan(0);
    });
  });

  // The budget, against the limits it exists between rather than against
  // itself. Each of these fails if somebody moves the constant to a number that
  // reads fine and is not one.
  describe("MAX_BUFFER_CHARS", () => {
    it("clears the largest event ingest will admit, many times over", () => {
      // One event must never be able to fill the ring on its own: a burst of
      // maximum-size tool responses — eight subagents each returning a big
      // Read — has to be held rather than collapsing the ring to a single
      // entry. Twenty is the floor this asserts; the shipped number is 26x.
      expect(
        MAX_BUFFER_CHARS / INGEST_LIMIT_CHARS,
        "the budget must hold a burst of maximum-size events, not one of them",
      ).toBeGreaterThanOrEqual(20);
    });

    it("holds a completely full ring of ordinary traffic without ever binding", () => {
      // The fix must not cost replay depth to traffic that was never the
      // problem. A full count-capped ring of mean-sized events is 10 MB, and
      // the budget sits an order of magnitude above it, so for ordinary
      // traffic MAX_BUFFER is still the bound that decides.
      expect(
        MAX_BUFFER_CHARS / (MAX_BUFFER * MEAN_EVENT_CHARS),
        "ordinary traffic must keep the full count-based replay depth",
      ).toBeGreaterThanOrEqual(10);
    });

    it("keeps the ring's worst case a bounded fraction of a small heap", () => {
      // The direction the old code failed in. 2000 events at 4.69 MB apiece is
      // 9.4 GB, more than twice the heap limit of a 32 GB machine and four
      // times that of an 8 GB one — a multiple of the heap rather than a
      // fraction of it. What replaces it has to be a fraction, allowing for the
      // worst measured gap between the charge and real retention.
      const worstRetained = MAX_BUFFER_CHARS * WORST_UNDERCHARGE;
      expect(
        worstRetained / SMALL_LAPTOP_HEAP,
        "the ring's worst case must stay a bounded fraction of an 8 GB laptop's heap",
      ).toBeLessThanOrEqual(0.25);
    });
  });

  // And the eviction, through the real ingest route, in the order the cases are
  // written: the ring is filled first, then cleared, and the resume case that
  // reads a whole replay runs against the cleared ring so it costs a few
  // hundred bytes instead of the whole budget.
  describe("the ring under maximum-size events", () => {
    // How many of those bodies it takes to fill the budget, derived from the
    // exported constant and the exported charge — never from a round number,
    // so moving either one moves this with it.
    const TO_FILL = Math.ceil(MAX_BUFFER_CHARS / BIG_EVENT_CHARS);
    const POSTS = TO_FILL + 4;
    let firstSeq = 0;
    let lastSeq = 0;

    it("stops growing once the budget is full, however many more arrive", async () => {
      for (let i = 0; i < POSTS; i++) {
        const seq = await postRaw(bigBody);
        if (i === 0) firstSeq = seq;
        lastSeq = seq;
      }

      const stats = eventBufferStats();
      // The bound, plus the one event the eviction deliberately never takes:
      // an event larger than the whole budget still has to be kept, or
      // pushEvent would return an envelope no client could ever be given.
      expect(
        stats.chars,
        `${POSTS} events of ${BIG_EVENT_CHARS} characters were posted; the ring must not be holding all of them`,
      ).toBeLessThanOrEqual(MAX_BUFFER_CHARS + BIG_EVENT_CHARS);
      // And it really did fill: a ring that evicted everything would satisfy
      // the line above and be useless.
      expect(stats.chars).toBeGreaterThan(MAX_BUFFER_CHARS - 2 * BIG_EVENT_CHARS);
      // Which means events were dropped, and the count cap is not what dropped
      // them — POSTS is nowhere near MAX_BUFFER.
      expect(stats.events).toBeLessThan(POSTS);
      expect(POSTS).toBeLessThan(MAX_BUFFER);
      // 32 posts of 4.9 MB, measured at 2.3s on macOS loopback. The budget is a
      // Windows runner's allowance for the same 157 MB, not a hint that this is
      // slow — and it is the file's largest, so under budget.ts it is the
      // allowance every case here runs on.
    }, 120_000);

    it("evicts a prefix and never an interior run", async () => {
      const stats = eventBufferStats();
      // What leaves is always the oldest, so the seqs still held are one
      // unbroken run ending at the newest. An eviction that took from the
      // middle would leave a hole that `GET /api/events` and the replay loop
      // would hand out without noticing, and no client could ask for again.
      expect(
        stats.newestSeq,
        "eviction must take the oldest event, never the one just pushed",
      ).toBe(lastSeq);
      expect(
        stats.newestSeq - stats.oldestSeq + 1,
        `the ring holds ${stats.events} events spanning seq ${stats.oldestSeq}..${stats.newestSeq}, which is not one unbroken run`,
      ).toBe(stats.events);
      expect(stats.oldestSeq).toBeGreaterThan(firstSeq);
    });

    it("starts a resume from the oldest event it still holds", async () => {
      // A tab that reconnects with an id the budget has already evicted. It is
      // a stale id and takes the path a stale id has always taken: everything
      // still held, oldest first. What must not happen is the replay skipping
      // ahead of its own oldest entry — that would be a hole with no id left to
      // ask for it again.
      //
      // Only the first frame is read. The whole replay is the whole budget, and
      // reading it here would cost more than every other case in this file put
      // together; the contiguity of a complete replay is asserted below,
      // against a ring small enough to read.
      const oldestHeld = eventBufferStats().oldestSeq;
      const sock = connect(port, "127.0.0.1");
      sockets.push(sock);
      let firstId = 0;
      let carry = "";
      sock.on("error", () => {});
      sock.setEncoding("utf8");
      sock.on("data", (c: string) => {
        if (firstId > 0) return;
        const s = carry + c;
        const m = /(?:^|\n)id: (\d+)\n/.exec(s);
        if (m) firstId = Number(m[1]);
        carry = s.slice(-64);
      });
      sock.write(
        `GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Accept: text/event-stream\r\nLast-Event-ID: ${firstSeq}\r\n\r\n`,
      );
      await waitUntil(() => firstId > 0, "the first replayed frame");
      expect(
        firstId,
        `resuming from the evicted id ${firstSeq} must start at the ring's oldest held event`,
      ).toBe(oldestHeld);
      sock.destroy();
    }, 120_000);

    it("empties the running total along with the ring", async () => {
      // `/api/clear` used to be a bare `events.length = 0`. With a running
      // total beside the array that is a permanent debt: the total would still
      // name the events the array no longer holds, so every push afterwards
      // would evict against a budget already spent and the deck would keep a
      // ring of one event for the rest of its life.
      await postClear();
      const stats = eventBufferStats();
      // The clear pushes its own `__clear` marker, so one small event is
      // exactly what should be left.
      expect(stats.events).toBe(1);
      expect(
        stats.chars,
        "the byte total must be emptied with the ring, or the budget is spent forever",
      ).toBeLessThan(1_024);
    }, 60_000);

    it("still replays contiguously to a client whose id is older than anything held", async () => {
      // The other half, and the half a blunter eviction would break: a client
      // resuming from an id the ring no longer holds is served everything that
      // is left, with no gaps inside it, ending in the sentinel — and is then
      // live. It is not hung up on, and it is not handed a replay with a hole
      // in the middle of it.
      //
      // Run here, after the clear, because the ring is now a handful of small
      // events rather than the whole budget.
      const seqs: number[] = [];
      for (let i = 0; i < 5; i++) {
        seqs.push(await post({ hook_event_name: "Stop", session_id: "sid-small", cwd: DIR, n: i }));
      }
      const held = eventBufferStats();

      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        get(
          { host: "127.0.0.1", port, path: "/events", agent: false, headers: { "Last-Event-ID": String(firstSeq) } },
          resolve,
        ).on("error", reject);
      });
      streams.push(res);

      const ids: number[] = [];
      let sentinel = false;
      let carry = "";
      res.setEncoding("utf8");
      res.on("error", () => {});
      res.on("data", (c: string) => {
        const s = carry + c;
        for (const m of s.matchAll(/(?:^|\n)id: (\d+)\n/g)) ids.push(Number(m[1]));
        if (s.includes("event: replay-end")) sentinel = true;
        carry = s.slice(-32);
      });

      await waitUntil(() => sentinel, "the replay-end sentinel");
      // Exactly the ring, in order, with nothing skipped inside it.
      expect(ids).toEqual(
        Array.from({ length: held.events }, (_, i) => held.oldestSeq + i),
      );
      for (const s of seqs) expect(ids).toContain(s);

      // And the stream is live behind the sentinel, which is what tells this
      // apart from a client that was quietly hung up on mid-replay.
      const live = await post({ hook_event_name: "Stop", session_id: "sid-small", cwd: DIR, n: "live" });
      await waitUntil(() => ids.includes(live), "the live event after the sentinel");
    }, 60_000);
  });
});
