// What a reconnecting page is replayed, and what it is not (#1168).
//
// `Last-Event-ID` is the whole of the deck's catch-up story: the page's
// EventSource sends the last id it saw, and handleSse walks the ring and skips
// everything at or below it. The suite exercised the SIZE of that replay —
// backpressure, the byte budget, the drain deadline — and never once its
// CONTENT, so the one line that decides what a page misses (`if (e.seq <=
// sentThrough) continue`) could have been deleted and the suite would have
// stayed green while every reconnect replayed the whole ring again, drawing
// every finished turn a second time.
//
// The last case here is the other end of that filter: an id the deck never
// issued, which is what a page carries when it is pointed at a DIFFERENT deck —
// another machine's, or a fresh one whose ids start again. It is replayed
// nothing, and the live stream still reaches it, so the canvas fills in again
// as soon as anything happens.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-sse-resume-window-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

const mod = await import("../../server/index.mjs");
const token = (): string => mod.hookToken();

type Frame = { event: string; data: string; id: string | null };

let server: Server;
let port = 0;
const streams: IncomingMessage[] = [];

const boot = async () => {
  server = await mod.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
};

beforeAll(boot, 30_000);
afterAll(async () => {
  for (const s of streams.splice(0)) s.destroy();
  await new Promise(done => server.close(done));
  rmTempDir(DIR);
});

/** One event into the ring. The route takes any JSON value. */
function postEvent(payload: unknown): Promise<number> {
  return new Promise((done, fail) => {
    const body = JSON.stringify(payload);
    const req = request({ host: "127.0.0.1", port, path: "/api/event", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-ccdeck-token": token() } }, res => {
      res.resume();
      res.on("end", () => done(res.statusCode ?? 0));
    });
    req.on("error", fail);
    req.end(body);
  });
}

/** An open /events stream whose frames can be waited on. */
function openStream(headers: Record<string, string> = {}) {
  const frames: Frame[] = [];
  const ready = new Promise<void>((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/events", method: "GET", headers: { accept: "text/event-stream", "x-ccdeck-token": token(), ...headers } }, res => {
      streams.push(res);
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end === -1) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith(":")) continue;             // the deck's ping
          const field = (name: string) => block.split("\n").find(l => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
          frames.push({ event: field("event") ?? "message", data: field("data") ?? "", id: field("id") });
        }
      });
      done();
    });
    req.on("error", fail);
    req.end();
  });
  const until = async (test: () => boolean, ms = 5_000) => {
    const t0 = Date.now();
    while (!test()) {
      if (Date.now() - t0 > ms) throw new Error(`gave up waiting; frames so far: ${JSON.stringify(frames)}`);
      await new Promise(done => setTimeout(done, 20));
    }
  };
  return { frames, ready, until, hooks: () => frames.filter(f => f.event === "hook") };
}

const marks = (s: { hooks: () => Frame[] }) => s.hooks().map(f => JSON.parse(f.data).payload?.mark);

describe("a page that reconnects", () => {
  it("is replayed the whole ring when it has seen nothing", async () => {
    for (const mark of ["a", "b", "c"]) expect(await postEvent({ mark })).toBe(200);
    const s = openStream();
    await s.ready;
    await s.until(() => s.frames.some(f => f.event === "replay-end"));
    expect(marks(s)).toEqual(["a", "b", "c"]);
    // Every replayed frame carries its own id, which is what the browser sends
    // back as Last-Event-ID, and the tag the page draws the replay by.
    expect(s.hooks().map(f => f.id)).toEqual(["1", "2", "3"]);
    expect(s.hooks().every(f => JSON.parse(f.data).replay === true)).toBe(true);
  });

  it("is replayed only what came after the id it names", async () => {
    const s = openStream({ "last-event-id": "2" });
    await s.ready;
    await s.until(() => s.frames.some(f => f.event === "replay-end"));
    expect(marks(s)).toEqual(["c"]);
    // And the sentinel still comes, so the page leaves its replay mode.
    expect(s.frames.at(-1)?.event).toBe("replay-end");
  });

  it("is replayed nothing when it is already at the tail, and then hears the live stream", async () => {
    const s = openStream({ "last-event-id": "3" });
    await s.ready;
    await s.until(() => s.frames.some(f => f.event === "replay-end"));
    expect(marks(s)).toEqual([]);
    expect(await postEvent({ mark: "d" })).toBe(200);
    await s.until(() => s.hooks().length === 1);
    const live = JSON.parse(s.hooks()[0].data);
    expect(live.payload.mark).toBe("d");
    expect(live.replay).toBeUndefined();   // live frames are not tagged as replay
  });

  it("hears an event that lands during its replay exactly once", async () => {
    // The replay repeats until it reaches the tail, and the client is added to
    // the live fan-out only after that — an event that arrives in between used
    // to be able to fall into the gap, or to be sent by both paths.
    const s = openStream();
    await s.ready;
    expect(await postEvent({ mark: "e" })).toBe(200);
    await s.until(() => marks(s).includes("e"));
    await new Promise(done => setTimeout(done, 100));
    expect(marks(s).filter(m => m === "e")).toHaveLength(1);
    expect(marks(s)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("a page that names an id this deck never issued", () => {
  it("is replayed nothing, and still hears what happens next", async () => {
    // A tab moved to another deck, or reconnecting to one whose ring starts
    // again: every id it knows is above this deck's tail. The filter skips the
    // whole ring — the page keeps what it already drew — and the sentinel still
    // arrives, so it leaves replay mode instead of waiting for a frame that is
    // never coming.
    const stale = openStream({ "last-event-id": "999999" });
    await stale.ready;
    await stale.until(() => stale.frames.some(f => f.event === "replay-end"));
    expect(marks(stale)).toEqual([]);

    expect(await postEvent({ mark: "z" })).toBe(200);
    await stale.until(() => marks(stale).includes("z"));

    // And a page connecting fresh is replayed everything, ids and all.
    const fresh = openStream();
    await fresh.ready;
    await fresh.until(() => fresh.frames.some(f => f.event === "replay-end"));
    expect(marks(fresh)).toEqual(["a", "b", "c", "d", "e", "z"]);
  });
});
