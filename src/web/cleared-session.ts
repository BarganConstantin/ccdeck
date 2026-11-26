// Where a Claude session's terminal went after a /clear.
//
// Claude Code's /clear (typed in Term, sent from Chat's composer, or a plan's
// "clear context" choice) does not end the process: the same terminal goes on
// as a NEW session, with a new id and a new transcript. Its hooks say so as a
// pair, one after the other from the same process: a `SessionEnd` with
// `reason: "clear"` for the session that was, and a `SessionStart` with
// `source: "clear"` for the one that is (session-lifecycle.ts marks both).
//
// The deck's own pane keeps the id it launched the agent under
// (terminal-target.mjs deckTarget), so a pane opened on the cleared session
// attaches a terminal that draws the new conversation. A Chat that read the
// cleared session's transcript beside it showed an earlier reply under Term's
// newer output, and none of the new conversation's questions. The pane follows
// the terminal instead: terminalSessionId (canvas-session.ts) answers the
// session a /clear left it to, and the stage shows that one, in Term and in
// Chat alike.
//
// PAIRED ONLY WHEN IT IS NOT A GUESS. The two ends must be in the same folder
// and within CLEAR_PAIR_MS of each other, in either order (the hooks are
// separate posts); two sessions cleared in one folder at that moment are not
// told apart, and neither is followed. A cleared session that begins again
// (Reopen here, `--resume`) is its own terminal's again.
import { rootAgentId } from "./graph-state";
import type { AgentNodeData } from "./types";

/** How far apart the two hooks of one /clear may land. They are posted back to
 *  back by one process; this leaves room for a slow or busy machine. */
export const CLEAR_PAIR_MS = 10_000;

/** How many /clears in a row are followed: a guard, not a limit anyone meets. */
export const MAX_CLEAR_HOPS = 8;

const isClaude = (a: AgentNodeData) => (a.provider ?? "claude") === "claude";

/** Roots in `cwd` whose mark `at` falls within CLEAR_PAIR_MS of `when`. */
function near(agents: ReadonlyMap<string, AgentNodeData>, cwd: string, when: number, at: (a: AgentNodeData) => number | undefined): AgentNodeData[] {
  const out: AgentNodeData[] = [];
  for (const a of agents.values()) {
    const mark = at(a);
    if (a.kind !== "root" || mark == null || a.cwd !== cwd || !isClaude(a)) continue;
    if (Math.abs(mark - when) <= CLEAR_PAIR_MS) out.push(a);
  }
  return out;
}

/** The session a /clear left session `id`'s terminal to, or null when it was
 *  not cleared, or when which one cannot be told. */
export function clearedInto(agents: ReadonlyMap<string, AgentNodeData>, id: string): string | null {
  const from = agents.get(id);
  if (!from || from.kind !== "root" || !isClaude(from) || from.clearedAt == null || from.closedAt == null || !from.cwd) return null;
  const began = near(agents, from.cwd, from.clearedAt, a => a.clearBeganAt).filter(a => a.sessionId !== from.sessionId);
  if (began.length !== 1) return null;
  const to = began[0];
  // And the new one could have come from this session only.
  const left = near(agents, from.cwd, to.clearBeganAt!, a => (a.closedAt != null ? a.clearedAt : undefined));
  return left.length === 1 && left[0] === from ? to.sessionId : null;
}

/** Session `id`, or the one its terminal went on as after one /clear or more. */
export function afterClears(agents: ReadonlyMap<string, AgentNodeData>, id: string): string {
  let at = id;
  const seen = new Set([id]);
  for (let hop = 0; hop < MAX_CLEAR_HOPS; hop++) {
    const next = clearedInto(agents, at);
    if (next === null || seen.has(next)) break;
    seen.add(next);
    at = next;
  }
  return at;
}

/** What the pane in focus shows: the tab it holds, kept under the id it was
 *  opened on (use-stage.ts splitOutTab), and the session that tab stands for
 *  now (afterClears, above). The two differ only after a /clear in that
 *  tab's terminal. */
export interface PaneShows { tab: string; session: string }

/**
 * Where the selection goes when the pane in focus has followed its terminal
 * through a /clear: the new session's root, or null to leave it as it is.
 *
 * The session on the stage is the selected one (use-stage.ts follow): every
 * way the reader moves the stage selects what it moves to. A /clear moves
 * what the pane shows with no one asking the stage for anything: the tab
 * stays, and the session it stands for is the new one. Left there, the
 * session list kept its highlight on the row of the session that ended, and
 * the Inspector and the topbar's ribbon named it, beside a pane that draws
 * the new conversation.
 *
 * So the selection follows the tab here, once for each /clear: at the render
 * that sees the same tab stand for another session (`before` is what the
 * pane showed at the render before, `now` what it shows). Only when the
 * selection was the session the pane showed until then, its root or one of
 * its cards (a subagent's card is its session's, graph-state.ts). A selection
 * the reader moved to another session meanwhile is theirs, and stays.
 */
export function selectionAfterClear(
  agents: ReadonlyMap<string, AgentNodeData>, before: PaneShows | null, now: PaneShows | null, primary: string | null,
): string | null {
  if (!before || !now || primary === null) return null;
  if (before.tab !== now.tab || before.session === now.session) return null;
  const selected = agents.get(primary)?.sessionId ?? primary;
  return selected === before.session ? rootAgentId(now.session) : null;
}
