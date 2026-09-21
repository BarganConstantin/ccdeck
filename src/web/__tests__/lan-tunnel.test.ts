// A beacon for the local network stays on it.
//
// A laptop using a Tailscale exit node without local network access, or any
// VPN that takes the local network too, routes even a broadcast for its own
// Wi-Fi into the tunnel, and it comes out on the far end — on an office LAN,
// where a colleague could see the name of a machine that is nothing to do with
// them. The machine is asked which interface each broadcast would leave by,
// and a beacon that would leave through a tunnel does not leave.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import { broadcastPlan, createBeacon, leavesByTunnel } from "../../server/lan-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { fingerprint } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createRouteCheck, looksLikeTunnel, lookupRoutes, viaFromFindNetRoute, viaFromIpRoute, viaFromRouteGet } from "../../server/route-via.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { readTailnet } from "../../server/tailscale.mjs";
import { tunnelNote } from "../components/LanSyncSection";

const WIFI = { en1: [{ address: "192.168.1.82", netmask: "255.255.255.0", family: "IPv4", internal: false }] };

describe("reading where the machine would send a packet", () => {
  it("reads macOS route get, Linux ip route get, and Windows Find-NetRoute", () => {
    // Measured on this Mac.
    expect(viaFromRouteGet("   route to: 192.168.1.255\ndestination: 192.168.1.255\n  interface: en1\n      flags: <UP,HOST,DONE,LLINFO,WASCLONED,BROADCAST,IFSCOPE>")).toBe("en1");
    expect(viaFromIpRoute("broadcast 192.168.1.255 dev wlan0 table local src 192.168.1.20 uid 1000 \\    cache <local,brd>")).toBe("wlan0");
    expect(viaFromIpRoute("192.168.1.255 dev tailscale0 table 52 src 100.101.1.2 uid 1000")).toBe("tailscale0");
    // Measured on the Windows box.
    expect([...viaFromFindNetRoute("255.255.255.255|Ethernet\r\n192.168.88.255|Ethernet\r\n10.9.9.255|\r\n")]).toEqual([
      ["255.255.255.255", "Ethernet"], ["192.168.88.255", "Ethernet"],
    ]);
  });

  it("knows a tunnel by the names tunnels go by, and a network by the rest", () => {
    for (const t of ["utun4", "tailscale0", "Tailscale", "wg0", "tun0", "ppp0", "NordLynx", "OpenVPN Data Channel Offload"]) expect(looksLikeTunnel(t), t).toBe(true);
    for (const n of ["en0", "en1", "eth0", "wlan0", "Ethernet", "Wi-Fi", "bridge100", null]) expect(looksLikeTunnel(n), String(n)).toBe(false);
  });

  it("asks each platform its own way, and one PowerShell for all of Windows", async () => {
    const calls: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.at(-1)}`.slice(0, 40));
      if (cmd === "route") return { ok: true, stdout: "  interface: en1\n" };
      if (cmd === "ip") return { ok: true, stdout: "broadcast 192.168.1.255 dev eth0 table local" };
      return { ok: true, stdout: "255.255.255.255|Ethernet\r\n192.168.1.255|Ethernet\r\n" };
    };
    const targets = ["255.255.255.255", "192.168.1.255", "not an address"];
    expect([...(await lookupRoutes(targets, { platform: "darwin", run })).values()]).toEqual(["en1", "en1"]);
    expect([...(await lookupRoutes(targets, { platform: "linux", run })).values()]).toEqual(["eth0", "eth0"]);
    expect([...(await lookupRoutes(targets, { platform: "win32", run })).values()]).toEqual(["Ethernet", "Ethernet"]);
    expect(calls.filter(c => c.startsWith("powershell"))).toHaveLength(1);
  });

  it("keeps each answer for a while, and never runs two lookups at once", async () => {
    let lookups = 0;
    let t = 0;
    const run = async () => { lookups++; return { ok: true, stdout: "  interface: en1\n" }; };
    const r = createRouteCheck({ platform: "darwin", run, now: () => t, ttlMs: 1_000 });
    expect(r.via("192.168.1.255")).toBeUndefined();
    await Promise.all([r.want(["192.168.1.255"]), r.want(["192.168.1.255"])]);
    expect(lookups).toBe(1);
    expect(r.via("192.168.1.255")).toBe("en1");
    await r.want(["192.168.1.255"]);
    expect(lookups).toBe(1);
    t = 2_000;
    await r.want(["192.168.1.255"]);
    expect(lookups).toBe(2);
  });
});

describe("which broadcasts stay home", () => {
  it("holds a directed broadcast back when it would leave by another interface than its own", () => {
    const [limited, wifi] = broadcastPlan(WIFI);
    expect(wifi).toEqual({ to: "192.168.1.255", iface: "en1" });
    expect(leavesByTunnel(wifi, "en1", looksLikeTunnel)).toBe(false);
    expect(leavesByTunnel(wifi, "utun4", looksLikeTunnel)).toBe(true);
    // The limited broadcast is nobody's, so only a tunnel holds it back.
    expect(leavesByTunnel(limited, "en1", looksLikeTunnel)).toBe(false);
    expect(leavesByTunnel(limited, "utun4", looksLikeTunnel)).toBe(true);
    // Unknown is not a reason to go quiet.
    expect(leavesByTunnel(wifi, undefined, looksLikeTunnel)).toBe(false);
  });

  it("sends nothing onto the local network while it all goes through a tunnel, and says so", async () => {
    const sent: string[] = [];
    let route = "utun4";
    const sock = {
      on() { /* nothing */ }, bind(_p: number, _h: string, cb: () => void) { cb(); }, setBroadcast() { /* nothing */ },
      send(_m: unknown, _p: number, to: string, cb?: (e: Error | null) => void) { sent.push(to); cb?.(null); }, close() { /* nothing */ },
    };
    const b = createBeacon({
      port: 51_234, name: "Laptop", fp: fingerprint(randomBytes(32)), ifaces: () => WIFI,
      createSocket: () => sock,
      routes: { via: () => route, want: async () => {} },
      // The owner's machines over Tailscale are reached THROUGH the tunnel on
      // purpose, and are never held back.
      unicast: () => ["100.101.1.2"],
    });
    await b.start();
    expect(sent).toEqual(["100.101.1.2"]);
    expect(b.tunneled()).toBe(true);
    sent.length = 0;
    route = "en1";
    b.announce();
    expect(sent).toEqual(["255.255.255.255", "192.168.1.255", "100.101.1.2"]);
    expect(b.tunneled()).toBe(false);
    b.stop();
  });
});

describe("what the panel says about it", () => {
  it("names Tailscale's own setting when an exit node is the tunnel", () => {
    const t = readTailnet({ BackendState: "Running", Self: { UserID: 1 }, ExitNodeStatus: { ID: "n1", Online: true } });
    expect(t.exitNode).toBe(true);
    expect(readTailnet({ BackendState: "Running", Self: { UserID: 1 } }).exitNode).toBe(false);
    expect(tunnelNote({ tailscale: { exitNode: true } as never })).toMatch(/Tailscale sends this machine's local network through an exit node.*Allow local network access/);
    expect(tunnelNote({ tailscale: null })).toMatch(/through a VPN/);
  });
});
