// The local accept switch says yes to a deck on the local network. A deck at an
// address in Tailscale's block (100.64.0.0/10) is on the local network only if
// Tailscale says it is not one of its own — and before the first read of the
// tailnet, after a read that failed, or while the last read still says
// Tailscale is starting, nothing here has said so. Such a deck waits for a
// press, the way a tailnet deck that is not the owner's own machine does,
// rather than being taken as a local one by default.
//
// The requests driven on their own, with the real routeOf over the snapshot a
// case hands it — see lan-requests.test.ts for the rest of their rules.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createRequests } from "../../server/lan-requests.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { readTailnet, routeOf } from "../../server/tailscale.mjs";

const T0 = 1_790_550_000_000;

const SHIPPED = {
  pairingMode: "automatic", autoAsk: true, autoAccept: true,
  tailscale: false, tailscaleAsk: true, tailscaleAccept: true, unpaired: [],
};

const STARTING = readTailnet(JSON.stringify({ BackendState: "Starting", Self: {}, Peer: {} }));
const RUNNING = readTailnet(JSON.stringify({
  BackendState: "Running", Self: { UserID: 1, TailscaleIPs: ["100.100.0.1"] },
  Peer: { a: { UserID: 1, OS: "linux", Online: true, TailscaleIPs: ["100.100.0.2"], DNSName: "desk.tail.ts.net." } },
}));

function rig(snapshot: unknown, over: Record<string, unknown> = {}) {
  const st = { cfg: { ...SHIPPED, ...over } as Record<string, unknown>, snapshot };
  const pressed: string[] = [];
  const r = createRequests({
    now: () => T0,
    settings: () => st.cfg,
    routeTo: (addr: string) => routeOf(st.snapshot, addr),
    wasUnpaired: () => false,
    engineNow: () => ({ accept: (fp: string) => { pressed.push(fp); return true; } }),
    onChange: () => {},
    localAddresses: () => ["192.168.1.82"],
  });
  return { r, st, pressed };
}

const asking = (fp: string, addr: string) => ({ fp, pub: `pub-${fp}`, name: `Deck-${fp}`, addr, port: 4800 });

describe("a deck at a tailnet address, before Tailscale has said whose it is", () => {
  it.each([["no read yet", null], ["Tailscale still starting", STARTING]])("waits for a press: %s", (_why, snapshot) => {
    const { r, pressed } = rig(snapshot);
    r.askToAccept(asking("t", "100.101.1.2"));
    expect(pressed, "the local switch said yes to a tailnet address").toEqual([]);
    expect(r.pendingRows()).toMatchObject([{ fp: "t", addr: "100.101.1.2" }]);
  });

  it("is not answered by turning the local switch on, either", () => {
    const { r, st, pressed } = rig(null, { autoAccept: false });
    r.askToAccept(asking("t", "100.101.1.2"));
    r.askToAccept(asking("l", "192.168.1.5"));
    const was = st.cfg;
    st.cfg = { ...st.cfg, autoAccept: true };
    r.switched(was);
    expect(pressed).toEqual(["l"]);
  });

  it("leaves the local network as it was: an ordinary address is still answered", () => {
    const { r, pressed } = rig(null);
    r.askToAccept(asking("l", "192.168.1.5"));
    r.askToAccept(asking("m", "::ffff:10.0.0.7"));
    expect(pressed).toEqual(["l", "m"]);
  });

  it("is answered as before once Tailscale says it is the owner's own machine", () => {
    const { r, pressed } = rig(RUNNING, { tailscale: true });
    r.askToAccept(asking("mine", "100.100.0.2"));
    r.askToAccept(asking("other", "100.101.1.2"));
    expect(pressed).toEqual(["mine"]);
  });
});
