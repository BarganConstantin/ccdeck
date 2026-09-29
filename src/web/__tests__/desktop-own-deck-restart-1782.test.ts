// "Restart ccdeck" on the app's own deck when that deck is hung (#1782).
//
// The tray's restart counted ANY error from POST /api/restart as the restart
// having happened — meant for the socket going away mid-answer — and a deck
// that did not answer at all fails the same way, with deck-link's "timed out".
// So a hung deck was never stopped: the tray said "Restarting the deck…", then
// "No deck running", and the next start put a second deck beside it on
// another port. That one's exit handler then cleared the module's `ownDeck`
// whichever child had exited, so Quit stopped neither.
//
// What decides it is now in deck-link.mjs (restartAsked) and own-deck.mjs (the
// tracker and the stop), and checked here: against a real socket for the three
// ways the request can end, and against a stand-in child for the rest.
import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deckJson, restartAsked } from "../../../desktop/deck-link.mjs";
// @ts-expect-error — plain .mjs, no types
import { createOwnDeck, stopChild } from "../../../desktop/own-deck.mjs";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });

/** A server on 127.0.0.1, and the `deck` object deck-link talks to it with. */
async function fakeDeck(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return { port, token: "tok-en", pid: 1 };
}

/** What restartDeck hands restartAsked: the answer, or the error. */
const outcome = (deck: { port: number; token: string }, timeoutMs = 5000) =>
  deckJson(deck, "/api/restart", { method: "POST", body: {}, timeoutMs }).catch((err: Error) => err);

describe("whether the restart was asked", () => {
  it("is not, when the deck does not answer in time", async () => {
    // Holds the request and never answers — a deck whose event loop is stuck.
    const deck = await fakeDeck(() => {});
    const got = await outcome(deck, 150);
    expect(got).toBeInstanceOf(Error);
    expect(restartAsked(got)).toBe(false);
  });

  it("is, when the deck drops the connection mid-answer", async () => {
    const deck = await fakeDeck(req => req.socket.destroy());
    const got = await outcome(deck);
    expect(got).toBeInstanceOf(Error);
    expect(restartAsked(got)).toBe(true);
  });

  it("is, when the deck says it will", async () => {
    const deck = await fakeDeck((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
    expect(restartAsked(await outcome(deck))).toBe(true);
  });

  it("is not, when the deck says it cannot", async () => {
    // Unsupervised, or with no log to replay: the app stops and starts its own.
    const deck = await fakeDeck((_req, res) => { res.writeHead(501, { "content-type": "application/json" }); res.end('{"ok":false}'); });
    expect(restartAsked(await outcome(deck))).toBe(false);
  });

  it("is not, when nothing is listening at all", () => {
    expect(restartAsked(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4317"), { code: "ECONNREFUSED" }))).toBe(false);
  });
});

/** A child process as far as the app reads one. */
function fakeChild({ exitsOnKill = 1 }: { exitsOnKill?: number } = {}) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    kills: 0,
    kill() {
      child.kills++;
      if (child.kills >= exitsOnKill) exit(child, null, "SIGTERM");
      return true;
    },
  });
  return child;
}
function exit(child: ReturnType<typeof fakeChild>, code: number | null, signal: string | null = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
}

describe("the deck this app started", () => {
  it("stays the new one when the deck it replaced exits afterwards", () => {
    const own = createOwnDeck();
    const exits: unknown[] = [];
    const a = own.track(fakeChild(), (code: number) => exits.push(["a", code]));
    const b = own.track(fakeChild(), (code: number) => exits.push(["b", code]));
    expect(own.current()).toBe(b);
    exit(a, 0);
    expect(own.current()).toBe(b);
    // Every exit is still heard.
    expect(exits).toEqual([["a", 0]]);
    exit(b, 1);
    expect(own.current()).toBe(null);
    expect(exits).toEqual([["a", 0], ["b", 1]]);
  });

  it("is stopped with a second signal when it does not go at the first", async () => {
    // The deck's supervisor passes the first signal on to its worker as
    // SIGTERM, which a worker stuck in its own event loop never handles, and
    // takes a second as the order to SIGKILL it (bin/agent-dag.js).
    const child = fakeChild({ exitsOnKill: 2 });
    expect(await stopChild(child, { graceMs: 10 })).toBe(true);
    expect(child.kills).toBe(2);
  });

  it("is not signalled when it goes by itself, or has already gone", async () => {
    const leaving = fakeChild();
    setTimeout(() => exit(leaving, 0), 5);
    expect(await stopChild(leaving, { graceMs: 1000 })).toBe(true);
    expect(leaving.kills).toBe(0);
    const gone = fakeChild();
    exit(gone, 0);
    expect(await stopChild(gone, { graceMs: 1000 })).toBe(true);
    expect(gone.kills).toBe(0);
  });

  it("says so when nothing stops it", async () => {
    const stuck = fakeChild({ exitsOnKill: Infinity });
    expect(await stopChild(stuck, { graceMs: 10 })).toBe(false);
    expect(stuck.kills).toBe(2);
  });
});

describe("the app's wiring", () => {
  const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");
  const fn = (name: string) => {
    const at = main.search(new RegExp(`(?:async )?function ${name}\\(`));
    expect(at, `${name} is gone or renamed`).toBeGreaterThan(-1);
    return main.slice(at, main.indexOf("\n}\n", at));
  };

  it("reads the restart's answer through restartAsked, the error included", () => {
    const body = fn("restartDeck");
    expect(body).toMatch(/asked = restartAsked\(await deckJson\(deck, "\/api\/restart", /);
    expect(body).toMatch(/catch \(err\) \{[^}]*asked = restartAsked\(err\);/);
    expect(body).not.toMatch(/asked = true;/);
  });

  it("tracks the deck it starts, and stops the one it tracks", () => {
    expect(main).toContain("const ownDeck = createOwnDeck();");
    // Assigned once, there: nothing else overwrites or clears it.
    expect(main.match(/\bownDeck = /g)).toHaveLength(1);
    expect(fn("ensureDeck")).toMatch(/ownDeck\.track\(startDeck\(\{/);
    expect(fn("stopOwnDeck")).toContain("const child = ownDeck.current();");
    expect(fn("stopOwnDeck")).toContain("await stopChild(child);");
  });

  it("packs the module into the app", () => {
    const config = readFileSync(fileURLToPath(new URL("../../../desktop/electron-builder.config.cjs", import.meta.url)), "utf8");
    expect(config).toContain('"own-deck.mjs"');
  });
});
