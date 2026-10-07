// The lane under a card: the commits its agent was seen making in the last
// half hour, newest on top, the way a git client draws one branch — a thin
// line in the branch's colour with a filled diamond per commit.
//
// What it shows is the server's GitRecentCommits (git-events.ts), kept on the
// session's root card. Only commits the deck saw an agent make (the ◆ mark,
// "seen by ccdeck"): never one it read off a commit message or guessed.
//
// WHOSE COMMITS. A session's main card speaks for the whole team, as its git
// view does: its main thread's commits and every subagent's, a subagent's
// named after its subject (`↳ test-writer`). A subagent's card has a lane of
// its own only where it has a branch chip of its own — when it works in a
// folder other than its session's (git-chip.ts) — and that lane holds its own
// commits alone. A subagent in its session's folder draws none: its commits
// are on its session's lane, and drawing them twice side by side would say
// two branches moved where one did.
//
// WHICH REPOSITORY. A row opens its card's git view on its commit, and that
// view reads the repository the session works in now. A main card draws only
// the commits in that repository (the lane's `repo`): one made in a repository
// the session has since left would open the view on a commit it does not
// hold, coloured by another repository's branches.
//
// HOW LONG. A commit stays for BAND_WINDOW_MS after it was made, and the lane
// goes with the last of them; the card works that out on the deck's shared
// clock (use-now.ts), so nothing keeps a timer of its own. At most BAND_ROWS
// rows; the rest fold into one line, "+N earlier".
//
// HOW TALL. The lane is drawn inside the card's node, under the card, so the
// node's measured height is what makes room for it: every layout pass, the
// session's box, the fit and the minimap read that height already. The two
// places that treat a node's height as the card's own — the tool chain's
// anchor at the card's middle (burst-layout.ts) and a recap note centred on its
// card (canvas-flow.ts) — take the lane's room back off with bandRoomFor.
//
// Pure. Built once per board revision (canvas-flow.ts); a lane that says what
// it said last revision keeps its identity.
import { agentNamer } from "./git-agent-name";
import { branchChip } from "./git-chip";
import { fixedSlot } from "./git-graph-layout";
import type { AgentNodeData, RecentCommit } from "./types";

/** How long a commit stays in the lane: the server's RECENT_COMMITS_MS. */
export const BAND_WINDOW_MS = 30 * 60_000;
/** The most commits drawn as rows; the rest fold into a count. */
export const BAND_ROWS = 5;

/** The lane's geometry, in the sheet's pixels (git-band.css): the line's run
 *  from the card's edge to the first row, a row, and the fold's line. Stated
 *  here because the layout reads the lane's height without a render
 *  (bandRoom), and git-commit-band.test.ts holds them to the sheet. */
export const BAND_TOP = 8;
export const BAND_ROW_H = 20;
export const BAND_FOLD_H = 20;

/** A commit as its lane draws it: `who` is `↳ name` for a subagent's commit on
 *  its session's lane, null for the card's own agent. */
export interface BandCommit extends RecentCommit {
  who: string | null;
}

/** A card's lane: its commits newest first, and the repository the branch
 *  colours are read for. */
export interface CardBand {
  repo: string | null;
  commits: readonly BandCommit[];
}

/** The fields of a card this reads. */
export type BandAgent = Pick<AgentNodeData, "id" | "sessionId" | "kind" | "label" | "cwd" | "git" | "gitRecent"> & Partial<Pick<AgentNodeData, "sessionName">>;

const subKey = (a: Pick<AgentNodeData, "id" | "sessionId">) => (a.id.startsWith(`${a.sessionId}::`) ? a.id.slice(a.sessionId.length + 2) : null);

/** Whether a card draws a lane of its own: every session's main card, and a
 *  subagent's only where it shows a branch chip of its own. */
export function drawsLane(a: Pick<AgentNodeData, "kind" | "git" | "cwd">): boolean {
  return a.kind !== "subagent" || (a.git != null && branchChip(a) != null);
}

/** The commits a card's lane is made of, newest first: the whole team's on a
 *  main card, in the repository its view reads; a subagent's own on its card;
 *  nothing for a card with no lane. */
export function laneCommits(a: BandAgent, root: Pick<AgentNodeData, "gitRecent"> | undefined): readonly RecentCommit[] {
  const all = root?.gitRecent?.commits;
  if (!all?.length || !drawsLane(a)) return [];
  if (a.kind !== "subagent") {
    const repo = root?.gitRecent?.repo;
    return repo ? all.filter(c => !c.repo || c.repo === repo) : all;
  }
  const key = subKey(a);
  return key ? all.filter(c => c.agentId === key) : [];
}

/**
 * Every card's lane on the board, by card id; a card with no commits is
 * absent. `prev` is the last board's answer: a lane that still says the same
 * thing is handed back as it was, so its card does not re-render for it.
 */
export function cardBands(agents: Iterable<BandAgent>, prev?: ReadonlyMap<string, CardBand>): Map<string, CardBand> {
  const byId = new Map<string, BandAgent>();
  for (const a of agents) byId.set(a.id, a);
  const out = new Map<string, CardBand>();
  let namer: ReturnType<typeof agentNamer> | null = null;
  for (const a of byId.values()) {
    const root = a.kind === "root" ? a : byId.get(a.sessionId);
    const commits = laneCommits(a, root);
    if (!commits.length) continue;
    const band: CardBand = {
      repo: root?.gitRecent?.repo ?? null,
      commits: commits.map(c => {
        if (a.kind === "subagent" || !c.agentId) return { ...c, who: null };
        namer ??= agentNamer(byId.values());
        return { ...c, who: `↳ ${namer(a.sessionId, c.agentId) ?? c.label ?? "subagent"}` };
      }),
    };
    const was = prev?.get(a.id);
    out.set(a.id, was && sameBand(was, band) ? was : band);
  }
  return out;
}

const sameBand = (x: CardBand, y: CardBand) => x.repo === y.repo && x.commits.length === y.commits.length
  && x.commits.every((c, i) => {
    const d = y.commits[i];
    return c.sha === d.sha && c.at === d.at && c.subject === d.subject && c.who === d.who && c.branch === d.branch;
  });

/** What a lane draws at `now`: the commits still inside the window, newest
 *  first, at most BAND_ROWS of them, and how many more the fold counts. */
export function bandView<C extends RecentCommit>(commits: readonly C[], now: number): { rows: C[]; earlier: number } {
  const live = commits.filter(c => now - c.at < BAND_WINDOW_MS);
  return { rows: live.slice(0, BAND_ROWS), earlier: Math.max(0, live.length - BAND_ROWS) };
}

/** How tall a lane drawing this is, in the sheet's pixels: none for no rows. */
export function bandRoom(view: { rows: readonly unknown[]; earlier: number }): number {
  if (!view.rows.length) return 0;
  return BAND_TOP + view.rows.length * BAND_ROW_H + (view.earlier > 0 ? BAND_FOLD_H : 0);
}

/** The room the lane under this agent's card takes at `now` — none while Git
 *  is switched off in Settings › Git (`on`), when the card does not draw it. */
export function bandRoomFor(agents: ReadonlyMap<string, AgentNodeData>, a: AgentNodeData, now: number, on: boolean): number {
  if (!on) return 0;
  const root = a.kind === "root" ? a : agents.get(a.sessionId);
  return bandRoom(bandView(laneCommits(a, root), now));
}

/** The slot (`--gv-lane-1` … `--gv-lane-5`, 0-based) a branch's line is drawn
 *  in: develop's and main's own, else the one the git view's history gave it
 *  in this repository (`remembered`, its slot memory), else the slot the
 *  history gives a new branch first — the one that clashes with no other. */
export const FALLBACK_SLOT = 3;
export function laneSlot(branch: string | null, remembered: ReadonlyMap<string, number>): number {
  if (!branch) return FALLBACK_SLOT;
  return fixedSlot(branch) ?? remembered.get(branch) ?? FALLBACK_SLOT;
}
