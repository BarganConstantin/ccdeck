// A refusal ends one LAN connection, never the listener's process.
//
// The listener stored the caller's challenge before deriving the key, and two
// of the refusals #1136 added (a `hello` whose ephemeral key was missing or
// unusable) return in between. So the challenge was set and the key still
// null. `refuse` destroyed the socket, but the frame reader carried on through
// the rest of the chunk, and a second frame in the same write reached the
// proof with no key: a throw inside the socket's data handler, which nothing
// catches, and the process ended. LAN sync listens on every interface.
//
// Three things hold now, and this file pins them: the reader turns a frame
// handler that throws into a refusal of that connection; the listener reads
// nothing after it has refused; and `auth` is refused while there is no key.
//
// The listener runs in a process of its own, so a throw in its handler shows as
// that process exiting rather than as an error in this one.

import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { frameReader } from "../../server/lan-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { identityFrom, challengeFor } from "../../server/lan-sync.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BASE = process.platform === "win32" ? tmpdir() : "/var/tmp";
const DIR = mkdtempSync(join(BASE, "ccdeck-lan-refusal-"));
const CHILD = join(DIR, "listener.mjs");
const moduleUrl = (rel: string) => JSON.stringify(pathToFileURL(join(ROOT, rel)).href);
writeFileSync(CHILD, `
const { createSyncServer } = await import(${moduleUrl("src/server/lan-socket.mjs")});
const { identityFrom } = await import(${moduleUrl("src/server/lan-sync.mjs")});
const id = identityFrom("");
const server = createSyncServer({
  fp: id.fp, pub: id.pub, secret: id.secret, name: "listener",
  handlers: () => {}, onError: () => {}, prefer: Number(process.argv[2]), host: "127.0.0.1",
  trusted: () => [], invite: () => null, declined: () => false, onPending: () => {},
});
const port = await server.start();
process.stdout.write("READY " + port + "\\n");
setInterval(() => {}, 1000);
`);

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  rmTempDir(DIR);
});

async function startListener(prefer: number): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, [CHILD, String(prefer)], {
    env: { ...process.env, HOME: DIR, USERPROFILE: DIR, AGENTS_DECK_NO_LAN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", d => {
      out += d;
      const m = /READY (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.once("exit", code => reject(new Error(`the listener exited before it was ready (${code})`)));
    setTimeout(() => reject(new Error("the listener never became ready")), 10_000).unref();
  });
  return { child, port };
}

/** Write `payload` in one go, and collect whatever comes back until the socket closes. */
function exchange(port: number, payload: string, ms = 1500): Promise<string> {
  return new Promise(resolve => {
    let got = "";
    const s = net.connect({ port, host: "127.0.0.1" });
    let finished = false;
    const done = () => { if (finished) return; finished = true; s.destroy(); resolve(got); };
    s.on("connect", () => s.write(payload));
    s.on("data", d => { got += d; });
    s.on("close", done);
    s.on("error", done);
    setTimeout(done, ms).unref();
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

type Identity = { fp: string; pub: string };
const identity = identityFrom as (secret: string) => Identity;
const challenge = challengeFor as (o: { seals: boolean; ephemeral: boolean }) => string;

/** A hello from a fresh identity. By default its challenge carries both marks —
 *  it seals, and it mixes an ephemeral key — which is what makes a missing or
 *  unusable `epk` a refusal. */
function hello(extra: Record<string, unknown> = {}): string {
  const id = identity("");
  return JSON.stringify({
    t: "hello", fp: id.fp, pub: id.pub, name: "probe", port: 1,
    challenge: challenge({ seals: true, ephemeral: true }), ...extra,
  }) + "\n";
}
const AUTH = JSON.stringify({ t: "auth", proof: "00" }) + "\n";
/** An X25519 public key whose point has low order: it parses, and any
 *  Diffie-Hellman with it throws. */
const LOW_ORDER_EPK = Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.alloc(32)]).toString("base64");
/** A plain hello from an older deck: no marks, so nothing is mixed and it is answered. */
const plainHello = () => hello({ challenge: challenge({ seals: false, ephemeral: false }) });

describe("the frame reader", () => {
  it("turns a frame handler that throws into a refusal of that connection, and reads nothing after it", () => {
    const seen: string[] = [];
    const refusals: string[] = [];
    const read = (frameReader as (on: (m: { t: string }) => void, refuse: (why: string) => void) => (chunk: string) => void)(
      msg => {
        seen.push(msg.t);
        if (msg.t === "boom") throw new TypeError("a handler threw");
      },
      why => { refusals.push(why); },
    );
    expect(() => read('{"t":"a"}\n{"t":"boom"}\n{"t":"after"}\n')).not.toThrow();
    expect(seen).toEqual(["a", "boom"]);
    expect(refusals).toEqual(["bad frame"]);
    read('{"t":"later"}\n');
    expect(seen, "nothing is read once the connection is refused").toEqual(["a", "boom"]);
  });
});

describe("a refused hello with another frame behind it in the same write", () => {
  it("is refused, and the listener lives to answer the next caller (no ephemeral key)", async () => {
    const { child, port } = await startListener(4700);
    expect(await exchange(port, hello() + AUTH)).toContain("bad hello");
    await sleep(300);
    expect(alive(child), "the listener's process ended").toBe(true);
    expect(await exchange(port, plainHello(), 800)).toContain('"t":"challenge"');
  }, 20_000);

  it("is refused, and the listener lives to answer the next caller (a low-order ephemeral key)", async () => {
    const { child, port } = await startListener(4701);
    expect(await exchange(port, hello({ epk: LOW_ORDER_EPK }) + AUTH)).toContain("bad hello");
    await sleep(300);
    expect(alive(child), "the listener's process ended").toBe(true);
    expect(await exchange(port, plainHello(), 800)).toContain('"t":"challenge"');
  }, 20_000);
});
