// With no engine — the default, and always so in the free product — the
// Command Panel's socket has nothing to relay to, and refuses: a ticket whose
// binding is an engine handle is refused 503 before the 101, the relay module
// is never even read, and nothing is started or looked up. Any other ticket
// goes to a bridge in this process only when a test handed the upgrade one (the
// JS backend's, `openBridge`); the product hands none, and refuses it the same
// way.
//
// The relay module is replaced by a stand-in that records being loaded, so
// "never read" is a fact about this run rather than about the source; the
// last case is the control that shows an engine ticket on an enabled engine
// really does reach the engine, so the cases above are not vacuous.
import { afterAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
// @ts-expect-error — plain .mjs server module, no types
import { createProEngineClient } from "../../server/pro-engine-client.mjs";
// @ts-expect-error — plain .mjs server module, no types
import * as ts from "../../server/terminal-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { acceptKey } from "../../server/ws-frames.mjs";
import { handshakeKey, json, openWs, type WsClient } from "./ws-test-client";

const relayLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../server/pro-engine-terminal.mjs", () => {
  relayLoads.count += 1;
  return { engineTerminals: () => ({ enabled: true, attach: async () => ({ ok: false, status: 503 }) }) };
});

const HANDLE = "ab".repeat(32);
const REFUSED_503 = "HTTP/1.1 503 Service Unavailable";
const servers: Server[] = [], sockets: WsClient[] = [];
afterAll(async () => {
  for (const c of sockets) c.socket.destroy();
  await Promise.all(servers.map(s => new Promise(r => { s.close(r); s.closeAllConnections?.(); })));
});

/** A deck whose upgrade has `engine`, and — unless `bridge` is false, as in the
 *  product — a stand-in for a test's JS bridge that records what it was handed. */
async function deck(engine: unknown, { bridge = true } = {}) {
  const tickets = ts.createTicketStore();
  const bridges: any[] = [];
  const server = createServer((_req, res) => { res.end("routed"); });
  servers.push(server);
  ts.installTerminalUpgrade(server, {
    enabled: () => true,
    tickets,
    engine,
    ...(bridge ? {
      openBridge: ({ conn, binding }: any) => {
        bridges.push(binding);
        conn.sendText(JSON.stringify({ t: "hello", kind: "js" }));
        return { message() {}, closed() {}, shutdown() {} };
      },
    } : {}),
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    bridges,
    async dial(binding: object) {
      const key = handshakeKey();
      const ticket = tickets.mint({ ...binding, origin });
      const c = await openWs({ port, path: `${ts.ATTACH_PATH}?ticket=${encodeURIComponent(ticket)}`, headers: { Host: `127.0.0.1:${port}`, Origin: origin, "Sec-WebSocket-Key": key } });
      sockets.push(c);
      return { c, key };
    },
  };
}

/** An engine's terminals as engineTerminals shapes them, with a switch and a record of every attach. */
function engineStandIn(enabled: () => boolean) {
  const attaches: unknown[][] = [];
  return {
    attaches,
    get enabled() { return enabled(); },
    attach: async (...args: unknown[]) => { attaches.push(args); return { ok: false, status: 503 }; },
  };
}

describe("the Command Panel's socket with no engine", () => {
  it("refuses an engine ticket 503 before the 101, with no engine, a null one or one switched off, and never hands it to a bridge here", async () => {
    // A configured client left off: what a deck would hold had the owner set
    // an installation up and not switched it on.
    const disabled = createProEngineClient({ directory: "/nonexistent", publicKey: "bogus" });
    const off = engineStandIn(() => disabled.enabled);
    for (const engine of [undefined, null, off]) {
      const d = await deck(engine);
      const { c } = await d.dial({ handle: HANDLE });
      expect(c.status).toBe(503);
      expect(c.head.startsWith(REFUSED_503), "a plain status, never a 101").toBe(true);
      // A test's own JS ticket, on a test's bridge: still served, with the same 101.
      const js = await d.dial({ kind: "A", pane: "%1" });
      expect(js.c.head).toBe(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(js.key)}\r\n\r\n`);
      expect(json(await js.c.next())).toEqual({ t: "hello", kind: "js" });
      js.c.sendClose();
      await js.c.closed;
      expect(d.bridges.map(b => b.pane ?? b.handle), "the handle never reached the bridge").toEqual(["%1"]);
    }
    await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(0));
    expect(off.attaches, "nothing was asked of the engine").toEqual([]);
    expect(relayLoads.count, "the relay module was never loaded").toBe(0);
    expect(disabled.running, "and no engine was started or looked for").toBe(false);
    expect(disabled.capabilities).toBeUndefined();
  });

  it("refuses every ticket 503 before the 101 on a deck handed no bridge, as the product is", async () => {
    for (const engine of [undefined, null, engineStandIn(() => false)]) {
      const d = await deck(engine, { bridge: false });
      for (const binding of [{ kind: "A", pane: "%1" }, { handle: HANDLE }]) {
        const { c } = await d.dial(binding);
        expect(c.status, JSON.stringify(binding)).toBe(503);
        expect(c.head.startsWith(REFUSED_503)).toBe(true);
      }
    }
    await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(0));
  });

  it("imports nothing of the engine's, nor of the JS backend, statically or on demand", () => {
    const source = readFileSync(new URL("../../server/terminal-socket.mjs", import.meta.url), "utf8");
    const imports = source.split("\n").filter(line => /^import\b/.test(line));
    expect(imports.length, "the scan sees the file's imports").toBeGreaterThan(0);
    expect(imports.filter(line => /pro-engine|terminal-bridge|terminal-js-routes|tmux/.test(line))).toEqual([]);
    expect(source.match(/import\([^)]*(pro-engine|terminal-bridge|terminal-js-routes|tmux)/g)).toBeNull();
  });

  it("relays an engine ticket on an enabled engine (the control for the cases above)", async () => {
    const on = engineStandIn(() => true);
    for (const bridge of [true, false]) {
      const d = await deck(on, { bridge });
      const { c } = await d.dial({ handle: HANDLE });
      expect(c.status, "the stand-in refuses").toBe(503);
      expect(d.bridges).toEqual([]);
    }
    expect(on.attaches.map(([handle]) => handle)).toEqual([HANDLE, HANDLE]);
    expect(relayLoads.count, "terminal-socket loads nothing of the engine's even then").toBe(0);
  });
});
