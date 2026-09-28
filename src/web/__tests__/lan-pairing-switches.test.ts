// The two permissions that answer for one route: whether this deck asks a deck
// it heard, and whether it says yes for its owner to a deck that asks.
//
// Four switches feed them and the pairing mode overrides all four. The engine
// reads them in three places — a beacon from a stranger, a request that
// finished a handshake, and a settings write that may have turned one on — and
// the third used to restate the conditions in a shape of its own. They are one
// function now, so what each switch answers for is pinned here once, against
// the function every one of those places calls.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { asksOn, saysYesOn } from "../../server/lan-engine.mjs";

/** The settings a deck ships with: automatic pairing, both local switches on,
 *  Tailscale discovery off with its own pair left at their defaults. */
const SHIPPED = { pairingMode: "automatic", autoAsk: true, autoAccept: true, tailscale: false };

describe("the switches that answer for the local network", () => {
  it("are the local pair, and only the local pair", () => {
    expect(asksOn(SHIPPED, "lan")).toBe(true);
    expect(saysYesOn(SHIPPED, "lan")).toBe(true);
    expect(asksOn({ ...SHIPPED, autoAsk: false }, "lan")).toBe(false);
    expect(saysYesOn({ ...SHIPPED, autoAccept: false }, "lan")).toBe(false);
    // Each answers for its own verb: turning one off leaves the other alone.
    expect(saysYesOn({ ...SHIPPED, autoAsk: false }, "lan")).toBe(true);
    expect(asksOn({ ...SHIPPED, autoAccept: false }, "lan")).toBe(true);
  });

  it("ignore the Tailscale pair entirely", () => {
    const tail = { ...SHIPPED, tailscale: true, tailscaleAsk: false, tailscaleAccept: false };
    expect(asksOn(tail, "lan")).toBe(true);
    expect(saysYesOn(tail, "lan")).toBe(true);
  });

  it("read a switch that is absent as off, which is what the panel draws", () => {
    expect(asksOn({ pairingMode: "automatic" }, "lan")).toBe(false);
    expect(saysYesOn({ pairingMode: "automatic" }, "lan")).toBe(false);
  });
});

describe("the switches that answer for the tailnet", () => {
  it("answer nothing while discovery over Tailscale is off", () => {
    expect(asksOn(SHIPPED, "tailscale")).toBe(false);
    expect(saysYesOn(SHIPPED, "tailscale")).toBe(false);
  });

  it("are on with discovery unless somebody turned them off", () => {
    // `!== false`, not truthiness: the pair defaults to on (deck-prefs ships
    // both true), so only a switch somebody turned off reads as off.
    const on = { ...SHIPPED, tailscale: true };
    expect(asksOn(on, "tailscale")).toBe(true);
    expect(saysYesOn(on, "tailscale")).toBe(true);
    expect(asksOn({ ...on, tailscaleAsk: false }, "tailscale")).toBe(false);
    expect(saysYesOn({ ...on, tailscaleAccept: false }, "tailscale")).toBe(false);
    expect(saysYesOn({ ...on, tailscaleAsk: false }, "tailscale")).toBe(true);
    expect(asksOn({ ...on, tailscaleAccept: false }, "tailscale")).toBe(true);
  });

  it("ignore the local pair entirely", () => {
    const local = { ...SHIPPED, autoAsk: false, autoAccept: false, tailscale: true };
    expect(asksOn(local, "tailscale")).toBe(true);
    expect(saysYesOn(local, "tailscale")).toBe(true);
  });
});

describe("pairing only by invite", () => {
  it("turns every switch off on every route, whatever each one says", () => {
    const all = {
      pairingMode: "invite", autoAsk: true, autoAccept: true,
      tailscale: true, tailscaleAsk: true, tailscaleAccept: true,
    };
    for (const via of ["lan", "tailscale"]) {
      expect(asksOn(all, via), via).toBe(false);
      expect(saysYesOn(all, via), via).toBe(false);
    }
  });

  it("gives every switch back when automatic pairing returns", () => {
    const back = { ...SHIPPED, tailscale: true };
    for (const via of ["lan", "tailscale"]) {
      expect(asksOn(back, via), via).toBe(true);
      expect(saysYesOn(back, via), via).toBe(true);
    }
  });
});

describe("the answer", () => {
  it("is a boolean, so a settings write compares two of them rather than two objects", () => {
    // apply() asks before and after a write and acts on "off, then on". A
    // truthy string or a stray object here would read as on both times.
    const odd = { pairingMode: "automatic", autoAsk: "yes", autoAccept: 1, tailscale: "on" };
    for (const via of ["lan", "tailscale"]) {
      expect(typeof asksOn(odd, via)).toBe("boolean");
      expect(typeof saysYesOn(odd, via)).toBe("boolean");
    }
  });
});
