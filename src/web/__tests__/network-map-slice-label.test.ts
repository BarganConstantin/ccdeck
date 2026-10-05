// The tailnet slice's name ran through its own decks' names.
//
// The name runs along the slice's outer edge, centred, and the slice's decks
// hang their names below them — toward that edge, at the lower right. The edge
// was meant to stand a name's depth past the furthest deck, but it stops inside
// the stage, so for a deck on the last ring it stood barely past that deck's
// caption; and a lone tailnet deck stands at the middle of the slice, which is
// exactly where the centred name crossed it. `TAILSCALE · 1 DECK` was drawn
// through `work-laptop / away · 2h ago` in the common one-remote-laptop case.
//
// Now the layout says where along the edge the name goes: the middle when it
// is clear, the nearest clear stretch when it is not, and nowhere when none is.
// These tests lay the name's glyphs along the edge the way the map draws them
// and ask whether any lands on a deck.
import { describe, expect, it } from "vitest";

import { mapLayout, nodeBoxes, nodeCaption, type MapLayout } from "../lan-network-map";
import type { DeckRow } from "../lan-roster";
import { sourceOf } from "./client-source";

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

/** The words the slice is named with. */
const sliceName = (count: number) => `Tailscale · ${count} deck${count === 1 ? "" : "s"}`;

/** Where the slice's name is drawn, glyph by glyph, as points: along the edge
 *  6px inside the slice's outer one (`zoneArc`), walked from the slice's lower
 *  end to its upper one, centred at the layout's offset — the middle, for a
 *  layout that names none, as the map drew it until now — in 9px mono capitals
 *  (5.94px each) reaching 7px in toward the centre from the line. */
function labelPoints(layout: MapLayout): Array<[number, number]> {
  const z = layout.zone;
  if (!z || z.labelAt === null) return [];
  const e = { rx: z.outer.rx - 6, ry: z.outer.ry - 6 };
  const path: Array<[number, number, number]> = [];
  let length = 0;
  for (let deg = z.to; deg >= z.from; deg -= 0.1) {
    const rad = (deg * Math.PI) / 180;
    const x = Math.cos(rad) * e.rx;
    const y = Math.sin(rad) * e.ry;
    const prev = path.at(-1);
    if (prev) length += Math.hypot(x - prev[0], y - prev[1]);
    path.push([x, y, length]);
  }
  const middle = length * (z.labelAt ?? 0.5);
  const half = (sliceName(z.count).length * 5.94) / 2;
  const out: Array<[number, number]> = [];
  for (const [x, y, s] of path) {
    if (Math.abs(s - middle) > half) continue;
    const d = Math.hypot(x, y);
    for (let k = 0; k <= 7; k++) out.push([x - (x / d) * k, y - (y / d) * k]);
  }
  return out;
}

/** The decks a glyph of the slice's name lands on — their disc or their name. */
function decksUnderName(rows: DeckRow[], w: number, h: number, core: string): string[] {
  const captionOf = (r: DeckRow) => nodeCaption(r, "macOS 26.1");
  const layout = mapLayout(rows, w, h, core, captionOf);
  const inside = (b: Box, [x, y]: [number, number]) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  const points = labelPoints(layout);
  return nodeBoxes(layout, core, captionOf).decks
    .filter(d => points.some(p => inside(d.label, p) || inside(d.disc, p)))
    .map(d => layout.nodes.find(n => n.row.fp === d.key)!.row.name);
}

describe("the tailnet slice's name", () => {
  it("does not run through a lone remote deck's name on the outer ring", () => {
    // Two decks on the local network, and one laptop over Tailscale that is
    // away — the stage of a 1280x720 window.
    const rows = [row({}), row({}), row({ here: false, via: "tailscale", name: "work-laptop", state: "last online 2h ago" })];
    const layout = mapLayout(rows, 864, 535, "constantin-thinkpad");
    expect(layout.zone).not.toBeNull();
    expect(layout.zone!.labelAt).not.toBeNull();
    expect(decksUnderName(rows, 864, 535, "constantin-thinkpad")).toEqual([]);
  });

  it("does not run through a nearby tailnet deck's name", () => {
    const rows = [
      row({}), row({}), row({ here: false, state: "last online 3h ago" }),
      row({ kind: "nearby", via: "tailscale", name: "phone-tail", state: "not paired yet" }),
    ];
    expect(decksUnderName(rows, 862, 534, "constantin-Venus-Series")).toEqual([]);
  });

  it("crosses no deck at any of the stages a window gives the map", () => {
    const networks: Array<() => DeckRow[]> = [
      () => [row({}), row({ via: "tailscale", here: false, name: "Deniss-MacBook-Pro", state: "last online 9h ago" })],
      () => [row({}), row({}), row({ here: false }), row({ kind: "nearby", via: "tailscale", name: "Evghenis-MacBook-Pro" })],
      () => [
        ...Array.from({ length: 4 }, () => row({})), row({ via: "tailscale", name: "Home Ubuntu" }),
        ...Array.from({ length: 2 }, () => row({ here: false, state: "last online 2h ago" })),
        row({ via: "tailscale", here: false, name: "mac-mini-office", state: "last online 5h ago" }),
        row({ kind: "nearby", via: "tailscale", name: "build-01", state: "not paired yet" }),
      ],
      () => [
        ...Array.from({ length: 6 }, (_, i) => row({ name: `Office-PC-${i}` })),
        row({ via: "tailscale", name: "Constantin Windows" }), row({ via: "tailscale", name: "Vitalie" }),
        ...Array.from({ length: 6 }, (_, i) => row({ name: `laptop-${i}`, here: false, state: "last online 4h ago" })),
        row({ via: "tailscale", here: false, name: "Kobe-Macbook", state: "last online 1h ago" }),
        ...Array.from({ length: 3 }, (_, i) => row({ kind: "nearby", name: `nearby-${i}`, state: "not paired yet" })),
        row({ kind: "nearby", via: "tailscale", name: "Vitalie-phone", state: "not paired yet" }),
      ],
    ];
    const stages: Array<[number, number]> = [[862, 693], [862, 534], [1180, 900], [918, 406]];
    const crossed: string[] = [];
    for (const network of networks) {
      for (const [w, h] of stages) {
        const hit = decksUnderName(network(), w, h, "constantin-Venus-Series");
        if (hit.length) crossed.push(`${w}x${h}: ${hit.join(", ")}`);
      }
    }
    expect(crossed).toEqual([]);
  });

  it("stays in the middle of the edge when nothing stands in its way", () => {
    // The tailnet deck on the inner ring, so its name hangs well inside the
    // slice's edge.
    const rows = [row({}), row({ via: "tailscale", name: "nas" }), row({ here: false }), row({ kind: "nearby" })];
    expect(mapLayout(rows, 862, 693, "mini").zone!.labelAt).toBe(0.5);
  });

  it("is drawn where the layout puts it, and not at all where it puts it nowhere", () => {
    const map = sourceOf("components/LanNetworkMap.tsx");
    expect(map).toMatch(/zone\.labelAt != null && \(/);
    expect(map).toMatch(/startOffset=\{`\$\{\(zone\.labelAt \* 100\)\.toFixed\(2\)\}%`\}/);
    expect(map).toMatch(/\{zoneLabel\(zone\.count\)\}/);
  });
});
