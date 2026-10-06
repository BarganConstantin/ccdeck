// The history's graph: lanes, merges, colours and tones, held on a real
// 150-commit history and on built worst cases.
//
// The checks that matter are the ones a reader's eye makes. A line must never
// run through a commit it does not belong to; two lines must never lie on top
// of each other; a lane moving over must bend beside its neighbours, not into
// them; and a new commit must never repaint a line that was already there.
// Those are checked as geometry, on the strokes the rows actually draw, as
// well as on the columns.
import { describe, it, expect } from "vitest";
import {
  layoutGraph, graphTones, baseTip, rowDrawing, onFocusLine, graphColumns, graphWidth, nodeReach,
  pickSlot, clashes, fixedSlot, mergedBranchName, branchKeyOf, seniority,
  parseSlotMemory, rememberSlots, repoSlots, historyAge, workDuration, conventionalPrefix,
  WIP_ID, VISIBLE_LANES, ROW_H, LANE_W, LANE_X0, SLOT_MEMORY_BRANCHES, SLOT_MEMORY_REPOS,
  type GraphLayout, type GraphRow, type LogCommit, type NodeShape,
} from "../git-graph-layout";
import { shopHistory, HISTORY_HEAD } from "./git-graph-history";

const HEAD = { sha: HISTORY_HEAD, branch: "develop", detached: false };

/** A commit for the built cases: parents and refs, nothing else matters. */
function c(sha: string, parents: string[] = [], local: string[] = [], extra: Partial<LogCommit> = {}): LogCommit {
  return {
    sha, parents, author: { name: "A", email: "a@example.com" }, date: "2026-10-05T16:00:00Z",
    subject: extra.subject ?? `commit ${sha}`, trailers: [], refs: { local, remote: [], tags: [], head: false },
    agent: null, ...extra,
  };
}

/** Child-first order, newest first among the ready, the way --topo-order lists. */
function topo(list: LogCommit[]): LogCommit[] {
  const by = new Map(list.map(x => [x.sha, x]));
  const kids = new Map(list.map(x => [x.sha, 0]));
  for (const x of list) for (const p of x.parents) if (kids.has(p)) kids.set(p, kids.get(p)! + 1);
  const order = new Map(list.map((x, i) => [x.sha, i]));
  const ready = list.filter(x => kids.get(x.sha) === 0);
  const out: LogCommit[] = [];
  while (ready.length) {
    ready.sort((a, b) => order.get(a.sha)! - order.get(b.sha)!);
    const x = ready.shift()!;
    out.push(x);
    for (const p of x.parents) {
      if (!by.has(p)) continue;
      kids.set(p, kids.get(p)! - 1);
      if (kids.get(p) === 0) ready.push(by.get(p)!);
    }
  }
  return out;
}

/** A seeded generator, so a failing random history is the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** A random history: branches forking off, committing, merging back, being
 *  merged into each other, octopus merges, back-merges. Newest first. */
function randomHistory(seed: number, size: number): LogCommit[] {
  const r = rng(seed);
  const made: LogCommit[] = [];
  const tips: Array<{ name: string; sha: string }> = [{ name: "main", sha: "r0" }];
  made.push(c("r0", [], []));
  let n = 1;
  while (made.length < size) {
    const roll = r();
    const sha = `c${n++}`;
    if (roll < 0.15 && tips.length < 14) {
      const from = made[Math.floor(r() * made.length)];
      tips.push({ name: `b${n}`, sha: from.sha });
      continue;
    }
    const t = tips[Math.floor(r() * tips.length)];
    if (roll < 0.35 && tips.length > 1) {
      const others = tips.filter(x => x !== t);
      const k = r() < 0.1 && others.length > 1 ? 2 : 1;
      const picks = others.sort(() => r() - 0.5).slice(0, k).map(x => x.sha);
      made.push(c(sha, [t.sha, ...picks]));
      if (r() < 0.5) {
        const gone = others.find(x => x.sha === picks[0]);
        if (gone && gone.name !== "main") tips.splice(tips.indexOf(gone), 1);
      }
    } else {
      made.push(c(sha, [t.sha]));
    }
    t.sha = sha;
  }
  for (const t of tips) {
    const at = made.find(x => x.sha === t.sha)!;
    at.refs = { ...at.refs, local: [...at.refs.local, t.name] };
  }
  return topo(made.reverse());
}

// ─── the invariants ───────────────────────────────────────────────────────

const lanesEqual = (a: GraphRow["output"], b: GraphRow["input"]) =>
  a.length === b.length && a.every((l, i) => (l === null ? b[i] === null : b[i] !== null && b[i]!.id === l.id && b[i]!.key === l.key && b[i]!.slot === l.slot));

/** Points along an SVG path made of M, V, H, Q and C commands, half a pixel
 *  apart or closer, each with the path's direction there. */
function samplePath(d: string): Array<[number, number, number, number]> {
  const tokens = d.match(/[MVHQC]|-?\d+(?:\.\d+)?/g)!;
  const pts: Array<[number, number, number, number]> = [];
  let x = 0, y = 0, i = 0;
  const num = () => Number(tokens[i++]);
  const push = (px: number, py: number, qx: number, qy: number) => {
    const len = Math.hypot(qx - px, qy - py) || 1;
    pts.push([qx, qy, (qx - px) / len, (qy - py) / len]);
  };
  const curve = (at: (u: number) => [number, number]) => {
    let [px, py] = [x, y];
    for (let t = 1; t <= 64; t++) { const [qx, qy] = at(t / 64); push(px, py, qx, qy); [px, py] = [qx, qy]; }
    [x, y] = [px, py];
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") { x = num(); y = num(); }
    else if (cmd === "V" || cmd === "H") {
      const to = num();
      const [x1, y1] = cmd === "V" ? [x, to] : [to, y];
      const [x0, y0] = [x, y];
      curve(u => [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]);
    } else if (cmd === "Q") {
      const [x0, y0] = [x, y];
      const cx = num(), cy = num(), ex = num(), ey = num();
      curve(u => { const v = 1 - u; return [v * v * x0 + 2 * v * u * cx + u * u * ex, v * v * y0 + 2 * v * u * cy + u * u * ey]; });
    } else if (cmd === "C") {
      const [x0, y0] = [x, y];
      const c1x = num(), c1y = num(), c2x = num(), c2y = num(), ex = num(), ey = num();
      curve(u => { const v = 1 - u; return [v ** 3 * x0 + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u ** 3 * ex, v ** 3 * y0 + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u ** 3 * ey]; });
    } else throw new Error(`unexpected ${cmd} in ${d}`);
  }
  return pts;
}

/**
 * Everything a reader's eye holds a graph to, row by row. Returns the broken
 * rules, so a failure names the row and the rule.
 */
function violations(layout: GraphLayout, commits: LogCommit[]): string[] {
  const out: string[] = [];
  const listed = new Set(commits.filter(x => !x.outsideWindow).map(x => x.sha));
  const byId = new Map(commits.map(x => [x.sha, x]));
  const rows = layout.rows;
  rows.forEach((row, r) => {
    const at = `row ${r} (${row.id})`;
    if (row.outside) {
      if (row.input.length || row.output.length || row.edges.length) out.push(`${at}: a lane runs through an older commit`);
      return;
    }
    const prev = rows[r - 1];
    if (prev && !prev.outside && !lanesEqual(prev.output, row.input)) out.push(`${at}: lanes leaving the row above are not the lanes entering it`);
    if (!prev && row.input.length) out.push(`${at}: the first row has lanes coming into it`);
    if (row.input[row.col] && row.input[row.col]!.id !== row.id) out.push(`${at}: a lane through the commit's own column does not end at it`);
    // Every lane waiting for this commit ends here, and no other lane does.
    row.input.forEach((l, j) => {
      if (!l) return;
      const ends = row.edges.some(e => e.kind === "in" && e.from === j);
      if ((l.id === row.id) !== ends) out.push(`${at}: lane ${j} waiting for ${l.id} ${ends ? "ends" : "runs on"} here`);
    });
    // Every parent is waited for below, by a lane that leaves this row.
    const commit = byId.get(row.id);
    // The uncommitted row's one parent is HEAD, wherever HEAD is listed.
    const parents = row.id === WIP_ID ? row.edges.filter(e => e.kind === "fp").map(e => row.output[e.to]?.id) : commit!.parents;
    for (const p of new Set(parents)) {
      if (!p) continue;
      if (!row.output.some(l => l && l.id === p)) out.push(`${at}: nothing leaves the row towards parent ${p}`);
      const toward = row.edges.some(e => (e.kind === "fp" || e.kind === "merge") && row.output[e.to]?.id === p);
      if (!toward) out.push(`${at}: no edge from the commit to parent ${p}`);
    }
    // Moves are one column at most, and only ever to the left.
    for (const e of row.edges) if (e.kind === "pass" || e.kind === "fp") {
      if (e.from - e.to > 1 || e.to > e.from) out.push(`${at}: a ${e.kind} lane moves from ${e.from} to ${e.to}`);
    }
    // A merge's new lane is right of every lane that reached the row.
    for (const e of row.edges) {
      const opened = e.kind === "merge" && !row.edges.some(p => p.kind === "pass" && p.to === e.to);
      if (opened && e.to < row.input.length) out.push(`${at}: a merge opens a lane in column ${e.to}, inside the ${row.input.length} columns that reached the row`);
    }
    // The horizontal runs of the row: from the lanes ending into the commit and
    // out to the lanes it joins or opens. Nothing bends across them, and no two
    // bends share a column band.
    let lo = row.col, hi = row.col;
    for (const e of row.edges) {
      if (e.kind === "in" && e.from !== row.col) { lo = Math.min(lo, e.from); hi = Math.max(hi, e.from); }
      if (e.kind === "merge") { lo = Math.min(lo, e.to); hi = Math.max(hi, e.to); }
    }
    const bands = new Set<number>();
    for (const e of row.edges) {
      if (e.kind !== "pass" || e.from === e.to) continue;
      const band = Math.min(e.from, e.to);
      if (bands.has(band)) out.push(`${at}: two lanes bend through the same columns`);
      bands.add(band);
      if (lo !== hi && band <= hi && band + 1 >= lo) out.push(`${at}: a lane bends across the row's own runs (${band}-${band + 1} in ${lo}-${hi})`);
      if (band === row.col || band + 1 === row.col) out.push(`${at}: a lane bends beside the commit's own column`);
    }
    // Every lane continuing to a listed commit is still waited for; a lane to
    // a commit outside the window runs on to the end.
    for (const l of row.output) if (l && l.id !== row.id && !listed.has(l.id) && byId.has(l.id) && !byId.get(l.id)!.outsideWindow) out.push(`${at}: a lane waits for ${l.id}, which is not listed`);
  });
  out.push(...geometry(layout));
  return out;
}

/** The drawn strokes: none comes near a node it is not joined to, and none
 *  overlaps another. */
function geometry(layout: GraphLayout): string[] {
  const out: string[] = [];
  const { folded } = graphColumns(layout.columns);
  layout.rows.forEach((row, r) => {
    if (row.outside) return;
    const shape: NodeShape = row.kind === "wip" ? "wip" : row.kind === "merge" ? "merge" : "commit";
    const drawing = rowDrawing(row, shape, layout.headKey, folded);
    if (drawing.folded) return;
    const reach = Math.max(nodeReach("seen"), 7.6);
    drawing.strokes.forEach(s => {
      const joined = s.kind !== "pass";
      const pts = samplePath(s.d);
      for (const [x, y] of pts) {
        if (y < -0.01 || y > ROW_H + 0.01) out.push(`row ${r}: a stroke leaves the row box (${s.d})`);
        const d = Math.hypot(x - drawing.x, y - drawing.y);
        if (!joined && d < reach + 1) { out.push(`row ${r} (${row.id}): a lane passes ${d.toFixed(1)}px from a commit it does not belong to (${s.d})`); break; }
        if (joined && d < nodeReach(shape) - 0.6) { out.push(`row ${r}: an edge runs inside its own node (${s.d})`); break; }
      }
    });
    // No two strokes lie on top of each other: a crossing is one point, an
    // overlap is a run of points close together going the same way. A merge
    // that joins a lane already waiting for its parent runs down that lane on
    // purpose, and lanes ending at one commit meet in it.
    const sampled = drawing.strokes.map(s => samplePath(s.d).filter(([, y]) => y > 1 && y < ROW_H - 1));
    const laneOf = (k: number) => {
      const s = drawing.strokes[k];
      const e = row.edges.find(x => x.kind === s.kind && x.slot === s.slot && rowDrawing({ ...row, edges: [x] }, shape, layout.headKey, folded).strokes[0]?.d === s.d);
      if (!e) return null;
      return e.kind === "pass" || e.kind === "merge" || e.kind === "fp" ? row.output[e.to]?.id ?? null : null;
    };
    for (let a = 0; a < sampled.length; a++) for (let b = a + 1; b < sampled.length; b++) {
      const sa = drawing.strokes[a], sb = drawing.strokes[b];
      if (sa.kind !== "pass" && sb.kind !== "pass") continue;
      const la = laneOf(a), lb = laneOf(b);
      if (la !== null && la === lb) continue;
      let run = 0;
      for (const [x1, y1, dx1, dy1] of sampled[a]) {
        const close = sampled[b].some(([x2, y2, dx2, dy2]) => Math.hypot(x1 - x2, y1 - y2) < 0.6 && Math.abs(dx1 * dy2 - dy1 * dx2) < 0.3);
        if (close) run++;
      }
      if (run > 6) out.push(`row ${r} (${row.id}): two strokes overlap (${sa.d} / ${sb.d})`);
    }
  });
  return out;
}

// ─── the real history ─────────────────────────────────────────────────────

describe("the 150-commit history", () => {
  const all = shopHistory();

  it("is the history the fixture describes", () => {
    expect(all).toHaveLength(150);
    expect(all.filter(x => x.parents.length > 1)).toHaveLength(29);
  });

  for (const [what, list] of [["the whole history", all], ["the 100-commit window", shopHistory(100)]] as const) {
    it(`lays out ${what} with every rule held, with and without the uncommitted row`, () => {
      for (const wip of [true, false]) {
        const layout = layoutGraph(list, { head: HEAD, wip });
        expect(violations(layout, [...list]), `wip=${wip}`).toEqual([]);
        expect(layout.rows).toHaveLength(list.length + (wip ? 1 : 0));
      }
    });
  }

  it("keeps HEAD's branch in the first column, joined to the uncommitted row", () => {
    const layout = layoutGraph(all, { head: HEAD, wip: true });
    expect(layout.rows[0]).toMatchObject({ id: WIP_ID, col: 0, kind: "wip" });
    const head = layout.rows.find(r => r.id === HISTORY_HEAD)!;
    expect(head.col).toBe(0);
    expect(head.edges.find(e => e.kind === "in")).toMatchObject({ from: 0, wip: true });
    expect(layout.headKey).toBe("develop");
  });

  it("gives develop and main their fixed colours, and every other branch one of the other three", () => {
    const layout = layoutGraph(all, { head: HEAD, wip: true });
    for (const row of layout.rows) {
      if (row.key === "develop") expect(row.slot).toBe(0);
      else if (row.key === "main") expect(row.slot).toBe(1);
    }
    for (const [key, slot] of layout.slots) expect([2, 3, 4, 1], key).toContain(slot);
  });

  it("names a merged lane after the branch its merge says it merged", () => {
    const layout = layoutGraph(all, { head: HEAD, wip: true });
    const merge = layout.rows.find(r => r.id === "2f2c90d")!;
    expect(merge.edges.find(e => e.kind === "merge")!.key).toBe("fix/cart-rounding-display");
    const back = layout.rows.find(r => r.id === "e341b0d")!;
    expect(back.key).toBe("feature/payments-v2");
    expect(back.edges.find(e => e.kind === "merge")!.key).toBe("develop");
  });

  it("measures develop against what it has not pushed: the two commits ahead are its own", () => {
    const tones = graphTones(all, HEAD);
    expect(tones.get("eb7170c")).toBe("own");
    expect(tones.get("ce73d51")).toBe("own");
    expect(tones.get("ebe97fb")).toBe("base");
    expect(tones.get("ab9d31e")).toBe("off"); // origin/develop is one ahead
    expect(tones.get("c66f14c")).toBe("off"); // another worktree's branch
    expect(baseTip(all, HEAD)).toBe("ab9d31e");
  });

  it("measures a feature branch against develop", () => {
    const head = { sha: "c66f14c", branch: "feature/auth-login", detached: false };
    const list = all.map(x => ({ ...x, refs: { ...x.refs, head: x.sha === "c66f14c" } }));
    const tones = graphTones(list, head);
    for (const own of ["c66f14c", "4402065", "65fecee", "bb50a24"]) expect(tones.get(own), own).toBe("own");
    expect(tones.get("dbebcb9")).toBe("base");
    expect(tones.get("eb7170c")).toBe("off");
    expect(baseTip(list, head)).toBe("eb7170c");
  });
});

// ─── built worst cases ────────────────────────────────────────────────────

describe("worst cases", () => {
  const check = (list: LogCommit[], head: { sha: string; branch: string | null; detached: boolean } | null = null, wip = false) => {
    const layout = layoutGraph(list, { head, wip });
    expect(violations(layout, list)).toEqual([]);
    return layout;
  };

  it("a lane ending on the rightmost column while the same row opens a merge lane: the new lane goes further right", () => {
    // m merges x; y's lane (rightmost) ends at m at the same time.
    const list = topo([c("y", ["m"], ["y"]), c("m", ["a", "x"], ["main"]), c("x", ["a"]), c("a")]);
    const layout = check(list);
    const m = layout.rows.find(r => r.id === "m")!;
    const ending = m.edges.find(e => e.kind === "in" && e.from !== m.col);
    const opened = m.edges.find(e => e.kind === "merge")!;
    if (ending) expect(opened.to).toBeGreaterThan(ending.from);
    expect(opened.to).toBeGreaterThanOrEqual(m.input.length);
  });

  it("an octopus merge opens its lanes side by side, right of everything", () => {
    const list = topo([c("o", ["a", "b", "d", "e"], ["main"]), c("b", ["a"]), c("d", ["a"]), c("e", ["a"]), c("a")]);
    const layout = check(list);
    const o = layout.rows[0];
    expect(o.edges.filter(e => e.kind === "merge").map(e => e.to)).toEqual([1, 2, 3]);
  });

  it("criss-cross merges", () => {
    const list = topo([
      c("m1", ["a2", "b2"], ["main"]), c("n1", ["b2", "a2"], ["topic"]),
      c("a2", ["a1", "b1"]), c("b2", ["b1", "a1"]), c("a1", ["r"]), c("b1", ["r"]), c("r"),
    ]);
    check(list);
  });

  it("twelve branches off one commit, each with a few commits, merged back in turn", () => {
    const list: LogCommit[] = [];
    let trunk = "t0";
    list.push(c("t0"));
    const tips: string[] = [];
    for (let b = 0; b < 12; b++) {
      let p = "t0";
      for (let k = 0; k < 3; k++) { const s = `b${b}c${k}`; list.push(c(s, [p])); p = s; }
      tips.push(p);
    }
    for (let b = 0; b < 6; b++) { const s = `m${b}`; list.push(c(s, [trunk, tips[b]])); trunk = s; }
    for (let b = 6; b < 12; b++) list.find(x => x.sha === tips[b])!.refs.local.push(`feature/${b}`);
    list.find(x => x.sha === trunk)!.refs.local.push("develop");
    const layout = check(topo(list.reverse()), { sha: trunk, branch: "develop", detached: false }, true);
    expect(layout.columns).toBeGreaterThan(VISIBLE_LANES + 1);
    // Where each branch's lane first appears, it does not sit beside a lane
    // whose colour it clashes with.
    for (const row of layout.rows) {
      const opened = row.input.length === 0 || !row.edges.some(e => e.kind === "in") ? row.col : -1;
      if (opened < 0 || !row.output[opened]) continue;
      const me = row.output[opened]!.slot;
      for (const side of [row.output[opened - 1], row.input[opened - 1]]) if (side) expect(clashes(me, side.slot), `${row.id} beside slot ${side.slot}`).toBe(false);
    }
    expect(graphColumns(layout.columns).folded).toBe(layout.columns - VISIBLE_LANES);
  });

  it("a merge into a lane to the commit's left", () => {
    // x on topic merges `a`, which main's lane (left of topic's) is waiting for.
    const list = topo([c("main1", ["a"], ["main"]), c("x", ["y", "a"], ["topic"]), c("y", ["a"]), c("a")]);
    check(list);
  });

  it("many lanes closing one hole at once bend in parallel, one column each", () => {
    // k1's lane ends at p beside main's, leaving a hole; on the next row the
    // three lanes right of it move over together.
    const list = [
      c("m", ["p", "k1"], ["main"]), c("b2", ["base"], ["b2"]), c("b3", ["base"], ["b3"]), c("b4", ["base"], ["b4"]),
      c("k1", ["p"]), c("p", ["q"]), c("q", ["base"]), c("base"),
    ];
    const layout = check(list);
    const p = layout.rows.find(r => r.id === "p")!;
    expect(p.output[1]).toBeNull(); // the hole, for this row
    const q = layout.rows.find(r => r.id === "q")!;
    expect(q.edges.filter(e => e.kind === "pass" && e.from !== e.to).map(e => [e.from, e.to])).toEqual([[2, 1], [3, 2], [4, 3]]);
  });

  it("the checker itself sees a lane through a commit and two lanes on top of each other", () => {
    const lane = (id: string) => ({ id, key: "x", slot: 3 });
    const through: GraphRow = {
      id: "n", col: 0, key: "x", slot: 3, kind: "commit", outside: false,
      input: [lane("n")], output: [lane("p")],
      edges: [{ kind: "in", from: 0, to: 0, key: "x", slot: 3 }, { kind: "fp", from: 0, to: 0, key: "x", slot: 3 }, { kind: "pass", from: 0, to: 0, key: "y", slot: 2 }],
    };
    const fake = { rows: [through], columns: 1, slots: new Map(), assigned: [], headKey: null } as GraphLayout;
    const found = violations(fake, [c("n", ["p"]), c("p")]);
    expect(found.some(v => v.includes("passes"))).toBe(true);
    expect(found.some(v => v.includes("overlap"))).toBe(true);
  });

  it("a history with the session's older commits after the window: no lane through them", () => {
    const list = [c("h", ["g"], ["main"]), c("g", ["f"]), { ...c("old1", ["old0"]), outsideWindow: true }, { ...c("old2", ["x"]), outsideWindow: true }];
    const layout = check(list, { sha: "h", branch: "main", detached: false }, true);
    const older = layout.rows.filter(r => r.outside);
    expect(older.map(r => r.id)).toEqual(["old1", "old2"]);
    for (const r of older) expect(r).toMatchObject({ col: 0, input: [], output: [], edges: [] });
  });

  it("an empty repository: the uncommitted row alone, with no line under it", () => {
    const layout = check([], { sha: null, branch: "main", detached: false } as never, true);
    expect(layout.rows).toEqual([expect.objectContaining({ id: WIP_ID, edges: [], output: [] })]);
  });

  it("random histories, thirty of them, every rule held", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const list = randomHistory(seed, 60 + (seed % 5) * 20);
      const tip = list.find(x => x.refs.local.length)!;
      const layout = layoutGraph(list, { head: { sha: tip.sha, branch: tip.refs.local[0], detached: false }, wip: seed % 2 === 0 });
      const broken = violations(layout, list);
      expect(broken, `seed ${seed}`).toEqual([]);
    }
  });
});

// ─── colour identity ──────────────────────────────────────────────────────

describe("lane colours are branch identity", () => {
  it("fixed slots for develop and main/master, none for anything else", () => {
    expect(fixedSlot("develop")).toBe(0);
    expect(fixedSlot("main")).toBe(1);
    expect(fixedSlot("master")).toBe(1);
    expect(fixedSlot("feature/x")).toBeNull();
  });

  it("a new branch avoids every slot in its row, lanes ending there included", () => {
    expect(pickSlot("feature/x", [3, 2], [], new Map())).toBe(4);
    expect(pickSlot("feature/x", [3, 4], [], new Map())).toBe(2);
  });

  it("and a slot that clashes with its neighbour for colour-blind readers", () => {
    // develop (teal) beside: pink and olive both clash with it, so indigo.
    for (const key of ["a", "b", "c", "feature/long-name"]) expect(pickSlot(key, [0], [0], new Map())).toBe(3);
    expect(clashes(0, 2) && clashes(0, 4) && clashes(1, 4) && clashes(2, 4)).toBe(true);
    expect(clashes(0, 3) || clashes(1, 3) || clashes(2, 3) || clashes(3, 4)).toBe(false);
  });

  it("borrows main's slot while main is not in the row, then the slot used longest ago", () => {
    expect(pickSlot("x", [2, 3, 4], [], new Map())).toBe(1);
    expect(pickSlot("x", [1, 2, 3, 4], [], new Map([[2, 9], [3, 4], [4, 7]]))).toBe(3);
  });

  it("adding a commit on top never changes an existing line's colour", () => {
    const base = shopHistory(100);
    const first = layoutGraph(base, { head: HEAD, wip: true });
    const colours = (l: GraphLayout) => new Map(l.rows.flatMap(r => [[`node ${r.id}`, r.slot], ...r.output.filter(Boolean).map(o => [`lane ${r.id}→${o!.id}`, o!.slot] as [string, number])]));
    const before = colours(first);
    // A new commit on develop, one on a new branch, and a merge of an
    // unmerged branch into develop: each on top of the last.
    const tops: LogCommit[] = [];
    const moved = base.map(x => ({ ...x, refs: { ...x.refs, local: x.refs.local.filter(b => b !== "develop"), head: false } }));
    tops.push(c("n1", [HISTORY_HEAD], ["develop"], { refs: { local: ["develop"], remote: [], tags: [], head: true } }));
    tops.unshift(c("n2", ["n1"], ["feature/new-thing"]));
    tops.unshift(c("n3", ["n1", "4270c7c"], [], { subject: "Merge branch 'feature/graphql-spike' into develop" }));
    for (let k = 1; k <= tops.length; k++) {
      const list = topo([...tops.slice(-k), ...moved]);
      const head = list.find(x => x.refs.head)?.sha ?? "n1";
      const next = layoutGraph(list, { head: { sha: head, branch: "develop", detached: false }, wip: true, slots: first.slots });
      const after = colours(next);
      for (const [what, slot] of before) if (what.startsWith("node ") && after.has(what) && what !== `node ${WIP_ID}`) expect(after.get(what), `${what} after ${k} new`).toBe(slot);
    }
  });

  it("remembers what it handed out, and hands the same again from the memory", () => {
    const list = shopHistory(100);
    const a = layoutGraph(list, { head: HEAD, wip: true });
    expect(a.assigned.length).toBeGreaterThan(5);
    const b = layoutGraph(list, { head: HEAD, wip: true, slots: a.slots });
    expect(b.assigned).toEqual([]);
    expect([...b.slots]).toEqual([...a.slots]);
  });

  it("branch identity: most senior local branch, else the remote's own name", () => {
    expect(branchKeyOf(c("x", [], ["feature/a", "develop"]))).toBe("develop");
    expect(branchKeyOf({ refs: { local: [], remote: ["upstream/x", "origin/x"], tags: [], head: false } })).toBe("x");
    expect(branchKeyOf({ refs: { local: [], remote: [], tags: ["v1"], head: false } })).toBeNull();
    expect(seniority("main")).toBeGreaterThan(seniority("develop"));
    expect(seniority("develop")).toBeGreaterThan(seniority("release/2.0"));
    expect(seniority("release/2.0")).toBeGreaterThan(seniority("feature/x"));
  });

  it("reads the merged branch out of every common merge subject", () => {
    expect(mergedBranchName("Merge branch 'feature/x'")).toBe("feature/x");
    expect(mergedBranchName("Merge branch 'feature/x' into 'develop'")).toBe("feature/x");
    expect(mergedBranchName("Merge pull request #35 from shopco/fix/cart-rounding-display")).toBe("fix/cart-rounding-display");
    expect(mergedBranchName("Merge remote-tracking branch 'origin/main'")).toBe("main");
    expect(mergedBranchName("feat: merge things")).toBeNull();
  });
});

describe("the remembered colours", () => {
  it("survives a store that holds garbage", () => {
    expect(parseSlotMemory(null)).toEqual({});
    expect(parseSlotMemory("{")).toEqual({});
    expect(parseSlotMemory("[1,2]")).toEqual({});
    expect(parseSlotMemory(JSON.stringify({ r: [["a", 2], ["b", 9], [3, 1], "x"] }))).toEqual({ r: [["a", 2]] });
  });

  it("keeps each repository's newest branches and the newest repositories", () => {
    let mem = {};
    for (let i = 0; i < SLOT_MEMORY_REPOS + 5; i++) mem = rememberSlots(mem, `repo${i}`, new Map([["a", 2]]), ["a"]);
    expect(Object.keys(mem)).toHaveLength(SLOT_MEMORY_REPOS);
    expect(Object.keys(mem)).not.toContain("repo0");
    const many = new Map(Array.from({ length: SLOT_MEMORY_BRANCHES + 20 }, (_, i) => [`b${i}`, 2] as [string, number]));
    const big = rememberSlots({}, "r", many, [...many.keys()]);
    expect(big.r).toHaveLength(SLOT_MEMORY_BRANCHES);
    expect(repoSlots(big, "r").has(`b${SLOT_MEMORY_BRANCHES + 19}`)).toBe(true);
    expect(repoSlots(big, "r").has("b0")).toBe(false);
  });
});

// ─── drawing ──────────────────────────────────────────────────────────────

describe("drawing a row", () => {
  it("folds past six lanes only when two or more would fold", () => {
    expect(graphColumns(6)).toEqual({ drawn: 6, folded: 0 });
    expect(graphColumns(7)).toEqual({ drawn: 7, folded: 0 });
    expect(graphColumns(12)).toEqual({ drawn: VISIBLE_LANES + 1, folded: 6 });
    expect(graphWidth(1)).toBe(LANE_X0 + 8);
    expect(graphWidth(7) - graphWidth(6)).toBe(LANE_W);
  });

  it("dims every line but HEAD's, and widens HEAD's", () => {
    const layout = layoutGraph(shopHistory(40), { head: HEAD, wip: true });
    const merge = layout.rows.find(r => r.id === "2f2c90d")!;
    const d = rowDrawing(merge, "merge", "develop", 0);
    const fp = d.strokes.find(s => s.kind === "fp")!;
    const branch = d.strokes.find(s => s.kind === "merge")!;
    expect(fp).toMatchObject({ dim: false, focus: true });
    expect(branch).toMatchObject({ dim: true, focus: false });
    const wip = rowDrawing(layout.rows[0], "wip", "develop", 0);
    expect(wip.strokes.every(s => s.wip && !s.dim)).toBe(true);
  });

  it("draws an unpulled commit of HEAD's own branch dim, like any line HEAD cannot reach", () => {
    // origin/develop is one ahead of HEAD (develop): same branch name, but
    // HEAD does not stand on it.
    const layout = layoutGraph(shopHistory(40), { head: HEAD, wip: true });
    const ahead = layout.rows.find(r => r.id === "ab9d31e")!;
    expect(ahead).toMatchObject({ key: "develop", onHead: false });
    expect(onFocusLine(ahead, layout.headKey)).toBe(false);
    const own = rowDrawing(ahead, "commit", layout.headKey, 0).strokes.filter(s => s.kind === "fp");
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ dim: true, focus: false });
    const base = layout.rows.find(r => r.id === "ebe97fb")!;
    expect(base.onHead).toBe(true);
    expect(onFocusLine(base, layout.headKey)).toBe(true);
    // Its line down into develop leaves from a commit HEAD cannot reach.
    const below = layout.rows.find(r => r.id === "908be5d")!;
    const fromAhead = rowDrawing(layout.rows[layout.rows.indexOf(ahead) + 1], "commit", layout.headKey, 0).strokes.filter(s => !s.focus && !s.wip);
    expect(fromAhead.every(s => s.dim)).toBe(true);
    expect(below.onHead).toBe(true);
  });

  it("dims what a detached HEAD cannot reach, though the branch it sits on is newer", () => {
    // main went on past the commit HEAD is detached at.
    const list = [c("m3", ["m2"], ["main"]), c("m2", ["m1"]), c("m1", ["h"]), c("h", ["b"]), c("b")];
    const head = { sha: "h", branch: null, detached: true };
    const layout = layoutGraph(list, { head, wip: true });
    const focus = layout.headKey;
    expect(focus).not.toBeNull();
    for (const id of ["m3", "m2", "m1"]) {
      const row = layout.rows.find(r => r.id === id)!;
      expect(onFocusLine(row, focus), id).toBe(false);
      for (const s of rowDrawing(row, "commit", focus, 0).strokes) if (!s.wip) expect(s.dim, `${id} ${s.d}`).toBe(true);
    }
    for (const id of ["h", "b"]) expect(onFocusLine(layout.rows.find(r => r.id === id)!, focus), id).toBe(true);
    expect(violations(layout, list)).toEqual([]);
  });

  it("keeps the dashed line from the uncommitted row dashed where a merge joins it", () => {
    // main's release merge takes HEAD (develop's tip) as its second parent
    // while the uncommitted row's line is still on its way down to it.
    const list = [c("m", ["b", "d"], ["main"]), c("d", ["z"], ["develop"]), c("b", ["z"]), c("z")];
    const layout = layoutGraph(list, { head: { sha: "d", branch: "develop", detached: false }, wip: true });
    expect(violations(layout, list)).toEqual([]);
    const merge = layout.rows.find(r => r.id === "m")!;
    const join = merge.edges.find(e => e.kind === "merge")!;
    expect(join).toMatchObject({ joins: true, to: 0 });
    const d = rowDrawing(merge, "merge", layout.headKey, 0);
    const solid = d.strokes.find(s => s.kind === "merge")!;
    // It meets the dashed line and stops there: nothing solid down the rest of the column.
    expect(solid.d.endsWith(`V${ROW_H}`)).toBe(false);
    expect(solid.d).toMatch(new RegExp(`Q${LANE_X0} ${ROW_H / 2} ${LANE_X0} [\\d.]+$`));
    expect(d.strokes.filter(s => s.wip && s.kind === "pass")).toHaveLength(1);
    // The merge does not stand on HEAD's history: its run is another branch's.
    expect(solid).toMatchObject({ dim: true, focus: false });
  });

  it("stops every edge at its node's outline, so a hollow node shows the row behind it", () => {
    const row = layoutGraph([c("b", ["a"], ["main"]), c("a")]).rows[0];
    for (const shape of ["commit", "seen", "trailer", "merge"] as NodeShape[]) {
      const d = rowDrawing(row, shape, null, 0);
      expect(d.strokes[0].d).toBe(`M${LANE_X0} ${ROW_H / 2 + nodeReach(shape)}V${ROW_H}`);
    }
  });
});

describe("words", () => {
  it("says an age in the narrow column's units", () => {
    expect([30, 120, 7200, 86400 * 3, 86400 * 20, 86400 * 100, 86400 * 800].map(historyAge)).toEqual(["now", "2m", "2h", "3d", "2w", "3mo", "2y"]);
  });
  it("says how long an agent worked", () => {
    expect([42_000, 372_000, 7_500_000].map(workDuration)).toEqual(["42s", "6m 12s", "2h 05m"]);
  });
  it("splits a conventional subject's prefix off", () => {
    expect(conventionalPrefix("feat(api): add a thing")).toEqual({ prefix: "feat(api):", rest: " add a thing" });
    expect(conventionalPrefix("fix!: break it")).toEqual({ prefix: "fix!:", rest: " break it" });
    expect(conventionalPrefix("Merge branch 'x'")).toBeNull();
  });
});
