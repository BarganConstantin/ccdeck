// #635: one small `POST /api/event` ended the deck inside pushEvent, before
// any GET was involved.
//
// The line was `const json = (sseClients.size > 0 || persisting) ?
// JSON.stringify(evt) : null`, unguarded. `JSON.stringify` walks a value
// recursively and `JSON.parse` does not, and the gap between the two is
// enormous — measured here on Node 22.14 / macOS: parse accepts a body nested
// 4,194,303 deep, and stringify gives up on the parsed result at 4,021. A body
// anywhere in that window parses cleanly and then throws `RangeError: Maximum
// call stack size exceeded` on the next line.
//
// That throw was fatal rather than a 500. pushEvent is reached from inside a
// raw `req.on("end")` listener in handleEventIngest, and the route does wrap the
// call — `guard(handleEventIngest(req, res, …), res)` — but handleEventIngest
// returns undefined and hands its work to a listener the event loop calls
// later, so `guard` had nothing to attach to. Measured against the real server
// before the fix: one POST of 24,378 bytes nested 4,050 deep to `/api/event` —
// a credential-free route, deliberately, because hook/hook.js is installed
// outside this package — and the process was gone with nothing on the socket to
// tell the poster why. 24 KB is a two-hundredth of the 5,000,000-character
// ingest cap, and `persisting` is the default, so it did not even need a
// browser tab open.
//
// Two consumers reach that line and either one is enough, so both are driven
// here: a subscribed SSE client (the whole first block, with no log) and the
// event log (the second, with no subscriber).
//
// The second-order half is the reason this file is mostly about SSE.
// `events.push(evt)` happens BEFORE the serialisation, so containing the throw
// on its own would leave the ring holding an envelope no reader can deliver —
// and the `Last-Event-ID` resume stringifies every envelope it replays. That
// throw is not fatal (handleSse catches it) but it drops the client, the
// browser reconnects on its own 1.5s timer, replays the same entry and is
// dropped again, so the canvas never loads for as long as the entry lives. The
// fix therefore takes the payload out of the ring at the write, and contains
// the resume for the one case the write cannot cover: a deck with no subscriber
// and no log serialises nothing, so the first read of such an entry really can
// be the replay.
//
// Payloads are ~36 KB. That is the point of the report: the trigger is cheap.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// handleEventIngest's `end` listener now has a `try`/`catch` of its own, and
// the only way to ask whether it holds for something other than the
// serialisation — which is contained at its own line and never reaches it — is
// to make one of the things it calls throw on demand. appendLogLine is the one
// import on that path; everything else in log-writer.mjs stays real. Same
// technique, and the same reason, as the systemSnapshot stub in
// api-events-streaming.test.ts.
const { boom } = vi.hoisted(() => ({ boom: { value: false } }));
vi.mock("../../server/log-writer.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    appendLogLine: (path: string, line: string) => {
      if (boom.value) throw new Error("log writer blew up");
      return (real.appendLogLine as (p: string, l: string) => unknown)(path, line);
    },
  };
});

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-deep-ingest-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { startServer } = await import("../../server/index.mjs");

/** Deep enough that `JSON.stringify` refuses on every runner this suite meets,
 *  and the same depth api-events-streaming.test.ts pins the sibling defect at.
 *  The measured ceiling on the author's machine is 4,021; the margin is for the
 *  platforms whose stacks are not that one. */
const DEPTH = 6000;

/** A value `depth` levels deep as JSON text, built by repetition rather than
 *  recursion — the shape overflows V8's stringifier, not this file's. */
const nestedJson = (depth: number) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;

/** A hook payload the deck will accept and then be unable to serialise. */
const deepBody = (sid: string) =>
  `{"hook_event_name":"PostToolUse","session_id":"${sid}","cwd":"/repo","deep":${nestedJson(DEPTH)}}`;

/** An ordinary one, for the "and it still works" half of each case. */
const plainBody = (sid: string, tag: string) =>
  JSON.stringify({ hook_event_name: "PostToolUse", session_id: sid, cwd: "/repo", tag });

// ─── The server ──────────────────────────────────────────────────────────────

let server: Server;
let port = 0;

async function boot(persist: string | null) {
  server = await startServer({ port: 0, host: "127.0.0.1", persist, codex: false });
  port = (server.address() as AddressInfo).port;
}

async function shutdown() {
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
}

type Reply = { status: number; text: string };

function call(method: "GET" | "POST", path: string, body?: string): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, agent: false }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, text: out }));
    });
    // A dead deck does not refuse the connection — it dies holding one — so the
    // honest failure here is not "vitest timed out after 20s" but "this request
    // was abandoned mid-flight". Ten seconds is far outside a loopback request
    // on the slowest of the three runners, so the failure names itself.
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`${method} ${path} was never answered — the request handler threw and took the process with it`));
    });
    req.on("error", fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const get = (path: string) => call("GET", path);
const post = (body: string) => call("POST", "/api/event", body);

async function health(): Promise<{ ok: boolean; clients: number }> {
  return JSON.parse((await get("/api/health")).text);
}

/** Silence the deck's own stderr for a case that provokes it, and hand back
 *  what it said — both halves matter: the operator is told, the wire is not. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string }> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const value = await fn();
    return { value, logged: spy.mock.calls.map(c => c.map(String).join(" ")).join("\n") };
  } finally {
    spy.mockRestore();
  }
}

async function waitUntil(pred: () => boolean | Promise<boolean>, label: string, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ─── An SSE subscriber ───────────────────────────────────────────────────────

type Frame = { id: string | null; event: string; data: string };

/**
 * A subscriber that reads everything, parsed into frames.
 *
 * `Last-Event-ID` is what a reconnecting tab sends and what walks the ring, so
 * it is the handle on the resume path; zero asks for the whole ring, which is
 * also what a tab opened for the first time gets.
 */
function openSse(lastEventId?: number) {
  const frames: Frame[] = [];
  let buf = "";
  let ended = false;
  const client = {
    frames,
    ended: () => ended,
    close: () => { req.destroy(); ended = true; },
    /** The `hook` frame carrying this seq, or undefined. */
    hook: (seq: number) => frames.find(f => f.event === "hook" && f.id === String(seq)),
    saw: (event: string) => frames.some(f => f.event === event),
    /** Wait, and say so plainly if the server hung up instead — which is what a
     *  replay that threw looks like from out here. */
    async waitFor(pred: () => boolean, label: string) {
      await waitUntil(() => {
        if (pred()) return true;
        if (ended) throw new Error(`the SSE stream was closed before ${label} — the replay threw and the client was dropped`);
        return false;
      }, label);
    },
  };
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId !== undefined) headers["Last-Event-ID"] = String(lastEventId);
  const req = request({ host: "127.0.0.1", port, path: "/events", method: "GET", agent: false, headers });
  return new Promise<typeof client>((done, fail) => {
    req.on("response", res => {
      res.setEncoding("utf8");
      res.on("data", c => {
        buf += c;
        // SSE frames are blank-line delimited; anything after the last one is a
        // partial frame and stays in the buffer.
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          if (block.trim() === "" || block.startsWith(":")) continue;
          const frame: Frame = { id: null, event: "message", data: "" };
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) frame.id = line.slice(4);
            else if (line.startsWith("event: ")) frame.event = line.slice(7);
            else if (line.startsWith("data: ")) frame.data = line.slice(6);
          }
          frames.push(frame);
        }
      });
      res.on("end", () => { ended = true; });
      res.on("close", () => { ended = true; });
      done(client);
    });
    req.on("error", fail);
    req.end();
  });
}

type Sse = Awaited<ReturnType<typeof openSse>>;

/** Open one and wait until the ring has finished replaying into it. */
async function subscriber(lastEventId?: number): Promise<Sse> {
  const s = await openSse(lastEventId);
  await s.waitFor(() => s.saw("replay-end"), "the ring to finish replaying");
  return s;
}

// ─── A subscriber is reason enough ───────────────────────────────────────────

describe("a payload the deck cannot serialise, with a subscriber and no log", () => {
  const open: Sse[] = [];

  beforeAll(async () => { await boot(null); });
  afterAll(async () => { for (const s of open) s.close(); await shutdown(); });

  let poisonSeq = 0;

  it("answers the poster and stays up, instead of dying on the next line", async () => {
    const sub = await subscriber();
    open.push(sub);

    const body = deepBody("sess-live");
    // The report's whole point: this is a small request.
    expect(body.length).toBeLessThan(40 * 1024);

    const { value: reply, logged } = await captureStderr(() => post(body));

    // Answered at all. Before the fix the process was gone by now and this
    // socket died with no status line on it, which is what the ten-second
    // timeout in `call` reports.
    expect(reply.status).toBe(200);
    const ack = JSON.parse(reply.text) as { ok: boolean; seq: number };
    expect(ack.ok).toBe(true);
    expect(typeof ack.seq).toBe("number");
    poisonSeq = ack.seq;

    // The operator is told why; the wire — readable by a DNS-rebound page,
    // which is the whole reason sendInternalError splits its two audiences —
    // is not.
    expect(logged).toContain("could not be serialized");
    expect(logged).toContain("Maximum call stack size exceeded");
    expect(reply.text).not.toContain("call stack");

    // The deck is still here, which is the point of the file.
    expect((await health()).ok).toBe(true);

    // And what went out on the live stream is a valid envelope keeping the seq,
    // not a truncated frame and not a dropped client.
    await sub.waitFor(() => sub.hook(poisonSeq) !== undefined, "the live frame for the unserialisable event");
    expect(JSON.parse(sub.hook(poisonSeq)!.data)).toEqual({
      seq: poisonSeq,
      epoch: expect.any(String),
      receivedAt: expect.any(Number),
      source: "hook",
      payload: null,
      unserializable: true,
    });
    expect((await health()).clients).toBe(1);

    // The next event is ordinary, so nothing about the fan-out was left broken.
    const next = await post(plainBody("sess-live", "after"));
    const nextSeq = (JSON.parse(next.text) as { seq: number }).seq;
    await sub.waitFor(() => sub.hook(nextSeq) !== undefined, "the live frame after the unserialisable one");
    expect(JSON.parse(sub.hook(nextSeq)!.data).payload.tag).toBe("after");
  }, 30_000);

  it("keeps no envelope in the ring that a later resume cannot replay", async () => {
    // A tab reconnecting with `Last-Event-ID: 0` — the resume that walks the
    // whole ring, and the one a poison entry would break forever.
    const { value: resumed, logged } = await captureStderr(async () => {
      const s = await subscriber(0);
      open.push(s);
      return s;
    });

    // It got there, and it got there without anything having to be contained on
    // the way: pushEvent took the payload out of the ring when it could not
    // serialise it, so the entry the resume replays is an ordinary envelope now.
    // A fix that only contained the throw per read would log here every time.
    expect(logged).not.toContain("could not be serialized");
    const replayed = resumed.hook(poisonSeq);
    expect(replayed, `the resume skipped seq ${poisonSeq} instead of replaying it`).toBeDefined();
    const env = JSON.parse(replayed!.data);
    expect(env.payload).toBeNull();
    expect(env.unserializable).toBe(true);
    // Tagged like every other replayed envelope, which is only true if the ring
    // entry itself is serialisable.
    expect(env.replay).toBe(true);

    // The same answer through the other reader of the same ring.
    const served = JSON.parse((await get("/api/events?since=0")).text) as Array<Record<string, unknown>>;
    const entry = served.find(e => e.seq === poisonSeq);
    expect(entry).toEqual({
      seq: poisonSeq,
      epoch: expect.any(String),
      receivedAt: expect.any(Number),
      source: "hook",
      payload: null,
      unserializable: true,
    });
  }, 30_000);

  it("replays an envelope nothing serialised on the way in", async () => {
    // The one case the write cannot cover. With no subscriber and no log,
    // pushEvent skips the serialisation entirely — deliberately, so a headless
    // deck does not pay a stringify per event for a string no one reads — so
    // the ring keeps the envelope exactly as posted, and the first thing to
    // walk it is the replay for the browser that connects next.
    for (const s of open) s.close();
    await waitUntil(async () => (await health()).clients === 0, "the subscribers to be gone");

    const cold = await post(deepBody("sess-cold"));
    expect(cold.status).toBe(200);
    const coldSeq = (JSON.parse(cold.text) as { seq: number }).seq;

    const { value: resumed, logged } = await captureStderr(async () => {
      const s = await subscriber(0);
      open.push(s);
      return s;
    });

    // Reaching replay-end at all is the assertion: uncontained, the replay threw
    // into handleSse's `.catch`, which destroyed the socket — so the subscriber
    // helper above would have failed with "the SSE stream was closed before the
    // ring to finish replaying".
    expect(logged).toContain("could not be serialized");
    const env = JSON.parse(resumed.hook(coldSeq)!.data);
    expect(env.seq).toBe(coldSeq);
    expect(env.payload).toBeNull();
    expect(env.unserializable).toBe(true);

    // And the client that got through the replay is a live subscriber, not a
    // socket the server is about to hang up on.
    expect((await health()).clients).toBe(1);
    const live = await post(plainBody("sess-cold", "live"));
    const liveSeq = (JSON.parse(live.text) as { seq: number }).seq;
    await resumed.waitFor(() => resumed.hook(liveSeq) !== undefined, "the live event after the replay");
    expect(JSON.parse(resumed.hook(liveSeq)!.data).payload.tag).toBe("live");
  }, 30_000);
});

// ─── The log is reason enough on its own ─────────────────────────────────────

describe("a payload the deck cannot serialise, with a log and no subscriber", () => {
  // Second, not first: startServer only ever assigns persistPath, so a
  // persisting server in this worker cannot be un-persisted for a later block.
  const LOG = join(DIR, "events.jsonl");

  beforeAll(async () => { await shutdown(); await boot(LOG); });
  afterAll(async () => { await shutdown(); });

  it("writes a line the log can hold, with nobody subscribed at all", async () => {
    expect((await health()).clients).toBe(0);

    const { value: reply, logged } = await captureStderr(() => post(deepBody("sess-log")));

    expect(reply.status).toBe(200);
    const seq = (JSON.parse(reply.text) as { seq: number }).seq;
    expect(logged).toContain("could not be serialized");
    expect(reply.text).not.toContain("call stack");
    expect((await health()).ok).toBe(true);

    // The append is fire-and-forget, so the file is polled rather than read once.
    await waitUntil(() => readFileSync(LOG, "utf8").includes(`"seq":${seq}`), "the event to reach the log");

    // JSONL means every line is a whole JSON document. A throw here would have
    // left a truncated one, and replayLog would refuse the file from that line
    // on — the deck's own canvas after a restart.
    const lines = readFileSync(LOG, "utf8").split("\n").filter(Boolean);
    const parsed = lines.map(l => JSON.parse(l) as Record<string, unknown>);
    const written = parsed.find(e => e.seq === seq);
    expect(written).toEqual({
      seq,
      epoch: expect.any(String),
      receivedAt: expect.any(Number),
      source: "hook",
      payload: null,
      unserializable: true,
    });
  }, 30_000);

  it("turns any other throw past the parse into a 500 rather than a dead deck", async () => {
    // Not the serialisation — that is contained at its own line and never
    // reaches this catch. This is the general question the report ends on: the
    // `end` listener is the one place in the route table `guard` cannot reach,
    // so anything thrown in it is an uncaughtException, and the next thing added
    // to it should not cost a process to find that out.
    boom.value = true;
    let reply: Reply;
    let logged: string;
    try {
      ({ value: reply, logged } = await captureStderr(() => post(plainBody("sess-boom", "boom"))));
    } finally {
      boom.value = false;
    }

    expect(reply!.status).toBe(500);
    expect(JSON.parse(reply!.text)).toEqual({ error: "internal error" });
    // Same split as everywhere else: the reason goes to stderr, never the wire.
    expect(reply!.text).not.toContain("log writer blew up");
    expect(logged!).toContain("log writer blew up");

    // And the route works again the moment its input does, which is only true
    // if this is the same process.
    const ok = await post(plainBody("sess-boom", "recovered"));
    expect(ok.status).toBe(200);
    expect((await health()).ok).toBe(true);
  }, 30_000);
});

afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});
