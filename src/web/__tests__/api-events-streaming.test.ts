// #626: `GET /api/events` answered by building the entire ring buffer as one
// string, synchronously, inside the request listener, with nothing catching a
// throw — so a large enough ring turned one plain unauthenticated GET into the
// end of the process.
//
// Two limits, one line of code. V8 will not build a string longer than
// `2^29 - 24` = 536,870,888 characters, so past that much serialised ring the
// `JSON.stringify` inside `send` throws `RangeError: Invalid string length`;
// and because it throws out of the listener rather than out of a promise, it is
// an uncaughtException, whose default is to end the worker. Reproduced before
// the fix on Node 22.14 / macOS against the real server: 112 posts of
// 4,900,061 characters to `POST /api/event` — an open route needing no
// credential — then one `GET /api/events?since=0`, and the deck was gone, SSE
// stream and hook ingest with it. 112 events is a twentieth of the 2000-event
// ring, so this is not a contrived ring; it is what a deck watching sessions
// with large Read and Bash responses accumulates on its own.
//
// The same line has a second, much cheaper trigger, and it is in here because
// it is the one that shows the size limit was never the whole story:
// `JSON.stringify` walks a value recursively, so a payload nested about five
// thousand deep comes back as `RangeError: Maximum call stack size exceeded`.
// A 36 KB POST — measured — ended the process on the very next GET.
//
// So both halves are pinned here. The route writes the array one envelope at a
// time, which removes the ceiling rather than raising it, and the listener no
// longer lets a synchronous throw out of any route at all.
//
// Plain node, no DOM. The arithmetic cases drive `writeJsonArray` against a
// stub — the same reason sse-buffer-accounting uses one — because "never holds
// the whole array as one string" is not observable through a socket, which is
// exactly how it survived unnoticed. The rest drive the real server over
// loopback, because "the process is still here afterwards" is not observable
// anywhere else.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// One route in the table is a bare `send(res, 200, systemSnapshot())` — called
// straight from the listener with no `guard` in front of it, exactly as
// `/api/events` was. Making its one input throw on demand is the only way to
// ask the listener the general question: is a synchronous throw on a bare route
// still fatal? Everything else in system-metrics.mjs stays real.
const { boom } = vi.hoisted(() => ({ boom: { value: false } }));
vi.mock("../../server/system-metrics.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    systemSnapshot: () => {
      if (boom.value) throw new Error("system metrics blew up");
      return (real.systemSnapshot as () => unknown)();
    },
  };
});

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-events-stream-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { startServer, writeJsonArray } = await import("../../server/index.mjs");

/** V8's longest string on a 64-bit build: `2^29 - 24`. Not a platform number —
 *  Linux, macOS and Windows all refuse at the same character. */
const V8_MAX_STRING = 536_870_888;

/** What `POST /api/event` accepts, in characters, less the envelope it grows. */
const INGEST_CAP = 5_000_000;

// ─── The stub ────────────────────────────────────────────────────────────────

/**
 * Enough of a ServerResponse for writeJsonArray, recording what it is handed.
 *
 * `writableLength` and `socket.writableLength` stay at zero, which is what a
 * reader keeping up looks like: writeResume takes its plain-write path and the
 * backpressure branch — which sse-resume-backpressure already covers through a
 * real socket — stays out of the way of the arithmetic being measured here.
 *
 * `keep: false` throws the chunks away and remembers only their sizes, so the
 * half-gigabyte case can be asserted on a laptop's worth of memory.
 */
function stubRes(keep = true) {
  const res = {
    chunks: [] as string[],
    written: 0,
    writes: 0,
    largest: 0,
    status: 0,
    headers: {} as Record<string, string>,
    ended: false,
    destroyed: false,
    writableLength: 0,
    socket: { writableLength: 0 },
    note(frame: string) {
      res.written += frame.length;
      res.writes += 1;
      if (frame.length > res.largest) res.largest = frame.length;
      if (keep) res.chunks.push(frame);
    },
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status;
      res.headers = headers;
    },
    write(frame: string) { res.note(frame); return true; },
    end(frame?: string) { if (frame !== undefined) res.note(frame); res.ended = true; },
    destroy() { res.destroyed = true; },
  };
  return res;
}

/** An envelope shaped like the ring's, carrying `chars` of payload. */
function envelope(seq: number, chars: number) {
  return { seq, epoch: "test-epoch", receivedAt: 1700000000000 + seq, source: "hook", payload: { blob: "x".repeat(chars) } };
}

/** A value `depth` levels deep, built iteratively — the shape that overflows
 *  V8's recursive stringifier without being large. */
function nested(depth: number): unknown {
  let node: unknown = 1;
  for (let i = 0; i < depth; i++) node = { a: node };
  return node;
}

/** The same thing as JSON text, for posting through ingest. */
function nestedJson(depth: number): string {
  return `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
}

// ─── The server ──────────────────────────────────────────────────────────────

let server: Server;
let port = 0;

beforeAll(async () => {
  // No persistence: the ring is the whole subject here, and a log would add a
  // second serialization of every event on a path this test is not about.
  server = await startServer({ port: 0, persist: null, codex: false });
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
  rmSync(DIR, { recursive: true, force: true });
});

type Reply = { status: number; text: string; headers: Record<string, string | string[] | undefined> };

function call(method: "GET" | "POST", path: string, body?: string): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, text: out, headers: res.headers }));
    });
    // A listener that throws leaves the socket open with no answer coming, and
    // the honest reading of that is not "vitest timed out after 20s" — it is
    // "this request was abandoned mid-flight". Ten seconds is far outside what
    // a loopback request costs on the slowest of the three runners and inside
    // the case budget, so the failure names itself.
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`${method} ${path} was never answered — the request handler threw and abandoned the response`));
    });
    req.on("error", fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const get = (path: string) => call("GET", path);
const post = (path: string, body: string) => call("POST", path, body);

/** Silence the deck's own stderr for a case that provokes it, and hand back
 *  what it said — both halves matter: the operator is told, the wire is not. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string }> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const value = await fn();
    const logged = spy.mock.calls.map(c => c.map(String).join(" ")).join("\n");
    return { value, logged };
  } finally {
    spy.mockRestore();
  }
}

// ─── Cases ───────────────────────────────────────────────────────────────────

describe("GET /api/events writes the ring instead of stringifying it", () => {
  it("emits one envelope per write and concatenates to exactly what send would have built", async () => {
    const items = Array.from({ length: 8 }, (_, i) => envelope(i + 1, 64 * 1024));
    const res = stubRes();

    await writeJsonArray(res, items);

    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.ended).toBe(true);
    // Byte-for-byte the old answer. Streaming it must not change what a caller
    // reads, only how much of it exists at once.
    expect(res.chunks.join("")).toBe(JSON.stringify(items));
    // One write per envelope plus the closing bracket, and — the property the
    // ceiling actually turns on — no single write ever holds two of them.
    expect(res.writes, "one write per envelope plus the closing bracket").toBe(items.length + 1);
    expect(res.written).toBeGreaterThan(8 * 64 * 1024);
    expect(res.largest, "no single string may hold more than one envelope").toBeLessThan(70 * 1024);
  });

  it("answers an empty ring with an empty array", async () => {
    const res = stubRes();
    await writeJsonArray(res, []);
    expect(res.chunks.join("")).toBe("[]");
    expect(res.ended).toBe(true);
  });

  // The ceiling, at a scale that fits in a CI matrix.
  //
  // Proving it at full size means actually serialising more than 536,870,888
  // characters, and that costs what it costs: measured here, 112 envelopes of
  // 4,900,061 characters took 20.7s inside a vitest worker, on the fast one of
  // the three operating systems this suite runs on. So the case asserts the
  // property the ceiling follows from instead, at 1/40th the size — the largest
  // string this route ever holds is ONE envelope, whatever the ring's total.
  // Twelve megabytes of answer, half a megabyte of peak, and the ratio is the
  // ring's length rather than a constant: at MAX_BUFFER envelopes of the five
  // million characters ingest admits, the answer is ten gigabytes and the
  // largest string is still one event, a hundredth of what V8 refuses at.
  //
  // The full-size failure is not left unproven, it is just proven outside the
  // suite: pre-fix, 112 such posts to the real server followed by one plain
  // `GET /api/events?since=0` ended the process with
  // `RangeError: Invalid string length`; post-fix the same GET answers
  // 548,817,253 bytes. The stub below is what would have to break first.
  it("never holds more than one envelope as a string, however long the ring", async () => {
    const items = Array.from({ length: 24 }, (_, i) => envelope(i + 1, 512 * 1024));
    const res = stubRes(false);

    await writeJsonArray(res, items);

    expect(res.status).toBe(200);
    expect(res.ended).toBe(true);
    expect(res.written).toBeGreaterThan(12 * 1024 * 1024);
    expect(res.writes, "one write per envelope plus the closing bracket").toBe(items.length + 1);
    expect(res.largest, "no single string may hold more than one envelope").toBeLessThan(512 * 1024 + 256);
    // Stated in the terms the bug was filed in: whatever this answer weighs,
    // the biggest string behind it stays a rounding error against V8's limit.
    expect(res.largest).toBeLessThan(INGEST_CAP);
    expect(res.largest * 20).toBeLessThan(res.written);
    expect(V8_MAX_STRING).toBeGreaterThan(res.largest * 100);
  });

  it("replaces an envelope that will not serialise instead of truncating the array", async () => {
    const items = [
      envelope(1, 8),
      { seq: 2, epoch: "test-epoch", receivedAt: 42, source: "hook", payload: nested(6000) },
      envelope(3, 8),
    ];
    const res = stubRes();

    const { logged } = await captureStderr(() => writeJsonArray(res, items));

    // Valid JSON, all three entries, both good ones untouched.
    const parsed = JSON.parse(res.chunks.join("")) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(3);
    expect(parsed[0].seq).toBe(1);
    expect(parsed[2].seq).toBe(3);
    // The bad one keeps its seq, so a caller paging with ?since= walks past it
    // rather than asking forever for a hole it can never be given.
    expect(parsed[1]).toEqual({
      seq: 2,
      epoch: "test-epoch",
      receivedAt: 42,
      source: "hook",
      payload: null,
      unserializable: true,
    });
    // The operator is told why; the wire — readable by a DNS-rebound page, which
    // is the whole reason sendInternalError splits its two audiences — is not.
    expect(logged).toContain("could not be serialized");
    expect(logged).toContain("Maximum call stack size exceeded");
    expect(res.chunks.join("")).not.toContain("call stack");
  });
});

describe("the live route survives a ring it cannot stringify", () => {
  it("serves the ring in order, chunked, with ?since= still filtering", async () => {
    for (const tag of ["one", "two", "three"]) {
      const body = JSON.stringify({ hook_event_name: "PostToolUse", session_id: `sess-${tag}`, cwd: "/repo", tag });
      expect((await post("/api/event", body)).status).toBe(200);
    }

    const all = await get("/api/events?since=0");
    expect(all.status).toBe(200);
    const parsed = JSON.parse(all.text) as Array<{ seq: number; payload: { tag?: string } }>;
    expect(parsed.length).toBeGreaterThanOrEqual(3);
    const tags = parsed.map(e => e.payload?.tag).filter(Boolean);
    expect(tags).toEqual(["one", "two", "three"]);
    // Seqs strictly increasing: the writer walks a snapshot, so nothing may be
    // repeated or reordered by the awaits between frames.
    for (let i = 1; i < parsed.length; i++) expect(parsed[i].seq).toBeGreaterThan(parsed[i - 1].seq);

    // No Content-Length, because computing one means building the string this
    // route no longer builds. A body of unknown length on HTTP/1.1 is chunked.
    expect(all.headers["content-length"]).toBeUndefined();
    expect(all.headers["transfer-encoding"]).toBe("chunked");

    const first = parsed[0].seq;
    const rest = JSON.parse((await get(`/api/events?since=${first}`)).text) as Array<{ seq: number }>;
    expect(rest.every(e => e.seq > first)).toBe(true);
    expect(rest.length).toBe(parsed.length - 1);
  });

  it("keeps serving after a payload the ring cannot stringify is posted to it", async () => {
    // 36 KB, and every byte of it accepted by the open ingest route. Before the
    // fix the GET below took the process with it.
    const body = `{"hook_event_name":"PostToolUse","session_id":"sess-deep","cwd":"/repo","deep":${nestedJson(6000)}}`;
    expect(body.length).toBeLessThan(64 * 1024);
    expect((await post("/api/event", body)).status).toBe(200);

    const { value: served, logged } = await captureStderr(() => get("/api/events?since=0"));

    expect(served.status).toBe(200);
    // Said before the parse, so a failure here reads as what it is rather than
    // as "Unexpected end of JSON input": the answer stopped mid-array because
    // serialising it threw, and the client is holding a truncated document.
    expect(
      served.text.startsWith("[") && served.text.endsWith("]"),
      `GET /api/events came back truncated (${served.text.length} chars, ending ${JSON.stringify(served.text.slice(-24))})`
        + " — serialising the ring threw and the answer was cut off where it did",
    ).toBe(true);
    const parsed = JSON.parse(served.text) as Array<Record<string, unknown>>;
    // One stub, everything else intact — and the array is parseable at all,
    // which a truncated write would not be.
    expect(parsed.filter(e => e.unserializable === true)).toHaveLength(1);
    expect(parsed.filter(e => e.unserializable !== true).length).toBeGreaterThanOrEqual(3);
    expect(logged).toContain("could not be serialized");

    // The point of the whole file: the deck is still answering.
    expect((await get("/api/health")).status).toBe(200);
  });

  it("turns a synchronous throw on a bare route into a 500 rather than a dead deck", async () => {
    // `/api/system` is dispatched straight from the listener with no `guard`,
    // which is what `/api/events` was and what the next route someone adds
    // without thinking about it will be.
    boom.value = true;
    let reply: Reply;
    let logged: string;
    try {
      ({ value: reply, logged } = await captureStderr(() => get("/api/system")));
    } finally {
      boom.value = false;
    }

    expect(reply!.status).toBe(500);
    expect(JSON.parse(reply!.text)).toEqual({ error: "internal error" });
    // Same split as everywhere else: the reason goes to stderr, never the wire.
    expect(reply!.text).not.toContain("system metrics blew up");
    expect(logged!).toContain("system metrics blew up");

    // And the route works again the moment its input does, which is only true
    // if the process is the same one.
    const ok = await get("/api/system");
    expect(ok.status).toBe(200);
    expect((await get("/api/health")).status).toBe(200);
  });
});
