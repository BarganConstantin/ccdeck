// The terminal panel's socket: who the upgrade lets in, the tickets that say
// which pane, and the order of everything said down it once it is open.
//
// THE UPGRADE IS THE WHOLE OF THE SOCKET'S PROTECTION. Once a server has an
// 'upgrade' listener, Node gives it every request carrying an Upgrade header
// and the route table's gates never run — so each refusal the gates would
// have made is made again here, against a real listener on 127.0.0.1, with
// requests a browser could never send: no Origin, another site's Origin, a
// rebound Host, a Sec-Fetch-Site the page did not choose, a ticket that was
// never minted, one that expired, one that was already used, and a fifth
// socket. Every one of them must get a plain HTTP status and a hung-up
// socket, never a 101 — and never spend the ticket of somebody who was turned
// away for something else.
//
// THE BRIDGE IS DRIVEN WITH A STAND-IN tmux CLIENT. The protocol is the
// contract with src/web/terminal-protocol.ts, and the interesting orders —
// a %pause in the middle of a seed, a pane that dies before the panel has a
// frame, a socket that falls 4 MiB behind — are hard to provoke on demand in
// real tmux. terminal-socket-tmux.test.ts does the round trip for real.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
// @ts-expect-error — plain .mjs server module, no types
import * as ts from "../../server/terminal-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { acceptKey } from "../../server/ws-frames.mjs";
import { TERMINAL_ATTACH_PATH } from "../terminal-protocol";
import { json, openWs, OPS, type Frame, type WsClient } from "./ws-test-client";

const NOT_FOUND = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";

describe("the tickets the routes mint and the upgrade redeems", () => {
  it("are 32 random bytes in base64url, different every time", () => {
    const store = ts.createTicketStore();
    const a = store.mint({ pane: "%1" });
    const b = store.mint({ pane: "%1" });
    expect(a, "32 bytes in base64url is 43 characters with no padding").toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).not.toBe(a);
  });

  it("answer their binding exactly once", () => {
    const store = ts.createTicketStore();
    const binding = { kind: "A", pane: "%3" };
    const t = store.mint(binding);
    expect(store.redeem(t)).toBe(binding);
    expect(store.redeem(t), "a ticket is spent by the first socket that uses it").toBeNull();
  });

  it("are no good after thirty seconds, and are spent by the attempt", () => {
    let now = 1_000_000;
    const store = ts.createTicketStore({ now: () => now });
    expect(ts.TICKET_TTL_MS).toBe(30_000);
    const fresh = store.mint({ pane: "%1" });
    now += ts.TICKET_TTL_MS - 1;
    expect(store.redeem(fresh), "one millisecond inside the window").toEqual({ pane: "%1" });
    const stale = store.mint({ pane: "%2" });
    now += ts.TICKET_TTL_MS;
    expect(store.redeem(stale)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("refuse what they never minted", () => {
    const store = ts.createTicketStore();
    store.mint({ pane: "%1" });
    for (const bad of ["", "nope", undefined, null, 42, {}]) expect(store.redeem(bad), String(bad)).toBeNull();
    expect(store.size, "a failed redemption takes nothing out").toBe(1);
  });

  it("hold at most MAX_TICKETS, dropping the oldest", () => {
    const store = ts.createTicketStore({ max: 3 });
    const first = store.mint({ n: 1 });
    for (let n = 2; n <= 4; n++) store.mint({ n });
    expect(store.size).toBe(3);
    expect(store.redeem(first), "the oldest made room for the fourth").toBeNull();
    expect(ts.MAX_TICKETS).toBeGreaterThanOrEqual(ts.MAX_TERMINALS);
  });
});

describe("the questions the upgrade asks, in the order it asks them", () => {
  const port = 4317;
  const here = `127.0.0.1:${port}`;
  const good = {
    method: "GET",
    url: `${ts.ATTACH_PATH}?ticket=abc`,
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    headers: {
      host: here,
      origin: `http://${here}`,
      "sec-fetch-site": "same-origin",
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
  };
  const on = { enabled: () => true, remoteAddress: "127.0.0.1" };
  const asked = (patch: Record<string, unknown> = {}, headers: Record<string, string | undefined> = {}, opts = {}) =>
    ts.upgradeVerdict({ ...good, ...patch, headers: { ...good.headers, ...headers } }, { ...on, ...opts });

  it("admits the deck's own page with a ticket", () => {
    expect(asked()).toEqual({ ok: true, key: good.headers["sec-websocket-key"], ticket: "abc", origin: `http://${here}` });
  });

  it("is on the same path the page dials", () => {
    expect(ts.ATTACH_PATH).toBe(TERMINAL_ATTACH_PATH);
  });

  it("answers any other path, or a deck with the panel off, as a route that is not there", () => {
    expect(asked({ url: "/" }).status).toBe(404);
    expect(asked({ url: "/events" }).status).toBe(404);
    expect(asked({ url: "/api/terminal/attach/x?ticket=abc" }).status).toBe(404);
    expect(asked({}, {}, { enabled: () => false }).status, "switched off").toBe(404);
    expect(asked({ url: "http://[" }).status, "unparseable").toBe(404);
  });

  it("refuses a Host that is not this machine, before anything else", () => {
    expect(asked({}, { host: "attacker.example:4317", origin: "http://attacker.example:4317" }).status).toBe(403);
    expect(asked({}, { host: undefined }).status).toBe(403);
  });

  it("refuses a peer that is not this machine even when the Host says loopback", () => {
    expect(asked({}, {}, { remoteAddress: "192.168.1.20" }).status).toBe(403);
    expect(asked({}, {}, { remoteAddress: "::ffff:127.0.0.1" }).ok, "a dual-stack loopback peer").toBe(true);
    expect(asked({}, {}, { remoteAddress: "::1" }).ok).toBe(true);
  });

  it("requires an Origin, and the page's own", () => {
    expect(asked({}, { origin: undefined }).status, "no Origin: not a page").toBe(403);
    expect(asked({}, { origin: "https://evil.example" }).status).toBe(403);
    expect(asked({}, { origin: "http://127.0.0.1:8000" }).status, "another port is another origin").toBe(403);
    expect(asked({}, { origin: "null" }).status).toBe(403);
  });

  it("refuses fetch metadata that says anything but same-origin, and allows none at all", () => {
    for (const site of ["cross-site", "same-site", "none"]) expect(asked({}, { "sec-fetch-site": site }).status, site).toBe(403);
    expect(asked({}, { "sec-fetch-site": undefined }).ok, "older Safari sends none").toBe(true);
  });

  it("answers a handshake it does not speak with ws-frames' own status", () => {
    const v = asked({}, { "sec-websocket-version": "8" });
    expect(v.status).toBe(426);
    expect(v.headers).toEqual({ "Sec-WebSocket-Version": "13" });
    expect(asked({ method: "POST" }).status).toBe(405);
  });

  it("is full at four, and then refuses before the ticket is looked at", () => {
    expect(ts.MAX_TERMINALS).toBe(4);
    expect(asked({}, {}, { live: 3 }).ok).toBe(true);
    expect(asked({}, {}, { live: 4 }).status).toBe(503);
    expect(asked({ url: ts.ATTACH_PATH }, {}, { live: 4 }).status, "503 even with no ticket").toBe(503);
  });

  it("needs a ticket", () => {
    expect(asked({ url: ts.ATTACH_PATH }).status).toBe(401);
    expect(asked({ url: `${ts.ATTACH_PATH}?ticket=` }).status).toBe(401);
  });
});

// ── a real listener ─────────────────────────────────────────────────────────

interface FakeBridge {
  binding: any;
  messages: any[];
  closedWith: unknown[] | null;
  shutdownWith: string | null;
}

let enabled = true;
let now = 5_000_000;
const tickets = ts.createTicketStore({ now: () => now });
const bridges: FakeBridge[] = [];
let throwOnOpen = false;
let server: Server;
let port = 0;
const clients: WsClient[] = [];

beforeAll(async () => {
  server = createServer((req, res) => { res.end("routed"); });
  ts.installTerminalUpgrade(server, {
    enabled: () => enabled,
    tickets,
    openBridge: ({ conn, binding }: any) => {
      if (throwOnOpen) throw new Error("no tmux today");
      const b: FakeBridge = { binding, messages: [], closedWith: null, shutdownWith: null };
      bridges.push(b);
      conn.sendText(JSON.stringify({ t: "hello", kind: binding.kind }));
      return {
        message: (m: any) => { b.messages.push(m); },
        closed: (...args: unknown[]) => { b.closedWith = args; },
        shutdown: (reason: string) => { b.shutdownWith = reason; conn.close(1001, reason); },
      };
    },
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const c of clients) c.socket.destroy();
  await new Promise(r => server.close(r));
});

const page = () => ({ Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" });

async function dial(path: string, headers: Record<string, string | null> = page()): Promise<WsClient> {
  const c = await openWs({ port, path, headers });
  clients.push(c);
  return c;
}

const attach = (ticket: string) => `${ts.ATTACH_PATH}?ticket=${encodeURIComponent(ticket)}`;

/** A refusal: exactly that status line, Connection: close, and the socket hung up. */
async function expectRefused(c: WsClient, status: number) {
  expect(c.status, c.head).toBe(status);
  expect(c.head).toMatch(new RegExp(`^HTTP/1\\.1 ${status} [^\\r]+\\r\\nConnection: close\\r\\n`));
  await c.closed;
  expect(c.frames, "nothing past the refusal").toEqual([]);
}

describe("the listener, which is there only while the panel is on", () => {
  it("follows the switch: absent while off, armed by the next request after it turns on, gone after it turns off", async () => {
    let on = false;
    const srv = createServer((_req, res) => { res.end("routed"); });
    const handle = ts.installTerminalUpgrade(srv, { enabled: () => on, tickets: ts.createTicketStore(), openBridge: () => ({ message() {}, closed() {}, shutdown() {} }) });
    await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
    const p = (srv.address() as { port: number }).port;
    const get = () => fetch(`http://127.0.0.1:${p}/x`).then(r => r.text());
    try {
      expect(srv.listenerCount("upgrade"), "off at install: Node routes an offered upgrade like any request").toBe(0);
      on = true;
      expect(await get()).toBe("routed");
      expect(srv.listenerCount("upgrade"), "the request after the switch armed it").toBe(1);
      expect(await get()).toBe("routed");
      expect(srv.listenerCount("upgrade"), "and never twice").toBe(1);
      on = false;
      handle.sync();
      expect(srv.listenerCount("upgrade")).toBe(0);
      on = true;
      handle.sync();
      on = false;
      expect(await get()).toBe("routed");
      expect(srv.listenerCount("upgrade"), "a request disarms it as well").toBe(0);
    } finally {
      await new Promise(r => srv.close(r));
    }
  });

  it("treats a switch that throws as off", () => {
    const srv = createServer();
    ts.installTerminalUpgrade(srv, { enabled: () => { throw new Error("prefs unreadable"); } });
    expect(srv.listenerCount("upgrade")).toBe(0);
  });
});

describe("the upgrade on a real socket", () => {
  it("admits a minted ticket with the exact 101 and hands the bridge its binding", async () => {
    const ticket = tickets.mint({ kind: "A", pane: "%7", origin: `http://127.0.0.1:${port}` });
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const c = await dial(attach(ticket), { ...page(), "Sec-WebSocket-Key": key });
    expect(c.head).toBe(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    expect(json(await c.next())).toEqual({ t: "hello", kind: "A" });
    const b = bridges.at(-1)!;
    expect(b.binding.pane).toBe("%7");
    c.sendText(JSON.stringify({ t: "size", cols: 80, rows: 24 }));
    c.sendBinary("ls\r");
    await vi.waitFor(() => expect(b.messages.length).toBe(2));
    expect(b.messages[0].type).toBe("text");
    expect(b.messages[1]).toEqual({ type: "binary", data: Buffer.from("ls\r") });
    c.sendClose(1000);
    await c.closed;
    await vi.waitFor(() => expect(b.closedWith).toEqual([1000, ""]));
    expect(ts.openTerminalCount()).toBe(0);
  });

  it("answers every other path with a 404 and hangs up, even with a good ticket", async () => {
    for (const path of ["/", "/events", "/api/health", "/api/terminal/status"]) {
      const ticket = tickets.mint({ kind: "A" });
      const c = await dial(`${path}?ticket=${ticket}`);
      expect(c.head, path).toBe(NOT_FOUND);
      await c.closed;
      expect(tickets.redeem(ticket), `${path} must not spend the ticket`).not.toBeNull();
    }
  });

  it("answers 404 on the attach path itself while the panel is switched off", async () => {
    enabled = false;
    try {
      const ticket = tickets.mint({ kind: "A" });
      const before = bridges.length;
      const c = await dial(attach(ticket));
      expect(c.head).toBe(NOT_FOUND);
      await c.closed;
      expect(bridges.length, "no bridge, so no tmux client").toBe(before);
      expect(tickets.redeem(ticket), "and the ticket is untouched").not.toBeNull();
    } finally {
      enabled = true;
    }
  });

  it("refuses a rebound Host", async () => {
    const ticket = tickets.mint({ kind: "A" });
    const c = await dial(attach(ticket), { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}`, "Sec-Fetch-Site": "same-origin" });
    await expectRefused(c, 403);
    expect(tickets.redeem(ticket), "turned away before the ticket was looked at").not.toBeNull();
  });

  it("refuses a handshake with no Origin", async () => {
    const c = await dial(attach(tickets.mint({ kind: "A" })), { Host: `127.0.0.1:${port}` });
    await expectRefused(c, 403);
  });

  it("refuses another site's page", async () => {
    const c = await dial(attach(tickets.mint({ kind: "A" })), { ...page(), Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    await expectRefused(c, 403);
    const d = await dial(attach(tickets.mint({ kind: "A" })), { ...page(), Origin: "https://evil.example" });
    await expectRefused(d, 403);
  });

  it("refuses Sec-Fetch-Site: cross-site even beside a matching Origin", async () => {
    const c = await dial(attach(tickets.mint({ kind: "A" })), { ...page(), "Sec-Fetch-Site": "cross-site" });
    await expectRefused(c, 403);
  });

  it("refuses a ticket it never minted", async () => {
    await expectRefused(await dial(attach("x".repeat(43))), 401);
    await expectRefused(await dial(ts.ATTACH_PATH), 401);
  });

  it("refuses an expired ticket", async () => {
    const ticket = tickets.mint({ kind: "A" });
    now += ts.TICKET_TTL_MS + 1;
    await expectRefused(await dial(attach(ticket)), 401);
  });

  it("refuses a ticket the second time", async () => {
    const ticket = tickets.mint({ kind: "A" });
    const first = await dial(attach(ticket));
    expect(first.status).toBe(101);
    await expectRefused(await dial(attach(ticket)), 401);
    first.sendClose();
    await first.closed;
  });

  it("refuses a ticket minted for another origin", async () => {
    const ticket = tickets.mint({ kind: "A", origin: "http://localhost:1" });
    await expectRefused(await dial(attach(ticket)), 403);
  });

  it("refuses a fifth terminal with a 503, keeps its ticket, and has room again once one closes", async () => {
    const open: WsClient[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await dial(attach(tickets.mint({ kind: "A", n: i })));
      expect(c.status, `socket ${i + 1}`).toBe(101);
      open.push(c);
    }
    const fifth = tickets.mint({ kind: "A", n: 5 });
    await expectRefused(await dial(attach(fifth)), 503);
    open[0].sendClose();
    await open[0].closed;
    await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(3));
    const again = await dial(attach(fifth));
    expect(again.status, "the refused ticket is still good").toBe(101);
    for (const c of [...open.slice(1), again]) { c.sendClose(); await c.closed; }
    await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(0));
  });

  it("answers a version it does not speak with 426 and the one it does", async () => {
    const c = await dial(attach(tickets.mint({ kind: "A" })), { ...page(), "Sec-WebSocket-Version": "8" });
    await expectRefused(c, 426);
    expect(c.head).toContain("Sec-WebSocket-Version: 13\r\n");
  });

  it("closes 1011 when the bridge cannot be opened, and the deck carries on", async () => {
    throwOnOpen = true;
    try {
      const c = await dial(attach(tickets.mint({ kind: "A" })));
      expect(c.status).toBe(101);
      const close = await c.until((f: Frame) => f.op === OPS.close);
      expect(close.data.readUInt16BE(0)).toBe(1011);
      // Answered, as a browser answers a close; the deck then hangs up.
      c.sendClose(1011);
      await c.closed;
    } finally {
      throwOnOpen = false;
    }
    const after = await dial(attach(tickets.mint({ kind: "A" })));
    expect(after.status).toBe(101);
    after.sendClose();
    await after.closed;
  });

  // Last: closeAllTerminals is the process going away, and after it this
  // module refuses every upgrade for the rest of the process's life.
  it("tells every open terminal at shutdown, and then refuses new ones", async () => {
    const a = await dial(attach(tickets.mint({ kind: "A" })));
    const b = await dial(attach(tickets.mint({ kind: "B" })));
    await a.next();
    await b.next();
    const mine = bridges.slice(-2);
    expect(ts.closeAllTerminals("server-shutdown")).toBe(2);
    for (const br of mine) expect(br.shutdownWith).toBe("server-shutdown");
    for (const c of [a, b]) {
      const close = await c.until((f: Frame) => f.op === OPS.close);
      expect(close.data.readUInt16BE(0)).toBe(1001);
      await c.closed;
    }
    await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(0));
    await expectRefused(await dial(attach(tickets.mint({ kind: "A" }))), 503);
  });
});

// ── the bridge ──────────────────────────────────────────────────────────────

type Sent = { type: "text"; msg: any } | { type: "binary"; data: Buffer };

class FakeConn {
  sent: Sent[] = [];
  closes: unknown[][] = [];
  bufferedAmount = 0;
  open = true;
  sendText(text: string) { if (!this.open) return false; this.sent.push({ type: "text", msg: JSON.parse(text) }); return true; }
  sendBinary(data: Buffer) { if (!this.open) return false; this.sent.push({ type: "binary", data: Buffer.from(data) }); return true; }
  close(code = 1000, reason = "") { this.closes.push([code, reason]); this.open = false; }
  texts() { return this.sent.filter(s => s.type === "text").map(s => (s as any).msg); }
}

/** What the next FakeControl's serverVersion() answers. */
let nextVersion: Promise<number[] | null> = Promise.resolve(null);

class FakeControl extends EventEmitter {
  opts: any;
  seeds = 0;
  resizes: number[][] = [];
  inputs: Buffer[] = [];
  pastes: string[] = [];
  closes = 0;
  /** Runs inside seed() before it resolves — where tmux-control emits a
   *  stale seed's 'reseed', or a pause lands. */
  duringSeed: ((n: number) => void) | null = null;
  seedFails = false;
  size = { cols: 120, rows: 40 };
  constructor(opts: any) { super(); this.opts = opts; }
  async seed() {
    const n = ++this.seeds;
    await Promise.resolve();
    this.duringSeed?.(n);
    if (this.seedFails) throw new Error("gone");
    return { bytes: Buffer.from(`SEED${n}`), cols: this.size.cols, rows: this.size.rows, cursor: [0, 0], alternate: false };
  }
  async resize(cols: number, rows: number) { this.resizes.push([cols, rows]); this.size = { cols, rows }; return { ok: true, lines: [] }; }
  async input(bytes: Buffer) { this.inputs.push(Buffer.from(bytes)); return { ok: true, lines: [] }; }
  async paste(text: string) { this.pastes.push(text); return { ok: true, lines: [] }; }
  colourReports: string[][] = [];
  versionAsked = 0;
  serverVersion() { this.versionAsked++; return nextVersion; }
  async colours(fg: string, bg: string) { this.colourReports.push([fg, bg]); return { ok: true, lines: [] }; }
  async close() { this.closes++; }
}

function bridge(binding: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  const conn = new FakeConn();
  const socket = new EventEmitter();
  let control!: FakeControl;
  const handle = ts.terminalBridge({
    conn,
    socket,
    binding: { kind: "A", tmux: "/bin/tmux", socket: { name: "ccdeck" }, target: "ccdeck-claude-0a1b2c3d", pane: "%4", ignoreSize: false, ...binding },
    open: (o: any) => (control = new FakeControl(o)),
    debounceMs: 5,
    ...opts,
  });
  const text = (msg: unknown) => handle.message({ type: "text", data: Buffer.from(JSON.stringify(msg)) });
  return { conn, socket, handle, control: () => control, text };
}

const settle = () => new Promise(r => setTimeout(r, 0));

describe("the bridge, in the order the panel expects", () => {
  it("says hello first, and nothing more until the panel's size", async () => {
    const { conn, control } = bridge();
    expect(conn.sent).toEqual([{ type: "text", msg: { t: "hello", kind: "A", sizeOwner: "dock", readOnly: false } }]);
    await settle();
    expect(control().seeds, "no seed before the panel has a size").toBe(0);
    expect(control().opts).toMatchObject({ target: "ccdeck-claude-0a1b2c3d", pane: "%4", ignoreSize: false, socket: { name: "ccdeck" } });
  });

  it("resizes the pane to the panel, then sends reset and ONE binary seed, then the stream", async () => {
    const { conn, control, text } = bridge();
    text({ t: "size", cols: 100, rows: 30 });
    await vi.waitFor(() => expect(conn.sent.length).toBe(3));
    expect(control().resizes).toEqual([[100, 30]]);
    expect(conn.sent[1]).toEqual({ type: "text", msg: { t: "reset", cols: 100, rows: 30 } });
    expect(conn.sent[2]).toEqual({ type: "binary", data: Buffer.from("SEED1") });
    control().emit("output", Buffer.from("hi"));
    expect(conn.sent[3]).toEqual({ type: "binary", data: Buffer.from("hi") });
  });

  it("holds sizes to 20..500 columns and 5..200 rows, and ignores ones that are not numbers", async () => {
    const { control, text } = bridge();
    text({ t: "size", cols: "wide", rows: 30 });
    text({ t: "size", cols: 9000, rows: 1 });
    await vi.waitFor(() => expect(control().seeds).toBe(1));
    expect(control().resizes).toEqual([[500, 5]]);
  });

  it("settles a drag into one resize, the last", async () => {
    const { control, text } = bridge();
    text({ t: "size", cols: 80, rows: 24 });
    await vi.waitFor(() => expect(control().seeds).toBe(1));
    for (const cols of [81, 82, 83, 84]) text({ t: "size", cols, rows: 24 });
    expect(control().resizes.length, "nothing yet: debounced").toBe(1);
    await vi.waitFor(() => expect(control().resizes).toEqual([[80, 24], [84, 24]]));
  });

  it("lets the pane own the size in the user's own tmux: no resizes, and the pane's size told", async () => {
    const { conn, control, text } = bridge({ kind: "B", ignoreSize: true, target: "%9", pane: "%9", socket: { path: "/tmp/tmux-1000/default" } });
    expect(conn.sent[0].type === "text" && conn.sent[0].msg).toMatchObject({ sizeOwner: "pane" });
    expect(control().opts.ignoreSize).toBe(true);
    text({ t: "size", cols: 100, rows: 30 });
    await vi.waitFor(() => expect(control().seeds).toBe(1));
    expect(conn.texts()[1], "the reset carries the pane's size, not the panel's").toEqual({ t: "reset", cols: 120, rows: 40 });
    text({ t: "size", cols: 90, rows: 20 });
    await new Promise(r => setTimeout(r, 20));
    expect(control().resizes, "the panel never resizes somebody else's pane").toEqual([]);
    control().emit("size", { cols: 132, rows: 43 });
    expect(conn.texts().at(-1)).toEqual({ t: "size", cols: 132, rows: 43 });
  });

  it("does not tell a panel that owns the size what size it is", async () => {
    const { conn, control, text } = bridge();
    text({ t: "size", cols: 100, rows: 30 });
    await vi.waitFor(() => expect(control().seeds).toBe(1));
    control().emit("size", { cols: 100, rows: 30 });
    expect(conn.texts().map(m => m.t)).toEqual(["hello", "reset"]);
  });

  it("tells a panel another view resized its pane, and takes the pane back when it is typed in", async () => {
    // Two tabs on one deck session: tmux sizes the shared window for the
    // latest client, so the other one's xterm must hear the real size or it
    // draws one pane at two sizes.
    const { conn, control, text, handle } = bridge();
    text({ t: "size", cols: 80, rows: 24 });
    await vi.waitFor(() => expect(control().seeds).toBe(1));
    expect(control().resizes).toEqual([[80, 24]]);
    control().emit("size", { cols: 150, rows: 45 });
    expect(conn.texts().at(-1), "the loser is told the pane's real size").toEqual({ t: "size", cols: 150, rows: 45 });
    control().emit("size", { cols: 150, rows: 45 });
    expect(conn.texts().filter(m => m.t === "size"), "once").toHaveLength(1);

    handle.message({ type: "binary", data: Buffer.from("y") });
    expect(control().resizes.at(-1), "typing takes the pane back at this panel's size").toEqual([80, 24]);
    await settle();
    expect(control().inputs.map(String)).toEqual(["y"]);
    // tmux answers with the pane at that size, which is news to the panel's
    // xterm (still at 150×45), so it is told.
    control().emit("size", { cols: 80, rows: 24 });
    expect(conn.texts().at(-1)).toEqual({ t: "size", cols: 80, rows: 24 });
    handle.message({ type: "binary", data: Buffer.from("z") });
    expect(control().resizes, "nothing to take back now").toHaveLength(2);

    control().emit("size", { cols: 100, rows: 30 });
    text({ t: "paste", text: "hello" });
    expect(control().resizes.at(-1), "a paste takes it back too").toEqual([80, 24]);
  });

  it("does not take back a pane on a read-only binding, nor one the user's terminal sizes", async () => {
    const ro = bridge({ readOnly: true });
    ro.text({ t: "size", cols: 80, rows: 24 });
    await vi.waitFor(() => expect(ro.control().seeds).toBe(1));
    ro.control().emit("size", { cols: 150, rows: 45 });
    ro.handle.message({ type: "binary", data: Buffer.from("y") });
    expect(ro.control().resizes).toEqual([[80, 24]]);

    const b = bridge({ kind: "B", ignoreSize: true, target: "%9", pane: "%9" });
    b.text({ t: "size", cols: 80, rows: 24 });
    await vi.waitFor(() => expect(b.control().seeds).toBe(1));
    b.control().emit("size", { cols: 150, rows: 45 });
    b.handle.message({ type: "binary", data: Buffer.from("y") });
    expect(b.control().resizes).toEqual([]);
  });

  it("does not count its own resize, pending or landed, as another view's", async () => {
    const { conn, control, text, handle } = bridge();
    text({ t: "size", cols: 80, rows: 24 });
    await vi.waitFor(() => expect(control().seeds).toBe(1));
    text({ t: "size", cols: 90, rows: 30 });
    // The echo of the first resize, arriving while the second waits out the debounce.
    control().emit("size", { cols: 80, rows: 24 });
    await new Promise(r => setTimeout(r, 20));
    expect(control().resizes.at(-1)).toEqual([90, 30]);
    control().emit("size", { cols: 90, rows: 30 });
    expect(conn.texts().filter(m => m.t === "size"), "the panel is never told its own size").toEqual([]);
    handle.message({ type: "binary", data: Buffer.from("y") });
    expect(control().resizes, "and nothing is taken back").toHaveLength(2);
  });

  it("tells the panel the tmux server's version once, before the first reset, asked as the bridge opens", async () => {
    nextVersion = Promise.resolve([3, 4]);
    try {
      const { conn, control, text } = bridge();
      expect(control().versionAsked, "asked before the panel's size is in").toBe(1);
      text({ t: "size", cols: 80, rows: 24 });
      await vi.waitFor(() => expect(control().seeds).toBe(1));
      control().emit("reseed");
      await vi.waitFor(() => expect(control().seeds).toBe(2));
      await settle();
      expect(conn.texts().map(m => m.t)).toEqual(["hello", "tmux", "reset", "reset"]);
      expect(conn.texts()[1]).toEqual({ t: "tmux", version: "3.4" });
    } finally {
      nextVersion = Promise.resolve(null);
    }
  });

  it("holds the first reset behind a version tmux answers late, and says nothing when it will not say", async () => {
    let answer!: (v: number[] | null) => void;
    nextVersion = new Promise(r => { answer = r; });
    try {
      const late = bridge();
      late.text({ t: "size", cols: 80, rows: 24 });
      await settle();
      expect(late.control().seeds, "the seed waits for the one answer queued ahead of it").toBe(0);
      answer([3, 8]);
      await vi.waitFor(() => expect(late.control().seeds).toBe(1));
      await settle();
      expect(late.conn.texts().map(m => m.t)).toEqual(["hello", "tmux", "reset"]);
    } finally {
      nextVersion = Promise.resolve(null);
    }
    const quiet = bridge();
    quiet.text({ t: "size", cols: 80, rows: 24 });
    await vi.waitFor(() => expect(quiet.control().seeds).toBe(1));
    expect(quiet.conn.texts().map(m => m.t)).toEqual(["hello", "reset"]);
  });

  it("passes the panel's colours to tmux for the deck's own pane: valid, once per change, the latest after a cooldown", async () => {
    const { control, text } = bridge({}, { coloursMs: 30 });
    text({ t: "colours", fg: "#e6e6e6", bg: "#14161b" });
    expect(control().colourReports).toEqual([["#e6e6e6", "#14161b"]]);
    text({ t: "colours", fg: "#e6e6e6", bg: "#14161b" });
    text({ t: "colours", fg: "#111111", bg: "#ffffff" });
    text({ t: "colours", fg: "#1f2328", bg: "#fafaf8" });
    expect(control().colourReports, "inside the cooldown nothing more goes out").toHaveLength(1);
    await new Promise(r => setTimeout(r, 50));
    expect(control().colourReports.at(-1), "then the latest, and only it").toEqual(["#1f2328", "#fafaf8"]);
    expect(control().colourReports).toHaveLength(2);
    for (const [fg, bg] of [["#FFFFFF", "#000000"], ["#fff", "#000000"], ["red", "#000000"], [1, 2], ["#ffffff", "#000000; kill-server"]]) {
      text({ t: "colours", fg, bg });
    }
    await new Promise(r => setTimeout(r, 50));
    expect(control().colourReports, "anything but #rrggbb in lowercase is dropped").toHaveLength(2);
  });

  it("never tells the user's own tmux, or a read-only view, any colours", async () => {
    const b = bridge({ kind: "B", ignoreSize: true, target: "%9", pane: "%9" });
    b.text({ t: "colours", fg: "#e6e6e6", bg: "#14161b" });
    const ro = bridge({ readOnly: true });
    ro.text({ t: "colours", fg: "#e6e6e6", bg: "#14161b" });
    await settle();
    expect(b.control().colourReports).toEqual([]);
    expect(ro.control().colourReports).toEqual([]);
  });

  it("re-seeds on 'reseed': reset and seed again, and the stream after", async () => {
    const { conn, control, text } = bridge();
    text({ t: "size", cols: 80, rows: 24 });
    await vi.waitFor(() => expect(control().seeds).toBe(1));
    control().emit("reseed");
    await vi.waitFor(() => expect(control().seeds).toBe(2));
    await settle();
    expect(conn.sent.slice(-2)).toEqual([
      { type: "text", msg: { t: "reset", cols: 80, rows: 24 } },
      { type: "binary", data: Buffer.from("SEED2") },
    ]);
  });

  it("drops a seed that went stale while it was captured, and sends only the newer one", async () => {
    const { conn, control, text } = bridge();
    control().duringSeed = (n) => { if (n === 1) control().emit("reseed"); };
    text({ t: "size", cols: 80, rows: 24 });
    await vi.waitFor(() => expect(control().seeds).toBe(2));
    await settle();
    const binaries = conn.sent.filter(s => s.type === "binary").map(s => (s as any).data.toString());
    expect(binaries, "SEED1 was out of date before it was sent").toEqual(["SEED2"]);
    expect(conn.texts().filter(m => m.t === "reset").length).toBe(1);
  });

  it("says why it ended, then closes 1000, and lets the tmux client go", async () => {
    for (const [reason, said] of [["ended", "ended"], ["detached", "detached"], ["error", "error"], ["something new", "error"]]) {
      const { conn, control, text } = bridge();
      text({ t: "size", cols: 80, rows: 24 });
      await vi.waitFor(() => expect(control().seeds).toBe(1));
      control().emit("exit", { reason, message: "no server running on /tmp/tmux-1000/ccdeck" });
      await vi.waitFor(() => expect(conn.closes).toEqual([[1000, said]]));
      const exit = conn.texts().at(-1);
      expect(exit.t).toBe("exit");
      expect(exit.reason, reason).toBe(said);
      expect(JSON.stringify(exit), "tmux's own words, and the path in them, stay in the deck").not.toContain("/tmp");
      if (said === "error") expect(exit.message).toBe("The deck lost its connection to tmux.");
      else expect(exit.message).toBeUndefined();
      expect(control().closes).toBe(1);
    }
  });

  it("ignores its own close", async () => {
    const { conn, control } = bridge();
    control().emit("exit", { reason: "closed" });
    await settle();
    expect(conn.texts().map(m => m.t)).toEqual(["hello"]);
  });

  it("shows a pane that died before the panel had a frame its last frame, then says ended — before it was looking", async () => {
    const { conn, control } = bridge();
    control().emit("exit", { reason: "ended" });
    await vi.waitFor(() => expect(conn.closes.length).toBe(1));
    expect(conn.sent.map(s => (s.type === "text" ? s.msg.t : "seed"))).toEqual(["hello", "reset", "seed", "exit"]);
    expect(conn.texts().at(-1)).toEqual({ t: "exit", reason: "ended", atOpen: true });
  });

  it("says a pane that was already dead at attach has ended right after its last frame, not a second later", async () => {
    // An ended session's deck pane, opened read-only for its last frame:
    // tmux's dead-pane subscription only reports once a second, and by then
    // the panel would have drawn the frame as live.
    const { conn, control, text } = bridge({ ignoreSize: true, readOnly: true });
    (control() as any).ready = Promise.resolve({ pane: "%4", cols: 120, rows: 40, dead: true });
    text({ t: "size", cols: 100, rows: 30 });
    await vi.waitFor(() => expect(conn.closes.length).toBe(1));
    expect(conn.sent.map(s => (s.type === "text" ? s.msg.t : "seed"))).toEqual(["hello", "reset", "seed", "exit"]);
    expect(conn.texts().at(-1)).toEqual({ t: "exit", reason: "ended", atOpen: true });
    expect(control().resizes, "a dead pane keeps its own size").toEqual([]);
  });

  it("keeps streaming a pane that was alive at attach", async () => {
    const { conn, control, text } = bridge();
    (control() as any).ready = Promise.resolve({ pane: "%4", cols: 120, rows: 40, dead: false });
    text({ t: "size", cols: 100, rows: 30 });
    await vi.waitFor(() => expect(control().seeds).toBe(1));
    await settle();
    expect(conn.closes).toEqual([]);
    expect(conn.texts().map(m => m.t)).toEqual(["hello", "reset"]);
  });

  it("says ended without a frame when the pane cannot be captured any more", async () => {
    const { conn, control } = bridge();
    control().seedFails = true;
    control().emit("exit", { reason: "ended" });
    await vi.waitFor(() => expect(conn.closes.length).toBe(1));
    expect(conn.texts().map(m => m.t)).toEqual(["hello", "exit"]);
  });

  it("types binary frames into the pane and pastes paste messages", async () => {
    const { control, handle, text } = bridge();
    handle.message({ type: "binary", data: Buffer.from("\x1b[A") });
    text({ t: "paste", text: "line one\nline two" });
    expect(control().inputs).toEqual([Buffer.from("\x1b[A")]);
    expect(control().pastes).toEqual(["line one\nline two"]);
  });

  it("ignores what it cannot read, and what it has never heard of", async () => {
    const { conn, control, handle, text } = bridge();
    handle.message({ type: "text", data: Buffer.from("{not json") });
    text({ t: "telepathy" });
    text({ t: "paste", text: 42 });
    text(null);
    await settle();
    expect(control().pastes).toEqual([]);
    expect(conn.closes, "a page newer than this deck is not cut off").toEqual([]);
  });

  it("types nothing on a read-only binding, and says so in its hello", async () => {
    const { conn, control, handle, text } = bridge({ readOnly: true });
    expect(conn.texts()[0].readOnly).toBe(true);
    handle.message({ type: "binary", data: Buffer.from("rm -rf /\r") });
    text({ t: "paste", text: "x" });
    expect(control().inputs).toEqual([]);
    expect(control().pastes).toEqual([]);
  });

  it("stops forwarding past 4 MiB unsent, and re-seeds once the socket drains", async () => {
    expect(ts.HIGH_WATER_BYTES).toBe(4 * 1024 * 1024);
    const { conn, socket, control, text } = bridge();
    text({ t: "size", cols: 80, rows: 24 });
    await vi.waitFor(() => expect(control().seeds).toBe(1));
    conn.bufferedAmount = ts.HIGH_WATER_BYTES + 1;
    const before = conn.sent.length;
    control().emit("output", Buffer.from("lost"));
    control().emit("output", Buffer.from("lost too"));
    expect(conn.sent.length, "nothing queued behind a socket that is not reading").toBe(before);
    conn.bufferedAmount = 0;
    socket.emit("drain");
    await vi.waitFor(() => expect(control().seeds).toBe(2));
    await settle();
    expect(conn.sent.slice(before).map(s => (s.type === "text" ? s.msg.t : s.data.toString()))).toEqual(["reset", "SEED2"]);
    control().emit("output", Buffer.from("back"));
    expect(conn.sent.at(-1)).toEqual({ type: "binary", data: Buffer.from("back") });
  });

  it("lets the tmux client go and says nothing more when the socket goes away", async () => {
    const { conn, control, handle, text } = bridge();
    text({ t: "size", cols: 80, rows: 24 });
    await vi.waitFor(() => expect(control().seeds).toBe(1));
    handle.closed(1006, "");
    expect(control().closes).toBe(1);
    const before = conn.sent.length;
    control().emit("output", Buffer.from("late"));
    control().emit("exit", { reason: "ended" });
    await settle();
    expect(conn.sent.length).toBe(before);
  });

  it("says server-shutdown and closes 1001 when the deck goes away", () => {
    const { conn, control, handle } = bridge();
    handle.shutdown("server-shutdown");
    expect(conn.texts().at(-1)).toEqual({ t: "exit", reason: "server-shutdown" });
    expect(conn.closes).toEqual([[1001, "server-shutdown"]]);
    expect(control().closes).toBe(1);
  });

  it("ends with an error, not a throw, when the tmux client cannot be opened", () => {
    const conn = new FakeConn();
    ts.terminalBridge({ conn, socket: new EventEmitter(), binding: { kind: "A" }, open: () => { throw new TypeError("openControl needs the tmux binary"); } });
    expect(conn.texts().map(m => m.t)).toEqual(["hello", "exit"]);
    expect(conn.texts()[1]).toEqual({ t: "exit", reason: "error", message: "The deck lost its connection to tmux." });
  });
});
