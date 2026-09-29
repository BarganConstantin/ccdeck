// #1739: a paired deck could make the listener hold unlimited replies.
//
// After the handshake the listener started its handler for every frame in a
// chunk at once, and each answer went out through a write that never looked at
// how much was already queued. A paired caller that pipelined thousands of
// `manifest` questions and never read made this process buffer every answer —
// about ten times the bytes it sent — and each frame reset the idle timer, so
// it could go on until memory ran out.
//
// A connection now has one question answered at a time, with a few at most
// waiting behind it: a round asks one and reads the answer before the next, so
// an honest deck never has any waiting. More than that closes the connection,
// and so does a caller whose unread answers pass a fixed size.
//
// Every listener binds 127.0.0.1 on a port the OS picks.
import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey, identityFrom } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { connectToPeer, createSyncServer } from "../../server/lan-socket.mjs";
import { rigDeck, stopAll } from "./lan-engine-rig";

const opened: Array<{ stop: () => void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  stopAll();
  for (const o of opened.splice(0)) o.stop();
});

/** Every socket the listener accepts, from the moment the spy is set. */
function acceptedSockets() {
  const accepted: net.Socket[] = [];
  const real = net.createServer.bind(net);
  vi.spyOn(net, "createServer").mockImplementation(((onConn: (s: net.Socket) => void) =>
    real(s => { accepted.push(s); onConn(s); })) as typeof net.createServer);
  return accepted;
}

const MB = 1024 * 1024;
const wait = (ms: number) => new Promise(res => setTimeout(res, ms));
/** What a listener-side socket is still holding for a caller that is not
 *  reading, or 0 once it has been let go. */
const held = (s: net.Socket) => (s.destroyed ? 0 : s.writableLength);

/** One frame out and the next one back, through the connection's own seal. */
function askOn(conn: { sock: net.Socket; send: (f: unknown) => void; read: (f: unknown) => unknown }, frame: unknown) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i === -1) return;
      conn.sock.off("data", onData);
      resolve(conn.read(JSON.parse(buf.slice(0, i))) as Record<string, unknown>);
    };
    conn.sock.on("data", onData);
    conn.sock.once("close", () => reject(new Error("closed")));
    conn.send(frame);
  });
}

describe("a paired caller that asks and never reads (#1739)", () => {
  it("is not answered into this process's memory", async () => {
    const accepted = acceptedSockets();
    const caller = identityFrom("");
    const rows = Array.from({ length: 10 }, (_, i) => ({ num: i + 1, email: `user${i}@example.test`, orgUuid: "org-1", alive: true }));
    const d = await rigDeck("Holder", {
      rows,
      shared: rows.map(r => accountKey(r.email, r.orgUuid)),
      settings: { autoAsk: false, autoAccept: false, trusted: [{ fp: caller.fp, pub: caller.pub, name: "Caller" }] },
    });
    const conn = await connectToPeer({
      host: "127.0.0.1", port: d.port, fp: caller.fp, pub: caller.pub, secret: caller.secret, name: "Caller",
      expectPub: d.id.pub,
    });
    try {
      conn.sock.pause();
      for (let i = 0; i < 20_000; i++) conn.send({ t: "manifest" });
      await wait(1_500);
      expect(accepted.length).toBeGreaterThan(0);
      for (const s of accepted) expect(held(s), "replies piled up for a caller that is not reading").toBeLessThan(1 * MB);
    } finally {
      conn.sock.destroy();
    }
  }, 20_000);

  it("is let go once its unread answers pass a fixed size, however slowly it asks", async () => {
    // One question at a time, never more than one waiting — and still never
    // reading. The answers are large on purpose, so what they would pile up to
    // is far past anything the loopback's own buffers could hide.
    const accepted = acceptedSockets();
    const me = identityFrom("");
    const caller = identityFrom("");
    const big = "x".repeat(120 * 1024);
    const s = createSyncServer({
      fp: me.fp, pub: me.pub, secret: me.secret, name: "Holder", host: "127.0.0.1",
      trusted: () => [{ fp: caller.fp, pub: caller.pub, name: "Caller" }],
      handlers: async (_msg: unknown, ctx: { send: (o: unknown) => void }) => { await null; ctx.send({ t: "big", big }); },
    });
    opened.push(s);
    const port = await s.start();
    const conn = await connectToPeer({
      host: "127.0.0.1", port, fp: caller.fp, pub: caller.pub, secret: caller.secret, name: "Caller", expectPub: me.pub,
    });
    try {
      conn.sock.pause();
      const until = Date.now() + 1_500;
      while (Date.now() < until && !conn.sock.destroyed) {
        conn.send({ t: "manifest" });
        await wait(5);
      }
      for (const a of accepted) expect(held(a), "answers piled up one question at a time").toBeLessThan(1 * MB);
    } finally {
      conn.sock.destroy();
    }
  }, 20_000);
});

describe("a caller that asks the way a round does (#1739)", () => {
  it("is answered every time, one question after another on one connection", async () => {
    const me = identityFrom("");
    const caller = identityFrom("");
    let n = 0;
    const s = createSyncServer({
      fp: me.fp, pub: me.pub, secret: me.secret, name: "Holder", host: "127.0.0.1",
      trusted: () => [{ fp: caller.fp, pub: caller.pub, name: "Caller" }],
      handlers: async (msg: { i: number }, ctx: { send: (o: unknown) => void }) => {
        await wait(1);
        ctx.send({ t: "answer", i: msg.i, n: ++n });
      },
    });
    opened.push(s);
    const port = await s.start();
    const conn = await connectToPeer({
      host: "127.0.0.1", port, fp: caller.fp, pub: caller.pub, secret: caller.secret, name: "Caller", expectPub: me.pub,
    });
    try {
      for (let i = 0; i < 50; i++) expect(await askOn(conn, { t: "q", i })).toMatchObject({ t: "answer", i, n: i + 1 });
    } finally {
      conn.sock.destroy();
    }
  }, 20_000);

  it("has two questions sent together answered in the order they were asked", async () => {
    const me = identityFrom("");
    const caller = identityFrom("");
    const s = createSyncServer({
      fp: me.fp, pub: me.pub, secret: me.secret, name: "Holder", host: "127.0.0.1",
      trusted: () => [{ fp: caller.fp, pub: caller.pub, name: "Caller" }],
      // The first answer takes longer than the second would, so answering
      // both at once would put them on the wire the wrong way round.
      handlers: async (msg: { i: number }, ctx: { send: (o: unknown) => void }) => {
        await wait(msg.i === 0 ? 30 : 1);
        ctx.send({ t: "answer", i: msg.i });
      },
    });
    opened.push(s);
    const port = await s.start();
    const conn = await connectToPeer({
      host: "127.0.0.1", port, fp: caller.fp, pub: caller.pub, secret: caller.secret, name: "Caller", expectPub: me.pub,
    });
    try {
      const got: unknown[] = [];
      let buf = "";
      const both = new Promise<void>(resolve => {
        conn.sock.on("data", (chunk: string) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n")) !== -1) {
            got.push(conn.read(JSON.parse(buf.slice(0, i))));
            buf = buf.slice(i + 1);
            if (got.length === 2) resolve();
          }
        });
      });
      // In one write, so both are at the listener before either is answered —
      // two writes would be two segments, and the second waits on the first's
      // ACK.
      conn.sock.cork();
      conn.send({ t: "q", i: 0 });
      conn.send({ t: "q", i: 1 });
      conn.sock.uncork();
      await both;
      expect(got).toMatchObject([{ t: "answer", i: 0 }, { t: "answer", i: 1 }]);
    } finally {
      conn.sock.destroy();
    }
  }, 20_000);
});
