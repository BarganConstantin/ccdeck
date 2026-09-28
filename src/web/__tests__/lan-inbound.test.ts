// Who has called a deck, driven on its own: a clock the test moves and a list
// of this machine's own addresses the test writes.
//
// lan-engine.test.ts proves the same records through whole engines — a deck
// that only calls in drawn with the time and route of its last call — and
// lan-blocked-inbound.test.ts proves what the panel says from them. What is
// pinned here is the bookkeeping: what a call records, which connection counts
// as another machine, and when the listener's clock starts and stops.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { anotherMachine, createInbound } from "../../server/lan-inbound.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { anotherMachine as FROM_ENGINE } from "../../server/lan-engine.mjs";

const T0 = 1_790_550_000_000;

function rig() {
  const st = { t: T0, mine: ["192.168.1.82"] };
  const inbound = createInbound({ now: () => st.t, localAddresses: () => st.mine });
  return { inbound, st };
}

describe("a paired deck that speaks", () => {
  it("is recorded by when, and by the address its hello named", () => {
    const { inbound, st } = rig();
    expect(inbound.spokeAt("fp-a")).toBeUndefined();
    expect(inbound.spokeFrom("fp-a")).toBeUndefined();
    inbound.spoke({ peerFp: "fp-a", peerAddr: "192.168.1.5", sock: { remoteAddress: "::ffff:10.9.9.9" } });
    expect(inbound.spokeAt("fp-a")).toBe(T0);
    expect(inbound.spokeFrom("fp-a")).toBe("192.168.1.5");
    st.t = T0 + 60_000;
    inbound.spoke({ peerFp: "fp-a", peerAddr: "100.64.0.7" });
    expect(inbound.spokeAt("fp-a")).toBe(T0 + 60_000);
    expect(inbound.spokeFrom("fp-a")).toBe("100.64.0.7");
  });

  it("falls back to the socket's own address, in v4 spelling", () => {
    const { inbound } = rig();
    inbound.spoke({ peerFp: "fp-a", sock: { remoteAddress: "::ffff:192.168.1.5" } });
    expect(inbound.spokeFrom("fp-a")).toBe("192.168.1.5");
  });

  it("with no address to say keeps the one it last had", () => {
    const { inbound, st } = rig();
    inbound.spoke({ peerFp: "fp-a", peerAddr: "192.168.1.5" });
    st.t = T0 + 1_000;
    inbound.spoke({ peerFp: "fp-a", sock: {} });
    expect(inbound.spokeAt("fp-a")).toBe(T0 + 1_000);
    expect(inbound.spokeFrom("fp-a")).toBe("192.168.1.5");
    inbound.spoke({ peerFp: "fp-b" });
    expect(inbound.spokeAt("fp-b")).toBe(T0 + 1_000);
    expect(inbound.spokeFrom("fp-b")).toBeUndefined();
  });
});

describe("a connection to the listener", () => {
  it("counts only from another machine, read against this one's addresses at the time", () => {
    const { inbound, st } = rig();
    for (const from of ["127.0.0.1", "::1", "192.168.1.82", "::ffff:192.168.1.82", "", null]) inbound.arrived(from);
    expect(inbound.inboundAt()).toBeNull();
    st.t = T0 + 5_000;
    inbound.arrived("::ffff:192.168.1.205");
    expect(inbound.inboundAt()).toBe(T0 + 5_000);
    // A machine whose address this one has since taken is this one now.
    st.mine = ["192.168.1.82", "10.0.0.3"];
    st.t = T0 + 9_000;
    inbound.arrived("10.0.0.3");
    expect(inbound.inboundAt()).toBe(T0 + 5_000);
  });

  it("is judged by the rule the engine still exports", () => {
    expect(FROM_ENGINE).toBe(anotherMachine);
    expect(anotherMachine("192.168.1.205", ["192.168.1.82"])).toBe(true);
    expect(anotherMachine("127.0.0.1")).toBe(false);
  });
});

describe("the listener's own clock", () => {
  it("starts when it comes up and is nothing while it is down", () => {
    const { inbound, st } = rig();
    expect(inbound.listeningSince()).toBeNull();
    inbound.listening();
    st.t = T0 + 30_000;
    expect(inbound.listeningSince()).toBe(T0);
    inbound.closed();
    expect(inbound.listeningSince()).toBeNull();
    // The next start measures from itself, not from the last one.
    inbound.listening();
    expect(inbound.listeningSince()).toBe(T0 + 30_000);
  });

  it("leaves when anybody last got through alone, down or up", () => {
    const { inbound } = rig();
    inbound.listening();
    inbound.arrived("192.168.1.205");
    inbound.closed();
    expect(inbound.inboundAt()).toBe(T0);
  });
});
