// The history's graph, worked out from the commits alone: which column each
// commit sits in, which lines run through each row and where they bend, what
// colour every line is, and how loud each commit's subject reads.
//
// Every row is drawn on its own (one small SVG per row, the way VS Code's
// source-control graph does it), so everything a row needs is computed here
// up front: the lanes that enter it at the top, the lanes that leave it at the
// bottom, and the edges between them. Nothing here touches the DOM, so the
// rules can be held by plain tests.
//
// THE RULES, in the order they bind:
//
//   A COMMIT WAITED FOR BY SEVERAL LANES takes the leftmost of them and the
//   most senior branch's identity (main/master, then develop, then release/*,
//   then the rest): its first parent runs straight down from it, and a branch
//   lane ends at the commit it forked from.
//
//   A LANE THAT ENDS ON A ROW LEAVES A HOLE THERE FOR THAT ROW. Lanes to its
//   right close the hole one row later, one column per row, so several lanes
//   moving at once bend as parallel elbows that never touch.
//
//   A MERGE'S NEW PARENT LANE GOES RIGHT OF EVERY LANE THAT REACHED THE ROW,
//   never into a column vacated on the same row, so the line coming into the
//   merge and the line leaving it never share a column.
//
//   NOTHING BENDS ACROSS A ROW'S OWN HORIZONTAL LINES. A lane whose bend would
//   overlap the run from a commit to a lane it ends or opens waits a row.
//
//   THE CHECKED-OUT COMMIT KEEPS THE FIRST COLUMN when the uncommitted row is
//   above it: that row is laid out as a commit whose parent is HEAD, so the
//   branch being worked on is the straight line on the left and is never the
//   lane that folds away in a busy repository.
//
// Colour is the branch's identity, not its column: develop and main/master
// keep fixed slots, any other branch takes a slot when its lane first appears
// and keeps it, remembered per repository, so a new commit never repaints an
// existing line.

// ─── what the server sends ────────────────────────────────────────────────
//
// The log's shapes are the view's (git-view-types.ts); these are the names
// this module and the list read them by.

import type { CommitAgent, GitHead, GitLook, LogCommit } from "./git-view-types";

export type { LogCommit } from "./git-view-types";
/** The repository's HEAD, as `/api/git/repo` reports it. */
export type RepoHead = GitHead;
/** Who made a commit, if anyone the deck knows of. */
export type LogAgent = CommitAgent | null;
/** An agent the deck saw make a commit, or matched to it after a rewrite. */
export type SeenAgent = Extract<CommitAgent, { confidence: "seen" | "matched" }>;

export const isSeen = (a: LogAgent): a is SeenAgent => !!a && a.confidence !== "trailer";

// ─── branch identity ──────────────────────────────────────────────────────

/** The id of the row above the history that stands for the working tree. */
export const WIP_ID = "uncommitted";

const MAIN = /^(main|master)$/;
/** The integration branch's usual names: develop's place and colour. */
const DEVELOP = /^(develop|development|dev)$/;
/** How senior a branch is when several lanes meet at one commit. The
 *  remote's default branch (`defaultBranch`) ranks with develop when its
 *  name is not one of the usual ones. */
export function seniority(key: string, defaultBranch: string | null = null): number {
  if (MAIN.test(key)) return 4;
  if (DEVELOP.test(key) || key === defaultBranch) return 3;
  if (/^release\//.test(key)) return 2;
  return 1;
}

/** `origin/feature/x` → `feature/x`: a remote-tracking branch's own name. */
export const remoteBranch = (ref: string): string => ref.slice(ref.indexOf("/") + 1);

/** The most senior of some branch names, the first listed on a tie. */
function senior(keys: string[], defaultBranch: string | null = null): string | null {
  let best: string | null = null;
  for (const k of keys) if (best === null || seniority(k, defaultBranch) > seniority(best, defaultBranch)) best = k;
  return best;
}

/** The branch a commit is the tip of, if any: its most senior local branch,
 *  else its most senior remote-tracking branch's own name (origin's first). */
export function branchKeyOf(c: Pick<LogCommit, "refs">, defaultBranch: string | null = null): string | null {
  const local = senior(c.refs.local, defaultBranch);
  if (local) return local;
  const remotes = [...c.refs.remote].sort((a, b) => Number(b.startsWith("origin/")) - Number(a.startsWith("origin/")));
  return senior(remotes.map(remoteBranch), defaultBranch);
}

/** The branch a merge commit's subject names as merged in, or null:
 *  `Merge branch 'x' [into y]`, `Merge pull request #1 from owner/x`,
 *  `Merge remote-tracking branch 'origin/x'`. */
export function mergedBranchName(subject: string): string | null {
  let m = /^Merge (?:branch|branches) '([^']+)'/.exec(subject);
  if (m) return m[1];
  m = /^Merge remote-tracking branch '([^']+)'/.exec(subject);
  if (m) return remoteBranch(m[1]);
  m = /^Merge pull request #\d+ from ([^\s]+)/.exec(subject);
  if (m) return m[1].includes("/") ? m[1].slice(m[1].indexOf("/") + 1) : m[1];
  return null;
}

// ─── colour slots ─────────────────────────────────────────────────────────

/** How many lane colours there are (`--gv-lane-1` … `--gv-lane-5`). */
export const SLOT_COUNT = 5;
/** develop's slot (teal) and main/master's (orange), always. */
export const DEVELOP_SLOT = 0;
export const MAIN_SLOT = 1;
/** The slots any other branch takes from, in preference order. */
const BRANCH_SLOTS = [3, 2, 4];
/**
 * Slot pairs that must not sit side by side: under deuteranopia or
 * protanopia, or for normal vision in one theme, they fall under the floors
 * (OKLab ΔE×100 under 8 simulated or 15 unsimulated). teal/pink, teal/olive and
 * orange/olive fail outright; pink/olive sits at 7.9 on white.
 */
const CLASH = new Set(["0-2", "0-4", "1-4", "2-4"]);
export const clashes = (a: number, b: number): boolean => CLASH.has(a < b ? `${a}-${b}` : `${b}-${a}`);

/** The slot a branch always has, or null for one that takes a slot. */
export function fixedSlot(key: string): number | null {
  if (DEVELOP.test(key)) return DEVELOP_SLOT;
  if (MAIN.test(key)) return MAIN_SLOT;
  return null;
}

function keyHash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
}

/** How many slots one clashes with: the fewer, the easier it sits anywhere. */
const clashCount = (slot: number) => [0, 1, 2, 3, 4].filter(o => o !== slot && clashes(o, slot)).length;

/**
 * The slot a new branch takes, in this order of preference:
 *   1. one no lane in its row uses (lanes ending on the row count, or the new
 *      line reads as their continuation) that does not clash with its
 *      neighbours, the one that clashes with fewest slots first;
 *   2. main's, while main is not in the row, if it does not clash;
 *   3. the slot used longest ago among those that do not clash with its
 *      neighbours (a colour shared with a far lane reads better than a clash
 *      beside it);
 *   4. a free slot that clashes; then the slot used longest ago.
 */
export function pickSlot(key: string, rowSlots: Iterable<number>, neighbours: number[], lastUse: ReadonlyMap<number, number>): number {
  const fixed = fixedSlot(key);
  if (fixed !== null) return fixed;
  const active = new Set(rowSlots);
  const h = keyHash(key);
  const order = BRANCH_SLOTS.map((_, i) => BRANCH_SLOTS[(h + i) % BRANCH_SLOTS.length]);
  const calm = (s: number) => neighbours.every(n => !clashes(n, s) && n !== s);
  const lru = (list: number[]) => [...list].sort((a, b) => (lastUse.get(a) ?? -1) - (lastUse.get(b) ?? -1))[0];
  const free = order.filter(s => !active.has(s));
  const freeCalm = free.filter(calm).sort((a, b) => clashCount(a) - clashCount(b));
  if (freeCalm.length) return freeCalm[0];
  if (!active.has(MAIN_SLOT) && calm(MAIN_SLOT)) return MAIN_SLOT;
  const calmAny = order.filter(calm);
  if (calmAny.length) return lru(calmAny);
  if (free.length) return free[0];
  if (!active.has(MAIN_SLOT)) return MAIN_SLOT;
  return lru(order);
}

// ─── the layout ───────────────────────────────────────────────────────────

/** One line through the graph: the commit it is waiting for, and whose it is. */
export interface Lane {
  /** The SHA the lane runs down to. */
  id: string;
  /** The branch identity it carries. */
  key: string;
  slot: number;
  /** The dashed line from the uncommitted row to HEAD. */
  wip?: boolean;
  /** Opened by a commit HEAD can reach (or by the uncommitted row): part of
   *  the history HEAD stands on, rather than a line that only shares its
   *  branch's name, like an unpulled remote-tracking branch. */
  onHead?: boolean;
}

/**
 * One edge of a row, in columns:
 *   pass   a lane through the row, from its column at the top (`from`) to its
 *          column at the bottom (`to`), at most one column apart;
 *   in     a lane ending at the row's commit, from its column at the top;
 *   fp     the commit's first parent, from the commit to its bottom column;
 *   merge  a further parent, from the commit to its lane's bottom column.
 */
export interface Edge {
  kind: "pass" | "in" | "fp" | "merge";
  from: number;
  to: number;
  key: string;
  slot: number;
  wip?: boolean;
  /** The lane's, for a pass or an end; the commit's own, for its parents. */
  onHead?: boolean;
  /** A merge into a lane already on its way down to the parent: the run
   *  meets that lane and leaves the rest of the column to it, so the lane
   *  keeps its own look there — dashed from the uncommitted row, full for
   *  HEAD's own line — whatever the merge's is. */
  joins?: boolean;
}

export interface GraphRow {
  /** The commit's SHA, or WIP_ID. */
  id: string;
  col: number;
  key: string;
  slot: number;
  kind: "commit" | "merge" | "wip";
  /** Listed after the window, with no lane through it — except HEAD's own
   *  line (`headLine`), which keeps its lane down the first column. */
  outside: boolean;
  /** HEAD, or a commit of its line, listed after the window because HEAD is
   *  older than it. */
  headLine?: boolean;
  /** HEAD can reach it (the uncommitted row too). */
  onHead: boolean;
  /** Lanes crossing the row's top edge, by column; null is a hole. */
  input: Array<Lane | null>;
  /** Lanes crossing its bottom edge, by column. */
  output: Array<Lane | null>;
  edges: Edge[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** The most columns any row uses. */
  columns: number;
  /** branch → slot, the given memory plus every slot this layout handed out. */
  slots: Map<string, number>;
  /** The branches given a slot for the first time by this layout. */
  assigned: string[];
  /** HEAD's lane: its branch identity, or null when HEAD is not listed. */
  headKey: string | null;
}

export interface LayoutOptions {
  head?: Pick<RepoHead, "sha" | "detached" | "branch"> | null;
  /** Lay out the uncommitted row above the history, joined to HEAD. */
  wip?: boolean;
  /** With `wip`, for a look that does not draw the uncommitted row or its
   *  held lane: a merge taking HEAD in turns that lane into its own line
   *  from there down, so the run reaches HEAD rather than meeting a lane
   *  that is not drawn. */
  wipHidden?: boolean;
  /** What this repository's branches were given before. */
  slots?: ReadonlyMap<string, number>;
  /** The branch the remote calls its default, which ranks with develop. */
  defaultBranch?: string | null;
}

interface Node {
  id: string;
  parents: string[];
  ownKey: string | null;
  subject: string;
  outside: boolean;
  wip: boolean;
}

/**
 * HEAD's own line when HEAD is older than the window: HEAD and the first
 * parents after it among the commits listed past the window, in order.
 * Empty when HEAD is in the window or not listed at all.
 */
export function headLine(commits: readonly LogCommit[], headSha: string | null): Set<string> {
  const byId = new Map(commits.map(c => [c.sha, c]));
  const line = new Set<string>();
  for (let c = headSha ? byId.get(headSha) : undefined; c && c.outsideWindow && !line.has(c.sha); c = byId.get(c.parents[0] ?? "")) line.add(c.sha);
  return line;
}

/**
 * The graph of a history listed child-first (`git log --topo-order`); after
 * it, HEAD's own line when HEAD is older than the window, then the session's
 * older commits (both `outsideWindow`).
 *
 * HEAD older than the window keeps its place: the uncommitted row's dashed
 * line runs down the first column to the window's foot, HEAD's line goes on
 * below it in that column, and the session's older commits stand alone.
 */
export function layoutGraph(commits: readonly LogCommit[], opts: LayoutOptions = {}): GraphLayout {
  const slots = new Map(opts.slots ?? []);
  const assigned: string[] = [];
  const trunk = opts.defaultBranch ?? null;
  const byId = new Map(commits.map(c => [c.sha, c]));
  const headSha = opts.head?.sha && byId.has(opts.head.sha) ? opts.head.sha : (commits.find(c => c.refs.head && !c.outsideWindow)?.sha ?? null);
  const fromHead = reach(byId, headSha);
  const line = headLine(commits, headSha);

  const nodes: Node[] = [];
  if (opts.wip) {
    const headCommit = headSha ? byId.get(headSha) : undefined;
    nodes.push({
      id: WIP_ID,
      parents: headCommit ? [headCommit.sha] : [],
      ownKey: headCommit ? (branchKeyOf(headCommit, trunk) ?? opts.head?.branch ?? headCommit.sha) : null,
      subject: "",
      outside: false,
      wip: true,
    });
  }
  for (const c of commits) nodes.push({ id: c.sha, parents: dedupe(c.parents), ownKey: branchKeyOf(c, trunk), subject: c.subject, outside: !!c.outsideWindow, wip: false });

  const lastUse = new Map<number, number>();
  const slotOf = (key: string, rowSlots: Iterable<number>, neighbours: number[]): number => {
    const fixed = fixedSlot(key);
    if (fixed !== null) return fixed;
    const known = slots.get(key);
    if (known !== undefined) return known;
    const s = pickSlot(key, rowSlots, neighbours, lastUse);
    slots.set(key, s);
    assigned.push(key);
    return s;
  };
  /** The identity of a lane opened for a merge's further parent. */
  const mergeLaneKey = (parent: string, subject: string): string => {
    const p = byId.get(parent);
    return (p && branchKeyOf(p, trunk)) ?? mergedBranchName(subject) ?? parent;
  };

  const rows: GraphRow[] = [];
  let lanes: Array<Lane | null> = [];
  let columns = 1;
  let headKey: string | null = null;

  nodes.forEach((n, index) => {
    if (n.outside && line.has(n.id)) {
      // HEAD's line past the window: one lane down the first column, into
      // HEAD from the uncommitted row's line above the window's foot, and
      // from each commit to the next one of the line listed.
      const at = lanes.findIndex(l => !!l && l.id === n.id);
      const into = at >= 0 ? lanes[at]! : null;
      const key = into && n.ownKey ? senior([n.ownKey, into.key], trunk)! : into?.key ?? n.ownKey ?? n.id;
      const slot = into && into.key === key ? into.slot : slotOf(key, [], []);
      const next = n.parents[0] !== undefined && line.has(n.parents[0]) ? n.parents[0] : null;
      const output: Lane[] = next ? [{ id: next, key, slot, onHead: true }] : [];
      const edges: Edge[] = [];
      if (into) edges.push({ kind: "in", from: 0, to: 0, key: into.key, slot: into.slot, onHead: !!into.onHead, ...(into.wip ? { wip: true } : {}) });
      if (next) edges.push({ kind: "fp", from: 0, to: 0, key, slot, onHead: true });
      if (n.id === headSha) headKey = key;
      rows.push({ id: n.id, col: 0, key, slot, kind: n.parents.length > 1 ? "merge" : "commit", outside: true, headLine: true, onHead: true, input: into ? [into] : [], output, edges });
      lanes = output;
      return;
    }
    if (n.outside) {
      // No lane runs through an older commit: the window's lanes stopped at
      // its last row, and this one stands alone in the first column.
      const key = n.ownKey ?? n.id;
      const slot = slotOf(key, [], []);
      rows.push({ id: n.id, col: 0, key, slot, kind: n.parents.length > 1 ? "merge" : "commit", outside: true, onHead: fromHead.has(n.id) || byId.get(n.id)?.onHead === true, input: [], output: [], edges: [] });
      lanes = [];
      return;
    }
    const input = lanes;
    const hits: number[] = [];
    input.forEach((l, j) => { if (l && l.id === n.id) hits.push(j); });

    let col: number;
    let key: string;
    let slot: number;
    if (hits.length) {
      col = hits[0];
      const keys = hits.map(j => input[j]!.key);
      if (n.ownKey) keys.unshift(n.ownKey);
      key = senior(keys, trunk)!;
      const inLane = hits.map(j => input[j]!).find(l => l.key === key);
      slot = inLane ? inLane.slot : slotOf(key, input.filter(Boolean).map(l => l!.slot), neighbourSlots(input, col));
    } else if (n.wip && !n.ownKey) {
      // The working tree of a repository with nothing to join it to: no
      // branch to remember a colour for.
      col = input.length;
      key = WIP_ID;
      slot = DEVELOP_SLOT;
    } else {
      col = input.length;
      key = n.ownKey ?? n.id;
      slot = slotOf(key, input.filter(Boolean).map(l => l!.slot), neighbourSlots(input, col));
    }
    if (n.id === headSha) headKey = key;
    const onHead = n.wip || fromHead.has(n.id);

    const [first, ...rest] = n.parents;
    // Further parents already awaited by a lane through this row join it;
    // the others open lanes right of everything.
    const joins: Array<{ parent: string; at: number }> = [];
    const opens: string[] = [];
    for (const p of rest) {
      if (p === first) continue;
      const at = input.findIndex((l, j) => !!l && l.id === p && !hits.includes(j));
      if (at >= 0) joins.push({ parent: p, at });
      else opens.push(p);
    }
    const openFrom = Math.max(input.length, col + 1);
    // The span of the row's horizontal runs: into the commit from the lanes
    // it ends, and out of it to the lanes it joins or opens.
    let minH = col, maxH = col;
    for (const j of hits) maxH = Math.max(maxH, j);
    for (const { at } of joins) { minH = Math.min(minH, at); maxH = Math.max(maxH, at); }
    if (opens.length) maxH = Math.max(maxH, openFrom + opens.length - 1);
    const crossesSpan = (lo: number, hi: number) => (minH !== maxH) && lo <= maxH && hi >= minH;

    const width = Math.max(input.length, col + 1);
    const output: Array<Lane | null> = new Array(width).fill(null);
    // A column a lane may bend into on this row: a hole left by an earlier
    // row, or one a bending lane has just left. A lane ending here leaves a
    // hole that is NOT open until the next row.
    const open = new Array<boolean>(width).fill(false);
    const edges: Edge[] = [];
    const placed = new Map<number, number>();
    let fpAt = -1;

    for (let j = 0; j < width; j++) {
      if (j === col) {
        if (first !== undefined) {
          const lane: Lane = { id: first, key, slot, onHead, ...(n.wip ? { wip: true } : {}) };
          // The commit's own line may bend left into a hole below it, unless a
          // run leaves the commit to the left on this same row.
          const bend = minH === col && col > 0 && open[col - 1] && output[col - 1] === null;
          fpAt = bend ? col - 1 : col;
          output[fpAt] = lane;
        }
        continue;
      }
      const l = input[j] ?? null;
      if (!l) { open[j] = true; continue; }
      if (hits.includes(j)) continue; // ends here: a hole, closed next row
      const bend = j > 0 && open[j - 1] && output[j - 1] === null && !crossesSpan(j - 1, j) && j - 1 !== col;
      const to = bend ? j - 1 : j;
      output[to] = l;
      placed.set(j, to);
      if (bend) open[j] = true;
    }

    const laneEdge = (kind: "in" | "pass", j: number, to: number): Edge => {
      const l = input[j]!;
      return { kind, from: j, to, key: l.key, slot: l.slot, onHead: !!l.onHead, ...(l.wip ? { wip: true } : {}) };
    };
    for (const j of hits) edges.push(laneEdge("in", j, col));
    for (const [j, to] of placed) edges.push(laneEdge("pass", j, to));
    if (fpAt >= 0) edges.push({ kind: "fp", from: col, to: fpAt, key, slot, onHead, ...(n.wip ? { wip: true } : {}) });
    for (const { at } of joins) {
      const to = placed.get(at)!;
      const target = output[to]!;
      const takesHidden = !!target.wip && !!opts.wipHidden;
      if (takesHidden) {
        const { wip: _held, ...line } = target;
        output[to] = line;
      }
      edges.push({ kind: "merge", from: col, to, key: target.key, slot: target.slot, onHead, ...(takesHidden ? {} : { joins: true }) });
    }
    opens.forEach((p, i) => {
      const at = openFrom + i;
      const mk = mergeLaneKey(p, n.subject);
      const rowSlots = [...input, ...output].filter(Boolean).map(l => l!.slot);
      const left = output.slice(0, at).reverse().find(Boolean) ?? null;
      const ms = slotOf(mk, rowSlots, left ? [left.slot] : []);
      while (output.length < at) output.push(null);
      output[at] = { id: p, key: mk, slot: ms, onHead };
      edges.push({ kind: "merge", from: col, to: at, key: mk, slot: ms, onHead });
    });

    while (output.length && output[output.length - 1] === null) output.pop();
    for (const l of output) if (l) lastUse.set(l.slot, index);
    columns = Math.max(columns, input.length, output.length, col + 1);
    rows.push({ id: n.id, col, key, slot, kind: n.wip ? "wip" : n.parents.length > 1 ? "merge" : "commit", outside: false, onHead, input, output, edges });
    lanes = output;
  });

  return { rows, columns, slots, assigned, headKey };
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

function neighbourSlots(lanes: Array<Lane | null>, col: number): number[] {
  const out: number[] = [];
  const left = lanes[col - 1];
  const right = lanes[col + 1];
  if (left) out.push(left.slot);
  if (right) out.push(right.slot);
  return out;
}

// ─── tones ────────────────────────────────────────────────────────────────

export type Tone = "own" | "base" | "off";

/** The branch names a branch is measured against, besides the remote's own
 *  default (server/git-reads.mjs keeps the same list for HEAD's line past the
 *  window, and a test holds the two together). */
export const TRUNK_NAMES = ["develop", "development", "dev", "main", "master", "trunk"];

/** The trunks of a repository: the branch its remote calls its default
 *  first, then the usual names. */
export function trunkNames(defaultBranch: string | null = null): string[] {
  return defaultBranch && !TRUNK_NAMES.includes(defaultBranch) ? [defaultBranch, ...TRUNK_NAMES] : TRUNK_NAMES;
}

/** The commits reachable from `from` within the list. */
function reach(byId: ReadonlyMap<string, LogCommit>, from: string | null): Set<string> {
  const seen = new Set<string>();
  const stack = from ? [from] : [];
  while (stack.length) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const c = byId.get(sha);
    if (!c) continue;
    seen.add(sha);
    for (const p of c.parents) stack.push(p);
  }
  return seen;
}

/**
 * What HEAD's branch is measured against, as the commits that name it: for a
 * trunk (the remote's default branch, develop, development, dev, main,
 * master, trunk) its own remote-tracking branches, so its own rows are what
 * has not been pushed; for any other branch, or a detached HEAD, every trunk
 * listed, local and remote-tracking alike — a local trunk left behind its
 * remote, or a branch made from a remote's trunk, measures the same. Empty
 * when the repository has none of them listed.
 */
export function baseTips(commits: readonly LogCommit[], head: Pick<RepoHead, "branch" | "detached"> | null, defaultBranch: string | null = null): string[] {
  const names = trunkNames(defaultBranch);
  const branch = head && !head.detached ? head.branch : null;
  const onTrunk = branch !== null && names.includes(branch);
  const tips: string[] = [];
  for (const c of commits) {
    if (c.outsideWindow) continue;
    const at = onTrunk
      ? c.refs.remote.some(r => remoteBranch(r) === branch)
      : c.refs.local.some(l => l !== branch && names.includes(l)) || c.refs.remote.some(r => names.includes(remoteBranch(r)));
    if (at) tips.push(c.sha);
  }
  return tips;
}

/**
 * Each commit's tone: "own" for what HEAD's branch has that its base does
 * not, "base" for the history the two share, "off" for what HEAD cannot
 * reach. With no base to measure against, a trunk's history is all "base"
 * and any other branch's all "own". HEAD's line past the window, and the
 * session's older commits, are measured by git (their `base`, and `onHead`
 * for the older ones), since the commits joining them to the window are not
 * listed.
 */
export function graphTones(commits: readonly LogCommit[], head: Pick<RepoHead, "sha" | "branch" | "detached"> | null, defaultBranch: string | null = null): Map<string, Tone> {
  const byId = new Map(commits.map(c => [c.sha, c]));
  const headSha = head?.sha && byId.has(head.sha) ? head.sha : (commits.find(c => c.refs.head)?.sha ?? null);
  const fromHead = reach(byId, headSha);
  const tips = baseTips(commits, head, defaultBranch);
  const fromBase = new Set<string>();
  for (const tip of tips) for (const sha of reach(byId, tip)) fromBase.add(sha);
  const branch = head && !head.detached ? head.branch : null;
  const noBase: Tone = !tips.length && branch !== null && !trunkNames(defaultBranch).includes(branch) ? "own" : "base";
  const out = new Map<string, Tone>();
  for (const c of commits) {
    if (!fromHead.has(c.sha) && !(c.outsideWindow && c.onHead === true)) out.set(c.sha, "off");
    else if (c.outsideWindow && typeof c.base === "boolean") out.set(c.sha, c.base ? "base" : "own");
    else if (!tips.length) out.set(c.sha, noBase);
    else out.set(c.sha, fromBase.has(c.sha) ? "base" : "own");
  }
  return out;
}

// ─── drawing ──────────────────────────────────────────────────────────────

/** A row's height, a lane's width, the first lane's centre, the bend radius. */
export const ROW_H = 24;
export const LANE_W = 12;
export const LANE_X0 = 7;
export const BEND = 5;
const MID = ROW_H / 2;
/** Lanes drawn before the rest fold into one dashed column. */
export const VISIBLE_LANES = 6;

/** How many columns the graph draws, and whether the last is the fold. A
 *  single extra lane is drawn rather than folded: the fold column would take
 *  the same room and say less. */
export function graphColumns(columns: number): { drawn: number; folded: number } {
  if (columns <= VISIBLE_LANES + 1) return { drawn: Math.max(1, columns), folded: 0 };
  return { drawn: VISIBLE_LANES + 1, folded: columns - VISIBLE_LANES };
}

/** The graph cell's width for that many drawn columns. */
export const graphWidth = (drawn: number): number => LANE_X0 + (drawn - 1) * LANE_W + 8;

export type NodeShape = "seen" | "trailer" | "merge" | "commit" | "wip";

/** How far an edge stops short of a node's centre, along either axis. */
export function nodeReach(shape: NodeShape): number {
  switch (shape) {
    case "seen": return 5.2;
    case "trailer": return 4.8;
    case "merge": return 4.2;
    case "wip": return 3.6;
    default: return 3.4;
  }
}

export interface Stroke {
  d: string;
  slot: number;
  kind: Edge["kind"];
  /** Not HEAD's own line — another branch's, or one that only shares its
   *  branch's name: drawn in the slot's pre-mixed dim. */
  dim: boolean;
  /** HEAD's own line: full colour, 2px. */
  focus: boolean;
  wip: boolean;
}

export interface RowDrawing {
  strokes: Stroke[];
  /** The node's centre. */
  x: number;
  y: number;
  /** The node sits in the fold column. */
  folded: boolean;
  /** The fold column's line over the part of the row its lanes are in: the
   *  top half for lanes folded where the row starts, the bottom half for
   *  lanes folded where it ends, so it meets the rows above and below and
   *  never sticks out of a row where the fold opens or closes. Null when no
   *  lane of the row is in the fold. */
  fold: string | null;
  foldX: number;
}

/** Whether a row's node, or an edge, is HEAD's own line: its branch, on the
 *  history HEAD stands on. A line of the same name HEAD cannot reach (an
 *  unpulled remote-tracking branch) is another branch's for the eye. */
export const onFocusLine = (x: { key: string; onHead?: boolean }, focusKey: string | null): boolean =>
  focusKey !== null && x.key === focusKey && !!x.onHead;

/**
 * The strokes of one row, in its own 0…ROW_H box. Edges stop at the node's
 * outline so a hollow node shows the row behind it; edges between two folded
 * columns are not drawn (the fold line stands for them).
 */
export function rowDrawing(row: GraphRow, shape: NodeShape, focusKey: string | null, folded: number): RowDrawing {
  const lastVisible = folded ? VISIBLE_LANES - 1 : Infinity;
  const hidden = (c: number) => c > lastVisible;
  const x = (c: number) => LANE_X0 + Math.min(c, folded ? VISIBLE_LANES : c) * LANE_W;
  const foldX = LANE_X0 + VISIBLE_LANES * LANE_W;
  const r = nodeReach(shape);
  const strokes: Stroke[] = [];
  const add = (d: string, e: Edge) => strokes.push({
    d, slot: e.slot, kind: e.kind, wip: !!e.wip,
    dim: !e.wip && focusKey !== null && !onFocusLine(e, focusKey),
    focus: !e.wip && onFocusLine(e, focusKey),
  });
  const nx = x(row.col);
  for (const e of row.edges) {
    const a = e.kind === "pass" || e.kind === "in" ? e.from : row.col;
    const b = e.kind === "in" ? row.col : e.to;
    if (hidden(a) && hidden(b)) continue;
    const xa = x(a), xb = x(b);
    if (e.kind === "pass") add(xa === xb ? `M${xa} 0V${ROW_H}` : bendDown(xa, xb), e);
    else if (e.kind === "in") add(xa === xb ? `M${xa} 0V${MID - r}` : intoNode(xa, xb, r), e);
    else if (e.kind === "fp") add(xa === xb ? `M${xa} ${MID + r}V${ROW_H}` : leaveDown(xa, xb, r), e);
    else if (e.joins && xa !== xb) add(outOfNode(xa, xb, r, false), e);
    else add(xa === xb ? `M${xa} ${MID + r}V${ROW_H}` : outOfNode(xa, xb, r), e);
  }
  // An edge between two folded columns is not drawn: its lane is folded at
  // the row's top, its bottom, or both, and the line stands for it there.
  const top = row.input.some((l, i) => l && hidden(i));
  const bottom = row.output.some((l, i) => l && hidden(i));
  const fold = top || bottom ? `M${foldX} ${top ? 0 : MID}V${bottom ? ROW_H : MID}` : null;
  return { strokes, x: nx, y: MID, folded: hidden(row.col), fold, foldX };
}

const n = (v: number) => Math.round(v * 100) / 100;

/** A lane moving one column at the row's middle: down, a quarter turn, a
 *  short run, a quarter turn, down. */
function bendDown(x1: number, x2: number): string {
  const dir = x2 > x1 ? 1 : -1;
  const r = Math.min(BEND, Math.abs(x2 - x1) / 2);
  return `M${x1} 0V${MID - r}Q${x1} ${MID} ${n(x1 + dir * r)} ${MID}H${n(x2 - dir * r)}Q${x2} ${MID} ${x2} ${MID + r}V${ROW_H}`;
}

/** A lane from the top ending at a node to its side. */
function intoNode(x1: number, xn: number, r: number): string {
  const dir = xn > x1 ? 1 : -1;
  const b = Math.min(BEND, Math.abs(xn - x1) / 2);
  return `M${x1} 0V${MID - b}Q${x1} ${MID} ${n(x1 + dir * b)} ${MID}H${n(xn - dir * r)}`;
}

/** A run from a node to a lane to its side that carries on down — or, into
 *  a lane already drawn down that column, that stops where it meets it. */
function outOfNode(xn: number, x2: number, r: number, down = true): string {
  const dir = x2 > xn ? 1 : -1;
  const b = Math.min(BEND, Math.abs(x2 - xn) / 2);
  return `M${n(xn + dir * r)} ${MID}H${n(x2 - dir * b)}Q${x2} ${MID} ${x2} ${MID + b}${down ? `V${ROW_H}` : ""}`;
}

/** The node's own line bending one column on its way down. */
function leaveDown(xn: number, x2: number, r: number): string {
  const y0 = MID + r;
  return `M${xn} ${n(y0)}C${xn} ${n(y0 + 4)} ${x2} ${ROW_H - 4} ${x2} ${ROW_H}`;
}

// ─── the Fork look ────────────────────────────────────────────────────────
//
// The same layout drawn the way Fork draws it: 22px rows, lanes 11px apart,
// 1.6px lines, a filled 5px dot for a commit and a ring with a chevron for a
// merge, every turn a circular quarter arc and never a diagonal. Every edge
// still crosses a row's top and bottom edges vertically at a lane's x, so the
// rows meet seamlessly. Colour is Fork's palette: HEAD's own line orange, and
// every other branch's stable slot mapped onto the rest of it, so a live
// commit never repaints a line.

export type { GitLook } from "./git-view-types";

/** What a look draws a row's graph with. */
export interface GraphGeometry {
  look: GitLook;
  /** A row's height; the node sits on its middle. */
  rowH: number;
  /** Between two lanes' centres. */
  laneW: number;
  /** The first lane's centre, from the row's own left edge. */
  laneX0: number;
  /** Every line's width. */
  line: number;
  /** A commit's dot. */
  dot: number;
  /** A merge's ring (Fork) or dot (deck). */
  ring: number;
  /** The widest a line turns. */
  elbow: number;
  /** From the rightmost lane's centre to the subject. */
  textGap: number;
}

export const DECK_GEOMETRY: GraphGeometry = { look: "deck", rowH: ROW_H, laneW: LANE_W, laneX0: LANE_X0, line: 1.5, dot: 3.4, ring: 4.2, elbow: BEND, textGap: 8 };

/** A Fork row stands 10px in from each edge of the pane, the room its
 *  selection pill is drawn in, so its first lane — 22.5px from the pane's
 *  edge — is 12.5px inside the row. */
export const FORK_ROW_INSET = 10;
export const FORK_GEOMETRY: GraphGeometry = { look: "fork", rowH: 22, laneW: 11, laneX0: 12.5, line: 1.6, dot: 2.5, ring: 6, elbow: 7, textGap: 10.5 };

/** Half a diamond's diagonal, ◆ or ◇, and the hollow one's stroke. */
export const FORK_DIAMOND = 4;
export const FORK_DIAMOND_STROKE = 1.3;
/** The chevron inside a merge's ring, from its centre. */
export const FORK_CHEVRON = "-2.75 -1.25 0 1.5 2.75 -1.25";

/** The graph cell's width for that many drawn columns, in a look. */
export const lookGraphWidth = (drawn: number, geo: GraphGeometry): number => geo.laneX0 + (drawn - 1) * geo.laneW + geo.textGap;

/** How far a Fork edge stops short of a node's centre: under a filled dot or
 *  diamond, at a hollow diamond's outline, at a ring's inner edge. */
export function forkNodeReach(shape: NodeShape): number {
  switch (shape) {
    case "seen": return FORK_DIAMOND - FORK_GEOMETRY.line;
    case "trailer": return FORK_DIAMOND + FORK_DIAMOND_STROKE / 2;
    case "merge": return FORK_GEOMETRY.ring - FORK_GEOMETRY.line / 2;
    default: return FORK_GEOMETRY.dot - 1;
  }
}

/** The palette index (`--fk-lane-0` … `--fk-lane-5`) each deck slot paints in
 *  the Fork look: develop yellow, main red, the three others green, blue and
 *  tan. Index 0, orange, is HEAD's own line alone. */
export const FORK_LANE_OF_SLOT = [1, 2, 5, 4, 3] as const;

/** The Fork palette index a node or an edge paints in. */
export const forkLane = (x: { key: string; slot: number; onHead?: boolean }, focusKey: string | null): number =>
  onFocusLine(x, focusKey) ? 0 : FORK_LANE_OF_SLOT[x.slot] ?? 1;

/**
 * One row's strokes in the Fork look, in its own 0…22 box, the row's node at
 * its centre. The same edges as rowDrawing, drawn with Fork's shapes; nothing
 * is dimmed (`dim` is always false), and edges between two folded columns are
 * not drawn, the fold column's line standing for them.
 */
export function forkRowDrawing(row: GraphRow, shape: NodeShape, focusKey: string | null, folded: number): RowDrawing {
  const G = FORK_GEOMETRY;
  const H = G.rowH, M = H / 2;
  const lastVisible = folded ? VISIBLE_LANES - 1 : Infinity;
  const hidden = (c: number) => c > lastVisible;
  const x = (c: number) => G.laneX0 + Math.min(c, folded ? VISIBLE_LANES : c) * G.laneW;
  const foldX = G.laneX0 + VISIBLE_LANES * G.laneW;
  const r = forkNodeReach(shape);
  const strokes: Stroke[] = [];
  const add = (d: string, e: Edge) => strokes.push({ d, slot: e.slot, kind: e.kind, wip: !!e.wip, dim: false, focus: !e.wip && onFocusLine(e, focusKey) });
  for (const e of row.edges) {
    const a = e.kind === "pass" || e.kind === "in" ? e.from : row.col;
    const b = e.kind === "in" ? row.col : e.to;
    if (hidden(a) && hidden(b)) continue;
    const xa = x(a), xb = x(b);
    if (e.kind === "pass") add(xa === xb ? `M${xa} 0V${H}` : forkThrough(xa, xb), e);
    else if (e.kind === "in") add(xa === xb ? `M${xa} 0V${n(M - r)}` : forkInto(xa, xb, r), e);
    else if (e.kind === "fp") add(xa === xb ? `M${xa} ${n(M + r)}V${H}` : forkLeave(xa, xb, r), e);
    else if (e.joins && xa !== xb) add(forkOut(xa, xb, r, false), e);
    else add(xa === xb ? `M${xa} ${n(M + r)}V${H}` : forkOut(xa, xb, r, true), e);
  }
  const top = row.input.some((l, i) => l && hidden(i));
  const bottom = row.output.some((l, i) => l && hidden(i));
  const fold = top || bottom ? `M${foldX} ${top ? 0 : M}V${bottom ? H : M}` : null;
  return { strokes, x: x(row.col), y: M, folded: hidden(row.col), fold, foldX };
}

/** Whether a Fork row draws the fold column, as forkRowDrawing draws it: its
 *  node in a folded column, or a line crossing one. */
export function forkDrawsFold(row: GraphRow, folded: number): boolean {
  if (!folded) return false;
  const inFold = (l: Lane | null, i: number) => !!l && i >= VISIBLE_LANES;
  return row.col >= VISIBLE_LANES || row.input.some(inFold) || row.output.some(inFold);
}

const FH = FORK_GEOMETRY.rowH;
const FM = FH / 2;
/** A quarter arc's sweep: turning from down to `dir`, or from `dir` to down. */
const sweepDownTo = (dir: number) => (dir > 0 ? 0 : 1);
const sweepToDown = (dir: number) => (dir > 0 ? 1 : 0);
const arc = (r: number, sweep: number, x: number, y: number) => `A${n(r)} ${n(r)} 0 0 ${sweep} ${n(x)} ${n(y)}`;

/** A lane moving a column on its way through: down to the row's middle, a
 *  quarter turn, a short run, a quarter turn, then a 1px tail so the bottom
 *  edge is crossed vertically. The turn sits in the lower half, clear of the
 *  row's node and its runs. */
function forkThrough(x1: number, x2: number): string {
  const dir = x2 > x1 ? 1 : -1;
  const r = Math.min(FORK_GEOMETRY.elbow, Math.abs(x2 - x1) / 2, (FH - 2) / 4);
  const run = FH - 1 - r;
  return `M${x1} 0V${n(run - r)}${arc(r, sweepDownTo(dir), x1 + dir * r, run)}H${n(x2 - dir * r)}${arc(r, sweepToDown(dir), x2, run + r)}V${FH}`;
}

/** A lane from the top ending at the node to its side: down, a quarter turn,
 *  and in along the row's middle to the node's outline. When the turn already
 *  reaches the outline the run is left out; a ring's hollow is masked by the
 *  row, so nothing shows inside it. */
function forkInto(x1: number, xn: number, reach: number): string {
  const dir = xn > x1 ? 1 : -1;
  const r = Math.min(FORK_GEOMETRY.elbow, Math.abs(xn - x1), FM);
  const run = Math.abs(xn - x1) - r > reach ? `H${n(xn - dir * reach)}` : "";
  return `M${x1} 0V${n(FM - r)}${arc(r, sweepDownTo(dir), x1 + dir * r, FM)}${run}`;
}

/** A run from the node out to a lane at its side, a quarter turn and down
 *  to the bottom — or, joining a lane already drawn down that column, only to
 *  where it meets it. */
function forkOut(xn: number, x2: number, reach: number, down: boolean): string {
  const dir = x2 > xn ? 1 : -1;
  const r = Math.min(FORK_GEOMETRY.elbow, Math.abs(x2 - xn), FM);
  const turn = x2 - dir * r;
  const start = Math.abs(x2 - xn) - r > reach ? xn + dir * reach : turn;
  return `M${n(start)} ${FM}${start === turn ? "" : `H${n(turn)}`}${arc(r, sweepToDown(dir), x2, FM + r)}${down ? `V${FH}` : ""}`;
}

/** The node's own line moving a column on its way down: it leaves the node
 *  straight down, and turns below it, never beside it. */
function forkLeave(xn: number, x2: number, reach: number): string {
  const dir = x2 > xn ? 1 : -1;
  const b = Math.min(FORK_GEOMETRY.elbow, Math.abs(x2 - xn) / 2, (FH - FM - reach - 1) / 2);
  const run = FH - 1 - b;
  return `M${xn} ${n(FM + reach)}V${n(run - b)}${arc(b, sweepDownTo(dir), xn + dir * b, run)}H${n(x2 - dir * b)}${arc(b, sweepToDown(dir), x2, run + b)}V${FH}`;
}

// ─── slot memory ──────────────────────────────────────────────────────────

/** Branches remembered per repository, newest use last. */
export const SLOT_MEMORY_BRANCHES = 300;
/** Repositories remembered. */
export const SLOT_MEMORY_REPOS = 40;

export type SlotMemory = Record<string, Array<[string, number]>>;

/** A stored memory read back, anything unreadable dropped. */
export function parseSlotMemory(text: string | null): SlotMemory {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: SlotMemory = {};
    for (const [repo, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      out[repo] = list.filter((e): e is [string, number] =>
        Array.isArray(e) && typeof e[0] === "string" && Number.isInteger(e[1]) && e[1] >= 0 && e[1] < SLOT_COUNT);
    }
    return out;
  } catch {
    return {};
  }
}

/** One repository's branch → slot map out of the memory. */
export function repoSlots(memory: SlotMemory, repoKey: string): Map<string, number> {
  return new Map(memory[repoKey] ?? []);
}

/**
 * The memory with one repository's map written back: its branches in use
 * order with the newest assignments last, each list capped, and the
 * repository moved to the end so the least recently opened is dropped first.
 */
export function rememberSlots(memory: SlotMemory, repoKey: string, slots: ReadonlyMap<string, number>, touched: readonly string[]): SlotMemory {
  const before = memory[repoKey] ?? [];
  const recent = new Set(touched);
  const kept = before.filter(([k]) => !recent.has(k) && slots.has(k)).map(([k]) => [k, slots.get(k)!] as [string, number]);
  const added = touched.filter(k => slots.has(k)).map(k => [k, slots.get(k)!] as [string, number]);
  const list = [...kept, ...added].slice(-SLOT_MEMORY_BRANCHES);
  const others = Object.entries(memory).filter(([k]) => k !== repoKey).slice(-(SLOT_MEMORY_REPOS - 1));
  return Object.fromEntries([...others, [repoKey, list]]);
}

// ─── words ────────────────────────────────────────────────────────────────

/** How long ago, in the history's narrow column: now, 12m, 3h, 5d, 6w, 4mo, 2y. */
export function historyAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 60) return `${Math.floor(s / (86400 * 7))}w`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

/** How long an agent worked before a commit: 42s, 6m 12s, 2h 05m. */
export function workDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** A conventional-commit subject's prefix and the rest: `feat(api):` + ` add…`. */
export function conventionalPrefix(subject: string): { prefix: string; rest: string } | null {
  const m = /^([a-z]+(?:\([^)]*\))?!?:)(\s.*)$/.exec(subject);
  return m ? { prefix: m[1], rest: m[2] } : null;
}
