// The Machine panel's network section: what the connection is moving, how far
// Claude's API is, and which way the traffic goes.
//
// It was designed the day Claude FM kept going silent for twenty seconds at a
// time on a line measuring 270 Mbit/s: every packet was leaving through a
// Tailscale exit node reached through a relay in Nuremberg. A speed test would
// have said the line was fine. These tests hold the three readings that would
// have said what was actually wrong, and the rules that keep them cheap.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyRoute, parseNetstatE, parseNetstatIbn, parseProcNetDev, rateBetween,
  routeIfaceDarwin, routeIfaceLinux, routeLabel, tailscaleExitFromStatus,
} from "../../server/network-metrics.mjs";
import {
  historySnapshot, probeNetwork, startSystemMetrics, stopSystemMetrics, systemSnapshot,
} from "../../server/system-metrics.mjs";
import { figureText, latencyFigure, rateFigure } from "../net-format";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9000000   1000    0    0    0     0          0         0  9000000   1000    0    0    0     0       0          0
wlp90s0: 5000000   4000    0    0    0     0          0         0  700000   3000    0    0    0     0       0          0
tailscale0: 4800000   3900    0    0    0     0          0         0  650000   2900    0    0    0     0       0          0
enp87s0: 100   2    0    0    0     0          0         0  200   2    0    0    0     0       0          0
`;

describe("reading what the connection moved", () => {
  it("counts only the wires it is told are wires — never loopback, never a tunnel twice", () => {
    const wires = new Set(["wlp90s0", "enp87s0"]);
    expect(parseProcNetDev(PROC_NET_DEV, n => wires.has(n))).toEqual({ rx: 5_000_100, tx: 700_200, ifaces: ["wlp90s0", "enp87s0"] });
    // With no list of wires, everything but loopback — the fallback, not the rule.
    expect(parseProcNetDev(PROC_NET_DEV)?.ifaces).toEqual(["wlp90s0", "tailscale0", "enp87s0"]);
    expect(parseProcNetDev("garbage")).toBeNull();
  });

  it("reads a Mac's Ethernet and Wi-Fi once each, from the end of the row", () => {
    const text = `Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0   16384 <Link#1>                        100     0      2000      100     0      2000     0
en0   1500  <Link#6>    a4:83:e7:00:00:01   5000     0   9000000     4000     0    700000     0
en0   1500  192.168.1     192.168.1.20      5000     -   9000000     4000     -    700000     -
en1   1500  <Link#7>                          10     0      1000        5     0       500     0
utun4 1280  <Link#20>                       300     0     40000      300     0     30000     0`;
    expect(parseNetstatIbn(text)).toEqual({ rx: 9_001_000, tx: 700_500 });
  });

  it("finds Windows' Bytes row by its shape, so a French machine reads too", () => {
    const en = "Interface Statistics\r\n\r\n                   Received       Sent\r\n\r\nBytes            1234567890    987654321\r\nUnicast packets        12345         6789\r\n";
    const fr = "Statistiques de l'interface\r\n\r\n                   Reçus          Envoyés\r\n\r\nOctets           1234567890    987654321\r\n";
    expect(parseNetstatE(en)).toEqual({ rx: 1_234_567_890, tx: 987_654_321 });
    expect(parseNetstatE(fr)).toEqual({ rx: 1_234_567_890, tx: 987_654_321 });
  });

  it("gives a rate only when the two readings can say one", () => {
    expect(rateBetween({ rx: 0, tx: 0, at: 0 }, { rx: 5_000_000, tx: 50_000, at: 5_000 })).toEqual({ down: 1_000_000, up: 10_000 });
    // An adapter reset is not a negative download.
    expect(rateBetween({ rx: 9_000, tx: 9_000, at: 0 }, { rx: 10, tx: 10, at: 5_000 })).toBeNull();
    // Two reads a few milliseconds apart would turn one packet into a spike.
    expect(rateBetween({ rx: 0, tx: 0, at: 0 }, { rx: 1_500, tx: 0, at: 10 })).toBeNull();
    expect(rateBetween(null, { rx: 1, tx: 1, at: 1 })).toBeNull();
  });
});

describe("which way the traffic goes", () => {
  it("reads the interface out of the routing table, policy tables included", () => {
    expect(routeIfaceLinux("160.79.104.10 dev tailscale0 table 52 src 100.106.152.6 uid 1000 \n    cache ")).toBe("tailscale0");
    expect(routeIfaceLinux("1.1.1.1 via 192.168.1.1 dev wlp90s0 src 192.168.1.20 uid 1000")).toBe("wlp90s0");
    expect(routeIfaceDarwin("   route to: 160.79.104.10\ndestination: default\n  interface: utun4\n")).toBe("utun4");
    expect(routeIfaceLinux(null)).toBeNull();
  });

  it("names a path by its interface, and calls the machine's own line direct", () => {
    expect(classifyRoute("wlp90s0")?.kind).toBe("direct");
    expect(classifyRoute("en0")?.kind).toBe("direct");
    expect(classifyRoute("tailscale0")).toEqual({ kind: "tailscale", iface: "tailscale0" });
    expect(classifyRoute("wg0")).toMatchObject({ kind: "vpn", name: "WireGuard" });
    expect(classifyRoute("utun4")).toMatchObject({ kind: "vpn", name: null });
    expect(classifyRoute("")).toBeNull();
  });

  it("names the exit node, and the relay only when the path goes through one", () => {
    const relayed = { ExitNodeStatus: { ID: "n", Online: true }, Peer: { a: { HostName: "Constantin’s iMac", ExitNode: true, CurAddr: "", Relay: "nue" } } };
    const direct = { ExitNodeStatus: { ID: "n", Online: true }, Peer: { a: { HostName: "office-box", ExitNode: true, CurAddr: "203.0.113.4:41641", Relay: "fra" } } };
    expect(tailscaleExitFromStatus(JSON.stringify(relayed))).toEqual({ node: "Constantin’s iMac", relay: "nue" });
    expect(tailscaleExitFromStatus(direct)).toEqual({ node: "office-box", relay: null });
    expect(tailscaleExitFromStatus({ Peer: {} })).toBeNull();
    expect(tailscaleExitFromStatus("not json")).toBeNull();
  });

  it("says one sentence for a route, the same everywhere it is shown", () => {
    expect(routeLabel({ kind: "tailscale-exit", node: "Constantin’s iMac", relay: "nue" }))
      .toBe("through Tailscale exit node Constantin’s iMac, relayed via nue");
    expect(routeLabel({ kind: "vpn", name: "WireGuard", iface: "wg0" })).toBe("through WireGuard VPN (wg0)");
    expect(routeLabel({ kind: "direct" })).toBe("direct");
  });
});

describe("writing a speed and a round trip", () => {
  it("uses the unit a person would, and changes unit on the rounded figure", () => {
    expect(rateFigure(0)).toEqual({ value: "0", unit: "KB/s" });
    expect(rateFigure(49)).toEqual({ value: "0", unit: "KB/s" });
    expect(rateFigure(4_200)).toEqual({ value: "4.2", unit: "KB/s" });
    expect(rateFigure(245_000)).toEqual({ value: "245", unit: "KB/s" });
    // Never "1000 KB/s".
    expect(rateFigure(999_600)).toEqual({ value: "1.0", unit: "MB/s" });
    expect(rateFigure(12_400_000)).toEqual({ value: "12", unit: "MB/s" });
    expect(rateFigure(2_500_000_000)).toEqual({ value: "2.5", unit: "GB/s" });
    expect(latencyFigure(92.4)).toEqual({ value: "92", unit: "ms" });
    expect(latencyFigure(1_250)).toEqual({ value: "1.3", unit: "s" });
    expect(figureText({ value: "84", unit: "%" })).toBe("84%");
    expect(figureText({ value: "1.2", unit: "MB/s" })).toBe("1.2 MB/s");
  });
});

describe("reaching out only when asked", () => {
  afterEach(() => stopSystemMetrics());

  const fakes = (over: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        force: true,
        platform: "linux",
        hasClaude: () => true,
        lookup: async () => { calls.push("lookup"); return { address: "160.79.104.10" }; },
        connect: async () => { calls.push("connect"); return 92; },
        run: async (file: string) => {
          calls.push(file);
          if (file === "ip") return "160.79.104.10 dev tailscale0 table 52 src 100.106.152.6 uid 1000";
          if (file === "tailscale") return JSON.stringify({ ExitNodeStatus: {}, Peer: { a: { HostName: "Constantin’s iMac", ExitNode: true, CurAddr: "", Relay: "nue" } } });
          return null;
        },
        ...over,
      },
    };
  };

  it("contacts nothing unless the server gave it permission", async () => {
    startSystemMetrics();
    const { calls, deps } = fakes();
    await probeNetwork({ ...deps, force: false });
    systemSnapshot();
    await probeNetwork({ ...deps, force: false });
    expect(calls).toEqual([]);
    const idx = read("../../server/index.mjs");
    expect(idx.match(/startSystemMetrics\(\{ probe: true \}\)/g)).toHaveLength(1);
  });

  it("times the API, reads the route, and puts both in the panel and the history", async () => {
    startSystemMetrics();
    const { calls, deps } = fakes();
    await probeNetwork(deps);
    expect(calls).toEqual(["lookup", "connect", "ip", "tailscale"]);
    const net = systemSnapshot().network;
    expect(net?.api).toEqual({ host: "api.anthropic.com", ms: 92 });
    expect(net?.route).toMatchObject({ kind: "tailscale-exit", node: "Constantin’s iMac", relay: "nue", to: "claude" });
    const hist = historySnapshot("network").series;
    const api = hist.find((s: { key: string }) => s.key === "net:api");
    // 92 ms with 15% headroom is ~106, and the scale rounds up to the next
    // 1-2-5 step a person would choose.
    expect(api).toMatchObject({ unit: "ms", label: "Claude API latency", top: 200 });
    // The first route seen is where looking began (`from` null), not a change.
    expect(api.changes).toEqual([{ t: expect.any(Number), label: "through Tailscale exit node Constantin’s iMac, relayed via nue", from: null }]);
  });

  it("says the API did not answer rather than printing a number it has not measured", async () => {
    startSystemMetrics();
    const { deps } = fakes({ connect: async () => null });
    await probeNetwork(deps);
    expect(systemSnapshot().network?.api).toEqual({ host: "api.anthropic.com", ms: null });
  });

  it("never runs two at once, however many polls arrive", async () => {
    startSystemMetrics();
    let resolve!: (v: number) => void;
    const { calls, deps } = fakes({ connect: () => new Promise<number>(r => { calls.push("connect"); resolve = r; }) });
    const first = probeNetwork(deps);
    await probeNetwork(deps);
    await probeNetwork(deps);
    resolve(80);
    await first;
    expect(calls.filter(c => c === "connect")).toHaveLength(1);
  });

  it("leaves the route out on a direct line, and skips the API on a machine without Claude Code", async () => {
    startSystemMetrics();
    const { calls, deps } = fakes({
      hasClaude: () => false,
      run: async (file: string) => { calls.push(file); return file === "ip" ? "1.1.1.1 via 192.168.1.1 dev wlp90s0" : null; },
    });
    await probeNetwork(deps);
    expect(calls).toEqual(["ip"]);
    const net = systemSnapshot().network;
    expect(net?.api ?? null).toBeNull();
    expect(net?.route ?? null).toBeNull();
  });

  it("forgets the lot when stopped", async () => {
    startSystemMetrics();
    await probeNetwork(fakes().deps);
    stopSystemMetrics();
    expect(systemSnapshot().network).toBeNull();
    expect(historySnapshot("network").series).toEqual([]);
  });
});

describe("the panel gives it a section of its own", () => {
  const panel = read("../components/MachinePanel.tsx");
  const css = read("../styles.css");

  // It shared a line with Load average for one release, two half-width columns
  // of three figures each. They are not one glance: a load average is a
  // statement about the CPU's queue and belongs against the core strip, and
  // pairing them put "how busy is the machine" and "how busy is its line" in
  // one visual sentence. Network stands alone now and Load average sits inside
  // the CPU block, so neither is read as a half of the other.
  it("stands on its own, with no half-width column left behind", () => {
    expect(panel).toContain('<div className="sd-section" role="group" aria-label="Network">');
    expect(panel).not.toContain("sd-pair");
    expect(css).not.toContain(".sd-pair");
  });

  it("opens its own history, named like every other section", () => {
    expect(panel).toContain('<OpensHistory group="network" title="Network history" action="Show network history" label="Network">');
  });

  // THREE FIGURES, THREE MEASUREMENTS: down and up are this machine's own
  // interface counters, the latency is one TCP handshake with one host. So each
  // column is NAMED — the name on top, the value and its unit under it — rather
  // than captioned "KB/s down", which put the unit where the name belongs and
  // left three readings looking like one connection measured three ways.
  it("names each column for what it measures", () => {
    expect(panel).toContain('<Fig key={name} value={f.value} unit={f.unit} cap={name} />');
    expect(panel).toContain('<Fig value={latency.value} unit={latency.unit} cap="Claude API" />');
    expect(panel).toContain('[["Download", down!], ["Upload", up!]]');
    // The unit belongs to the figure, a tier down from it, and never to the
    // label above.
    expect(css).toMatch(/\.sd-fig-unit \{ color: var\(--muted\); font-size: 10px; \}/);
  });

  // The sentence — "Traffic to Claude goes through Tailscale exit node …" — was
  // two lines under the figures on every poll of every session. It is behind
  // one press now, and only when there is a path to disclose: the server
  // reports no route at all on a direct line.
  it("puts the path behind a press, and keeps the relay on the surface", () => {
    expect(panel).toContain("{route && (");
    expect(panel).toContain('className="sd-detail"');
    expect(panel).toContain('anchorId="sd-conn"');
    expect(panel).toContain('boundaryId="system-panel"');
    expect(panel).toContain('<span className="sd-route-relay"> · relayed</span>');
    expect(css).toMatch(/\.sd-route-relay \{ color: var\(--warn\); \}/);
  });

  // A connection that cannot be asked is the one network state that is a fault
  // rather than a figure, so it never moves inside the disclosure.
  it("says an unreachable API in the panel itself", () => {
    expect(panel).toContain('<div className="sd-note sd-note-warn">Can’t reach Claude</div>');
  });
});
