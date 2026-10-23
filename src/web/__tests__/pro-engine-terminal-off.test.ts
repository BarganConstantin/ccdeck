// With no engine — the default, and always so in the free product — the
// terminal socket is the JS path it always was: every ticket goes to the
// bridge in this process, the relay module is never even read, and nothing
// is started or looked up.
//
// The relay module is replaced by a stand-in that records being loaded, so
// "never read" is a fact about this run rather than about the source; the
// last case is the control that shows an engine ticket on an enabled engine
// really does leave the JS path, so the cases above are not vacuous.
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
const servers: Server[] = [], sockets: WsClient[] = [];
afterAll(async () => {
  for (const c of sockets) c.socket.destroy();
  await Promise.all(servers.map(s => new Promise(r => { s.close(r); s.closeAllConnections?.(); })));
});

/** A deck whose upgrade has `engine`, and a stand-in bridge that records what it was handed. */
async function deck(engine: unknown) {
  const tickets = ts.createTicketStore();
  const bridges: any[] = [];
  const server = createServer((_req, res) => { res.end("routed"); });
  servers.push(server);
  ts.installTerminalUpgrade(server, {
    enabled: () => true,
    tickets,
    engine,
    openBridge: ({ conn, binding }: any) => {
      bridges.push(binding);
      conn.sendText(JSON.stringify({ t: "hello", kind: "js" }));
      return { message() {}, closed() {}, shutdown() {} };
    },
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

describe("the terminal socket with no engine", () => {
  it("hands every ticket to the bridge in this process, a handle binding included, with the same 101", async () => {
    // A configured client left off: what a deck would hold had the owner set
    // an installation up and not switched it on.
    const disabled = createProEngineClient({ directory: "/nonexistent", publicKey: "bogus" });
    const off = engineStandIn(() => disabled.enabled);
    for (const engine of [undefined, null, off]) {
      const d = await deck(engine);
      for (const binding of [{ kind: "A", pane: "%1" }, { handle: HANDLE }]) {
        const { c, key } = await d.dial(binding);
        expect(c.head).toBe(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
        expect(json(await c.next())).toEqual({ t: "hello", kind: "js" });
        c.sendClose();
        await c.closed;
      }
      expect(d.bridges.map(b => b.pane ?? b.handle)).toEqual(["%1", HANDLE]);
    }
    await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(0));
    expect(off.attaches, "nothing was asked of the engine").toEqual([]);
    expect(relayLoads.count, "the relay module was never loaded").toBe(0);
    expect(disabled.running, "and no engine was started or looked for").toBe(false);
    expect(disabled.capabilities).toBeUndefined();
  });

  it("imports nothing of the engine's, statically or on demand", () => {
    const source = readFileSync(new URL("../../server/terminal-socket.mjs", import.meta.url), "utf8");
    const imports = source.split("\n").filter(line => /^import\b/.test(line));
    expect(imports.length, "the scan sees the file's imports").toBeGreaterThan(0);
    expect(imports.filter(line => line.includes("pro-engine"))).toEqual([]);
    expect(source.match(/import\([^)]*pro-engine/g)).toBeNull();
  });

  it("leaves the JS path only for an engine ticket on an enabled engine (the control for the cases above)", async () => {
    const on = engineStandIn(() => true);
    const d = await deck(on);
    const { c } = await d.dial({ handle: HANDLE });
    expect(c.status, "the stand-in refuses").toBe(503);
    expect(on.attaches.map(([handle]) => handle)).toEqual([HANDLE]);
    expect(d.bridges).toEqual([]);
    const js = await d.dial({ kind: "A", pane: "%1" });
    expect(json(await js.c.next()), "any other ticket still goes to the bridge here").toEqual({ t: "hello", kind: "js" });
    expect(d.bridges.map(b => b.pane)).toEqual(["%1"]);
    js.c.sendClose();
    await js.c.closed;
    await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(0));
    expect(relayLoads.count, "terminal-socket loads nothing of the engine's even then").toBe(0);
  });
});
