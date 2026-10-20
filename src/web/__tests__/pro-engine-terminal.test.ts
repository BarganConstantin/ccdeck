// The terminal panel's socket relayed to the optional local engine, against a
// test double that speaks the engine's half of the stream contract
// (fixtures/pro-engine-peer.cjs, docs/contracts/pro-engine-host-v1.md).
//
// TWO HALVES. The first drives the client's streams directly: ids, the
// demultiplexing, parts joined into one message, the input window and its
// credit, `flow`, and every violation that must end the engine. The second
// opens real WebSockets through installTerminalUpgrade: every gate the JS
// upgrade asks is still asked, in the same order, before anything reaches the
// engine; a refused attach is a plain status; and what the panel receives —
// bytes, order, close codes — is what terminal-socket.mjs sends.
//
// THE DOUBLE IS STRICT IN BOTH DIRECTIONS. It checks the host's sequence
// numbers, stream ids, input window and `flow` counts, and exits 64 on any
// violation, as the engine does; so a test that passes here also says the host
// broke none of them.
//
// Real-engine interop is not here: no engine build that runs terminal streams
// is available to the public suite.
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import { createProEngineClient } from "../../server/pro-engine-client.mjs";
// @ts-expect-error — plain .mjs server module, no types
import * as ts from "../../server/terminal-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { engineTerminals, SHUTDOWN_GRACE_MS } from "../../server/pro-engine-terminal.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { acceptKey } from "../../server/ws-frames.mjs";
import { clientFrame, handshakeKey, json, openWs, OPS, type Frame, type WsClient } from "./ws-test-client";

const roots: string[] = [], clients: any[] = [], servers: Server[] = [], sockets: WsClient[] = [], raws: net.Socket[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const KiB = 1024, MiB = 1024 * 1024;
afterEach(async () => {
  for (const c of sockets.splice(0)) c.socket.destroy();
  for (const r of raws.splice(0)) r.destroy();
  await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(0));
  await Promise.all(clients.splice(0).map(c => c.close()));
  await Promise.all(servers.splice(0).map(s => new Promise(r => { s.close(r); s.closeAllConnections?.(); })));
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});

/** The double as an installed, signed engine; `backend` is what it advertises. */
async function installed({ backend = "tmux", ...options }: Record<string, any> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ccpro-stream-")); roots.push(directory); await chmod(directory, 0o700);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const source = (await readFile(new URL("./fixtures/pro-engine-peer.cjs", import.meta.url), "utf8")).replace("const TERMINAL_BACKEND = 'unavailable';", `const TERMINAL_BACKEND = '${backend}';`);
  const bytes = Buffer.from(`#!${process.execPath}\n${source}`);
  await writeFile(join(directory, "ccdeck-pro-engine"), bytes, { mode: 0o700 });
  const entry = { file: "ccdeck-pro-engine", protocol: 1, target: `${process.arch === "x64" ? "x86_64" : "aarch64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, version: "0.1.0" };
  const payload = Buffer.from(JSON.stringify(entry));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") }), { mode: 0o600 });
  const client = createProEngineClient({ enabled: true, directory, publicKey: publicKey.export({ type: "spki", format: "pem" }), heartbeatMs: 60_000, ...options });
  clients.push(client);
  const lost: string[] = [];
  client.on("disconnected", (code: string) => lost.push(code));
  await client.start();
  return { client, lost };
}
type Engine = Awaited<ReturnType<typeof installed>>;

// The double's own methods, over the ordinary authenticated requests.
const mint = async (e: Engine): Promise<string> => (await e.client.request("terminal.mint")).handle;
const plan = (e: Engine, ...plans: object[]) => e.client.request("terminal.plan", { plans });
const emit = (e: Engine, frames: object[]) => e.client.request("terminal.emit", { frames });
const engineLog = async (e: Engine): Promise<any[]> => (await e.client.request("terminal.log")).log;
const attaches = async (e: Engine) => (await engineLog(e)).filter(x => x.attach !== undefined);
const received = async (e: Engine, stream: number) => (await engineLog(e)).filter(x => x.stream === stream && x.kind);
const controls = async (e: Engine, stream: number) => (await engineLog(e)).filter(x => x.stream === stream && x.control).map(x => x.control);
/** The bytes the double sends for `{ binary: size, seed }`. */
const pattern = (size: number, seed: number) => { const b = Buffer.allocUnsafe(size); for (let i = 0; i < size; i++) b[i] = (i * 31 + seed + (i >>> 11)) & 255; return b; };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A stand-in socket for the client's streams: what it was handed, in order. */
function sink(buffered = 0) {
  const got: any[] = [];
  let resumed = 0;
  return {
    got,
    get resumed() { return resumed; },
    binary: (b: Buffer) => got.push(["binary", Buffer.from(b)]),
    text: (b: Buffer) => got.push(["text", b.toString("utf8")]),
    close: (code: number, reason: string) => got.push(["close", code, reason]),
    lost: () => got.push(["lost"]),
    buffered: () => buffered,
    resume: () => { resumed += 1; },
  };
}
const HELLO = JSON.stringify({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });

describe.skipIf(process.platform === "win32")("terminal streams on the engine's IPC", () => {
  it("allocates ids from 1 per instance, registers each before its attach is written, and holds what arrives before the relay starts", async () => {
    const e = await installed();
    const first = await e.client.attachTerminal(await mint(e));
    expect(first.id).toBe(1);
    // The double writes hello right behind its answer; more arrives before start.
    await emit(e, [{ kind: 2, stream: 1, text: "early" }]);
    const s = sink(77);
    first.start(s);
    expect(s.got).toEqual([["text", HELLO], ["text", "early"]]);
    await vi.waitFor(async () => expect((await controls(e, 1)).at(-1)).toEqual({ t: "flow", relayed: HELLO.length + 5, buffered: 77 }));
    await plan(e, { refuse: "busy" });
    await expect(e.client.attachTerminal(await mint(e))).rejects.toMatchObject({ code: "busy" });
    const third = await e.client.attachTerminal(await mint(e));
    expect(third.id, "a refused id stays named and is never reused").toBe(3);
    expect((await attaches(e)).map(a => a.attach)).toEqual([1, 2, 3]);
    await expect(e.client.request("terminal.attach", { handle: await mint(e), stream: 9 }), "only attachTerminal registers a stream").rejects.toMatchObject({ code: "unknown_method" });
    expect(e.lost).toEqual([]);
  });

  it("demultiplexes streams on the one sequence counter, and joins kind-4 parts into one message", async () => {
    const e = await installed();
    const a = await e.client.attachTerminal(await mint(e)), b = await e.client.attachTerminal(await mint(e));
    const sa = sink(), sb = sink();
    a.start(sa); b.start(sb);
    await emit(e, [
      { kind: 1, stream: 2, size: 10, seed: 1 }, { kind: 4, stream: 1, size: 5, seed: 2 }, { kind: 2, stream: 2, text: "b-text" },
      { kind: 4, stream: 1, size: 6, seed: 3 }, { kind: 1, stream: 1, size: 7, seed: 4 }, { kind: 1, stream: 2, size: 0 },
    ]);
    expect(sa.got).toEqual([["text", HELLO], ["binary", Buffer.concat([pattern(5, 2), pattern(6, 3), pattern(7, 4)])]]);
    expect(sb.got).toEqual([["text", HELLO], ["binary", pattern(10, 1)], ["text", "b-text"], ["binary", Buffer.alloc(0)]]);
    // Both directions, interleaved across kinds and streams; the double ends
    // the process over one number out of place, so none was.
    a.send("text", Buffer.from("to a")); b.send("binary", Buffer.from("to b")); a.send("binary", Buffer.from([0, 255]));
    await vi.waitFor(async () => expect((await received(e, 1)).map(x => Buffer.from(x.data, "base64").toString("latin1"))).toEqual(["to a", "\x00\xff"]));
    expect((await received(e, 2)).map(x => [x.kind, Buffer.from(x.data, "base64").toString()])).toEqual([[1, "to b"]]);
    expect(e.lost).toEqual([]);
  });

  it("joins a binary message up to 64 MiB and ends the engine at a byte over", async () => {
    const e = await installed();
    const st = await e.client.attachTerminal(await mint(e));
    const s = sink();
    st.start(s);
    await emit(e, [{ binary: 64 * MiB, stream: 1, seed: 9 }]);
    expect(s.got).toHaveLength(2);
    expect(s.got[1][1].length).toBe(64 * MiB);
    expect(sha(s.got[1][1])).toBe(sha(pattern(64 * MiB, 9)));
    s.got.length = 0;
    await expect(emit(e, [{ binary: 64 * MiB + 1, stream: 1, seed: 9 }])).rejects.toMatchObject({ code: "protocol" });
    expect(s.got, "nothing of it relayed, and the socket closed for a reconnect").toEqual([["lost"]]);
  }, 60_000);

  it("ends the engine for every violation of the stream frames", async () => {
    const cases: Array<[string, object[]]> = [
      ["a kind past 4", [{ kind: 5, stream: 1, text: "x" }]],
      ["kind 0 on a stream", [{ kind: 0, stream: 1, text: "{}" }]],
      ["data on stream 0", [{ kind: 1, stream: 0, text: "x" }]],
      ["an id never allocated", [{ kind: 1, stream: 2, text: "x" }]],
      ["parts broken by a text", [{ kind: 4, stream: 1, text: "part" }, { kind: 2, stream: 1, text: "{}" }]],
      ["parts broken by a control", [{ kind: 4, stream: 1, text: "part" }, { kind: 3, stream: 1, text: '{"t":"credit","bytes":0}' }]],
      ["an empty part", [{ kind: 4, stream: 1, text: "" }]],
      ["a sequence number skipped", [{ kind: 2, stream: 1, text: "{}", skip: 1 }]],
      ["a control that is not JSON", [{ kind: 3, stream: 1, text: '{"t":' }]],
      ["an unknown control", [{ kind: 3, stream: 1, text: '{"t":"pause"}' }]],
      ["an unknown field", [{ kind: 3, stream: 1, text: '{"t":"credit","bytes":0,"pane":"%1"}' }]],
      ["a field twice", [{ kind: 3, stream: 1, text: '{"t":"credit","bytes":0,"bytes":0}' }]],
      ["a wrong type", [{ kind: 3, stream: 1, text: '{"t":"credit","bytes":"0"}' }]],
      ["a missing field", [{ kind: 3, stream: 1, text: '{"t":"close","code":1000}' }]],
      ["a control over 4096 bytes", [{ kind: 3, stream: 1, text: JSON.stringify({ t: "credit", bytes: 0, pad: "x".repeat(4100) }) }]],
      ["a close code the bridge never sends", [{ kind: 3, stream: 1, text: '{"t":"close","code":1006,"reason":""}' }]],
      ["a close reason over 123 bytes", [{ kind: 3, stream: 1, text: JSON.stringify({ t: "close", code: 1000, reason: "é".repeat(62) }) }]],
      ["credit past what was sent", [{ kind: 3, stream: 1, text: '{"t":"credit","bytes":1}' }]],
    ];
    for (const [name, frames] of cases) {
      const e = await installed();
      const st = await e.client.attachTerminal(await mint(e));
      const s = sink();
      st.start(s);
      await expect(emit(e, frames), name).rejects.toMatchObject({ code: "protocol" });
      expect(e.lost, name).toEqual(["protocol"]);
      expect(s.got.at(-1), name).toEqual(["lost"]);
    }
  }, 60_000);

  it("accepts a close that spells its fields in any order, with a reason exactly 123 bytes long", async () => {
    const e = await installed();
    const st = await e.client.attachTerminal(await mint(e));
    const s = sink();
    st.start(s);
    const reason = "é".repeat(61) + "x";
    await emit(e, [{ kind: 3, stream: 1, text: `{ "reason" : ${JSON.stringify(reason)}, "code":1011,"t":"close"}` }, { kind: 2, stream: 1, text: "after its close" }]);
    expect(s.got).toEqual([["text", HELLO], ["close", 1011, reason]]);
    st.close();
    await delay(20);
    expect(await controls(e, 1), "no close back after the engine's own").toEqual([{ t: "flow", relayed: HELLO.length, buffered: 0 }]);
    expect(e.lost).toEqual([]);
  });

  it("discards what arrives for a named id that is not live, refused or given up", async () => {
    const e = await installed({ timeoutMs: 150 });
    await plan(e, { refuse: "unavailable" }, { silent: true });
    await expect(e.client.attachTerminal(await mint(e))).rejects.toMatchObject({ code: "unavailable" });
    await expect(e.client.attachTerminal(await mint(e))).rejects.toMatchObject({ code: "timeout" });
    expect(await controls(e, 1), "a refusal owes the engine nothing").toEqual([]);
    expect(await controls(e, 2), "a deadline gives the attach up on its stream").toEqual([{ t: "close" }]);
    await emit(e, [{ kind: 2, stream: 1, text: "late" }, { kind: 4, stream: 2, text: "part" }, { kind: 3, stream: 2, text: "not even JSON" }]);
    expect(e.lost).toEqual([]);
    const ac = new AbortController();
    await plan(e, { delayMs: 200 });
    const third = e.client.attachTerminal(await mint(e), { signal: ac.signal });
    await vi.waitFor(async () => expect(await attaches(e)).toHaveLength(3));
    ac.abort();
    await expect(third).rejects.toMatchObject({ code: "cancelled" });
    await delay(300);
    expect(await controls(e, 3), "an abort gives it up at once").toEqual([{ t: "close" }]);
    expect((await e.client.request("terminal.log")).live, "and the engine never started it").toEqual([]);
    expect(e.lost).toEqual([]);
  });

  it("holds input past the window in order, stops the socket, and lets it go as credit makes room", async () => {
    const e = await installed();
    await plan(e, { hold: true });
    const st = await e.client.attachTerminal(await mint(e));
    const s = sink();
    st.start(s);
    expect(st.send("binary", pattern(300 * KiB, 1)), "nothing owed: sent").toBe(true);
    expect(st.send("binary", pattern(300 * KiB, 2)), "300 KiB owed and 300 more would pass 512").toBe(false);
    expect(st.send("text", Buffer.from("after")), "and everything after it waits behind it").toBe(false);
    await delay(50);
    expect((await received(e, 1)).map(x => x.size)).toEqual([300 * KiB]);
    expect(s.resumed).toBe(0);
    await e.client.request("terminal.hold", { stream: 1, hold: false });
    await vi.waitFor(async () => expect((await received(e, 1)).map(x => x.size)).toEqual([300 * KiB, 300 * KiB, 5]));
    expect((await received(e, 1))[1].sha256).toBe(sha(pattern(300 * KiB, 2)));
    expect(s.resumed, "read again once nothing is held").toBe(1);
    // A whole mebibyte goes when nothing is owed, though it is twice the window.
    // The double credited the last bytes ahead of its answer to the log above,
    // so nothing is owed now.
    expect(st.send("text", Buffer.alloc(MiB, 0x61))).toBe(true);
    await vi.waitFor(async () => expect((await received(e, 1)).at(-1)?.size).toBe(MiB));
    expect(() => st.send("text", Buffer.alloc(MiB + 1)), "never more than a browser may send").toThrow(RangeError);
    expect(e.lost).toEqual([]);
  });

  it("closes once, shuts down once, and says nothing after the engine's close", async () => {
    const e = await installed();
    const st = await e.client.attachTerminal(await mint(e));
    const s = sink();
    st.start(s);
    expect(st.shutdown("error", "The terminal was turned off in Settings.")).toBe(true);
    await vi.waitFor(() => expect(s.got.at(-1)).toEqual(["close", 1000, "error"]));
    expect(JSON.parse(s.got[1][1])).toEqual({ t: "exit", reason: "error", message: "The terminal was turned off in Settings." });
    expect(st.shutdown("error"), "no longer live").toBe(false);
    st.close();
    expect(() => st.shutdown("x".repeat(124))).toThrow(RangeError);
    const other = await e.client.attachTerminal(await mint(e));
    other.start(sink());
    other.close(); other.close();
    await delay(20);
    expect((await controls(e, 1)).filter(c => c.t !== "flow")).toEqual([{ t: "shutdown", reason: "error", text: "The terminal was turned off in Settings." }]);
    expect((await controls(e, 2)).filter(c => c.t === "close")).toEqual([{ t: "close" }]);
  });

  // The double, as the engine, ends on a lone surrogate anywhere in its JSON.
  it("never puts a lone surrogate on the wire: refuses such a request, and writes U+FFFD for one in a shutdown", async () => {
    const e = await installed();
    const { pid } = await e.client.request("terminal.echo", { text: "ok" });
    for (const params of [{ text: "\ud800" }, { text: "a\udc00b" }, { ["\udbff"]: 1 }, { list: ["fine", { deep: "\ud83d" }] }]) {
      await expect(e.client.request("terminal.echo", params)).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(await e.client.request("terminal.echo", { text: "😀 pair" }), "a well-formed pair is sent as it is").toEqual({ value: { text: "😀 pair" }, pid });
    const st = await e.client.attachTerminal(await mint(e));
    const s = sink();
    st.start(s);
    expect(st.shutdown("err\ud800", "off \udfff now")).toBe(true);
    await vi.waitFor(() => expect(s.got.at(-1)).toEqual(["close", 1000, "err�"]));
    expect((await controls(e, 1)).filter(c => c.t !== "flow")).toEqual([{ t: "shutdown", reason: "err�", text: "off � now" }]);
    expect(() => st.shutdown("\ud800".repeat(42)), "measured as the U+FFFD it is sent as").toThrow(RangeError);
    expect((await e.client.request("terminal.echo", { text: "still" })).pid, "the same engine, still up").toBe(pid);
    expect(e.lost).toEqual([]);
  });

  it("closes every relayed stream when the engine is lost, rejects pending attaches, and starts ids again at 1", async () => {
    const e = await installed();
    const st = await e.client.attachTerminal(await mint(e));
    const s = sink();
    st.start(s);
    await plan(e, { silent: true });
    const waiting = e.client.attachTerminal(await mint(e)).catch((error: any) => error);
    const notStarted = await e.client.attachTerminal(await mint(e));
    await expect(e.client.request("terminal.crash")).rejects.toMatchObject({ code: "exited" });
    expect(await waiting).toMatchObject({ code: "exited" });
    expect(s.got.at(-1)).toEqual(["lost"]);
    const late = sink();
    notStarted.start(late);
    expect(late.got, "a stream started after the loss closes at once").toEqual([["lost"]]);
    await expect(e.client.attachTerminal("a".repeat(64)), "never starts the engine").rejects.toMatchObject({ code: "unavailable" });
    expect(e.client.running).toBe(false);
    await delay(300);
    await e.client.start();
    expect((await e.client.attachTerminal(await mint(e))).id).toBe(1);
  });

  it("asks nothing of an engine with no terminal backend, and checks the handle before asking", async () => {
    const off = await installed({ backend: "unavailable" });
    await expect(off.client.attachTerminal("a".repeat(64))).rejects.toMatchObject({ code: "unavailable" });
    expect(await attaches(off)).toEqual([]);
    const e = await installed();
    for (const bad of ["A".repeat(64), "a".repeat(63), "../../tmp", 42]) await expect(e.client.attachTerminal(bad)).rejects.toMatchObject({ code: "bad_params" });
    expect(await attaches(e)).toEqual([]);
  });
});

// ── the relay through a real WebSocket ──────────────────────────────────────

/** A server with the terminal upgrade and `e` as its engine. JS tickets go to
 *  a stand-in bridge, so which path a ticket took is plain. */
async function deck(e: Engine) {
  const tickets = ts.createTicketStore();
  const jsBridges: any[] = [];
  const upgraded: net.Socket[] = [];
  const server = createServer((_req, res) => { res.end("routed"); });
  servers.push(server);
  server.prependListener("upgrade", (_req, socket: net.Socket) => { upgraded.push(socket); });
  ts.installTerminalUpgrade(server, {
    enabled: () => true,
    tickets,
    engine: engineTerminals(e.client),
    openBridge: ({ conn, binding }: any) => {
      jsBridges.push(binding);
      conn.sendText(JSON.stringify({ t: "hello", kind: "js" }));
      return { message() {}, closed() {}, shutdown() {} };
    },
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const page = { Host: `127.0.0.1:${port}`, Origin: origin, "Sec-Fetch-Site": "same-origin" };
  const path = (ticket: string) => `${ts.ATTACH_PATH}?ticket=${encodeURIComponent(ticket)}`;
  return {
    tickets, jsBridges, upgraded, port, origin, page, path,
    ticket: async (handle?: string) => tickets.mint({ handle: handle ?? await mint(e), origin }),
    async dial(ticket: string, headers: Record<string, string | null> = page) {
      const c = await openWs({ port, path: path(ticket), headers });
      sockets.push(c);
      return c;
    },
    /** A handshake on a bare socket, for a client that goes away before its answer. */
    raw(ticket: string, extra = Buffer.alloc(0)) {
      const socket = net.connect(port, "127.0.0.1");
      raws.push(socket);
      socket.on("error", () => {});
      socket.write(`GET ${path(ticket)} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${handshakeKey()}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      if (extra.length) socket.write(extra);
      let head = "";
      socket.on("data", (d) => { head += d.toString("latin1"); });
      return { socket, head: () => head };
    },
  };
}

async function expectRefused(c: WsClient, status: number) {
  expect(c.status, c.head).toBe(status);
  expect(c.head).toMatch(new RegExp(`^HTTP/1\\.1 ${status} [^\\r]+\\r\\nConnection: close\\r\\n\\r\\n$`));
  await c.closed;
  expect(c.frames, "nothing past the refusal").toEqual([]);
}
const closeOf = (f: Frame) => [f.data.readUInt16BE(0), f.data.subarray(2).toString("utf8")];

describe.skipIf(process.platform === "win32")("the terminal socket relayed to the engine", () => {
  it("admits an engine ticket with the exact 101, relays both ways verbatim, and closes the stream with the socket", async () => {
    const e = await installed();
    const d = await deck(e);
    const key = handshakeKey();
    const c = await d.dial(await d.ticket(), { ...d.page, "Sec-WebSocket-Key": key });
    expect(c.head).toBe(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    expect(json(await c.next())).toEqual(JSON.parse(HELLO));
    const [attach] = await attaches(e);
    expect(attach.params, "a handle and a stream id, nothing about a pane").toEqual(["handle", "stream"]);
    c.sendText(JSON.stringify({ t: "size", cols: 80, rows: 24 }));
    c.sendBinary("ls\r");
    const paste = JSON.stringify({ t: "paste", text: "p".repeat(MiB - 23) });
    expect(Buffer.byteLength(paste)).toBe(MiB);
    c.sendText(paste);
    await vi.waitFor(async () => expect(await received(e, 1)).toHaveLength(3));
    const [size, keys, pasted] = await received(e, 1);
    expect([size.kind, Buffer.from(size.data, "base64").toString()]).toEqual([2, JSON.stringify({ t: "size", cols: 80, rows: 24 })]);
    expect([keys.kind, Buffer.from(keys.data, "base64").toString()]).toEqual([1, "ls\r"]);
    expect([pasted.kind, pasted.size, pasted.sha256], "a 1 MiB paste is one 1 MiB text").toEqual([2, MiB, sha(Buffer.from(paste))]);
    await emit(e, [{ kind: 2, stream: 1, text: '{"t":"reset","cols":80,"rows":24}' }, { kind: 1, stream: 1, text: "\x1bc$ " }]);
    expect(json(await c.next())).toEqual({ t: "reset", cols: 80, rows: 24 });
    const seed = await c.next();
    expect([seed.op, seed.data.toString()]).toEqual([OPS.binary, "\x1bc$ "]);
    expect(d.jsBridges, "no bridge in this process").toEqual([]);
    c.sendClose(1000);
    await c.closed;
    await vi.waitFor(async () => expect((await controls(e, 1)).filter(m => m.t === "close")).toEqual([{ t: "close" }]));
    expect((await e.client.request("terminal.log")).live).toEqual([]);
    expect(e.lost).toEqual([]);
  });

  it("keeps every gate ahead of the engine: another origin, a replayed ticket, no ticket — and nothing reaches it", async () => {
    const e = await installed();
    const d = await deck(e);
    const handle = await mint(e);
    await expectRefused(await d.dial(d.tickets.mint({ handle, origin: "http://localhost:1" })), 403);
    await expectRefused(await d.dial(await d.ticket(handle), { ...d.page, Origin: "https://evil.example" }), 403);
    await expectRefused(await d.dial(await d.ticket(handle), { ...d.page, "Sec-Fetch-Site": "cross-site" }), 403);
    await expectRefused(await d.dial(await d.ticket(handle), { ...d.page, Host: `attacker.example:${d.port}`, Origin: `http://attacker.example:${d.port}` }), 403);
    await expectRefused(await d.dial("x".repeat(43)), 401);
    expect(await attaches(e), "not one attach for a request a gate turned away").toEqual([]);
    const ticket = await d.ticket(handle);
    const first = await d.dial(ticket);
    expect(first.status).toBe(101);
    await expectRefused(await d.dial(ticket), 401);
    expect(await attaches(e), "a replayed ticket is refused here, not by the engine").toHaveLength(1);
    expect(e.lost).toEqual([]);
  });

  it("lets nothing a browser sends reach the engine without a ticket the deck minted", async () => {
    const e = await installed();
    const d = await deck(e);
    const frames = Buffer.concat([clientFrame(OPS.binary, "rm -rf ~\r"), clientFrame(OPS.text, JSON.stringify({ t: "paste", text: "x" }))]);
    for (const ticket of ["x".repeat(43), "", (await d.ticket()).slice(1)]) {
      const r = d.raw(ticket, frames);
      await new Promise(res => r.socket.once("close", res));
      expect(r.head()).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
    }
    const log = await engineLog(e);
    expect(log.filter(x => x.attach !== undefined || x.stream !== undefined)).toEqual([]);
  });

  it("refuses an attach the engine refuses, with the status for its code, and never answers 101", async () => {
    const e = await installed({ timeoutMs: 300 });
    const d = await deck(e);
    for (const [refuse, status] of [["bad_params", 500], ["busy", 503], ["unavailable", 503]] as const) {
      await plan(e, { refuse });
      await expectRefused(await d.dial(await d.ticket()), status);
    }
    // invalid_handle from the engine itself: a handle it never minted, and one
    // already redeemed under another ticket.
    await expectRefused(await d.dial(await d.ticket(randomBytes(32).toString("hex"))), 401);
    const once = await mint(e);
    expect((await d.dial(await d.ticket(once))).status).toBe(101);
    await expectRefused(await d.dial(await d.ticket(once)), 401);
    // A binding whose handle could not be one: the deck's own fault, not asked.
    const before = (await attaches(e)).length;
    await expectRefused(await d.dial(await d.ticket("not-a-handle")), 500);
    expect(await attaches(e)).toHaveLength(before);
    // No answer in time: 503, and the attach is given up on its stream.
    await plan(e, { silent: true });
    await expectRefused(await d.dial(await d.ticket()), 503);
    const silent = (await attaches(e)).at(-1).attach;
    await vi.waitFor(async () => expect(await controls(e, silent)).toEqual([{ t: "close" }]));
    expect(e.lost).toEqual([]);
  });

  it("refuses with 503, asking nothing, while the engine advertises no terminal or has gone", async () => {
    const off = await installed({ backend: "unavailable" });
    const d = await deck(off);
    await expectRefused(await d.dial(d.tickets.mint({ handle: "a".repeat(64), origin: d.origin })), 503);
    expect(await attaches(off)).toEqual([]);
    const e = await installed();
    const d2 = await deck(e);
    const ticket = await d2.ticket();
    await plan(e, { silent: true });
    const pending = d2.dial(await d2.ticket());
    await vi.waitFor(async () => expect(await attaches(e)).toHaveLength(1));
    await expect(e.client.request("terminal.crash")).rejects.toMatchObject({ code: "exited" });
    await expectRefused(await pending, 503);
    await expectRefused(await d2.dial(ticket), 503);
    expect(e.client.running, "an upgrade never starts the engine").toBe(false);
  });

  it("refuses a fifth while four attaches are pending, keeps its ticket, and opens all four once answered", async () => {
    const e = await installed();
    const d = await deck(e);
    await plan(e, ...Array.from({ length: 4 }, () => ({ delayMs: 400 })));
    const tickets = await Promise.all(Array.from({ length: 4 }, () => d.ticket()));
    const pending = tickets.map(t => d.dial(t));
    await vi.waitFor(async () => expect(await attaches(e)).toHaveLength(4));
    const fifth = await d.ticket();
    await expectRefused(await d.dial(fifth), 503);
    expect(await attaches(e), "the engine was not asked").toHaveLength(4);
    const opened = await Promise.all(pending);
    expect(opened.map(c => c.status)).toEqual([101, 101, 101, 101]);
    for (const c of opened) expect(json(await c.next())).toEqual(JSON.parse(HELLO));
    opened[0].sendClose();
    await opened[0].closed;
    await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(3));
    const again = await d.dial(fifth);
    expect(again.status, "the refused ticket is still good").toBe(101);
  });

  it("gives an attach up at once when its socket is destroyed before the answer, and closes the stream when it goes after", async () => {
    const e = await installed();
    const d = await deck(e);
    await plan(e, { delayMs: 300 });
    const early = d.raw(await d.ticket());
    await vi.waitFor(async () => expect(await attaches(e)).toHaveLength(1));
    // Destroyed on this side — a reset, a write that failed, a timeout.
    d.upgraded.at(-1)!.destroy();
    await vi.waitFor(async () => expect(await controls(e, 1)).toEqual([{ t: "close" }]));
    await delay(400);
    expect((await e.client.request("terminal.log")).live, "the answer that crossed the close started nothing").toEqual([]);
    expect(early.head(), "and no 101 was written").toBe("");
    const c = await d.dial(await d.ticket());
    expect(json(await c.next())).toEqual(JSON.parse(HELLO));
    c.socket.destroy();
    await vi.waitFor(async () => expect((await controls(e, 2)).filter(m => m.t === "close")).toEqual([{ t: "close" }]));
    expect((await e.client.request("terminal.log")).live).toEqual([]);
    expect(e.lost).toEqual([]);
  });

  // An upgrade socket is not read until its 101, so a browser's own hang-up
  // while the engine answers is seen once the socket is read: the stream the
  // engine attached is closed right after, and nothing of it is left.
  it("closes the stream of a browser that hung up while its attach was waiting, once the socket is read", async () => {
    const e = await installed();
    const d = await deck(e);
    await plan(e, { delayMs: 200 });
    const early = d.raw(await d.ticket());
    await vi.waitFor(async () => expect(await attaches(e)).toHaveLength(1));
    early.socket.destroy();
    await vi.waitFor(async () => expect((await controls(e, 1)).filter(m => m.t === "close")).toEqual([{ t: "close" }]));
    expect((await e.client.request("terminal.log")).live).toEqual([]);
    await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(0));
    expect(e.lost).toEqual([]);
  });

  it("closes the socket 1011 with no exit when the engine crashes mid-stream, and attaches again once it is back", async () => {
    const e = await installed();
    const d = await deck(e);
    const c = await d.dial(await d.ticket());
    expect(json(await c.next())).toEqual(JSON.parse(HELLO));
    await emit(e, [{ kind: 1, stream: 1, text: "output" }]);
    await expect(e.client.request("terminal.crash")).rejects.toMatchObject({ code: "exited" });
    const rest: Frame[] = [];
    for (;;) { const f = await c.next(); rest.push(f); if (f.op === OPS.close) break; }
    expect(rest.map(f => f.op)).toEqual([OPS.binary, OPS.close]);
    expect(closeOf(rest[1])).toEqual([1011, "the server could not handle a message"]);
    c.sendClose(1011);
    await c.closed;
    await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(0));
    await delay(300);
    await e.client.start();
    const again = await d.dial(await d.ticket());
    expect(json(await again.next())).toEqual(JSON.parse(HELLO));
    expect((await attaches(e)).map(a => a.attach), "a new instance names its streams from 1 again").toEqual([1]);
  });

  it("keeps the order and bytes of large output, a split seed arriving as one binary message", async () => {
    const e = await installed();
    const d = await deck(e);
    const c = await d.dial(await d.ticket());
    await c.next();
    const reset = '{"t":"reset","cols":200,"rows":50}', size = '{"t":"size","cols":120,"rows":40}';
    await emit(e, [
      { kind: 2, stream: 1, text: reset }, { binary: 3 * MiB, stream: 1, seed: 7 },
      { binary: 64 * KiB, stream: 1, seed: 8 }, { kind: 2, stream: 1, text: size }, { binary: 1, stream: 1, seed: 9 },
    ]);
    const got = [await c.next(), await c.next(), await c.next(), await c.next(), await c.next()];
    expect(got.map(f => f.op)).toEqual([OPS.text, OPS.binary, OPS.binary, OPS.text, OPS.binary]);
    expect(got[0].data.toString()).toBe(reset);
    expect(got[1].data.length, "one message, not its parts").toBe(3 * MiB);
    expect(sha(got[1].data)).toBe(sha(pattern(3 * MiB, 7)));
    expect(got[2].data.equals(pattern(64 * KiB, 8))).toBe(true);
    expect(got[3].data.toString()).toBe(size);
    expect(got[4].data.equals(pattern(1, 9))).toBe(true);
    const total = HELLO.length + reset.length + 3 * MiB + 64 * KiB + size.length + 1;
    await vi.waitFor(async () => expect((await controls(e, 1)).filter(m => m.t === "flow").at(-1)?.relayed, "every byte reported relayed").toBe(total));
    expect(e.lost).toEqual([]);
  });

  it("stops reading a socket whose input the engine has not credited, and reads it again in order once it has", async () => {
    const e = await installed();
    const d = await deck(e);
    await plan(e, { hold: true });
    const c = await d.dial(await d.ticket());
    await c.next();
    const server = d.upgraded.at(-1)!;
    c.sendBinary(pattern(300 * KiB, 1));
    c.sendBinary(pattern(300 * KiB, 2));
    c.sendText('{"t":"ack","bytes":1}');
    c.sendBinary("typed");
    await vi.waitFor(async () => expect((await received(e, 1)).length).toBe(1));
    await delay(100);
    expect((await received(e, 1)).length, "held until credit").toBe(1);
    expect(server.isPaused(), "and the socket is not read").toBe(true);
    await e.client.request("terminal.hold", { stream: 1, hold: false });
    await vi.waitFor(async () => expect((await received(e, 1)).map(x => [x.kind, x.size])).toEqual([[1, 300 * KiB], [1, 300 * KiB], [2, Buffer.byteLength('{"t":"ack","bytes":1}')], [1, 5]]));
    const got = await received(e, 1);
    expect([got[0].sha256, got[1].sha256]).toEqual([sha(pattern(300 * KiB, 1)), sha(pattern(300 * KiB, 2))]);
    expect(server.isPaused()).toBe(false);
    c.sendBinary("more");
    await vi.waitFor(async () => expect((await received(e, 1)).length).toBe(5));
    expect(e.lost).toEqual([]);
  });

  it("tells each relayed panel of a switch-off through the engine, then ends its socket", async () => {
    const e = await installed();
    const d = await deck(e);
    const a = await d.dial(await d.ticket()), b = await d.dial(await d.ticket());
    await a.next(); await b.next();
    const text = "The terminal was turned off in Settings. The session is still running.";
    expect(ts.closeOpenTerminals("error", text)).toBe(2);
    for (const c of [a, b]) {
      expect(json(await c.next())).toEqual({ t: "exit", reason: "error", message: text });
      expect(closeOf(await c.next())).toEqual([1000, "error"]);
      await c.closed;
    }
    for (const id of [1, 2]) expect((await controls(e, id)).find(m => m.t === "shutdown")).toEqual({ t: "shutdown", reason: "error", text });
    expect(e.lost).toEqual([]);
  });

  it("ends a relayed socket anyway when the engine does not answer a switch-off in time", async () => {
    const e = await installed();
    const d = await deck(e);
    await plan(e, { ignoreShutdown: true });
    const c = await d.dial(await d.ticket());
    await c.next();
    const at = Date.now();
    ts.closeOpenTerminals("error", "off");
    await c.closed;
    expect(Date.now() - at).toBeGreaterThanOrEqual(SHUTDOWN_GRACE_MS - 50);
    expect(c.frames.slice(1), "nothing said: the engine said nothing").toEqual([]);
    await vi.waitFor(async () => expect((await controls(e, 1)).map(m => m.t)).toEqual(["flow", "shutdown", "close"]));
  });

  it("tells a socket whose attach was waiting when the switch went off, as soon as it opens", async () => {
    const e = await installed();
    const d = await deck(e);
    await plan(e, { delayMs: 300 });
    const pending = d.dial(await d.ticket());
    await vi.waitFor(async () => expect(await attaches(e)).toHaveLength(1));
    expect(ts.closeOpenTerminals("error", "off"), "not open yet").toBe(0);
    const c = await pending;
    expect(c.status).toBe(101);
    expect(json(await c.next())).toEqual(JSON.parse(HELLO));
    expect(json(await c.next())).toEqual({ t: "exit", reason: "error", message: "off" });
    expect(closeOf(await c.next())).toEqual([1000, "error"]);
    await c.closed;
  });

  // Last: closeAllTerminals is the process going away, and after it this
  // module refuses every upgrade for the rest of the file.
  it("says server-shutdown through the engine at shutdown, gives up an attach still waiting, and refuses new ones", async () => {
    const e = await installed();
    const d = await deck(e);
    const c = await d.dial(await d.ticket());
    await c.next();
    await plan(e, { delayMs: 300 });
    const pending = d.dial(await d.ticket());
    await vi.waitFor(async () => expect(await attaches(e)).toHaveLength(2));
    expect(ts.closeAllTerminals("server-shutdown")).toBe(1);
    expect(json(await c.next())).toEqual({ t: "exit", reason: "server-shutdown" });
    expect(closeOf(await c.next())).toEqual([1001, "server-shutdown"]);
    await c.closed;
    await expectRefused(await pending, 503);
    await vi.waitFor(async () => expect((await controls(e, 2)).filter(m => m.t === "close")).toEqual([{ t: "close" }]));
    const before = (await attaches(e)).length;
    await expectRefused(await d.dial(await d.ticket()), 503);
    expect(await attaches(e)).toHaveLength(before);
    expect(e.lost).toEqual([]);
  });
});
