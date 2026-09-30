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

  it("stands the decks that are on inside, the quiet paired ones next, and the unpaired outside", () => {
    const rows = [row({}), row({ here: false }), row({ kind: "nearby" })];
    const { nodes, rings } = mapLayout(rows, W, H);
    expect(nodes.map(n => n.ring)).toEqual([0, 1, 2]);
    expect(rings).toHaveLength(3);
    expect(rings[0].rx).toBeLessThan(rings[1].rx);
    expect(rings[1].rx).toBeLessThan(rings[2].rx);
  });

  it("draws the rings from the inside out, with tailnet decks together on theirs", () => {
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
    const rows = [
      ...Array.from({ length: 10 }, () => row({})),
      ...Array.from({ length: 7 }, () => row({ here: false })),
      ...Array.from({ length: 6 }, () => row({ kind: "nearby" })),
    ];
    for (const n of mapLayout(rows, W, H).nodes) {
      expect(Math.abs(n.x)).toBeLessThanOrEqual(W / 2);
      expect(Math.abs(n.y)).toBeLessThanOrEqual(H / 2);
    }
  });

  it("sets a name over the decks along the top and under every other", () => {
    const { nodes } = mapLayout(Array.from({ length: 4 }, () => row({})), W, H);
    const by = (pick: (a: typeof nodes[number], b: typeof nodes[number]) => boolean) =>
      nodes.reduce((best, n) => (pick(n, best) ? n : best));
    expect(by((a, b) => a.y < b.y).side).toBe("top");
    expect(by((a, b) => a.y > b.y).side).toBe("bottom");
    expect(by((a, b) => a.x > b.x).side).toBe("bottom");
  });

  it("stands decks a little off an even spacing, without two of them trading places", () => {
    const { nodes } = mapLayout(Array.from({ length: 8 }, () => row({})), W, H);
    // Clockwise from the first deck, wherever its offset put it.
    const round = nodes.map(n => (n.angle - nodes[0].angle + 360) % 360);
    for (let i = 1; i < round.length; i++) expect(round[i]).toBeGreaterThan(round[i - 1]);
    const gaps = round.slice(1).map((a, i) => a - round[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(1);
  });

  it("keeps a deck's own offset when the rest of the network changes around it", () => {
    const deck = row({ fp: "steady", here: false });
    const alone = mapLayout([row({}), deck, row({ here: false }), row({ here: false })], W, H);
    const joined = mapLayout([row({}), row({}), deck, row({ here: false }), row({ here: false })], W, H);
    const at = (l: typeof alone) => l.nodes.find(n => n.row.fp === "steady")!;
    expect(at(joined).x).toBeCloseTo(at(alone).x, 6);
    expect(at(joined).y).toBeCloseTo(at(alone).y, 6);
  });

  it("widens a busy inner ring toward the middle one rather than crowding it", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => row({})),
      ...Array.from({ length: 5 }, () => row({ here: false })),
      ...Array.from({ length: 3 }, () => row({ kind: "nearby" })),
    ];
    const { dense, rings } = mapLayout(rows, W, H);
    expect(dense).toBe(false);
    expect(rings[1].rx - rings[0].rx).toBeGreaterThanOrEqual(0.2 * (W / 2 - 76) - 1e-9);
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

describe("the tailnet's own slice of the map", () => {
  /** Where a deck stands round the map, as the slice's own angles count. */
  const param = (n: { x: number; y: number }, rings: { rx: number; ry: number }) =>
    (Math.atan2(n.y / rings.ry, n.x / rings.rx) * 180) / Math.PI;
  const within = (deg: number, from: number, to: number) => {
    const d = (((deg - from) % 360) + 360) % 360;
    return d <= to - from;
  };

  it("stands every tailnet deck inside one slice, and every other deck outside it", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => row({})),
      row({ via: "tailscale" }), row({ via: "tailscale", here: false }),
      ...Array.from({ length: 4 }, () => row({ here: false })),
      row({ kind: "nearby", via: "tailscale" }),
    ];
    const { nodes, rings, zone } = mapLayout(rows, W, H);
    expect(zone).not.toBeNull();
    for (const n of nodes) {
      const ring = rings.find(r => r.ring === n.ring)!;
      const inside = within(param(n, ring), zone!.from, zone!.to);
      expect(`${n.row.via ?? "lan"}: ${inside}`).toBe(`${n.row.via ?? "lan"}: ${n.row.via === "tailscale"}`);
    }
  });

  it("keeps the rings' meaning inside the slice", () => {
    const rows = [row({}), row({ via: "tailscale" }), row({ via: "tailscale", here: false }), row({ kind: "nearby", via: "tailscale" })];
    const ts = mapLayout(rows, W, H).nodes.filter(n => n.row.via === "tailscale");
    expect(ts.map(n => n.ring)).toEqual([0, 1, 2]);
  });

  it("draws no slice without a tailnet deck, or when every deck is on the tailnet", () => {
    expect(mapLayout([row({}), row({ here: false })], W, H).zone).toBeNull();
    expect(mapLayout([row({ via: "tailscale" }), row({ via: "tailscale", here: false })], W, H).zone).toBeNull();
  });

  it("gives one tailnet deck a slice wide enough to read, and a mostly-tailnet network room for the rest", () => {
    const one = mapLayout([...Array.from({ length: 9 }, () => row({})), row({ via: "tailscale" })], W, H).zone!;
    expect(one.to - one.from).toBeGreaterThanOrEqual(64);
    const most = mapLayout([row({}), ...Array.from({ length: 9 }, () => row({ via: "tailscale" }))], W, H).zone!;
    expect(most.to - most.from).toBeLessThanOrEqual(150);
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
