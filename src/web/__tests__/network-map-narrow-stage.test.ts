// In a narrow window the network map drew decks under this deck's own name.
//
// The name at the centre sits on a plate under the orb, and the layout treats
// it as an obstacle: a deck whose disc or name lands on it slides round its
// ring. Two things kept that from working where the stage is short or narrow —
// the panel stacks under the map below 1040px, and a phone leaves it 357px
// wide. A ring of one or two decks never moved at all, so the tailnet slice
// could stand its second deck just right of six o'clock, under the plate. And
// a layout that cleared neither with three rings nor with two was drawn as it
// was, with the slice holding every tailnet deck to an arc of the inner ring
// about as long as the plate is wide: at phone width `Studio Mac` sat under the
// centre's name and `pi-box` under another deck's disc, where the same decks
// without the slice drew clean.
//
// Now a ring of one or two may step off the plate (and only off the plate),
// and where the slice is what keeps the names from clearing the map is drawn
// without it, as it is when every deck is on the tailnet.
import { describe, expect, it } from "vitest";

import { mapLayout, nodeBoxes, nodeCaption } from "../lan-network-map";
import { deckRows, type DeckRow } from "../lan-roster";
import type { Peer } from "../lan-types";

let seq = 0;
function row(over: Partial<DeckRow>): DeckRow {
  seq += 1;
  return {
    fp: `fp-${seq}`, name: `deck-${seq}`, addr: "192.168.1.10",
    kind: "paired", state: "online", tone: "ok", here: true, hint: "",
    ...over,
  };
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const meet = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const captionOf = (r: DeckRow) => nodeCaption(r, "macOS 26.1");

/** Everything drawn over something else: a deck's disc or name on the
 *  centre's name, or on another deck's disc or name. */
function clashes(rows: DeckRow[], w: number, h: number, core: string): string[] {
  const layout = mapLayout(rows, w, h, core, captionOf);
  const { core: plate, decks } = nodeBoxes(layout, core, captionOf);
  const name = (key: string) => layout.nodes.find(n => n.row.fp === key)!.row.name;
  const out: string[] = [];
  decks.forEach((a, i) => {
    if (meet(a.disc, plate) || meet(a.label, plate)) out.push(`${name(a.key)} on the centre's name`);
    for (const b of decks.slice(i + 1)) {
      if (meet(a.label, b.disc) || meet(b.label, a.disc) || meet(a.label, b.label) || meet(a.disc, b.disc)) {
        out.push(`${name(a.key)} on ${name(b.key)}`);
      }
    }
  });
  return out;
}

/** The stages the map gets: a 1000x700 window, and a phone's 390x844. */
const NARROW_WINDOW: [number, number] = [920, 406];
const PHONE: [number, number] = [357, 464];

describe("this deck's name at the centre of a narrow map", () => {
  it("has no tailnet deck under it when two of them share the inner ring", () => {
    const rows = [
      row({ via: "tailscale", name: "office-box" }), row({ via: "tailscale", name: "home-mini" }),
      row({ here: false, name: "old-tower", state: "last online 4h ago" }),
    ];
    expect(clashes(rows, ...NARROW_WINDOW, "constantin-thinkpad")).toEqual([]);
  });

  it("has no deck under it at phone width, when that deck is the only one", () => {
    expect(clashes([row({ name: "work-laptop" })], ...PHONE, "constantin-Venus-Series")).toEqual([]);
    expect(clashes([row({ name: "work-laptop", via: "tailscale", here: false, state: "last online 2h ago" })], ...PHONE,
      "constantin-Venus-Series")).toEqual([]);
  });

  it("has no deck under it, and no deck on another, at phone width with a deck over Tailscale", () => {
    // The network the finding was drawn from, as /api/lan said it: a deck on
    // the tailnet among the live ones, a quiet one with a long name, one that
    // only calls in, an address being dialled, and two heard nearby — one of
    // them over the tailnet too.
    const NOW = 1_790_000_000_000;
    const peer = (fp: string, name: string, over: Record<string, unknown>) => ({
      fp, peerFp: fp, name, addr: "192.168.1.22", port: 4317, paired: true, lastSeen: NOW - 5_000,
      last: { at: NOW - 20_000 }, pairedAt: NOW - 86_400_000, via: "lan" as const, ...over,
    });
    const rows = deckRows({
      aliases: { fpB: "Studio Mac" },
      peers: [
        peer("fpA", "work-laptop", { last: { at: NOW - 20_000, done: [{ email: "work@acme.io", action: "kept", ok: true }] } }),
        peer("fpB", "studio", { addr: "100.66.5.9", lastSeen: NOW - 9_000, via: "tailscale" }),
        peer("fpC", "old-tower-with-a-really-long-hostname-indeed", {
          addr: "192.168.1.40", lastSeen: NOW - 3 * 86_400_000, last: { at: NOW - 3 * 86_400_000, error: "ECONNREFUSED" },
        }),
        { fp: "fpD", peerFp: null, name: "10.0.0.9:4317", addr: "10.0.0.9", port: 4317, manual: true, met: false, paired: false,
          lastSeen: null, last: { at: NOW - 60_000, error: "ETIMEDOUT" }, via: "lan" as const },
        peer("fpE", "pi-box", { addr: "", waiting: true, lastSeen: NOW - 40_000, last: undefined, pairedAt: null }),
      ] as Peer[],
      strangers: [
        { fp: "fpS1", name: "neighbour-pc", addr: "192.168.1.77", port: 4317, at: NOW - 10_000, via: "lan" },
        { fp: "fpS2", name: "phone-tail", addr: "100.66.9.9", port: 4317, at: NOW - 10_000, via: "tailscale" },
      ],
      declined: [{ fp: "fpX", name: "intruder", addr: "192.168.1.99", port: 4317, at: NOW - 86_400_000 }],
    }, NOW);
    expect(rows.filter(r => r.via === "tailscale").map(r => r.name)).toEqual(["Studio Mac", "phone-tail"]);
    expect(clashes(rows, ...PHONE, "constantin-Venus-Series")).toEqual([]);
    // The slice is only left out where it costs the names their room: the
    // same network in a desktop window keeps it.
    expect(mapLayout(rows, 862, 693, "constantin-Venus-Series", captionOf).zone).not.toBeNull();
  });

  it("leaves a lone deck where it stands when its name is clear of the centre", () => {
    // The exact places a ring of one or two keeps are only given up to step
    // off the centre's name.
    const [one] = mapLayout([row({})], 862, 693, "mini").nodes;
    expect(one.angle).toBeCloseTo(0);
    const two = mapLayout([row({}), row({})], 862, 693, "mini").nodes;
    expect(two.map(n => Math.round(n.angle))).toEqual([0, 180]);
  });
});
