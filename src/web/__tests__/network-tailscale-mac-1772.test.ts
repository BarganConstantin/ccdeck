// A Tailscale exit node on a Mac read as "through a VPN (utun4)" (#1772).
//
// On macOS the tunnel is a `utun` like every other VPN there, so the network
// section asks Tailscale's CLI whether an exit node is carrying the traffic.
// It asked a bare `tailscale` from PATH. The Mac app ships its CLI inside the
// bundle and puts nothing on PATH unless the owner pressed "Install CLI", a
// deck started from Finder or at login has launchd's PATH anyway, and the
// bundle binary is also the GUI: without TAILSCALE_BE_CLI it prints "The
// Tailscale GUI failed to start" and exits 0. tailscale.mjs had already solved
// all three for the LAN code — tailscaleCandidates() and cliEnv() — and the
// sampler used neither. So the diagnosis the section exists to give, which exit
// node and whether it is relayed, never appeared on the platform it was most
// likely to be needed on.
//
// Run through probeNetwork's own seam: the commands are a fake that answers
// the way a Mac with only the app installed does, and nothing is spawned.
import { describe, it, expect, afterEach } from "vitest";

// @ts-expect-error — plain .mjs server module, no types
import { networkSnapshot, probeNetwork, stopNetwork } from "../../server/network-sampler.mjs";

const BUNDLE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const STATUS = JSON.stringify({
  BackendState: "Running",
  ExitNodeStatus: { ID: "n1", Online: true },
  Peer: { a: { HostName: "office-box", ExitNode: true, CurAddr: "", Relay: "fra" } },
});

afterEach(() => stopNetwork());

/** A Mac with the App Store build and nothing on PATH: `route` answers, the
 *  bundle binary answers only when it is told it is a CLI, and every other
 *  candidate is not there. */
function mac() {
  const calls: { file: string; env?: Record<string, string | undefined> }[] = [];
  const run = async (file: string, _args: string[], _ms?: number, env?: Record<string, string | undefined>) => {
    calls.push({ file, env });
    if (file === "route") return "   route to: 1.1.1.1\ndestination: default\n       mask: default\n  interface: utun4\n      flags: <UP,DONE,STATIC>\n";
    if (file === BUNDLE) return env?.TAILSCALE_BE_CLI === "1" ? STATUS : "The Tailscale GUI failed to start\n";
    return null;
  };
  return { calls, run };
}

describe("the network section on a Mac behind a Tailscale exit node", () => {
  it("names the exit node and its relay, found through the app bundle's CLI", async () => {
    const { run } = mac();
    await probeNetwork({ force: true, platform: "darwin", hasClaude: () => false, run });
    const route = networkSnapshot().route;
    expect(route?.kind).toBe("tailscale-exit");
    expect(route).toMatchObject({ iface: "utun4", node: "office-box", relay: "fra" });
    expect(route?.label).toBe("through Tailscale exit node office-box, relayed via fra");
  });

  it("asks the bundle as a CLI, and stops at the first candidate that answered", async () => {
    const { calls, run } = mac();
    await probeNetwork({ force: true, platform: "darwin", hasClaude: () => false, run });
    const asked = calls.filter(c => c.file !== "route");
    expect(asked.map(c => c.file)).toEqual([BUNDLE]);
    expect(asked[0].env?.TAILSCALE_BE_CLI).toBe("1");
  });

  it("keeps the generic label when no candidate is Tailscale's CLI", async () => {
    // A utun from some other VPN, and no Tailscale at all: every candidate is
    // asked, none answers, and the section says what it does know.
    const calls: string[] = [];
    const run = async (file: string) => {
      calls.push(file);
      return file === "route" ? "  interface: utun4\n" : null;
    };
    await probeNetwork({ force: true, platform: "darwin", hasClaude: () => false, run });
    expect(networkSnapshot().route).toMatchObject({ kind: "vpn", iface: "utun4", label: "through a VPN (utun4)" });
    expect(calls.slice(1)).toEqual([BUNDLE, "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "tailscale"]);
  });
});
