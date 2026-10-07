// The history's graph in the git view's Fork look: Fork's geometry (22px rows,
// lanes 11px apart from 22.5px in, 1.6px lines, a 5px dot, a 13.6px ring with
// a chevron), every turn a circular quarter arc and never a diagonal, rows
// that meet exactly, and Fork's colours mapped onto the deck's stable branch
// slots so a live commit never repaints a line.
import { describe, expect, it } from "vitest";
import {
  layoutGraph, forkRowDrawing, forkNodeReach, forkLane, lookGraphWidth, graphColumns, graphWidth,
  FORK_GEOMETRY, FORK_ROW_INSET, FORK_LANE_OF_SLOT, FORK_DIAMOND, DECK_GEOMETRY, VISIBLE_LANES,
  type GraphLayout, type GraphRow, type LogCommit, type NodeShape,
} from "../git-graph-layout";
import { shopHistory, HISTORY_HEAD } from "./git-graph-history";

const HEAD = { sha: HISTORY_HEAD, branch: "develop", detached: false, short: HISTORY_HEAD, unborn: false };
const G = FORK_GEOMETRY;
const H = G.rowH;
const M = H / 2;

function c(sha: string, parents: string[] = [], local: string[] = [], extra: Partial<LogCommit> = {}): LogCommit {
  return {
    sha, parents, author: { name: "A", email: "a@example.com" }, date: "2026-10-05T16:00:00Z",
    subject: extra.subject ?? `commit ${sha}`, trailers: [], refs: { local, remote: [], tags: [], head: false },
    agent: null, ...extra,
  };
}

// ─── reading a Fork path ──────────────────────────────────────────────────

type Seg = { cmd: "M" | "V" | "H" | "A"; x0: number; y0: number; x: number; y: number; r?: number; sweep?: number };

/** A path's segments; only M, V, H and A may appear in a Fork stroke. */
function segments(d: string): Seg[] {
  const t = d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g)!;
  const out: Seg[] = [];
  let i = 0, x = 0, y = 0;
  const num = () => Number(t[i++]);
  while (i < t.length) {
    const cmd = t[i++];
    const x0 = x, y0 = y;
    if (cmd === "M") { x = num(); y = num(); }
    else if (cmd === "V") y = num();
    else if (cmd === "H") x = num();
    else if (cmd === "A") {
      const r = num(); num(); num(); num(); const sweep = num(); x = num(); y = num();
      out.push({ cmd, x0, y0, x, y, r, sweep });
      continue;
    } else throw new Error(`a Fork stroke draws only M, V, H and arcs; found ${cmd} in ${d}`);
    out.push({ cmd: cmd as Seg["cmd"], x0, y0, x, y });
  }
  return out;
}

/** The centre of a quarter arc, by the SVG rule (small arc, sweep direction). */
function arcCentre(s: Seg): [number, number] {
  const cands: Array<[number, number]> = [[s.x0, s.y], [s.x, s.y0]];
  for (const [cx, cy] of cands) {
    const a0 = Math.atan2(s.y0 - cy, s.x0 - cx), a1 = Math.atan2(s.y - cy, s.x - cx);
    const delta = s.sweep ? (a1 - a0 + 2 * Math.PI) % (2 * Math.PI) : (a0 - a1 + 2 * Math.PI) % (2 * Math.PI);
    if (delta <= Math.PI + 1e-6) return [cx, cy];
  }
  throw new Error("no centre");
}

/** Points along a path, half a pixel apart or closer. */
function sample(d: string): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (const s of segments(d)) {
    if (s.cmd === "M") { pts.push([s.x, s.y]); continue; }
    if (s.cmd !== "A") {
      for (let k = 1; k <= 64; k++) pts.push([s.x0 + (s.x - s.x0) * k / 64, s.y0 + (s.y - s.y0) * k / 64]);
      continue;
    }
    const [cx, cy] = arcCentre(s);
    const a0 = Math.atan2(s.y0 - cy, s.x0 - cx);
    let a1 = Math.atan2(s.y - cy, s.x - cx);
    if (s.sweep && a1 < a0) a1 += 2 * Math.PI;
    if (!s.sweep && a1 > a0) a1 -= 2 * Math.PI;
    for (let k = 1; k <= 64; k++) { const a = a0 + (a1 - a0) * k / 64; pts.push([cx + s.r! * Math.cos(a), cy + s.r! * Math.sin(a)]); }
  }
  return pts;
}

/** Everything a Fork stroke is held to: arcs that are true quarter circles
 *  turning smoothly out of and into straight runs, a vertical crossing of
 *  the row's top and bottom edges, and nothing outside the row's box. */
function strokeFaults(d: string): string[] {
  const out: string[] = [];
  const segs = segments(d);
  segs.forEach((s, k) => {
    if (s.cmd !== "A") return;
    if (Math.abs(Math.abs(s.x - s.x0) - s.r!) > 0.02 || Math.abs(Math.abs(s.y - s.y0) - s.r!) > 0.02) out.push(`not a quarter arc: ${d}`);
    const [cx, cy] = arcCentre(s);
    const prev = segs[k - 1], next = segs[k + 1];
    // Out of a vertical run the centre is level with the start; out of a
    // horizontal one it is plumb under or over it. The same into the next.
    if (prev && prev.cmd === "V" && Math.abs(cy - s.y0) > 0.02) out.push(`a turn kinks out of a vertical run: ${d}`);
    if (prev && prev.cmd === "H" && Math.abs(cx - s.x0) > 0.02) out.push(`a turn kinks out of a horizontal run: ${d}`);
    if (next && next.cmd === "V" && Math.abs(cy - s.y) > 0.02) out.push(`a turn kinks into a vertical run: ${d}`);
    if (next && next.cmd === "H" && Math.abs(cx - s.x) > 0.02) out.push(`a turn kinks into a horizontal run: ${d}`);
  });
  if (segs[0].y === 0 && segs[1]?.cmd !== "V") out.push(`leaves the top edge other than straight down: ${d}`);
  const last = segs[segs.length - 1];
  if (Math.abs(last.y - H) < 0.01 && last.cmd !== "V") out.push(`reaches the bottom edge other than straight down: ${d}`);
  for (const [, y] of sample(d)) if (y < -0.01 || y > H + 0.01) { out.push(`leaves the row's box: ${d}`); break; }
  return out;
}

const shapeOf = (row: GraphRow): NodeShape => (row.kind === "merge" ? "merge" : "commit");

/** The x of every point where a path touches y = `at`. */
function touches(d: string, at: number): number[] {
  return segments(d).filter(s => Math.abs(s.y - at) < 0.01 || (s.cmd === "M" && Math.abs(s.y - at) < 0.01)).map(s => Math.round(s.x * 100) / 100);
}

function seamBreaks(layout: GraphLayout): string[] {
  const { folded } = graphColumns(layout.columns);
  const xs = (row: GraphRow, at: number) => {
    const d = forkRowDrawing(row, shapeOf(row), layout.headKey, folded);
    return [...new Set([...d.strokes.map(s => s.d), ...(d.fold ? [d.fold] : [])].flatMap(p => touches(p, at)))].sort((a, b) => a - b).join(",");
  };
  const out: string[] = [];
  layout.rows.forEach((row, r) => {
    const below = layout.rows[r + 1];
    if (!below || row.outside || below.outside) return;
    if (xs(row, H) !== xs(below, 0)) out.push(`${row.id} → ${below.id}: leaves at [${xs(row, H)}], enters at [${xs(below, 0)}]`);
  });
  return out;
}

/** Every stroke of every row held to strokeFaults, and no lane drawn close to
 *  a commit it does not belong to. */
function drawingFaults(layout: GraphLayout): string[] {
  const out: string[] = [];
  const { folded } = graphColumns(layout.columns);
  layout.rows.forEach((row, r) => {
    if (row.outside) return;
    const shape = shapeOf(row);
    const d = forkRowDrawing(row, shape, layout.headKey, folded);
    for (const s of d.strokes) {
      out.push(...strokeFaults(s.d).map(f => `row ${r} (${row.id}): ${f}`));
      if (d.folded || s.kind !== "pass") continue;
      for (const [x, y] of sample(s.d)) {
        const dist = Math.hypot(x - d.x, y - d.y);
        if (dist < G.ring + 1) { out.push(`row ${r} (${row.id}): a lane passes ${dist.toFixed(1)}px from a commit it does not belong to (${s.d})`); break; }
      }
    }
    // A lane joined to a dot or a diamond stops at its outline; only a ring's
    // hollow can hold a line's end, and the row masks it there.
    if (shape !== "merge" && !d.folded) {
      for (const s of d.strokes.filter(x => x.kind !== "pass")) {
        for (const [x, y] of sample(s.d)) if (Math.hypot(x - d.x, y - d.y) < forkNodeReach(shape) - 0.6) { out.push(`row ${r}: an edge runs inside its own node (${s.d})`); break; }
      }
    }
  });
  return out;
}

/** A seeded random history: branches forking, merging back, octopus merges. */
function randomHistory(seed: number, size: number, maxTips: number): LogCommit[] {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const made: LogCommit[] = [c("r0")];
  const tips: Array<{ name: string; sha: string }> = [{ name: "main", sha: "r0" }];
  let n = 1;
  while (made.length < size) {
    const roll = rnd();
    const sha = `c${n++}`;
    if (roll < 0.15 && tips.length < maxTips) { tips.push({ name: `b${n}`, sha: made[Math.floor(rnd() * made.length)].sha }); continue; }
    const t = tips[Math.floor(rnd() * tips.length)];
    if (roll < 0.35 && tips.length > 1) {
      const others = tips.filter(x => x !== t);
      const picks = others.sort(() => rnd() - 0.5).slice(0, rnd() < 0.1 && others.length > 1 ? 2 : 1).map(x => x.sha);
      made.push(c(sha, [t.sha, ...picks]));
      if (rnd() < 0.5) { const gone = others.find(x => x.sha === picks[0]); if (gone && gone.name !== "main") tips.splice(tips.indexOf(gone), 1); }
    } else made.push(c(sha, [t.sha]));
    t.sha = sha;
  }
  for (const t of tips) { const at = made.find(x => x.sha === t.sha)!; at.refs = { ...at.refs, local: [...at.refs.local, t.name] }; }
  // Child first, newest first among the ready.
  const list = made.reverse();
  const kids = new Map(list.map(x => [x.sha, 0]));
  for (const x of list) for (const p of x.parents) kids.set(p, (kids.get(p) ?? 0) + 1);
  const order = new Map(list.map((x, i) => [x.sha, i]));
  const by = new Map(list.map(x => [x.sha, x]));
  const ready = list.filter(x => kids.get(x.sha) === 0);
  const out: LogCommit[] = [];
  while (ready.length) {
    ready.sort((a, b) => order.get(a.sha)! - order.get(b.sha)!);
    const x = ready.shift()!;
    out.push(x);
    for (const p of x.parents) { kids.set(p, kids.get(p)! - 1); if (kids.get(p) === 0) ready.push(by.get(p)!); }
  }
  return out;
}

// ─── geometry ─────────────────────────────────────────────────────────────

describe("Fork's geometry", () => {
  it("is 22px rows, lanes 11px apart, the first 22.5px from the pane's edge, 1.6px lines, a 5px dot and a 13.6px ring", () => {
    expect(G.rowH).toBe(22);
    expect(G.laneW).toBe(11);
    expect(FORK_ROW_INSET + G.laneX0).toBe(22.5);
    expect(G.line).toBe(1.6);
    expect(G.dot * 2).toBe(5);
    expect(G.ring * 2 + G.line).toBeCloseTo(13.6, 5);
    expect(G.elbow).toBe(7);
    expect(FORK_DIAMOND * 2).toBe(8);
    // The deck's geometry is the one it always had.
    expect(DECK_GEOMETRY).toMatchObject({ rowH: 24, laneW: 12, laneX0: 7, textGap: 8 });
    for (const n of [1, 3, 7]) expect(lookGraphWidth(n, DECK_GEOMETRY)).toBe(graphWidth(n));
  });

  it("starts the subject 10.5px after the rightmost lane, one width for the whole list", () => {
    for (const n of [1, 2, 7]) expect(lookGraphWidth(n, G) - (G.laneX0 + (n - 1) * G.laneW)).toBe(10.5);
  });

  it("stops lines at a ring's inner edge and at a hollow diamond's outline", () => {
    expect(forkNodeReach("merge")).toBeCloseTo(6 - 0.8, 5);
    expect(forkNodeReach("trailer")).toBeCloseTo(4.65, 5);
    expect(forkNodeReach("commit")).toBeLessThan(G.dot);
    expect(forkNodeReach("seen")).toBeLessThan(FORK_DIAMOND);
  });

  it("turns a lane ending at a node on a 7px quarter arc, and a lane moving a column on two 5px ones", () => {
    // b is a branch of a; a's row has the branch's lane coming in from the right.
    const layout = layoutGraph([c("m", ["a"], ["main"]), c("b", ["a"], ["topic"]), c("a")], { head: { sha: "m", branch: "main", detached: false } });
    const a = layout.rows.find(r => r.id === "a")!;
    const into = forkRowDrawing(a, "commit", layout.headKey, 0).strokes.find(s => s.kind === "in" && /A/.test(s.d))!;
    const x0 = G.laneX0, x1 = G.laneX0 + G.laneW;
    expect(into.d).toBe(`M${x1} 0V${M - 7}A7 7 0 0 1 ${x1 - 7} ${M}H${x0 + forkNodeReach("commit")}`);
    // A lane through a row a column over, as the layout closes a hole.
    const through: GraphRow = { id: "x", col: 0, key: "k", slot: 0, kind: "commit", outside: false, onHead: true, input: [], output: [],
      edges: [{ kind: "pass", from: 2, to: 1, key: "k2", slot: 3 }] };
    const d = forkRowDrawing(through, "commit", null, 0).strokes[0].d;
    expect(d).toMatch(/A5 5 0 0 1 .*A5 5 0 0 0 /);
    expect(strokeFaults(d)).toEqual([]);
  });

  it("leaves a node straight down, and turns its own line below the node, never beside it", () => {
    const row: GraphRow = { id: "x", col: 1, key: "k", slot: 0, kind: "commit", outside: false, onHead: true, input: [], output: [],
      edges: [{ kind: "fp", from: 1, to: 0, key: "k", slot: 0 }] };
    for (const shape of ["commit", "seen", "trailer", "merge"] as NodeShape[]) {
      const d = forkRowDrawing(row, shape, null, 0).strokes[0].d;
      const xn = G.laneX0 + G.laneW;
      expect(d.startsWith(`M${xn} ${Math.round((M + forkNodeReach(shape)) * 100) / 100}V`), `${shape}: ${d}`).toBe(true);
      expect(strokeFaults(d), shape).toEqual([]);
      // Every point left of the node's column is below the node's outline.
      for (const [x, y] of sample(d)) if (x < xn - 0.01) expect(y, `${shape}: ${d}`).toBeGreaterThan(M + forkNodeReach(shape) - 0.01);
    }
  });

  it("draws nothing but vertical runs, horizontal runs and quarter arcs, rows meeting exactly, on the 150-commit history and on random ones", () => {
    const cases: Array<[string, GraphLayout]> = [];
    for (const wip of [false, true]) cases.push([`the 150-commit history, wip=${wip}`, layoutGraph(shopHistory(), { head: HEAD, wip })]);
    for (let seed = 1; seed <= 16; seed++) {
      const list = randomHistory(seed, 150, seed % 2 ? 14 : 30);
      const tip = list.find(x => x.refs.local.length)!;
      cases.push([`seed ${seed}`, layoutGraph(list, { head: { sha: tip.sha, branch: tip.refs.local[0], detached: false } })]);
    }
    expect(cases.filter(([, l]) => graphColumns(l.columns).folded > 0).length).toBeGreaterThan(4);
    for (const [what, layout] of cases) {
      expect(seamBreaks(layout), what).toEqual([]);
      expect(drawingFaults(layout), what).toEqual([]);
    }
  });

  it("keeps the fold: six lanes, then one dashed column 6 lanes over", () => {
    const list = randomHistory(3, 150, 30);
    const tip = list.find(x => x.refs.local.length)!;
    const layout = layoutGraph(list, { head: { sha: tip.sha, branch: tip.refs.local[0], detached: false } });
    const { folded, drawn } = graphColumns(layout.columns);
    expect(folded).toBeGreaterThan(0);
    expect(drawn).toBe(VISIBLE_LANES + 1);
    const foldX = G.laneX0 + VISIBLE_LANES * G.laneW;
    const withFold = layout.rows.map(r => forkRowDrawing(r, shapeOf(r), layout.headKey, folded)).filter(d => d.fold);
    expect(withFold.length).toBeGreaterThan(0);
    for (const d of withFold) expect(d.fold).toMatch(new RegExp(`^M${foldX} (0|${M})V(${M}|${H})$`));
  });
});

// ─── colour ───────────────────────────────────────────────────────────────

describe("Fork's colours on the deck's stable slots", () => {
  it("paints HEAD's own line orange and maps every other slot onto the rest of Fork's palette", () => {
    expect(FORK_LANE_OF_SLOT).toEqual([1, 2, 5, 4, 3]);
    const layout = layoutGraph(shopHistory(60), { head: HEAD });
    const { folded } = graphColumns(layout.columns);
    const lanes = new Set<number>();
    for (const row of layout.rows) {
      const d = forkRowDrawing(row, shapeOf(row), layout.headKey, folded);
      for (const s of d.strokes) {
        const lane = s.focus ? 0 : FORK_LANE_OF_SLOT[s.slot];
        lanes.add(lane);
        if (s.focus) expect(lane).toBe(0);
        else expect(lane).not.toBe(0);
      }
      expect(forkLane(row, layout.headKey)).toBe(row.key === "develop" && row.onHead ? 0 : FORK_LANE_OF_SLOT[row.slot]);
    }
    expect(lanes.has(0)).toBe(true);
    // main is red when HEAD is develop; develop yellow when HEAD is not on it.
    const main = layout.rows.find(r => r.key === "main")!;
    expect(forkLane(main, layout.headKey)).toBe(2);
    const off = layoutGraph(shopHistory(60), { head: { sha: "c66f14c", branch: "feature/auth-login", detached: false } });
    const dev = off.rows.find(r => r.key === "develop")!;
    expect(forkLane(dev, off.headKey)).toBe(1);
  });

  it("never dims a lane", () => {
    const layout = layoutGraph(shopHistory(60), { head: HEAD });
    for (const row of layout.rows) for (const s of forkRowDrawing(row, shapeOf(row), layout.headKey, 0).strokes) expect(s.dim).toBe(false);
  });
});
