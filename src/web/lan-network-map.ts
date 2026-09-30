// Where every deck stands on the network map, and what the map says about the
// network as a whole.
//
// THE MAP IS A STAR, BECAUSE THE DATA IS ONE. This deck knows which decks it
// can reach and which can reach it; no frame on the wire carries another
// deck's list of peers, so a line between two peers would be a claim nothing
// here can back. Every wire runs from the centre, and the centre is this deck.
//
// DISTANCE IS THE RELATIONSHIP, ANGLE IS THE ORDER. Three rings, innermost
// first: the paired decks that are on, the paired decks that have gone quiet,
// and — outside, in grey — the machines nothing is shared with yet: heard
// nearby, asking, or an address still being dialled. So the one thing a
// glance takes from the picture, before any word is read, is how much of the
// network is actually there, and how much of the rest is yours.
//
// THREE RINGS AGAIN, after a spell as two. The first drawing on a real
// network of fifteen decks set each name beside its deck, and in the width a
// dialog has, three rings left each ring under a hundred pixels from the
// next — the inner ring's names landed on the outer ring's decks, so the
// rings were merged. Names have sat over and under their decks since then,
// which needs height rather than width, and the three fit. A ring that holds
// more decks than its circumference has room for is widened toward the next
// one first, so a busy office's inner ring does not crowd.
//
// NOT A CLOCK FACE. Evenly spaced on perfect ellipses, the decks read as a
// diagram of a network rather than a network. Each one stands a little off
// its even place — a few degrees round, a few percent in or out — by an
// amount drawn from the machine's own identity, so the picture is the same
// every time it opens and a deck never wanders between two polls. Rings of
// one or two keep their exact places: two decks are a line, not a scatter.
//
// THE TAILNET HAS A ZONE OF ITS OWN. A deck reached over Tailscale is on
// another network — often another building — and a dashed wire among the
// solid ones said so to nobody who had not read the key. So every tailnet
// deck, whatever ring it is on, stands in one slice of the map at its lower
// right, and the slice is drawn: a faint ground, an edge, and its name along
// the outside. The rings still say the relationship inside it. Without a
// tailnet deck, or with nothing else, there is no slice.
//
// Within a ring the order is the list's own, so a reader who knows the list
// finds the same machine in the same place.
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
export const RING_OF: Record<MapTier, number> = { online: 0, offline: 1, loose: 2 };

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

/** The tailnet's slice: between two angles, clockwise from three o'clock in
 *  the rings' own parameter, and between an inner and an outer ellipse. */
export interface MapZone {
  from: number;
  to: number;
  inner: { rx: number; ry: number };
  outer: { rx: number; ry: number };
  count: number;
}

export interface MapLayout {
  nodes: MapNode[];
  rings: MapRing[];
  zone: MapZone | null;
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
  3: [0.42, 0.72, 1],
};
/** The least a ring widened for its decks may leave between itself and the
 *  next one out, as a share of the stage's usable half. */
const RING_STEP = 0.2;
/** How far off its even place a deck may stand: a share of the step between
 *  two decks round the ring, and a share of its ring's distance in or out. */
const SCATTER_TURN = 0.16;
const SCATTER_REACH = 0.05;
/** A deck's disc, and the box its name and caption take, as the stylesheet
 *  draws them — see `.nm-node` and `.nm-label`. Estimated here rather than
 *  measured, so the layout stays a function with no DOM in it; the glyph
 *  widths are the 12px sans's and 10px mono's average. */
const DISC_R = 20;
const LOOSE_DISC_R = 17;
const LABEL_GAP = 7;
const LABEL_TALL = 30;
const LABEL_MAX_W = 116;
const NAME_CH_W = 6.6;
/** How far a deck may slide round its ring to clear a name, per step, and
 *  how close it may come to its neighbours on that ring while it does. */
const EASE_STEP = 1.5;
const EASE_ROUNDS = 80;
const NEIGHBOUR_KEEP = 0.45;
/** Where the tailnet's slice is centred — the lower right, clockwise from
 *  three o'clock — and how wide it may be: its share of the decks, held
 *  between the two so one tailnet deck still gets a slice worth reading and
 *  a mostly-tailnet network still leaves the room its own decks need. */
const ZONE_AT = 40;
const ZONE_MIN = 64;
const ZONE_MAX = 150;
/** The slice's inner and outer edges, as shares of the stage's usable half:
 *  clear of this deck's name at the centre, and a little outside the last
 *  ring, where the slice's own name runs. */
const ZONE_INNER = 0.3;
/** Past the slice's furthest deck by a name's depth and then the slice's own
 *  name, in pixels: its decks' names hang below them, and the slice's name
 *  runs along its outer edge, and the two must not meet. Nothing else stands
 *  out there — no deck off the tailnet is ever placed inside the slice. */
const ZONE_OUTER_PAD_PX = 84;
/** A tailnet deck's room in its slice, as a share over the least gap a ring
 *  gives any deck: a slice's decks sit at its edges' mercy as well as each
 *  other's. */
const ZONE_ROOM = 1.3;
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

/** Tailnet decks together, and otherwise the list's own order — deckRows has
 *  already sorted by what is owed to whom and then by name. */
function ringOrder(rows: Array<{ row: DeckRow; tier: MapTier }>): Array<{ row: DeckRow; tier: MapTier }> {
  return rows
    .map((m, i) => ({ ...m, i }))
    .sort((a, b) => MAP_TIERS.indexOf(a.tier) - MAP_TIERS.indexOf(b.tier)
      || Number(a.row.via === "tailscale") - Number(b.row.via === "tailscale")
      || a.i - b.i)
    .map(({ row, tier }) => ({ row, tier }));
}

/** A number in [-1, 1) that belongs to one machine and one purpose: FNV-1a
 *  over its key, salted, so its turn and its reach do not move together. */
function scatter(key: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 20_000) / 10_000 - 1;
}

/** How far out each drawn ring stands: its share of the usable half, widened
 *  where it holds more decks than it has room for, never closer than
 *  RING_STEP to the ring outside it. */
function ringSpread(counts: number[], ax: number, ay: number): number[] {
  const spread = [...(RING_SPREAD[counts.length] ?? [])];
  for (let i = 0; i < spread.length; i++) {
    const n = counts[i];
    if (n < 2) continue;
    const room = ellipsePerimeter(ax * spread[i], ay * spread[i]) / n;
    if (!(room > 0) || room >= MAP_MIN_GAP) continue;
    const ceiling = i + 1 < spread.length ? spread[i + 1] - RING_STEP : 1;
    // A little over the exact answer: perimeter is linear in the spread, and
    // landing on the gap to the last decimal still reads as crowded.
    spread[i] = Math.max(spread[i], Math.min(ceiling, spread[i] * (MAP_MIN_GAP / room) * 1.02));
  }
  return spread;
}

interface Box { x0: number; y0: number; x1: number; y1: number }

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** A crowded ring's names: a step smaller, and without the line under them —
 *  see `.nm-stage[data-dense]`. A deck asking to pair keeps its line, so its
 *  box keeps the height. */
const DENSE_LABEL = { h: 16, ch: 6.1, maxW: 100 };

/** This deck's own name at the centre, on its plate: the one box every deck
 *  has to stay clear of wherever it stands. See `.nm-core-label`. */
function coreBox(coreName: string): Box {
  const w = coreName ? Math.max(80, coreName.length * 7.2 + 16) : 128;
  return { x0: -w / 2, y0: 32, x1: w / 2, y1: 66 };
}

/** The disc and the name box of a deck standing at (x, y). */
function footprint(row: DeckRow, tier: MapTier, x: number, y: number, dense = false): [Box, Box] {
  const r = tier === "loose" ? LOOSE_DISC_R : DISC_R;
  const tall = !dense || row.kind === "asks";
  const LABEL_H = tall ? LABEL_TALL : DENSE_LABEL.h;
  const ch = dense ? DENSE_LABEL.ch : NAME_CH_W;
  const w = Math.min(dense ? DENSE_LABEL.maxW : LABEL_MAX_W, Math.max(2 * r, nodeName(row).length * ch));
  const disc = { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
  const label = sideOf(x, y) === "top"
    ? { x0: x - w / 2, y0: y - r - LABEL_GAP - LABEL_H, x1: x + w / 2, y1: y - r - LABEL_GAP }
    : { x0: x - w / 2, y0: y + r + LABEL_GAP, x1: x + w / 2, y1: y + r + LABEL_GAP + LABEL_H };
  return [disc, label];
}

/** A deck as the layout moves it: where round its ring it stands, how far
 *  out, and on which ring of how many. */
interface Placed {
  row: DeckRow;
  tier: MapTier;
  ring: MapRing;
  index: number;
  count: number;
  theta: number;
  reach: number;
  /** The arc it may not leave while it is eased: its slice, or the rest. */
  lo: number;
  hi: number;
}

const pointOf = (p: Placed): [number, number] => {
  const rad = (p.theta * Math.PI) / 180;
  return [Math.cos(rad) * p.ring.rx * p.reach, Math.sin(rad) * p.ring.ry * p.reach];
};

/** The signed turn from `b` to `a`, the short way round. */
const turnBetween = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

/**
 * NO NAME ON ANOTHER DECK. Evenly spaced rings still put one ring's names on
 * the next ring's decks wherever the two happen to line up — over the top of
 * the inner ring, and beside it at nine and three. So every pair whose disc
 * or name boxes meet is eased apart: the deck further out slides a step round
 * its ring, away from the other, until nothing meets or the rounds run out.
 * Never past a neighbour on its own ring, so the order the list gives is the
 * order the ring keeps; and never a ring of one or two, whose places are
 * exact. Deterministic, like everything else here.
 */
function easeApart(placed: Placed[], dense: boolean, core: Box): boolean {
  const ringOf = new Map<MapRing, Placed[]>();
  for (const p of placed) {
    if (!ringOf.has(p.ring)) ringOf.set(p.ring, []);
    ringOf.get(p.ring)!.push(p);
  }
  const boxesNow = () => placed.map(p => { const [x, y] = pointOf(p); return footprint(p.row, p.tier, x, y, dense); });
  /** Slide `mover` a step away from `from`, if its ring and its arc allow. */
  const slide = (mover: Placed, dir: number): boolean => {
    if (mover.count <= 2) return false;
    const next = mover.theta + dir * EASE_STEP;
    // Not past a neighbour: the ring keeps the list's order.
    const mates = ringOf.get(mover.ring)!;
    const keep = (360 / mover.count) * NEIGHBOUR_KEEP;
    const ahead = mates[(mover.index + 1) % mover.count];
    const behind = mates[(mover.index - 1 + mover.count) % mover.count];
    const clear = dir > 0 ? turnBetween(ahead.theta, next) >= keep : turnBetween(next, behind.theta) >= keep;
    if (!clear || next < mover.lo || next > mover.hi) return false;
    mover.theta = next;
    return true;
  };
  const meets = ([discA, labelA]: [Box, Box], [discB, labelB]: [Box, Box]) =>
    overlaps(labelA, discB) || overlaps(labelB, discA) || overlaps(labelA, labelB) || overlaps(discA, discB);
  const onCore = ([disc, label]: [Box, Box]) => overlaps(disc, core) || overlaps(label, core);

  for (let round = 0; round < EASE_ROUNDS; round++) {
    const boxes = boxesNow();
    let moved = false;
    for (let i = 0; i < placed.length; i++) {
      // THE CENTRE'S NAME IS AN OBSTACLE TOO. It hangs under the orb, so a
      // deck at six o'clock whose name lands on it turns away from six.
      if (onCore(boxes[i])) {
        moved = slide(placed[i], turnBetween(placed[i].theta, 90) >= 0 ? 1 : -1) || moved;
      }
      for (let j = i + 1; j < placed.length; j++) {
        if (!meets(boxes[i], boxes[j])) continue;
        const a = placed[i];
        const b = placed[j];
        const mover = b.ring.ring > a.ring.ring || (b.ring === a.ring && j > i) ? b : a;
        const other = mover === b ? a : b;
        moved = slide(mover, turnBetween(mover.theta, other.theta) >= 0 ? 1 : -1) || moved;
      }
    }
    if (!moved) break;
  }
  // Whether it worked: nothing still meets anything, and nothing meets the
  // centre's name.
  const boxes = boxesNow();
  for (let i = 0; i < boxes.length; i++) {
    if (onCore(boxes[i])) return false;
    for (let j = i + 1; j < boxes.length; j++) if (meets(boxes[i], boxes[j])) return false;
  }
  return true;
}

/** The rings when three cannot hold their names — see mapLayout: the decks
 *  that are away and the ones not paired share the outer ring, and their
 *  marks, wires and captions still tell them apart. */
const RING_OF_FOLDED: Record<MapTier, number> = { online: 0, offline: 1, loose: 1 };

export function mapLayout(rows: DeckRow[], width: number, height: number, coreName = ""): MapLayout {
  // THREE RINGS WHERE THEY FIT, TWO WHERE THEY DO NOT. In a short stage — a
  // narrow window stacks the panel under the picture — three rings sit fifty
  // pixels apart top to bottom, and a name is forty. When the three cannot be
  // cleared even with the dense names, the outer two fold into one, which
  // buys the height back; the tiers keep their own marks and strokes on it.
  const three = placeRings(rows, width, height, coreName, RING_OF);
  if (three.clear || three.layout.rings.length < 3) return three.layout;
  const two = placeRings(rows, width, height, coreName, RING_OF_FOLDED);
  return two.clear ? two.layout : three.layout;
}

function placeRings(
  rows: DeckRow[], width: number, height: number, coreName: string, ringOf: Record<MapTier, number>,
): { layout: MapLayout; clear: boolean } {
  const byRing = new Map<number, Array<{ row: DeckRow; tier: MapTier }>>();
  for (const row of rows) {
    const tier = mapTier(row);
    if (!tier) continue;
    const r = ringOf[tier];
    if (!byRing.has(r)) byRing.set(r, []);
    byRing.get(r)!.push({ row, tier });
  }
  const drawn = [...byRing.keys()].sort((a, b) => a - b);
  const ax = Math.max(0, width / 2 - MAP_EDGE_X);
  const ay = Math.max(0, height / 2 - MAP_EDGE_Y);
  const spread = ringSpread(drawn.map(r => byRing.get(r)!.length), ax, ay);

  const rings: MapRing[] = drawn.map((ring, i) => ({
    ring, rx: ax * spread[i], ry: ay * spread[i], count: byRing.get(ring)!.length,
  }));

  // THE SLICE, when there is one to draw: its share of the decks on the map,
  // or the arc its busiest ring needs to give each of its decks a name's
  // room, whichever is wider — between the two bounds, centred on the lower
  // right. A share alone gave two tailnet decks on one ring a slice too
  // narrow for two names side by side.
  const onMap = rings.reduce((n, r) => n + r.count, 0);
  const isTailnet = (m: { row: DeckRow }) => m.row.via === "tailscale";
  const overTailnet = [...byRing.values()].flat().filter(isTailnet).length;
  const needed = Math.max(0, ...rings.map(ring => {
    const k = byRing.get(ring.ring)!.filter(isTailnet).length;
    const around = ellipsePerimeter(ring.rx, ring.ry);
    return k > 0 && around > 0 ? ((k * MAP_MIN_GAP * ZONE_ROOM) / around) * 360 : 0;
  }));
  const zoneWidth = overTailnet > 0 && overTailnet < onMap
    ? Math.min(ZONE_MAX, Math.max(ZONE_MIN, (overTailnet / onMap) * 360, needed))
    : 0;
  const zoneFrom = ZONE_AT - zoneWidth / 2;
  const zoneTo = ZONE_AT + zoneWidth / 2;

  const placed: Placed[] = [];
  let dense = false;
  rings.forEach((ring, r) => {
    const members = ringOrder(byRing.get(ring.ring)!);
    const n = members.length;
    const crowded = n > 1 && ellipsePerimeter(ring.rx, ring.ry) / n < MAP_MIN_GAP;
    if (crowded) dense = true;
    // The step out is toward the next ring; the outer ring steps in instead,
    // since outside it is the edge.
    const outer = r === rings.length - 1;
    const zig = outer ? -ZIG * (spread[r] - (spread[r - 1] ?? 0)) : ZIG * (spread[r + 1] - spread[r]);
    // Two arcs when there is a slice — the local network's, clockwise from
    // the slice's far edge round to its near one, then the slice — and one
    // whole ring when there is not.
    const groups = zoneWidth > 0
      ? [
        { members: members.filter(m => m.row.via !== "tailscale"), from: zoneTo, width: 360 - zoneWidth },
        { members: members.filter(m => m.row.via === "tailscale"), from: zoneFrom + 360, width: zoneWidth },
      ]
      : [{ members, from: null as number | null, width: 360 }];
    let j = 0;
    for (const group of groups) {
      const count = group.members.length;
      if (count === 0) continue;
      const turn = group.width / count;
      const scattered = count > 2;
      group.members.forEach(({ row, tier }, k) => {
        const key = machineKey(row);
        const even = group.from == null ? startAngle(count, r) + turn * k : group.from + turn * (k + 0.5);
        const off = scattered ? scatter(key, 1) * SCATTER_TURN * turn : 0;
        const zigged = crowded && j % 2 === 1 ? 1 + zig / spread[r] : 1;
        // Inward only on the outer ring, where outward is the edge of the stage.
        const drift = scattered ? scatter(key, 2) * SCATTER_REACH : 0;
        const margin = turn * 0.3;
        placed.push({
          row, tier, ring, index: j, count: n,
          theta: even + off,
          reach: zigged * (1 + (outer ? -Math.abs(drift) : drift)),
          lo: group.from == null ? -Infinity : group.from + margin,
          hi: group.from == null ? Infinity : group.from + group.width - margin,
        });
        j++;
      });
    }
  });
  // A RING THAT CANNOT CLEAR ITS NAMES GOES DENSE. A ring can have the room
  // round it and still land names on a neighbour's disc; rather than guess a
  // size at which that starts, the layout eases with the full names, and if
  // something still meets, it eases again with the dense ones — the step
  // smaller, captionless names the stylesheet draws under `data-dense`.
  const core = coreBox(coreName);
  let clear = easeApart(placed, dense, core);
  if (!clear && !dense) {
    dense = true;
    clear = easeApart(placed, true, core);
  }

  const nodes: MapNode[] = placed.map((p, order) => {
    const [x, y] = pointOf(p);
    return {
      row: p.row, tier: p.tier, ring: p.ring.ring, x, y,
      angle: normalised((Math.atan2(y, x) * 180) / Math.PI),
      dist: Math.hypot(x, y),
      side: sideOf(x, y),
      order,
    };
  });
  // Out only as far as its own decks: a slice reaching the stage's last ring
  // for two decks on the first is a large empty shape saying nothing.
  const reached = rings.reduce((far, ring, i) =>
    (byRing.get(ring.ring)!.some(isTailnet) ? Math.max(far, spread[i]) : far), 0);
  const zone: MapZone | null = zoneWidth > 0
    ? {
      from: zoneFrom,
      to: zoneTo,
      inner: { rx: ax * ZONE_INNER, ry: ay * ZONE_INNER },
      outer: {
        rx: Math.min(width / 2 - 8, ax * reached + ZONE_OUTER_PAD_PX),
        ry: Math.min(height / 2 - 8, ay * reached + ZONE_OUTER_PAD_PX),
      },
      count: overTailnet,
    }
    : null;
  return { layout: { nodes, rings, zone, dense }, clear };
}

/** The boxes a laid-out map draws — every deck's disc and name, and this
 *  deck's own name at the centre — by the same rule the layout eased them
 *  with. Offset to the stage's centre at 0, 0. */
export function nodeBoxes(layout: MapLayout, coreName = ""): { core: Box; decks: Array<{ key: string; disc: Box; label: Box }> } {
  return {
    core: coreBox(coreName),
    decks: layout.nodes.map(n => {
      const [disc, label] = footprint(n.row, n.tier, n.x, n.y, layout.dense);
      return { key: machineKey(n.row), disc, label };
    }),
  };
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
  /** Paired decks that are away and only ever call in: this deck has no
   *  address to reach them on. */
  oneWay: number;
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
    oneWay: count(r => r.kind === "paired" && !r.here && r.state.startsWith("one-way")),
  };
}

/** The line under the map's title. A deck asking to pair leads, in the
 *  words the row that opens the map uses for it, because it is somebody
 *  waiting on this keyboard. Then the paired decks, because that is the number
 *  the row already said — `9 of 15 online` — and a dialog that led with a
 *  different count would make a reader check whether the two were counting
 *  different things. */
export function mapHeadline(s: MapSummary): string {
  const parts: string[] = [];
  if (s.asks) parts.push(s.asks === 1 ? "1 deck wants to pair" : `${s.asks} decks want to pair`);
  if (s.paired === 0) parts.push("no paired decks yet");
  else if (s.paired === 1) parts.push(s.online ? "1 paired deck, online" : "1 paired deck, away");
  else if (s.online === s.paired) parts.push(`${s.paired} paired decks, all online`);
  else parts.push(`${s.online} of ${s.paired} paired decks online`);
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
    // An address is named by its host, so its port goes under it.
    case "dialling": return namedByHost(row) ? `${row.name.slice(row.addr.length)} · dialling` : "dialling";
    case "declined": return "declined";
    case "paired": {
      if (row.here) return os ? shortOs(os) : "online";
      const since = lastOnline(row);
      if (since) return since === "now" ? "away · just now" : `away · ${since}`;
      // The list's own words for a deck that calls in and has not yet.
      return row.state.startsWith("one-way") ? "has not called yet" : "away";
    }
  }
}

/** A deck's name as the map draws it. An address still being dialled is
 *  `192.168.1.153:55731` — a port nobody reads at a glance — so the map names
 *  it by its host and puts the port on the line under it. */
export function nodeName(row: DeckRow): string {
  return namedByHost(row) ? row.addr : row.name;
}

function namedByHost(row: DeckRow): boolean {
  return row.kind === "dialling" && !!row.addr && row.name.startsWith(`${row.addr}:`);
}

/** Whether a deck is there, in a sentence: the list's presence word without
 *  the round the list appends to it. */
export function presenceLine(row: DeckRow): string {
  if (row.kind !== "paired") return row.via === "tailscale" ? `${row.state}, over Tailscale` : row.state;
  if (row.here) return row.via === "tailscale" ? "online, over Tailscale" : "online";
  const since = lastOnline(row);
  // AWAY, NOT OFFLINE: the list's own word for these ("6 ready · 8 away"),
  // and the honest one — a deck that only calls in may well be switched on.
  const quiet = since
    ? (since === "now" ? "away · last online just now" : `away · last online ${since}`)
    : row.state.startsWith("one-way") ? row.state : "away";
  return row.via === "tailscale" ? `${quiet}, over Tailscale` : quiet;
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

/** The machine a row stands for, as a key that survives its twins trading
 *  places. A machine running two decks is one row whose lead — and so whose
 *  `fp` — is whichever of the two answered last (see oneRowPerMachine), so a
 *  row's own fp can change between two polls while the machine does not. The
 *  least of its decks' fingerprints does not. */
export function machineKey(row: Pick<DeckRow, "fp" | "twins">): string {
  let least = row.fp;
  for (const t of row.twins ?? []) if (t.fp < least) least = t.fp;
  return least;
}

/** The next angle for a wire that already stands at `prev`, turned the short
 *  way round. A wire at 350° whose deck moves to 10° would otherwise sweep
 *  back through the whole circle, since CSS eases the two numbers and not the
 *  direction. Unbounded on purpose: 370° and 10° point the same way. */
export function continuousAngle(prev: number | undefined, next: number): number {
  if (prev == null) return next;
  const delta = ((((next - prev) % 360) + 540) % 360) - 180;
  return prev + delta;
}

/**
 * The one thing worth doing about the network, for the panel with nothing
 * pointed at — the first that applies, in the order a person would want to
 * hear them: somebody waiting on this keyboard, then decks this one cannot
 * reach back, then addresses answering nothing, then machines not yet paired.
 * Every verb names a control that exists where it says.
 */
export function networkNextStep(s: MapSummary): string | null {
  if (s.asks) {
    return s.asks === 1
      ? "1 deck wants to pair. Answer it in the Local network list, behind this map."
      : `${s.asks} decks want to pair. Answer them in the Local network list, behind this map.`;
  }
  if (s.oneWay) {
    return `${s.oneWay} away deck${s.oneWay === 1 ? " only calls" : "s only call"} in, and this deck has no address to call `
      + `${s.oneWay === 1 ? "it" : "them"} on. Add ${s.oneWay === 1 ? "its address" : "their addresses"} through Add a deck `
      + `to reach ${s.oneWay === 1 ? "it" : "them"} both ways.`;
  }
  if (s.dialling) {
    return s.dialling === 1
      ? "1 address has never answered. Open it to stop dialling it."
      : `${s.dialling} addresses have never answered. Open one to stop dialling it.`;
  }
  if (s.nearby) {
    return s.nearby === 1
      ? "1 deck nearby is not paired. Open it to ask to pair."
      : `${s.nearby} decks nearby are not paired. Open one to ask to pair.`;
  }
  return null;
}

/** What to do about one deck that is not online, in its panel — or nothing,
 *  for a deck that is on or simply away. */
export function deckNextStep(row: DeckRow, pairingMode?: "automatic" | "invite"): string | null {
  switch (row.kind) {
    case "asks": return "It is waiting for an answer. Answer it in the Local network list, behind this map.";
    case "dialling": return "Nothing has answered at this address yet. Its own dialog can stop dialling it.";
    case "nearby":
      return pairingMode === "invite"
        ? "This deck pairs by invite only. Send one from Add a deck."
        : "Nothing is shared with it yet. Its own dialog can ask to pair.";
    case "paired":
      return !row.here && row.state.startsWith("one-way")
        ? "It calls this deck, and this deck has no address to call it back on. Add its address through Add a deck to reach it both ways."
        : null;
    default: return null;
  }
}

/** Logins with something wrong first, then the rest, each group in the order
 *  it came — so the six the panel has room for include every one that needs a
 *  look. A copy: the deck's own dialog draws the exchange's own order. */
export function troubleFirst<T extends { tone: "ok" | "wait" | "bad" | "idle" }>(lanes: readonly T[]): T[] {
  const rank = { bad: 0, wait: 1, idle: 2, ok: 3 } as const;
  return lanes.map((l, i) => ({ l, i })).sort((a, b) => rank[a.l.tone] - rank[b.l.tone] || a.i - b.i).map(({ l }) => l);
}
