// The decks waiting on somebody here, driven on their own: a fake engine whose
// accept the test watches, settings the test writes, and a route rule where a
// 100.x address is the tailnet and 100.1.1.1 is the owner's own machine.
//
// lan-engine.test.ts, lan-pairing-switches.test.ts and lan-tailscale.test.ts
// prove the same rules through whole engines and real handshakes. What is
// pinned here is the bookkeeping and the one decision it makes — who is on
// which list, and when a switch presses accept instead of a person.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createRequests } from "../../server/lan-requests.mjs";

const T0 = 1_790_550_000_000;

type Cfg = Record<string, unknown>;
const SHIPPED: Cfg = {
  pairingMode: "automatic", autoAsk: false, autoAccept: false,
  tailscale: false, tailscaleAsk: true, tailscaleAccept: true, unpaired: [],
};

function rig(over: Cfg = {}) {
  const st = { cfg: { ...SHIPPED, ...over } as Cfg, t: T0, changes: 0 };
  const pressed: Array<[string, unknown]> = [];
  const engine = { accept: (fp: string, opts: unknown) => { pressed.push([fp, opts]); } };
  const r = createRequests({
    now: () => st.t,
    settings: () => st.cfg,
    routeTo: (addr: string) => (String(addr).startsWith("100.") ? { own: addr === "100.1.1.1" } : null),
    wasUnpaired: (fp: string) => (st.cfg.unpaired as string[]).includes(fp),
    engineNow: () => engine,
    onChange: () => { st.changes++; },
    localAddresses: () => ["192.168.1.82"],
  });
  return { r, st, pressed };
}

const asking = (fp: string, addr = "192.168.1.5") => ({ fp, pub: `pub-${fp}`, name: `Deck-${fp}`, addr, port: 4800 });
const heard = (fp: string, extra: Record<string, unknown> = {}) =>
  ({ fp, name: `Deck-${fp}`, addr: "192.168.1.5", port: 4800, at: T0, via: "lan", ...extra });

describe("a deck that asked", () => {
  it("is a request, drawn once, first asked when it first asked", () => {
    const { r, st } = rig();
    r.askToAccept(asking("a"));
    st.t = T0 + 5_000;
    r.askToAccept(asking("a"));
    expect(st.changes).toBe(1);
    expect(r.seen("a")).toMatchObject({ at: T0, lastAt: T0 + 5_000, via: "lan", own: false });
    expect(r.pendingRows()).toEqual([{ fp: "a", name: "Deck-a", addr: "192.168.1.5", at: T0, via: "lan", own: false }]);
  });

  it("is answered for the owner when the switch for its route says to", () => {
    const { r, pressed } = rig({ autoAccept: true });
    r.askToAccept(asking("a"));
    expect(pressed).toEqual([["a", { byHand: false }]]);
  });

  it("over the tailnet is answered only for the owner's own machine", () => {
    const { r, pressed } = rig({ tailscale: true, autoAccept: false });
    r.askToAccept(asking("stranger", "100.2.2.2"));
    r.askToAccept(asking("mine", "100.1.1.1"));
    expect(pressed).toEqual([["mine", { byHand: false }]]);
    expect(r.seen("stranger")).toMatchObject({ via: "tailscale", own: false });
  });

  it("is never answered by a switch once somebody here unpaired it", () => {
    const { r, pressed } = rig({ autoAccept: true, unpaired: ["a"] });
    r.askToAccept(asking("a"));
    expect(pressed).toEqual([]);
    expect(r.pendingRows()).toHaveLength(1);
  });

  it("is not a row at all when it was told no, or the deck pairs only by invite", () => {
    const { r, st } = rig();
    r.askToAccept(asking("a"));
    r.dismiss("a");
    r.askToAccept(asking("a"));
    expect(r.pendingRows()).toEqual([]);
    st.cfg = { ...st.cfg, pairingMode: "invite" };
    r.askToAccept(asking("b"));
    expect(r.seen("b")).toBeNull();
  });
});

describe("a deck only heard", () => {
  it("is a row somebody can accept, one per machine", () => {
    const { r, st } = rig();
    r.heardStranger(heard("old", { host: "box-1" }));
    r.heardStranger(heard("new", { host: "box-1" }));
    r.heardStranger(heard("new", { host: "box-1" }));
    expect(r.seen("old")).toBeNull();
    expect(r.strangerRows().map((p: { fp: string }) => p.fp)).toEqual(["new"]);
    // Only a deck that is new to this one is news.
    expect(st.changes).toBe(2);
  });

  it("is asked when the ask switch is on, once, and never after a no or an unpair", () => {
    const { r, pressed } = rig({ autoAsk: true, unpaired: ["gone"] });
    r.heardStranger(heard("a"));
    r.heardStranger(heard("a"));
    r.heardStranger(heard("gone"));
    expect(pressed).toEqual([["a", { byHand: false }]]);
    r.heardStranger(heard("b"));
    r.dismiss("b");
    r.heardStranger(heard("b"));
    expect(pressed.map(([fp]) => fp)).toEqual(["a", "b"]);
  });

  it("over the tailnet is asked unprompted only when it is the owner's own machine", () => {
    const { r, pressed } = rig({ tailscale: true });
    r.heardStranger(heard("them", { via: "tailscale", addr: "100.2.2.2" }));
    r.heardStranger(heard("mine", { via: "tailscale", addr: "100.1.1.1" }));
    expect(pressed).toEqual([["mine", { byHand: false }]]);
    expect(r.strangerRows()).toContainEqual(expect.objectContaining({ fp: "them", via: "tailscale", own: false }));
  });

  it("is not offered once told no, nor when it is this machine", () => {
    const { r } = rig();
    r.heardStranger(heard("a"));
    r.heardStranger(heard("self", { addr: "192.168.1.82", name: "Me" }));
    r.dismiss("a");
    expect(r.strangerRows()).toEqual([]);
  });
});

describe("answering and refusing", () => {
  it("takes an accepted deck off both lists, and a heard one asked off its own", () => {
    const { r } = rig();
    r.askToAccept(asking("a"));
    r.heardStranger(heard("a"));
    r.heardStranger(heard("b"));
    r.drop("a");
    r.dropHeard("b");
    expect(r.seen("a")).toBeNull();
    expect(r.seen("b")).toBeNull();
  });

  it("prefers the request to the beacon when a deck is on both", () => {
    const { r } = rig();
    r.heardStranger(heard("a"));
    r.askToAccept(asking("a"));
    expect(r.seen("a")).toMatchObject({ pub: "pub-a" });
  });

  // A deck that asked AND is heard is on both lists, and `dismiss` takes it
  // off the first one it finds. The heard row it leaves is the one the next
  // beacon writes anyway — a declined deck heard is still recorded, only never
  // asked — so nothing can tell the two apart: every reader of the heard list
  // asks the declined one first, and once the answer is taken back the deck is
  // where a fresh beacon would have put it.
  it("told no while on both lists, is offered and asked by nothing until allowed", () => {
    const both = rig({ autoAsk: false });
    both.r.heardStranger(heard("a"));
    both.r.askToAccept(asking("a"));
    expect(both.r.dismiss("a")).toBe(true);
    // The same deck heard only, told no, and heard again while declined.
    const heardOnly = rig({ autoAsk: false });
    heardOnly.r.heardStranger(heard("a"));
    heardOnly.r.dismiss("a");
    heardOnly.r.heardStranger(heard("a"));
    for (const { r, st, pressed } of [both, heardOnly]) {
      expect(r.pendingRows()).toEqual([]);
      expect(r.strangerRows()).toEqual([]);
      expect(r.declinedRows().map((p: { fp: string }) => p.fp)).toEqual(["a"]);
      // Neither the beacon nor the switch asks it.
      r.heardStranger(heard("a"));
      const was = st.cfg;
      st.cfg = { ...was, autoAsk: true };
      r.switched(was);
      r.heardStranger(heard("a"));
      expect(pressed).toEqual([]);
      // Allowed again, it is the heard row it always was, not asked by a
      // beacon, and a request again the next time it dials.
      r.allow("a");
      r.heardStranger(heard("a"));
      expect(pressed).toEqual([]);
      expect(r.strangerRows().map((p: { fp: string }) => p.fp)).toEqual(["a"]);
      r.askToAccept(asking("a"));
      expect(r.pendingRows().map((p: { fp: string }) => p.fp)).toEqual(["a"]);
    }
  });

  it("keeps a declined deck by name and address until somebody changes their mind", () => {
    const { r, st } = rig();
    r.heardStranger(heard("a"));
    st.t = T0 + 1_000;
    expect(r.dismiss("a")).toBe(true);
    expect(r.dismiss("a")).toBe(false);
    expect(r.isDeclined("a")).toBe(true);
    expect(r.declinedRows()).toEqual([{ fp: "a", name: "Deck-a", addr: "192.168.1.5", at: T0 + 1_000 }]);
    const before = st.changes;
    expect(r.allow("a")).toBe(true);
    expect(r.allow("a")).toBe(false);
    expect(st.changes).toBe(before + 1);
    expect(r.isDeclined("a")).toBe(false);
  });
});

describe("a settings write", () => {
  it("to invite-only clears the requests, so none becomes a yes later", () => {
    const { r, st } = rig();
    r.askToAccept(asking("a"));
    const was = st.cfg;
    st.cfg = { ...was, pairingMode: "invite" };
    r.switched(was);
    expect(r.pendingRows()).toEqual([]);
  });

  it("that turns the yes on answers what is already waiting, per route", () => {
    const { r, st, pressed } = rig({ tailscale: true, tailscaleAccept: false });
    r.askToAccept(asking("lan"));
    r.askToAccept(asking("them", "100.2.2.2"));
    r.askToAccept(asking("mine", "100.1.1.1"));
    expect(pressed).toEqual([]);
    // The local switch answers the local request and nothing on the tailnet.
    let was = st.cfg;
    st.cfg = { ...was, autoAccept: true };
    r.switched(was);
    expect(pressed.map(([fp]) => fp)).toEqual(["lan"]);
    // The tailnet one answers only the owner's own machine.
    was = st.cfg;
    st.cfg = { ...was, tailscaleAccept: true };
    r.switched(was);
    expect(pressed.map(([fp]) => fp)).toEqual(["lan", "mine"]);
  });

  it("that turns the ask on asks the decks already heard, and not one told no", () => {
    const { r, st, pressed } = rig();
    r.heardStranger(heard("a"));
    r.heardStranger(heard("told-no"));
    r.dismiss("told-no");
    const was = st.cfg;
    st.cfg = { ...was, autoAsk: true };
    r.switched(was);
    expect(pressed).toEqual([["a", { byHand: false }]]);
  });

  it("that turns the tailnet off forgets who was heard over it", () => {
    const { r, st } = rig({ tailscale: true });
    r.heardStranger(heard("far", { via: "tailscale", addr: "100.2.2.2" }));
    r.heardStranger(heard("near"));
    const was = st.cfg;
    st.cfg = { ...was, tailscale: false };
    r.switched(was);
    expect(r.seen("far")).toBeNull();
    expect(r.seen("near")).not.toBeNull();
  });
});
