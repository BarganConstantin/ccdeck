// Where the usage panel's ccusage session rows meet the canvas: what the board
// calls each session, what it is doing, and how two rows under one name are
// told apart.
//
// Lifted out of UsagePanel.tsx, where these were the bodies of two memos and
// the tail of a third, so that a test can call them rather than match their
// text. ccusage knows what a session cost and the canvas knows what to call
// it; both file a session under the same id, and the join is on that id and
// nothing else. No React and no graph: an agent here is the five fields read.
import type { AgentState } from "./types";
import { distinctIdTail } from "./session-id-tail";

/** What the join reads off a board agent. */
export interface JoinableAgent {
  kind: string;
  sessionId?: string;
  label?: string;
  cwdBasename?: string;
  state: AgentState;
}

/**
 * The board's own names, by session id. `period` on a ccusage session row is
 * the session id, which is the same key the canvas files its agents under.
 */
export function boardSessionNames(agents: Iterable<JoinableAgent>): Map<string, string> {
  const names = new Map<string, string>();
  for (const a of agents) {
    // The same label the board's own session rows use — a.label when the
    // session has been named, the working directory otherwise. Roots only:
    // a subagent carries its parent's sessionId and would overwrite the
    // session's name with a tool's.
    if (a.kind !== "root" || !a.sessionId) continue;
    const label = a.label || a.cwdBasename;
    if (label) names.set(a.sessionId, label);
  }
  return names;
}

/**
 * What the canvas is doing right now, by the same key. A ccusage row for a
 * session that finished last week has no state to report and gets no dot; one
 * that is on the board keeps the dot the session list draws for it.
 */
export function boardSessionStates(agents: Iterable<JoinableAgent>): Map<string, AgentState> {
  const st = new Map<string, AgentState>();
  for (const a of agents) {
    if (a.kind !== "root" || !a.sessionId) continue;
    st.set(a.sessionId, a.state);
  }
  return st;
}

/**
 * The rows, with a repeated name told apart by the tail of its session id.
 *
 * Two sessions in the same folder is the normal case here — parallel agents,
 * or one deck restarted — and both then arrive under the same project name.
 * Identical rows carrying different figures read as a bug in the panel, so a
 * repeated name takes the last four characters of its session id — more when
 * another row under that name ends the same way. Only a repeated one: the
 * common case is a list of distinct projects, and a uuid fragment on every row
 * would be noise on a 280px column.
 *
 * The TAIL, because a Codex id is a UUIDv7 and opens with its timestamp: every
 * Codex session of the same seven weeks shares its first four characters, so
 * the head told two of them apart not at all (#1732). See session-id-tail.ts.
 *
 * Counted over the rows it is given, so the panel hands it the list after its
 * cut: a name repeated only among rows that are not drawn is not repeated on
 * screen. A row that is not renamed comes back as the same object.
 */
export function distinctSessionLabels<T extends { label: string | null; sessionId: string }>(rows: readonly T[]): T[] {
  const idsByLabel = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.label) continue;
    const ids = idsByLabel.get(r.label);
    if (ids) ids.push(r.sessionId);
    else idsByLabel.set(r.label, [r.sessionId]);
  }
  return rows.map(r => {
    const ids = r.label ? idsByLabel.get(r.label) ?? [] : [];
    return ids.length > 1 ? { ...r, label: `${r.label} ${distinctIdTail(r.sessionId, ids)}` } : r;
  });
}
