// The per-client buffer cap counted the same bytes twice, so it dropped
// subscribers that were not behind at all.
//
// `queuedBytes` read `res.writableLength` and then added `res.socket
// .writableLength` to it, on the reasoning that the first is what the response
// has not handed to the socket and the second is what the socket has not handed
// to the kernel. Node does not divide them that way. Its
// `OutgoingMessage.writableLength` getter is `outputSize + this[kChunkedLength]
// + (socket ? socket.writableLength : 0)`, so the socket's queue is already
// inside the response's reading; and for an SSE response, whose outputSize is
// zero from the moment the headers flush, the two readings are the same number
// exactly. Measured here on Node 22.14 against a reader that was doing nothing
// wrong: `res.writableLength=4194615 socket.writableLength=4194615`, identical
// at every sample. The sum was therefore exactly twice the real backlog, and
// `MAX_CLIENT_BUFFER_BYTES` behaved as half the 8 MiB it named.
//
// That is not a stricter version of the intended rule, because one SSE frame
// can be larger than 4 MiB on its own. `POST /api/event` admits a body of
// 5,000,000 characters, and log-writer.mjs's own note on that limit says a
// PostToolUse carrying a large Read or Bash response is routinely a good
// fraction of it. The socket cannot have drained megabytes synchronously inside
// `res.write`, so the check on the very next line saw the whole frame, doubled,
// and hung up. Against a live server on loopback, with a subscriber reading
// everything as fast as http.get would hand it over: 1, 2 and 3 MiB events were
// survived, and a 4 MiB event dropped it — and it drops every tab subscribed at
// that moment, `pushEvent` walking the whole set with the same frame. The tabs
// reconnect and resume from Last-Event-ID, so nothing is lost; what the user
// sees is the live pill flapping and the ring replaying, during exactly the
// runs the deck exists to watch.
//
// Why this needed a new file rather than an assertion added to one of the two
// backpressure tests. Neither of them could have caught it. sse-backpressure
// asserts only that the stalled subscriber is gone, and its healthy subscriber
// is never shown a frame big enough to trip the halved cap.
// sse-resume-backpressure allowed 14 MiB of slack against an 8 MiB cap — six
// megabytes of tolerance, which is more than the entire error. So the shape
// here is the pairing that pins the constant to the number it names: an event
// well under the cap must NOT cost a reader its connection, an event that is
// the largest thing ingest will accept must not either, and a subscriber that
// has genuinely stopped reading must still be hung up on. The arithmetic itself
// is asserted directly, on a stub rather than through a socket, because that is
// the layer the bug lived at and the only layer where it is visible without
// tolerances wide enough to hide it.
//
// 8 MiB stays 8 MiB, and the last case here is why that is enough rather than
// merely traditional. The cap is compared against `writableLength`, which for a
// string chunk counts UTF-16 units and not encoded bytes, and the ingest limit
// it has to clear is 5,000,000 characters — the same unit. So the largest event
// admissible can occupy about 60% of the cap however many bytes it weighs on
// the wire, which the CJK case measures directly at fourteen megabytes sent and
// 4,800,311 queued. Counted twice it was 120%, which is the bug stated as a
// percentage.
//
// The order of the live cases is load-bearing. The stalled one runs first,
// while the ring is still empty, so that the subscriber it stalls reaches the
// fan-out set through a trivial replay and is dropped by `writeSse` — the
// function whose cap this is. Run later, against a full ring, it would be
// dropped by `writeResume` on the way in instead, which is a different code
// path with a different rule (it waits) and is already covered by
// sse-resume-backpressure. The one healthy subscriber is opened before any
// event exists and kept for every case, for the same reason: a subscriber
// opened later replays the whole ring first, and the cases below want to
// measure a live frame landing on a drained buffer, not a frame landing behind
// tens of megabytes of catch-up.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { get, request, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Everything lives under this temp directory; the real ~/.claude and ~/.codex
// are never read or written. Resolved at module import time, hence before the
// dynamic import below.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-buffer-accounting-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { startServer, queuedBytes, MAX_CLIENT_BUFFER_BYTES } = await import("../../server/index.mjs");

// The ceiling `handleEventIngest` enforces, in characters of request body, and
// the largest frame that can turn into — which is the thing MAX_CLIENT_BUFFER
// _BYTES has to clear, because a single write of such a frame queues the whole
// of it with nothing having had the chance to drain any.
//
// Both are in characters, and the match of units is the point. Despite the
// name, the cap is compared against `writableLength`, and a Writable with
// decodeStrings false — which is what an OutgoingMessage and its socket are —
// counts a string chunk as `chunk.length`, UTF-16 units. Measured here: a
// 4,800,000-character CJK payload is 14,400,184 bytes on the wire and
// `res.writableLength` reports 4,800,311. So an event cannot put more units in
// the queue than ingest let through characters, whatever it costs in bytes,
// and the deck's own envelope on top of that measured at 127.
const INGEST_LIMIT_CHARS = 5_000_000;
const LARGEST_ADMISSIBLE_FRAME = INGEST_LIMIT_CHARS + 1024;

let server: Server;
let port = 0;
const sockets: Socket[] = [];
const streams: IncomingMessage[] = [];

/** The one healthy subscriber, opened against an empty ring and kept. */
let reader: Reader;

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
  reader = await healthySubscriber();
  await reader.caughtUp();
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
  rmSync(DIR, { recursive: true, force: true });
});

function post(body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1", port, path: "/api/event", method: "POST", agent: false,
        headers: { "Content-Type": "application/json" },
      },
      res => { res.resume(); res.on("end", () => resolve()); },
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

async function waitUntil(pred: () => Promise<boolean> | boolean, label: string, tries = 600): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Reader {
  /** True once a frame carrying this marker has arrived. */
  saw: (marker: string) => boolean;
  /** True once the server has said the replay is over. */
  caughtUp: () => Promise<void>;
  /** Resolves when nothing has arrived for a moment, i.e. the buffer is drained. */
  quiet: () => Promise<void>;
  alive: () => boolean;
}

/**
 * A subscriber that reads everything the server sends, as fast as it is sent.
 * Frames are scanned for small unique markers rather than counted in bytes:
 * one of the cases below is fourteen megabytes of CJK on the wire, where a
 * count would have to say whether it meant UTF-16 units or UTF-8 bytes before
 * it meant anything, and "did this exact event arrive" is the question being
 * asked anyway.
 */
async function healthySubscriber(): Promise<Reader> {
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/events", agent: false }, resolve).on("error", reject);
  });
  streams.push(res);
  const markers = new Set<string>();
  let sentinel = false;
  let lastChunkAt = Date.now();
  let ended = false;
  let carry = "";
  res.setEncoding("utf8");
  res.on("error", () => { ended = true; });
  res.on("end", () => { ended = true; });
  res.on("close", () => { ended = true; });
  res.on("data", (c: string) => {
    lastChunkAt = Date.now();
    // Frames split across chunks at arbitrary offsets, so each scan starts with
    // the tail of the last one. Only the seam is rescanned — the markers are
    // short and the payloads are megabytes, so keeping the whole stream around
    // to search would be the expensive way to ask a cheap question.
    const s = carry + c;
    for (const m of s.matchAll(/"tool_use_id":"([a-z0-9-]+)"/g)) markers.add(m[1]);
    if (s.includes("event: replay-end")) sentinel = true;
    carry = s.slice(-64);
  });
  return {
    saw: marker => markers.has(marker),
    caughtUp: () => waitUntil(() => sentinel, "the replay-end sentinel"),
    quiet: async () => {
      await waitUntil(() => Date.now() - lastChunkAt > 250, "the reader's buffer to drain");
    },
    alive: () => !ended,
  };
}

/**
 * A subscriber that opens the stream and then never reads a byte. Raw TCP
 * rather than http.get: pausing a parsed response still lets Node drain the
 * socket, and it is the socket standing still that reproduces a frozen tab.
 */
function stalledSubscriber(): Socket {
  const sock = connect(port, "127.0.0.1");
  sockets.push(sock);
  sock.on("error", () => {});
  sock.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`);
  sock.pause();
  return sock;
}

function toolEvent(marker: string, response: string) {
  return {
    hook_event_name: "PostToolUse", session_id: "sid-cap", cwd: DIR,
    tool_use_id: marker, tool_name: "Read", tool_response: response,
  };
}

/**
 * Prove the reader is still on the live fan-out, by posting a small event now
 * and requiring it to arrive.
 *
 * Having seen the big frame proves nothing on its own, and this is the trap
 * this file has to step around: `writeSse` writes the whole frame FIRST and
 * only then decides whether to hang up, and the marker scanned for above sits
 * near the front of the JSON — so a subscriber that was dropped over a frame
 * can still have read the opening bytes of that very frame. Only a frame
 * written after the decision tells the two apart. Confirmed by restoring the
 * double count by hand: without this probe the largest-event case passed under
 * the bug it exists to catch.
 */
async function expectStillLive(probe: string): Promise<void> {
  await post(toolEvent(probe, "probe"));
  await waitUntil(
    () => reader.saw(probe),
    `the reader to receive ${probe}, which it only can if it was not hung up on`,
  );
  expect(reader.alive()).toBe(true);
}

describe("SSE per-client buffer accounting", () => {
  // The bug, at the layer it lived at. Everything below this point needs a
  // socket and therefore a tolerance; this needs neither.
  describe("queuedBytes", () => {
    it("counts bytes the response and its socket both report only once", () => {
      // Node's getter already folds the socket's queue into the response's
      // reading, so for a flushed SSE response the two are one number seen
      // twice. This is the pair the issue measured against a paused reader.
      const QUEUED = 6_030_876;
      const flushedSseResponse = { writableLength: QUEUED, socket: { writableLength: QUEUED } };
      expect(queuedBytes(flushedSseResponse)).toBe(QUEUED);
    });

    it("still reports the whole backlog if the response's reading stops including the socket's", () => {
      // The composition above is a Node implementation detail and has moved
      // before. Were the getter to drop the socket term, a flushed SSE
      // response would report zero of its own and the socket would hold all of
      // it; the answer must not become zero with it.
      const QUEUED = 6_030_876;
      expect(queuedBytes({ writableLength: 0, socket: { writableLength: QUEUED } })).toBe(QUEUED);
    });

    it("falls back to the response's own reading once the socket is detached", () => {
      expect(queuedBytes({ writableLength: 4_194_615, socket: null })).toBe(4_194_615);
      expect(queuedBytes({ writableLength: 4_194_615, socket: undefined })).toBe(4_194_615);
    });

    it("reads a response offering neither figure as holding nothing", () => {
      expect(queuedBytes({})).toBe(0);
      expect(queuedBytes({ writableLength: undefined, socket: {} })).toBe(0);
    });

    it("leaves the largest frame ingest can admit inside the cap", () => {
      // The two halves of the fix in one assertion: the frame is counted once,
      // and the constant is large enough for it. Under the doubled accounting
      // this reads 10,002,048 against 8,388,608 — which is the whole bug, that
      // a single admissible event could hang up on a reader by itself.
      const holdingTheLargestFrame = {
        writableLength: LARGEST_ADMISSIBLE_FRAME,
        socket: { writableLength: LARGEST_ADMISSIBLE_FRAME },
      };
      expect(queuedBytes(holdingTheLargestFrame)).toBeLessThanOrEqual(MAX_CLIENT_BUFFER_BYTES);
    });
  });

  // First, while the ring is empty — see the note at the top of the file on why
  // the order matters.
  it("hangs up on a subscriber that has genuinely stopped reading, and keeps the one that has not", async () => {
    stalledSubscriber();
    await waitUntil(async () => (await health()).clients === 2, "both subscribers registered");

    const BLOB = "x".repeat(1024 * 1024);
    // Enough to carry the stalled socket past the cap on any platform: it is
    // dropped once what is queued for it exceeds MAX_CLIENT_BUFFER_BYTES, and
    // what the two kernels absorb before that starts counting is a loopback
    // buffer size, not a share of this budget. Measured at 9 events on macOS;
    // the loop stops the moment it happens, so the headroom costs nothing.
    let dropped = false;
    for (let i = 0; i < 48 && !dropped; i++) {
      await post(toolEvent(`stall-${i}`, BLOB));
      dropped = (await health()).clients === 1;
    }
    expect(dropped).toBe(true);

    // The half neither existing test asks: the subscriber that was reading saw
    // the same frames and is still here, still being fed.
    await waitUntil(() => reader.saw("stall-0"), "the reader to receive the events that dropped the other one");
    await expectStillLive("probe-after-stall");
  }, 120_000);

  it("keeps a subscriber that is reading through an event the doubled count dropped it on", async () => {
    await reader.quiet();
    const before = (await health()).clients;

    // Four megabytes: comfortably inside the 8 MiB the constant named, and the
    // exact size measured dropping a healthy reader when it was counted twice.
    await post(toolEvent("live-4mib", "x".repeat(4 * 1024 * 1024)));

    await waitUntil(() => reader.saw("live-4mib"), "the 4 MiB event to reach the reader");
    await expectStillLive("probe-after-4mib");
    expect((await health()).clients).toBe(before);
  }, 120_000);

  it("keeps a subscriber that is reading through the largest event ingest will accept", async () => {
    await reader.quiet();
    const before = (await health()).clients;

    // The biggest single frame the deck can be made to emit: a tool response
    // filling the ingest limit. Ingest is the binding constraint, not the cap —
    // nothing admissible can come closer to MAX_CLIENT_BUFFER_BYTES than about
    // 60% of it — which is the property this asserts, and which the doubled
    // accounting destroyed by putting the same event at 120%.
    await post(toolEvent("live-largest", "x".repeat(INGEST_LIMIT_CHARS - 100_000)));

    await waitUntil(() => reader.saw("live-largest"), "the largest admissible event to reach the reader");
    await expectStillLive("probe-after-largest");
    expect((await health()).clients).toBe(before);
  }, 120_000);

  it("measures the same event in the units the cap is written in, whatever it costs on the wire", async () => {
    await reader.quiet();
    const before = (await health()).clients;

    // The same size of event as the case above, in CJK: 4.8M characters, and
    // 14,400,184 bytes once it goes out as UTF-8 — comfortably more than the
    // 8 MiB the cap names. It survives because `writableLength` counts the
    // string chunk's UTF-16 units, not its encoded bytes, so the queue reads
    // 4,800,311 for it.
    //
    // Worth a case of its own rather than a line in a comment, because the
    // unit is what the cap's whole justification rests on: it is compared
    // against an ingest limit denominated in characters, and if some future
    // Node — or a change here to write Buffers rather than strings — started
    // reporting bytes, that comparison would quietly stop holding and this
    // event would begin hanging up on healthy tabs. This is what would notice.
    await post(toolEvent("live-cjk", "中".repeat(4_800_000)));

    await waitUntil(() => reader.saw("live-cjk"), "the CJK event to reach the reader");
    await expectStillLive("probe-after-cjk");
    expect((await health()).clients).toBe(before);
  }, 120_000);
});
