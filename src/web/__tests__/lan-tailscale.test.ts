// Discovery over Tailscale: reading the tailnet, reaching the owner's own
// machines on it, and answering only for those.
//
// NO TAILNET IS NEEDED TO RUN THIS. The reader is driven with a fake `run` and
// status documents shaped like the ones measured on macOS 1.102.2 and Windows
// 1.102.3, and the engine cases stand loopback in for a tailnet address: a
// fake reader lists 127.0.0.1 as one of the owner's machines, so two real
// engines on this host take exactly the path two decks on a real tailnet take —
// a beacon from a tailnet address, a handshake, a pairing nobody pressed for.
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import { beaconTargets, cliEnv, createTailnet, readTailnet, routeOf, tailscaleCandidates } from "../../server/tailscale.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createBeacon, DISCOVERY_PORT } from "../../server/lan-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey, fingerprint, hostId, identityFrom, notePeer, PRESENT_MS, PROTOCOL } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createEngine } from "../../server/lan-engine.mjs";
import { tailscaleNote } from "../components/LanSetupModal";

// ── the status document ─────────────────────────────────────────────────────

/** A `tailscale status --json`, trimmed to the fields the reader looks at and
 *  shaped like the real one: peers keyed by node key, omitted-when-false flags
 *  left out rather than set false. */
function status(over: Record<string, unknown> = {}, peers: Record<string, unknown>[] = []) {
  return {
    Version: "1.102.2",
    BackendState: "Running",
    TailscaleIPs: ["100.101.1.1", "fd7a:115c:a1e0::1"],
    Self: { ID: "self", HostName: "Mac", DNSName: "mac.tail1234.ts.net.", OS: "macOS", UserID: 11, TailscaleIPs: ["100.101.1.1", "fd7a:115c:a1e0::1"] },
    User: { 11: { ID: 11, LoginName: "owner@example.com" }, 22: { ID: 22, LoginName: "colleague@example.com" } },
    CurrentTailnet: { Name: "owner@example.com", MagicDNSSuffix: "tail1234.ts.net" },
    Peer: Object.fromEntries(peers.map((p, i) => [`nodekey:${i}`, p])),
    ...over,
  };
}

const node = (name: string, ip: string, over: Record<string, unknown> = {}) => ({
  ID: `n-${name}`, HostName: name, DNSName: `${name.toLowerCase()}.tail1234.ts.net.`, OS: "windows",
  UserID: 11, TailscaleIPs: [ip, "fd7a:115c:a1e0::9"], Online: true, ...over,
});

describe("where the Tailscale CLI is", () => {
  it("tries the app bundle first on macOS, where launchd's PATH has none of it", () => {
    const mac = tailscaleCandidates("darwin", {});
    expect(mac[0]).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    expect(mac).toContain("/opt/homebrew/bin/tailscale");
    expect(mac.at(-1)).toBe("tailscale");
  });

  it("builds the Windows path with Windows separators, from any machine", () => {
    const win = tailscaleCandidates("win32", { ProgramFiles: "D:\\Apps" });
    expect(win[0]).toBe("D:\\Apps\\Tailscale\\tailscale.exe");
    expect(win).toContain("C:\\Program Files\\Tailscale\\tailscale.exe");
    for (const c of win) expect(c).not.toContain("/");
    for (const c of tailscaleCandidates("linux", {})) expect(c).not.toContain("\\");
  });

  it("runs the macOS binary as the CLI rather than as the app", () => {
    // With no TERM it prints "The Tailscale GUI failed to start" and exits 0.
    expect(cliEnv({})).toMatchObject({ TAILSCALE_BE_CLI: "1", TERM: "dumb" });
    expect(cliEnv({ TERM: "xterm-256color", HOME: "/h" })).toMatchObject({ TERM: "xterm-256color", HOME: "/h" });
  });
});

describe("reading the tailnet", () => {
  it("counts a node as the owner's only when it is the same user, untagged and not shared in", () => {
    const t = readTailnet(JSON.stringify(status({}, [
      node("PC", "100.101.1.2"),
      node("Colleague", "100.101.1.3", { UserID: 22 }),
      node("Server", "100.101.1.4", { Tags: ["tag:server"] }),
      node("Shared", "100.101.1.5", { ShareeNode: true }),
    ])));
    expect(t.running).toBe(true);
    expect(t.self).toMatchObject({ login: "owner@example.com", ips: ["100.101.1.1"], tagged: false });
    expect(t.peers.map((p: { name: string; own: boolean }) => [p.name, p.own])).toEqual([
      ["pc", true], ["colleague", false], ["server", false], ["shared", false],
    ]);
  });

  it("owns nothing on a machine that joined with a tag", () => {
    // A tagged machine's user is the shared tagged-devices identity, so "same
    // user" would be true of every tagged node on the tailnet.
    const t = readTailnet(status({ Self: { UserID: 11, Tags: ["tag:ci"], TailscaleIPs: ["100.101.1.1"] } }, [node("PC", "100.101.1.2")]));
    expect(t.peers[0].own).toBe(false);
    expect(beaconTargets(t)).toEqual([]);
  });

  it("says stopped rather than running when the backend is stopped, whatever the exit code", () => {
    const t = readTailnet(status({ BackendState: "Stopped" }, [node("PC", "100.101.1.2")]));
    expect(t.running).toBe(false);
    expect(beaconTargets(t)).toEqual([]);
  });

  it("is nothing at all for output that is not a status document", () => {
    expect(readTailnet("The Tailscale GUI failed to start: (Tailscale.CLIError error 3.)")).toBeNull();
    expect(readTailnet("")).toBeNull();
    expect(readTailnet(JSON.stringify({ Peer: {} }))).toBeNull();
  });
});

describe("where a beacon goes on the tailnet", () => {
  it("goes to the owner's online computers only, one IPv4 address each", () => {
    const t = readTailnet(status({}, [
      node("PC", "100.101.1.2"),
      node("Laptop", "100.101.1.3", { OS: "macOS" }),
      node("Asleep", "100.101.1.4", { Online: false }),
      node("Phone", "100.101.1.5", { OS: "iOS" }),
      node("Expired", "100.101.1.6", { Expired: true }),
      node("Colleague", "100.101.1.7", { UserID: 22 }),
      node("Box", "100.101.1.8", { OS: "linux" }),
    ]));
    expect(beaconTargets(t)).toEqual(["100.101.1.2", "100.101.1.3", "100.101.1.8"]);
  });

  it("tells a tailnet address from a local one, and whose it is", () => {
    const t = readTailnet(status({}, [node("PC", "100.101.1.2"), node("Colleague", "100.101.1.3", { UserID: 22 })]));
    expect(routeOf(t, "100.101.1.2")).toMatchObject({ via: "tailscale", own: true, name: "pc" });
    expect(routeOf(t, "::ffff:100.101.1.2")).toMatchObject({ via: "tailscale", own: true });
    expect(routeOf(t, "100.101.1.3")).toMatchObject({ via: "tailscale", own: false });
    // Joined since the last read: a tailnet address, and nobody's own yet.
    expect(routeOf(t, "100.90.0.9")).toMatchObject({ via: "tailscale", own: false });
    expect(routeOf(t, "192.168.1.20")).toBeNull();
    // 100.128/9 is outside Tailscale's block.
    expect(routeOf(t, "100.128.0.1")).toBeNull();
    // Not on a tailnet at all: everything is the local network, as before.
    expect(routeOf(null, "100.101.1.2")).toBeNull();
    expect(routeOf({ ...t, running: false }, "100.101.1.2")).toBeNull();
  });
});

describe("the reader", () => {
  const ok = (doc: unknown) => ({ ok: true, code: 0, stdout: JSON.stringify(doc), stderr: "" });
  const missing = { ok: false, code: "ENOENT", stdout: "", stderr: "" };

  it("walks the candidates until one answers, and keeps that one", async () => {
    const calls: string[] = [];
    let env: Record<string, string> = {};
    const run = async (file: string, _args: string[], opts: { env: Record<string, string> }) => {
      calls.push(file);
      env = opts.env;
      return file === "/usr/local/bin/tailscale" ? ok(status({}, [node("PC", "100.101.1.2")])) : missing;
    };
    const r = createTailnet({ run, platform: "darwin", env: {}, exists: () => true });
    await r.refresh();
    expect(r.found()).toBe(true);
    expect(beaconTargets(r.snapshot())).toEqual(["100.101.1.2"]);
    expect(calls).toEqual([
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale",
    ]);
    expect(env.TAILSCALE_BE_CLI).toBe("1");
    calls.length = 0;
    await r.refresh();
    expect(calls).toEqual(["/usr/local/bin/tailscale"]);
  });

  it("skips an absolute path that is not there without spawning it", async () => {
    const calls: string[] = [];
    const run = async (file: string) => { calls.push(file); return missing; };
    const r = createTailnet({ run, platform: "darwin", env: {}, exists: () => false });
    await r.refresh();
    expect(calls).toEqual(["tailscale"]);
    expect(r.found()).toBe(false);
    expect(r.snapshot()).toBeNull();
  });

  it("is found with no tailnet when the CLI runs and says nothing readable", async () => {
    const run = async () => ({ ok: true, code: 0, stdout: "The Tailscale GUI failed to start", stderr: "" });
    const r = createTailnet({ run, platform: "linux", env: {}, exists: () => true });
    await r.refresh();
    expect(r.found()).toBe(true);
    expect(r.snapshot()).toBeNull();
  });

  it("reads again only when the last read is older than asked", async () => {
    let n = 0;
    let t = 1_000;
    const run = async () => { n++; return ok(status()); };
    const r = createTailnet({ run, platform: "linux", env: {}, exists: () => true, now: () => t });
    await r.freshen(60_000);
    await r.freshen(60_000);
    expect(n).toBe(1);
    t += 61_000;
    await r.freshen(60_000);
    expect(n).toBe(2);
  });
});

// ── the beacon ──────────────────────────────────────────────────────────────

function fakeSocket() {
  const sent: Array<{ port: number; addr: string }> = [];
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    sent,
    deliver(msg: Buffer, address: string) { handlers.get("message")?.(msg, { address }); },
    on(ev: string, fn: (...args: unknown[]) => void) { handlers.set(ev, fn); },
    bind(_port: number, _host: string, cb: () => void) { cb(); },
    setBroadcast() { /* nothing */ },
    send(_msg: Buffer, port: number, addr: string, cb?: (e: Error | null) => void) { sent.push({ port, addr }); cb?.(null); },
    close() { /* nothing */ },
  };
}

const packet = (name: string) => Buffer.from(JSON.stringify({
  m: "CCDK", v: PROTOCOL, n: name, f: fingerprint(randomBytes(32)), p: 50_000,
  i: "00".repeat(8), h: hostId({ hostname: `host-${name}`, home: "/home/x" }),
}));

describe("a beacon on a tailnet", () => {
  it("is sent to each tailnet machine as well as to the broadcast", async () => {
    const sock = fakeSocket();
    const b = createBeacon({
      port: 51_234, name: "Mac", fp: fingerprint(randomBytes(32)), createSocket: () => sock, ifaces: () => ({}),
      unicast: () => ["100.101.1.2", "100.101.1.3"],
    });
    await b.start();
    expect(sock.sent.map(s => s.addr)).toEqual(["255.255.255.255", "100.101.1.2", "100.101.1.3"]);
    expect(sock.sent.every(s => s.port === DISCOVERY_PORT)).toBe(true);
    b.stop();
  });

  it("ignores a packet its route says to ignore, and says which route the rest came by", async () => {
    const sock = fakeSocket();
    const strangers: Array<{ via: string }> = [];
    const b = createBeacon({
      port: 51_234, name: "Mac", fp: fingerprint(randomBytes(32)), createSocket: () => sock, ifaces: () => ({}),
      onStranger: (e: { via: string }) => strangers.push(e),
      routeFor: (addr: string) => (addr.startsWith("100.") ? (addr === "100.101.1.2" ? "tailscale" : null) : "lan"),
    });
    await b.start();
    sock.deliver(packet("Office"), "192.168.1.9");
    sock.deliver(packet("Home"), "100.101.1.2");
    sock.deliver(packet("Off"), "100.101.1.3");
    expect(strangers.map(s => s.via)).toEqual(["lan", "tailscale"]);
    b.stop();
  });

  it("answers a deck that found it over the tailnet down the tailnet", async () => {
    // A broadcast never gets back down a tunnel, so the "I am here too" reply
    // to a new deck has to go to its address.
    const sock = fakeSocket();
    const b = createBeacon({
      port: 51_234, name: "Mac", fp: fingerprint(randomBytes(32)), createSocket: () => sock, ifaces: () => ({}),
      routeFor: () => "tailscale",
    });
    await b.start();
    sock.sent.length = 0;
    sock.deliver(packet("Home"), "100.101.1.2");
    expect(sock.sent.map(s => s.addr)).toEqual(["255.255.255.255", "100.101.1.2"]);
    b.stop();
  });
});

describe("one machine heard by two routes", () => {
  const beacon = { fp: "abc-def-012-345", name: "Laptop", port: 50_000, instance: "i1", host: "h" };

  it("keeps the local address while the local network still hears it", () => {
    const peers = new Map();
    notePeer(peers, beacon, "192.168.1.9", 1_000, "lan");
    const over = notePeer(peers, beacon, "100.101.1.2", 2_000, "tailscale");
    expect(over.changed).toBe(false);
    expect(peers.get(beacon.fp)).toMatchObject({ addr: "192.168.1.9", via: "lan", lastSeen: 2_000 });
  });

  it("moves to the tailnet once the local network has gone quiet", () => {
    const peers = new Map();
    notePeer(peers, beacon, "192.168.1.9", 1_000, "lan");
    const moved = notePeer(peers, beacon, "100.101.1.2", 1_000 + PRESENT_MS + 1, "tailscale");
    expect(moved.changed).toBe(true);
    expect(peers.get(beacon.fp)).toMatchObject({ addr: "100.101.1.2", via: "tailscale" });
    // And back the moment it is heard at the office again.
    notePeer(peers, beacon, "192.168.1.9", 1_000 + PRESENT_MS + 2, "lan");
    expect(peers.get(beacon.fp)).toMatchObject({ addr: "192.168.1.9", via: "lan" });
  });
});

// ── two engines, loopback standing in for the tailnet ───────────────────────

interface Row { num: number; email: string; orgUuid: string; alive: boolean }
const K = (email: string, org: string) => accountKey(email, org);

function store(rows: Row[]) {
  const imported: string[] = [];
  return {
    imported,
    deps: {
      readAccounts: async () => ({ accounts: rows }),
      exportAccount: async (num: number) => `ccdeck2:slot-${num}`,
      importAccount: async (blob: string) => { imported.push(blob); return true; },
    },
  };
}

/** A reader whose tailnet holds 127.0.0.1 — the other engine — as a machine
 *  of the owner's, or of somebody else's. */
function loopbackTailnet(own: boolean) {
  const t = {
    state: "Running", running: true,
    self: { name: "me", ips: ["100.101.1.1"], login: "owner@example.com", tagged: false },
    peers: [{ name: "other", os: "macOS", ips: ["127.0.0.1"], online: true, expired: false, own }],
  };
  return { snapshot: () => t, refresh: async () => {}, freshen: async () => {}, found: () => true };
}

function deafSocket() {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  return {
    on(ev: string, fn: (...a: unknown[]) => void) { handlers.set(ev, fn); },
    bind(_p: number, _h: string, cb: () => void) { cb(); },
    setBroadcast() { /* nothing */ },
    send(_m: unknown, _p: number, _a: string, cb?: (e: Error | null) => void) { cb?.(null); },
    close() { /* nothing */ },
    deliver(msg: Buffer, from: string) { handlers.get("message")?.(msg, { address: from }); },
  };
}

const running: Array<{ stop: () => void }> = [];
afterEach(() => { for (const e of running.splice(0)) e.stop(); });

async function deck(rows: Row[], name: string, shared: string[], tailnet: unknown, on: Record<string, unknown>) {
  const s = store(rows);
  const id = identityFrom("");
  const trusted: unknown[] = [];
  const sock = deafSocket();
  const e = createEngine({
    ...s.deps, tailnet, host: "127.0.0.1",
    createSocket: () => sock,
    onTrust: (list: unknown[]) => { trusted.splice(0, trusted.length, ...list); },
  });
  running.push(e);
  await e.apply({ enabled: true, name, secret: id.secret, shared, trusted, autoAsk: false, autoAccept: false, ...on });
  return { e, s, id, sock };
}

/** One beacon from `from`, arriving at `to` from 127.0.0.1. */
const announce = (to: { sock: ReturnType<typeof deafSocket> }, from: { e: { status: () => { fp: string; port: number } } }, name: string) =>
  to.sock.deliver(Buffer.from(JSON.stringify({
    m: "CCDK", v: PROTOCOL, n: name, f: from.e.status().fp, p: from.e.status().port,
    i: "00".repeat(8), h: hostId({ hostname: `host-${name}`, home: "/home/x" }),
  })), "127.0.0.1");

const TS_ON = { tailscale: true, tailscaleAsk: true, tailscaleAccept: true };

describe("the owner's own machines over Tailscale", () => {
  it("pair and heal with nobody pressing anything", async () => {
    const acct = K("claude1@example.com", "org-1");
    const a = await deck([{ num: 3, email: "claude1@example.com", orgUuid: "org-1", alive: true }], "Home", [acct], loopbackTailnet(true), TS_ON);
    const b = await deck([{ num: 1, email: "claude1@example.com", orgUuid: "org-1", alive: false }], "Office", [acct], loopbackTailnet(true), TS_ON);

    announce(b, a, "Home");
    // B asked A on its own; A said yes for its owner; B, reaching a deck it
    // raised a request for, says yes for its owner; then the heal.
    await b.e.round();
    await b.e.round();
    const healed = await b.e.round();
    expect(a.e.status().trusted).toMatchObject([{ fp: b.id.fp }]);
    expect(b.e.status().trusted).toMatchObject([{ fp: a.id.fp }]);
    expect(healed).toMatchObject([{ key: acct, action: "heal", ok: true }]);
    expect(b.s.imported).toEqual(["ccdeck2:slot-3"]);
    const row = (b.e.status().peers as Array<{ via: string }>)[0];
    expect(row.via).toBe("tailscale");
  }, 20_000);

  it("reports the tailnet it sees", async () => {
    const a = await deck([], "Home", [], loopbackTailnet(true), TS_ON);
    expect(a.e.status().tailscale).toMatchObject({
      found: true, running: true, on: true, ask: true, accept: true,
      login: "owner@example.com", addr: "100.101.1.1", devices: 1,
    });
  });
});

describe("anybody else on the tailnet", () => {
  it("is listed and never asked or accepted unprompted", async () => {
    const a = await deck([], "Colleague", [], null, { autoAsk: false, autoAccept: false });
    // Both Tailscale switches on, and the local pair too: none of them answers
    // for a node that is not on this person's own account.
    const b = await deck([], "Mine", [], loopbackTailnet(false), { ...TS_ON, autoAsk: true, autoAccept: true });
    announce(b, a, "Colleague");
    expect(b.e.status().strangers).toMatchObject([{ fp: a.id.fp, via: "tailscale", own: false }]);
    expect(b.e.status().peers).toEqual([]);

    // And when it dials in, it waits for a press.
    a.e.addPeer("127.0.0.1", b.e.status().port);
    await a.e.round();
    expect(b.e.status().pending).toMatchObject([{ fp: a.id.fp, via: "tailscale", own: false }]);
    expect(b.e.status().trusted).toEqual([]);
  }, 20_000);
});

describe("with the Tailscale switch off", () => {
  it("does not act on a tailnet beacon, and the local switches do not answer for the tailnet", async () => {
    const a = await deck([], "Home", [], null, {});
    const b = await deck([], "Office", [], loopbackTailnet(true), { autoAsk: true, autoAccept: true });
    announce(b, a, "Home");
    expect(b.e.status().strangers).toEqual([]);
    expect(b.e.status().peers).toEqual([]);

    a.e.addPeer("127.0.0.1", b.e.status().port);
    await a.e.round();
    expect(b.e.status().pending).toMatchObject([{ fp: a.id.fp, via: "tailscale", own: true }]);
    expect(b.e.status().trusted).toEqual([]);

    // Turning it on answers the owner's own machine that is already waiting.
    await b.e.apply(TS_ON);
    expect(b.e.status().trusted).toMatchObject([{ fp: a.id.fp }]);
  }, 20_000);
});

describe("the line under the switches", () => {
  const base = { found: true, state: "Running", running: true, on: false, ask: true, accept: true, login: "owner@example.com", addr: "100.101.1.1", devices: 2 };
  it("names the account whose machines count", () => {
    expect(tailscaleNote(base)).toMatch(/signed in to owner@example\.com/);
    expect(tailscaleNote({ ...base, on: true })).toMatch(/^2 of your devices are online, signed in to owner@example\.com\./);
    expect(tailscaleNote({ ...base, on: true, devices: 1 })).toMatch(/^1 of your devices is online,/);
  });
  it("says why nothing is found while Tailscale is not connected", () => {
    expect(tailscaleNote({ ...base, running: false, state: "Stopped" })).toMatch(/turned off/);
    expect(tailscaleNote({ ...base, running: false, state: "NeedsLogin" })).toMatch(/signed out/);
  });
});
