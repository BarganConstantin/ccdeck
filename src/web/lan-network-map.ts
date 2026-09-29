// Where every deck stands on the network map, and what the map says about the
// network as a whole.
//
// THE MAP IS A STAR, BECAUSE THE DATA IS ONE. This deck knows which decks it
// can reach and which can reach it; no frame on the wire carries another
// deck's list of peers, so a line between two peers would be a claim nothing
// here can back. Every wire runs from the centre, and the centre is this deck.
//
// DISTANCE IS THE RELATIONSHIP, ANGLE IS THE ORDER. The paired decks that are
// on stand on the inner ring; everything else — a paired deck that has gone
// quiet, a machine heard nearby, one asking, an address still being dialled —
// stands on the outer one. So the one thing a glance takes from the picture,
// before any word is read, is how much of the network is actually there.
// Which of the outer kinds a deck is, its mark and its wire say: hollow and
// dashed for paired and quiet, dashed and dotted for nothing shared yet.
//
// TWO RINGS, NOT THREE, and that is what the first drawing on a real network
// of fifteen decks decided. Three rings in the width a dialog has left each
// ring under a hundred pixels from the next, and a name set beside or under
// a deck is wider than that — the inner ring's names landed on the outer
// ring's decks. Within a ring the order is the list's own, quiet paired decks
// before the rest, with the decks over the tailnet gathered into one arc, so
// a reader who knows the list finds the same machine in the same place.
//
// A layout with a closed form needs no engine. React Flow is already in the
// bundle, but what it adds is pan, zoom and drag, and none of that belongs in
// a picture made to be looked at; a force simulation would put every deck
// somewhere else each time the map opens. This is a function of the rows and
// the size of the stage, and nothing else, which is also what makes it
// testable without a DOM.
import type { DeckRow } from "./lan-roster";
import type { LanStatus } from "./lan-types";

/** Which ring a deck stands on. `declined` is on none: somebody here already
 *  said no to it, and a machine drawn on the map is a machine the map is
 *  saying something about. It is counted in the summary instead. */
export type MapTier = "online" | "offline" | "loose";

/** In the order a ring lists them. */
export const MAP_TIERS: readonly MapTier[] = ["online", "offline", "loose"];

/** Which ring each tier stands on, innermost 0. */
export const RING_OF: Record<MapTier, number> = { online: 0, offline: 1, loose: 1 };

export function mapTier(row: DeckRow): MapTier | null {
  if (row.kind === "declined") return null;
  if (row.kind === "paired") return row.here ? "online" : "offline";
  return "loose";
}

/** Where a deck's name goes: over the decks along the top of the map, so the
 *  name is not set on its own wire coming up from the centre, and under every
 *  other. Never beside: a name beside a deck on the inner ring reached the
 *  outer ring's decks. */
export type LabelSide = "top" | "bottom";

export interface MapNode {
  row: DeckRow;
  tier: MapTier;
  /** Which ring it stands on, 0 innermost. */
  ring: number;
  /** From the centre of the stage, in pixels. */
  x: number;
  y: number;
  /** The direction of the deck from the centre, clockwise from three
   *  o'clock, in degrees — as CSS `rotate` reads it, for the wire. On an
   *  ellipse that is not the angle the deck was placed at, and a wire turned
   *  to the placing angle misses every deck but the four on the axes. */
  angle: number;
  /** From the centre to the deck's own centre. */
  dist: number;
  side: LabelSide;
  /** Its place in the entrance — ring by ring, clockwise inside each. */
  order: number;
}

export interface MapRing { ring: number; rx: number; ry: number; count: number }

export interface MapLayout {
  nodes: MapNode[];
  rings: MapRing[];
  /** A ring that could not give each deck its minimum room, so every other
   *  deck on it stands a step out. The stylesheet reads it to set names a
   *  size smaller, because a zig-zag ring is a crowded one. */
  dense: boolean;
}

/** The room the drawing needs outside the outer ring: half a name either
 *  side, and a name and the key under it. */
export const MAP_EDGE_X = 76;
export const MAP_EDGE_Y = 62;
/** The least distance, along a ring, between two decks' centres — a disc and
 *  a name either side of it. */
export const MAP_MIN_GAP = 96;
/** How far out, as a share of the stage's usable half, each ring stands, by
 *  how many rings there are. One ring alone is pulled in from the edge so the
 *  picture reads as a group rather than a frame. */
const RING_SPREAD: Record<number, readonly number[]> = {
  1: [0.62],
  2: [0.58, 1],
};
/** The step out a crowded ring's every other deck takes, as a share of the
 *  distance to the next ring out. */
const ZIG = 0.16;

/** Ramanujan's first approximation — within a fraction of a percent at every
 *  aspect ratio this stage can have. */
export function ellipsePerimeter(rx: number, ry: number): number {
  return Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
}

function sideOf(x: number, y: number): LabelSide {
  return y < -Math.abs(x) * 0.6 ? "top" : "bottom";
}

/** Where each ring starts. One deck alone stands at three o'clock — where the
 *  far machine stands in a deck's own dialog, so the two pictures agree — and
 *  two stand either side; from three on, the first stands at twelve. Each
 *  ring after the first is turned half a step, so a wire to the outer ring
 *  passes between two inner decks rather than through one. */
function startAngle(count: number, ring: number): number {
  if (count <= 2) return ring % 2 === 0 ? 0 : 90;
  const step = 360 / count;
  return -90 + (ring % 2 === 0 ? 0 : step / 2);
}

/** Quiet paired decks before the machines nothing is shared with, tailnet
 *  decks together inside each, and otherwise the list's own order — deckRows
 *  has already sorted by what is owed to whom and then by name. */
function ringOrder(rows: Array<{ row: DeckRow; tier: MapTier }>): Array<{ row: DeckRow; tier: MapTier }> {
  return rows
    .map((m, i) => ({ ...m, i }))
    .sort((a, b) => MAP_TIERS.indexOf(a.tier) - MAP_TIERS.indexOf(b.tier)
      || Number(a.row.via === "tailscale") - Number(b.row.via === "tailscale")
      || a.i - b.i)
    .map(({ row, tier }) => ({ row, tier }));
}

export function mapLayout(rows: DeckRow[], width: number, height: number): MapLayout {
  const byRing = new Map<number, Array<{ row: DeckRow; tier: MapTier }>>();
  for (const row of rows) {
    const tier = mapTier(row);
    if (!tier) continue;
    const r = RING_OF[tier];
    if (!byRing.has(r)) byRing.set(r, []);
    byRing.get(r)!.push({ row, tier });
  }
  const drawn = [...byRing.keys()].sort((a, b) => a - b);
  const spread = RING_SPREAD[drawn.length] ?? [];
  const ax = Math.max(0, width / 2 - MAP_EDGE_X);
  const ay = Math.max(0, height / 2 - MAP_EDGE_Y);

  const rings: MapRing[] = drawn.map((ring, i) => ({
    ring, rx: ax * spread[i], ry: ay * spread[i], count: byRing.get(ring)!.length,
  }));

  const nodes: MapNode[] = [];
  let dense = false;
  let order = 0;
  rings.forEach((ring, r) => {
    const members = ringOrder(byRing.get(ring.ring)!);
    const n = members.length;
    const crowded = n > 1 && ellipsePerimeter(ring.rx, ring.ry) / n < MAP_MIN_GAP;
    if (crowded) dense = true;
    // The step out is toward the next ring; the outer ring steps in instead,
    // since outside it is the edge.
    const outer = r === rings.length - 1;
    const step = outer ? -ZIG * (spread[r] - (spread[r - 1] ?? 0)) : ZIG * (spread[r + 1] - spread[r]);
    const start = startAngle(n, r);
    members.forEach(({ row, tier }, j) => {
      const placed = ((start + (360 / n) * j) * Math.PI) / 180;
      const reach = crowded && j % 2 === 1 ? 1 + step / spread[r] : 1;
      const x = Math.cos(placed) * ring.rx * reach;
      const y = Math.sin(placed) * ring.ry * reach;
      nodes.push({
        row, tier, ring: ring.ring, x, y,
        angle: normalised((Math.atan2(y, x) * 180) / Math.PI),
        dist: Math.hypot(x, y),
        side: sideOf(x, y),
        order: order++,
      });
    });
  });
  return { nodes, rings, dense };
}

function normalised(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

export interface MapSummary {
  paired: number;
  online: number;
  offline: number;
  nearby: number;
  asks: number;
  dialling: number;
  declined: number;
  tailnet: number;
}

/** The counts the map's header and its resting inspector say, from the same
 *  rows the rings are drawn from. */
export function mapSummary(rows: DeckRow[]): MapSummary {
  const count = (test: (r: DeckRow) => boolean) => rows.filter(test).length;
  return {
    paired: count(r => r.kind === "paired"),
    online: count(r => r.kind === "paired" && r.here),
    offline: count(r => r.kind === "paired" && !r.here),
    nearby: count(r => r.kind === "nearby"),
    asks: count(r => r.kind === "asks"),
    dialling: count(r => r.kind === "dialling"),
    declined: count(r => r.kind === "declined"),
    tailnet: count(r => r.kind !== "declined" && r.via === "tailscale"),
  };
}

/** The line under the map's title. Paired decks first, because that is the
 *  number the row that opens the map already said — `9 of 15 online` — and a
 *  dialog that led with a different count would make a reader check whether
 *  the two were counting different things. */
export function mapHeadline(s: MapSummary): string {
  const parts: string[] = [];
  if (s.paired === 0) parts.push("no paired decks yet");
  else if (s.online === s.paired) parts.push(`${s.paired} paired deck${s.paired === 1 ? "" : "s"}, all online`);
  else parts.push(`${s.online} of ${s.paired} paired deck${s.paired === 1 ? "" : "s"} online`);
  if (s.asks) parts.push(`${s.asks} asking to pair`);
  if (s.nearby) parts.push(`${s.nearby} nearby, not paired`);
  if (s.dialling) parts.push(`${s.dialling} still dialling`);
  return parts.join(" · ");
}

/** The one short line under a deck's name on the map. The map is about who
 *  is there, so it carries what tells two decks apart at a glance — what a
 *  live machine runs, and how long a quiet one has been quiet.
 *
 *  NOT WHAT THE LAST ROUND DID. `0 of 1 logins arrived` under half the decks
 *  on a real network read as half the network in trouble, in the attention
 *  colour, about a detail of one sync that says nothing about the machine;
 *  the first person to see it said it told them nothing. The round stays in
 *  the list and in the deck's own dialog, where it is one fact among the
 *  others rather than the caption of every machine. */
export function nodeCaption(row: DeckRow, os: string | null | undefined): string {
  switch (row.kind) {
    case "asks": return "wants to pair";
    case "nearby": return row.state;
    case "dialling": return "dialling";
    case "declined": return "declined";
    case "paired": {
      if (row.here) return os ? shortOs(os) : "online";
      const since = lastOnline(row);
      if (since) return since === "now" ? "offline · just now" : `offline · ${since}`;
      return row.state.startsWith("one-way") ? "one-way · quiet" : "offline";
    }
  }
}

/** Whether a deck is there, in a sentence: the list's presence word without
 *  the round the list appends to it. */
export function presenceLine(row: DeckRow): string {
  if (row.kind !== "paired") return row.state;
  if (row.here) return row.via === "tailscale" ? "online, over Tailscale" : "online";
  const since = lastOnline(row);
  if (since) return since === "now" ? "offline · last online just now" : `offline · last online ${since}`;
  return row.state.startsWith("one-way") ? row.state : "offline";
}

function lastOnline(row: DeckRow): string | null {
  return /last online (.+)$/.exec(row.state)?.[1] ?? null;
}

/** `macOS 26.0` reads whole at 10px; `Ubuntu 24.04.1 LTS` does not, and the
 *  inspector has the rest. */
export function shortOs(os: string): string {
  const words = os.trim().split(/\s+/);
  return words.slice(0, 2).join(" ");
}

/** This deck's addresses, in the order somebody types one: the local network
 *  first, then the tailnet's. */
export function ownAddresses(status: Pick<LanStatus, "addrs" | "port" | "tailscale"> | null): string[] {
  if (!status) return [];
  const out = (status.addrs ?? []).map(a => `${a}:${status.port}`);
  const ts = status.tailscale?.addr;
  if (ts && !(status.addrs ?? []).includes(ts)) out.push(`${ts}:${status.port}`);
  return out;
}
