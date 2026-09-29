// The network map's layout is a function of the rows and the stage's size,
// with no DOM in it, so everything the picture promises about where a deck
// stands can be asserted here: which ring, which way its wire points, which
// side its name goes, and what the line under the name says.
import { describe, expect, it } from "vitest";

import {
  continuousAngle, machineKey, mapHeadline, mapLayout, mapSummary, mapTier, nodeCaption, ownAddresses, presenceLine,
} from "../lan-network-map";
import type { DeckRow } from "../lan-roster";

let seq = 0;
function row(over: Partial<DeckRow>): DeckRow {
  seq += 1;
  return {
    fp: `fp-${seq}`, name: `deck-${seq}`, addr: "192.168.1.10",
    kind: "paired", state: "online", tone: "ok", here: true, hint: "",
    ...over,
  };
}

const W = 860;
const H = 640;

describe("which ring a deck stands on", () => {
  it("puts paired decks that are on inside, and every other machine outside", () => {
    expect(mapTier(row({ kind: "paired", here: true }))).toBe("online");
    expect(mapTier(row({ kind: "paired", here: false }))).toBe("offline");
    expect(mapTier(row({ kind: "nearby" }))).toBe("loose");
    expect(mapTier(row({ kind: "asks" }))).toBe("loose");
    expect(mapTier(row({ kind: "dialling", here: false }))).toBe("loose");
  });

  it("draws no deck somebody here already said no to", () => {
    const declined = row({ kind: "declined" });
    expect(mapTier(declined)).toBeNull();
    const { nodes } = mapLayout([row({}), declined], W, H);
    expect(nodes.map(n => n.row.fp)).not.toContain(declined.fp);
    expect(mapSummary([declined]).declined).toBe(1);
  });

  it("stands the quiet paired decks and the unpaired machines on one outer ring", () => {
    const rows = [row({}), row({ here: false }), row({ kind: "nearby" })];
    const { nodes, rings } = mapLayout(rows, W, H);
    expect(nodes.map(n => n.ring)).toEqual([0, 1, 1]);
    expect(rings).toHaveLength(2);
    expect(rings[0].rx).toBeLessThan(rings[1].rx);
  });

  it("lists quiet paired decks before unpaired ones on the outer ring, with tailnet decks together", () => {
    const nearby = row({ kind: "nearby" });
    const quietTs = row({ here: false, via: "tailscale" });
    const quiet = row({ here: false });
    const { nodes } = mapLayout([nearby, quietTs, quiet], W, H);
    expect(nodes.map(n => n.row.fp)).toEqual([quiet.fp, quietTs.fp, nearby.fp]);
  });
});

describe("where a deck stands", () => {
  it("stands one deck alone at three o'clock, where a deck's own dialog draws the far machine", () => {
    const [n] = mapLayout([row({})], W, H).nodes;
    expect(n.angle).toBeCloseTo(0);
    expect(n.x).toBeGreaterThan(0);
    expect(Math.abs(n.y)).toBeLessThan(1e-9);
  });

  it("stands two decks either side of this one", () => {
    const nodes = mapLayout([row({}), row({})], W, H).nodes;
    expect(nodes.map(n => Math.round(n.angle))).toEqual([0, 180]);
  });

  it("turns every wire to where its deck actually is, off the axes of the ellipse too", () => {
    const { nodes } = mapLayout(Array.from({ length: 7 }, () => row({})), W, H);
    for (const n of nodes) {
      const rad = (n.angle * Math.PI) / 180;
      expect(Math.cos(rad) * n.dist).toBeCloseTo(n.x, 6);
      expect(Math.sin(rad) * n.dist).toBeCloseTo(n.y, 6);
    }
  });

  it("keeps every deck inside the stage, with room for the names outside the outer ring", () => {
    const rows = [...Array.from({ length: 10 }, () => row({})), ...Array.from({ length: 7 }, () => row({ here: false }))];
    for (const n of mapLayout(rows, W, H).nodes) {
      expect(Math.abs(n.x)).toBeLessThanOrEqual(W / 2);
      expect(Math.abs(n.y)).toBeLessThanOrEqual(H / 2);
    }
  });

  it("sets a name over the decks along the top and under every other", () => {
    const { nodes } = mapLayout(Array.from({ length: 4 }, () => row({})), W, H);
    const top = nodes.find(n => Math.round(n.angle) === 270)!;
    const bottom = nodes.find(n => Math.round(n.angle) === 90)!;
    const side = nodes.find(n => Math.round(n.angle) === 0)!;
    expect(top.side).toBe("top");
    expect(bottom.side).toBe("bottom");
    expect(side.side).toBe("bottom");
  });

  it("draws the same network in the same place every time it opens", () => {
    const rows = Array.from({ length: 9 }, () => row({}));
    expect(mapLayout(rows, W, H)).toEqual(mapLayout(rows, W, H));
  });

  it("steps every other deck of a crowded ring out, and says the ring is crowded", () => {
    const rows = Array.from({ length: 24 }, () => row({}));
    const { nodes, dense } = mapLayout(rows, W, H);
    expect(dense).toBe(true);
    expect(nodes[1].dist / nodes[0].dist).not.toBeCloseTo(1, 2);
  });

  it("is not crowded at a real office's fifteen decks", () => {
    const rows = [...Array.from({ length: 10 }, () => row({})), ...Array.from({ length: 5 }, () => row({ here: false }))];
    expect(mapLayout(rows, W, H).dense).toBe(false);
  });

  it("draws nothing before the stage has been measured", () => {
    const { nodes } = mapLayout([row({})], 0, 0);
    expect(nodes[0].dist).toBe(0);
  });
});

describe("the line under a deck's name", () => {
  it("says what a live deck runs, never what its last round moved", () => {
    const troubled = row({ state: "online · 0 of 1 logins arrived", tone: "bad" });
    expect(nodeCaption(troubled, "Windows 11")).toBe("Windows 11");
    expect(nodeCaption(troubled, null)).toBe("online");
  });

  it("says how long a quiet deck has been quiet", () => {
    expect(nodeCaption(row({ here: false, state: "not listening · last online 2h ago", tone: "bad" }), "macOS 26.5"))
      .toBe("offline · 2h ago");
    expect(nodeCaption(row({ here: false, state: "last online now" }), null)).toBe("offline · just now");
    expect(nodeCaption(row({ here: false, state: "one-way · has not called yet" }), null)).toBe("one-way · quiet");
    expect(nodeCaption(row({ here: false, state: "never reached" }), null)).toBe("offline");
  });

  it("cuts a long system name to its first two words", () => {
    expect(nodeCaption(row({}), "Ubuntu 24.04.1 LTS")).toBe("Ubuntu 24.04.1");
  });

  it("names what an unpaired machine is", () => {
    expect(nodeCaption(row({ kind: "asks" }), null)).toBe("wants to pair");
    expect(nodeCaption(row({ kind: "dialling", here: false, state: "not listening", tone: "bad" }), null)).toBe("dialling");
    expect(nodeCaption(row({ kind: "nearby", state: "needs an invite" }), null)).toBe("needs an invite");
  });
});

describe("the side panel's presence line", () => {
  it("drops the round the list appends to a deck's presence", () => {
    expect(presenceLine(row({ state: "online · 0 of 1 logins arrived" }))).toBe("online");
    expect(presenceLine(row({ state: "online · all logins fine", via: "tailscale" }))).toBe("online, over Tailscale");
    expect(presenceLine(row({ here: false, state: "no answer · last online 3m ago" }))).toBe("offline · last online 3m ago");
  });

  it("says a deck is over the tailnet whether or not it is on", () => {
    expect(presenceLine(row({ here: false, state: "last online 2h ago", via: "tailscale" })))
      .toBe("offline · last online 2h ago, over Tailscale");
    expect(presenceLine(row({ kind: "nearby", state: "not paired yet", via: "tailscale" })))
      .toBe("not paired yet, over Tailscale");
  });
});

describe("which machine a deck is, across polls", () => {
  it("is the same machine when its two decks trade the lead", () => {
    const a = row({ fp: "b-deck" });
    const b = row({ fp: "a-deck" });
    const ledByA = { ...a, twins: [b] };
    const ledByB = { ...b, twins: [a] };
    expect(machineKey(ledByA)).toBe(machineKey(ledByB));
  });

  it("is the deck's own fingerprint for the ordinary machine running one", () => {
    expect(machineKey(row({ fp: "only" }))).toBe("only");
  });
});

describe("the way a wire turns when its deck moves", () => {
  it("turns the short way across twelve o'clock's seam", () => {
    expect(continuousAngle(350, 10)).toBe(370);
    expect(continuousAngle(10, 350)).toBe(-10);
  });

  it("turns the short way from three o'clock to twelve, as two decks becoming three does", () => {
    expect(continuousAngle(0, 270)).toBe(-90);
  });

  it("keeps building on an angle that has already wound past a full turn", () => {
    expect(continuousAngle(370, 20)).toBe(380);
    expect(continuousAngle(undefined, 45)).toBe(45);
  });
});

describe("the map's headline", () => {
  it("leads with the count the row that opened it already said", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => row({})),
      ...Array.from({ length: 5 }, () => row({ here: false })),
      row({ kind: "dialling", here: false }), row({ kind: "dialling", here: false }),
    ];
    expect(mapHeadline(mapSummary(rows))).toBe("10 of 15 paired decks online · 2 still dialling");
  });

  it("says so when every paired deck is on, and when there are none", () => {
    expect(mapHeadline(mapSummary([row({}), row({})]))).toBe("2 paired decks, all online");
    expect(mapHeadline(mapSummary([row({ kind: "nearby" })]))).toBe("no paired decks yet · 1 nearby, not paired");
  });

  it("counts the tailnet among the decks it draws", () => {
    const s = mapSummary([row({ via: "tailscale" }), row({ kind: "nearby", via: "tailscale" }), row({ kind: "declined", via: "tailscale" })]);
    expect(s.tailnet).toBe(2);
  });
});

describe("this deck's addresses", () => {
  it("lists the local network's first and the tailnet's once", () => {
    expect(ownAddresses({ addrs: ["192.168.1.82"], port: 60263, tailscale: { addr: "100.67.32.58" } as never }))
      .toEqual(["192.168.1.82:60263", "100.67.32.58:60263"]);
    expect(ownAddresses({ addrs: ["100.67.32.58"], port: 1, tailscale: { addr: "100.67.32.58" } as never }))
      .toEqual(["100.67.32.58:1"]);
    expect(ownAddresses(null)).toEqual([]);
  });
});
