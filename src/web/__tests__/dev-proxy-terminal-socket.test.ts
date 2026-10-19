// The dev server forwards the terminal panel's WebSocket, and launders the
// Origin of nobody's page but its own.
//
// Under `npm run dev:web` the page is served by Vite and its socket is
// proxied to the deck, so the deck's Origin-equals-Host check
// (terminal-socket.mjs) can only pass if the proxy rewrites the Origin. For a
// POST the /api entry rewrites every one, and fetch metadata still stops a
// cross-site request at the deck. A WebSocket is the case where that is not
// enough to lean on: browsers apply no same-origin policy to it, and the
// Origin check is what stands between any page the browser has open and a
// typeable terminal. So vite.config.ts rewrites it only for a request whose
// Origin is this dev server's own, on a loopback name. These pin that rule,
// and that the config hands it the upgrade on the attach path and nowhere
// else. Nothing here opens a socket: the config's target is the owner's
// running deck, which a test must never reach.
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import config, { terminalSocketOrigin } from "../../../vite.config";

const DECK = "http://127.0.0.1:4317";

describe("which upgrades have their Origin rewritten to the deck's", () => {
  it("a page this dev server served, under any loopback name it was opened by", () => {
    for (const host of ["localhost:5174", "127.0.0.1:5174", "[::1]:5174", "LOCALHOST:5174", "127.0.0.2:5175"]) {
      expect(terminalSocketOrigin({ host, origin: `http://${host.toLowerCase()}` }), host).toBe(DECK);
    }
  });

  it("never another site's page, nor another local server's", () => {
    // The deck's rule compares host and port, not the scheme: one port is one
    // server, so a page on this port is this server's whichever scheme it uses.
    for (const origin of ["https://evil.example", "http://localhost:3000", "http://127.0.0.1:4317", "http://127.0.0.1:5174", "null"]) {
      expect(terminalSocketOrigin({ host: "localhost:5174", origin }), origin).toBeNull();
    }
  });

  it("never a rebound name, though its Origin matches its Host", () => {
    // DNS rebinding: every header is self-consistent and attacker-chosen.
    expect(terminalSocketOrigin({ host: "evil.example:5174", origin: "http://evil.example:5174" })).toBeNull();
    expect(terminalSocketOrigin({ host: "127.0.0.1.nip.io:5174", origin: "http://127.0.0.1.nip.io:5174" })).toBeNull();
  });

  it("never a request that does not say where it came from", () => {
    expect(terminalSocketOrigin({ host: "localhost:5174" })).toBeNull();
    expect(terminalSocketOrigin({ host: "localhost:5174", origin: "" })).toBeNull();
    expect(terminalSocketOrigin({ origin: "http://localhost:5174" })).toBeNull();
    expect(terminalSocketOrigin({ host: ["localhost:5174"], origin: ["http://localhost:5174"] })).toBeNull();
  });
});

describe("the dev server's proxy", () => {
  type Entry = { target?: string; ws?: boolean; changeOrigin?: boolean; configure?: (proxy: EventEmitter, options: unknown) => void };
  const proxy = (config as { server: { proxy: Record<string, Entry> } }).server.proxy;

  it("forwards a WebSocket on the terminal's attach path and on no other", () => {
    expect(Object.keys(proxy)[0], "first, so it is the entry that matches its path").toBe("/api/terminal/attach");
    expect(proxy["/api/terminal/attach"]).toMatchObject({ target: DECK, changeOrigin: true, ws: true });
    for (const [path, entry] of Object.entries(proxy)) {
      if (path !== "/api/terminal/attach") expect(entry.ws, path).toBeFalsy();
    }
  });

  it("rewrites the upgrade's Origin through that rule, and leaves any other untouched", () => {
    const emitter = new EventEmitter();
    proxy["/api/terminal/attach"].configure!(emitter, proxy["/api/terminal/attach"]);
    const upgrade = (headers: Record<string, string>) => {
      const set: Record<string, string> = {};
      emitter.emit("proxyReqWs", { setHeader: (k: string, v: string) => { set[k] = v; } }, { headers });
      return set;
    };
    expect(upgrade({ host: "localhost:5174", origin: "http://localhost:5174" })).toEqual({ origin: DECK });
    expect(upgrade({ host: "localhost:5174", origin: "https://evil.example" }), "the deck sees the real Origin and refuses it").toEqual({});
    expect(emitter.listenerCount("proxyReq"), "and nothing is hooked on plain requests on this path").toBe(0);
  });
});
