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
// Within a ring the order is the list's own, with the decks over the tailnet
// gathered into one arc, so a reader who knows the list finds the same
// machine in the same place.
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
const LABEL_H = 30;
const LABEL_MAX_W = 116;
const NAME_CH_W = 6.6;
/** How far a deck may slide round its ring to clear a name, per step, and
 *  how close it may come to its neighbours on that ring while it does. */
const EASE_STEP = 1.5;
const EASE_ROUNDS = 80;
const NEIGHBOUR_KEEP = 0.45;
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

/** The disc and the name box of a deck standing at (x, y). */
function footprint(row: DeckRow, tier: MapTier, x: number, y: number): [Box, Box] {
  const r = tier === "loose" ? LOOSE_DISC_R : DISC_R;
  const w = Math.min(LABEL_MAX_W, Math.max(2 * r, row.name.length * NAME_CH_W));
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
function easeApart(placed: Placed[]): void {
  const ringOf = new Map<MapRing, Placed[]>();
  for (const p of placed) {
    if (!ringOf.has(p.ring)) ringOf.set(p.ring, []);
    ringOf.get(p.ring)!.push(p);
  }
  for (let round = 0; round < EASE_ROUNDS; round++) {
    const boxes = placed.map(p => { const [x, y] = pointOf(p); return footprint(p.row, p.tier, x, y); });
    let moved = false;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const [discA, labelA] = boxes[i];
        const [discB, labelB] = boxes[j];
        if (!(overlaps(labelA, discB) || overlaps(labelB, discA) || overlaps(labelA, labelB) || overlaps(discA, discB))) continue;
        const a = placed[i];
        const b = placed[j];
        const mover = b.ring.ring > a.ring.ring || (b.ring === a.ring && j > i) ? b : a;
        const other = mover === b ? a : b;
        if (mover.count <= 2) continue;
        const dir = turnBetween(mover.theta, other.theta) >= 0 ? 1 : -1;
        const next = mover.theta + dir * EASE_STEP;
        // Not past a neighbour: the ring keeps the list's order.
        const mates = ringOf.get(mover.ring)!;
        const keep = (360 / mover.count) * NEIGHBOUR_KEEP;
        const ahead = mates[(mover.index + 1) % mover.count];
        const behind = mates[(mover.index - 1 + mover.count) % mover.count];
        const clear = dir > 0 ? turnBetween(ahead.theta, next) >= keep : turnBetween(next, behind.theta) >= keep;
        if (!clear) continue;
        mover.theta = next;
        moved = true;
      }
    }
    if (!moved) return;
  }
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
  const ax = Math.max(0, width / 2 - MAP_EDGE_X);
  const ay = Math.max(0, height / 2 - MAP_EDGE_Y);
  const spread = ringSpread(drawn.map(r => byRing.get(r)!.length), ax, ay);

  const rings: MapRing[] = drawn.map((ring, i) => ({
    ring, rx: ax * spread[i], ry: ay * spread[i], count: byRing.get(ring)!.length,
  }));

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
    const turn = 360 / n;
    const start = startAngle(n, r);
    const scattered = n > 2;
    members.forEach(({ row, tier }, j) => {
      const key = machineKey(row);
      const off = scattered ? scatter(key, 1) * SCATTER_TURN * turn : 0;
      const zigged = crowded && j % 2 === 1 ? 1 + zig / spread[r] : 1;
      // Inward only on the outer ring, where outward is the edge of the stage.
      const drift = scattered ? scatter(key, 2) * SCATTER_REACH : 0;
      placed.push({
        row, tier, ring, index: j, count: n,
        theta: start + turn * j + off,
        reach: zigged * (1 + (outer ? -Math.abs(drift) : drift)),
      });
    });
  });
  easeApart(placed);

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
  if (row.kind !== "paired") return row.via === "tailscale" ? `${row.state}, over Tailscale` : row.state;
  if (row.here) return row.via === "tailscale" ? "online, over Tailscale" : "online";
  const since = lastOnline(row);
  const quiet = since
    ? (since === "now" ? "offline · last online just now" : `offline · last online ${since}`)
    : row.state.startsWith("one-way") ? row.state : "offline";
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
