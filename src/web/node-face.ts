import type { AgentNodeData, ToolCall, WaitingBlock } from "./types";
import { isAlarming } from "./ambient-counts";

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
  for (const a of agents) {
    if (a.kind !== "subagent" || a.exitAt != null) continue;
    let b = out.get(a.sessionId);
    if (!b) { b = { total: 0, live: 0, done: 0, err: 0, failed: 0 }; out.set(a.sessionId, b); }
    b.total += 1;
    if (a.state === "active") b.live += 1;
    else if (a.state === "err") b.err += 1;
    else b.done += 1;
    for (const t of a.tools) if (t.ok === false) b.failed += 1;
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
 * a face cannot call a session stuck that the chip beside it calls fine. A
 * finished turn waiting for its next prompt is next, quietly. Then failures,
 * then what the branch is doing, then what the card itself is doing right now.
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
  data: Pick<AgentNodeData, "kind" | "waiting" | "tools" | "state">,
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
  if (w && w.kind === "idle") {
    const said = words.sayWaiting(w);
    return { tone: "idle", long: said, short: said };
  }
  const failed = data.tools.filter(t => t.ok === false).length;
  if (failed > 0) {
    return {
      tone: "err",
      long: `${failed} tool ${failed === 1 ? "call" : "calls"} failed`,
      short: `${failed} failed`,
    };
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
export type StateMarkKind = "live" | "done" | "err";

export function stateMarkKind(state: AgentNodeData["state"]): StateMarkKind {
  return state === "active" ? "live" : state === "done" ? "done" : "err";
}
