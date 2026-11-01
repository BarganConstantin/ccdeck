import { canvasSessions } from "./canvas-session";
import type { AgentNodeData, ToolCall, WaitingBlock } from "./types";
import { isAlarming } from "./ambient-counts";
import { planLine, planSummary } from "./agent-plan";
import { stopRowLabel, stopShortLabel } from "./stop-failure-copy";

/**
 * WHAT A SESSION'S SUBAGENTS ADD UP TO, for the faces that are too small to
 * show them one by one.
 *
 * Counted from the subagent cards that are on the canvas and staying there —
 * a card with `exitAt` set is fading out, and a summary that still counted it
 * would say `5 subagents` over a branch the reader can see has four. Not
 * `childCount`, which is how many the session has EVER spawned and keeps
 * counting cards the canvas retired turns ago.
 *
 * It is a summary and it is drawn as one: the subagent cards are still there,
 * each still a tile of its own, and this is a line of text on the root about
 * them — never a node standing in for them.
 */
export interface BranchSummary {
  total: number;
  live: number;
  done: number;
  err: number;
  /** Failed tool calls across the whole branch. */
  failed: number;
}

/** One summary per session that has at least one subagent on the canvas. */
export function branchSummaries(agents: Iterable<AgentNodeData>): Map<string, BranchSummary> {
  const out = new Map<string, BranchSummary>();
  const rows = [...agents];
  const groups = canvasSessions(rows);
  for (const a of rows) {
    if ((a.kind !== "subagent" && !(a.provider === "codex" && a.parentId)) || a.exitAt != null) continue;
    const group = groups.get(a.id) ?? a.sessionId;
    if (a.provider === "codex" && group === a.sessionId) continue;
    let b = out.get(group);
    if (!b) { b = { total: 0, live: 0, done: 0, err: 0, failed: 0 }; out.set(group, b); }
    b.total += 1;
    if (a.state === "active") b.live += 1;
    else if (a.state === "err") b.err += 1;
    else b.done += 1;
    // Every failure the subagent ever had, not the ones its 200-call window
    // still holds — the count its own card prints (#1809).
    b.failed += a.toolErrorCount ?? 0;
  }
  return out;
}

/** "5 subagents · 3 live · 2 done". A zero is left out rather than printed,
 *  except the total, which is what the line is about. */
export function branchLong(b: BranchSummary): string {
  return [
    `${b.total} ${b.total === 1 ? "subagent" : "subagents"}`,
    b.live > 0 ? `${b.live} live` : null,
    b.done > 0 ? `${b.done} done` : null,
    b.err > 0 ? `${b.err} err` : null,
  ].filter(Boolean).join(" · ");
}

/** The same fact in the card's own notation: `→ 5` is what the spawn badge on
 *  a full card has always said for "spawned five". */
export function branchShort(b: BranchSummary): string {
  if (b.live > 0) return `→ ${b.total} · ${b.live} live`;
  return `→ ${b.total} · done`;
}

/** The tone a face's second line is drawn in. `warn` is how this sheet says
 *  "this one is on you", `err` is a failure, `idle` is the quiet accent the
 *  waiting row gives a finished turn, `muted` is information. */
export type FaceTone = "warn" | "err" | "idle" | "muted";

export interface FaceSignal {
  tone: FaceTone;
  /** For the compact face, with a line of its own to spend. */
  long: string;
  /** For the overview face, which has a word or two. */
  short: string;
}

/**
 * THE ONE THING A SMALL FACE SAYS UNDER THE NAME, in the order a reader would
 * want to be interrupted by it.
 *
 * A session blocked on a human comes first, and only the two kinds `isAlarming`
 * names — the same set the topbar count, the minimap and the waiting row use, so
 * a face cannot call a session stuck that the chip beside it calls fine. A turn
 * that stopped on an error is next: it is on you too, a "continue" away. A
 * finished turn waiting for its next prompt is next, quietly. Then failures,
 * then the step of its plan the card is on, then what the branch is doing,
 * then what the card itself is doing right now.
 * Nothing at all when none of those is true: a quiet card is a quiet face.
 *
 * Every string here is one the full card already says in some form. The face
 * picks; it does not invent — and the two sentences it borrows are handed in
 * rather than written again here: `sayWaiting` is the card's own waitingLabel
 * and `describeCall` the bubbles' own words for a call (primaryDisplayFor and
 * toolSubject), so the face and the card cannot come to word the same block,
 * or the same call, two ways.
 */
export function faceSignal(
  data: Pick<AgentNodeData, "kind" | "waiting" | "tools" | "state" | "toolErrorCount" | "plan" | "stopFailure">,
  branch: BranchSummary | undefined,
  words: {
    sayWaiting: (w: WaitingBlock) => string;
    describeCall: (t: ToolCall) => { name: string; subject?: string | null };
  },
): FaceSignal | null {
  const w = data.kind === "root" ? data.waiting : null;
  if (w && isAlarming(w)) {
    return {
      tone: "warn",
      long: words.sayWaiting(w),
      short: w.kind === "permission" ? "Needs you" : "Asked you",
    };
  }
  const stop = data.kind === "root" ? data.stopFailure : null;
  if (stop) return { tone: "err", long: stopRowLabel(stop), short: stopShortLabel(stop) };
  if (w && w.kind === "idle") {
    const said = words.sayWaiting(w);
    return { tone: "idle", long: said, short: said };
  }
  const failed = data.toolErrorCount ?? 0;
  if (failed > 0) {
    return {
      tone: "err",
      long: `${failed} tool ${failed === 1 ? "call" : "calls"} failed`,
      short: `${failed} failed`,
    };
  }
  // The step of its own plan a running card is on (#2157), ahead of the call it
  // has open: the call changes every few seconds and says HOW, the step holds
  // for minutes and says WHAT — which is the question a board seen from a
  // distance is asked. Only while it runs, and only with a step to name: a
  // finished list is history, and the full card says it.
  //
  // And ahead of the branch. A session that keeps a plan is the one that fans
  // out, so with the branch first a planning root's face said "3 subagents"
  // for the whole run and its plan was on no surface a fitted board draws —
  // the report was "release notes mentioned the agent's plan and progress but
  // I don't see it anywhere". The branch is still on the cluster pill and in
  // the subagents' own tiles beside this one.
  if (data.state === "active") {
    const plan = planSummary(data.plan);
    if (plan && plan.current && !plan.allDone) {
      return { tone: "muted", long: planLine(plan), short: `${plan.done}/${plan.total} done` };
    }
  }
  if (branch && branch.total > 0) return { tone: "muted", long: branchLong(branch), short: branchShort(branch) };
  // The newest call still open, when the card is running one: the line a
  // bubble would have carried, now that the bubbles are not drawn.
  if (data.state === "active") {
    for (let i = data.tools.length - 1; i >= 0; i--) {
      const t = data.tools[i];
      if (t.endedAt != null) continue;
      const { name, subject } = words.describeCall(t);
      return { tone: "muted", long: subject ? `${name} · ${subject}` : name, short: name };
    }
  }
  return null;
}

/** The mark a face draws for the card's state, which is a SHAPE per state and
 *  not only a colour: a filled dot for live, a tick for done, a cross for err. */
/**
 * The tooltip a line on a small face carries. Every line there is cut with an
 * ellipsis when the face is narrower than its text, at a size the face decides
 * per card, so each carries its whole text on hover the way the full card's
 * name does: the card's own tooltip for it when that already holds the text — a
 * root is named after the folder its tooltip opens with — and the text on a
 * line above it when not, as for a subagent named after its type.
 */
export function faceTitle(text: string, tooltip?: string): string {
  if (!tooltip) return text;
  return tooltip.includes(text) ? tooltip : `${text}\n${tooltip}`;
}

export type StateMarkKind = "live" | "done" | "err" | "idle";

/**
 * The state a card DRAWS, in its pill and its mark. A root whose last turn
 * stopped on an error (StopFailure, #2185) is drawn as a failure — the cross,
 * not done's tick beside a red "Stopped · login expired". Its `state` stays
 * "done", because the turn did end, and everything that counts live and done
 * sessions reads that.
 */
export function drawnState(data: Pick<AgentNodeData, "kind" | "state" | "stopFailure">): AgentNodeData["state"] {
  return data.kind === "root" && data.stopFailure && data.state === "done" ? "err" : data.state;
}

export function stateMarkKind(state: AgentNodeData["state"]): StateMarkKind {
  return state === "active" ? "live" : state === "done" ? "done" : "err";
}

/** What the detail card says about its state, beside the mark (V4's Agent /
 *  Card): a sentence-case word and the glyph. One function so the card's head
 *  and the faces at a distance agree on which state a card is in: `mark` is the
 *  face's own stateMarkKind for the three states.
 *
 *  A session blocked on you is the one case the two differ, on purpose. On the
 *  detail card the word "Waiting" names the state, so Figma's single Waiting
 *  glyph (the alert triangle) REPLACES the state mark. On the zoomed-out face
 *  there is no word, so the alert triangle stands BESIDE the state mark (a
 *  permission prompt lands on a session that is still live and the reader needs
 *  both). The colour is the CSS's, from `data-tone`. */
export type CardStateTone = "active" | "done" | "err" | "waiting";
export interface CardState {
  tone: CardStateTone;
  word: string;
  /** The mark beside the word; the waiting tone draws the alert triangle. */
  mark: StateMarkKind | "alert";
}

export function cardState(data: Pick<AgentNodeData, "kind" | "state" | "stopFailure" | "waiting">): CardState {
  if (data.kind === "root" && isAlarming(data.waiting)) {
    return { tone: "waiting", word: "Waiting", mark: "alert" };
  }
  const shown = drawnState(data);
  const mark = stateMarkKind(shown);
  return shown === "active" ? { tone: "active", word: "Working", mark }
    : shown === "done" ? { tone: "done", word: "Done", mark }
    : { tone: "err", word: "Failed", mark };
}
