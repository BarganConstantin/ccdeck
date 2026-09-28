// How the reducer tells the wire delivering one thing twice from two things.
//
// Every event can arrive more than once — a copy per deck sharing events.jsonl,
// a hook retry, a whole log replayed into every tab that opens — and each copy
// carries a fresh seq, so the seq/epoch guard lets it through. Where a payload
// has no id of its own to compare, the reducer puts a clock on the ambiguity,
// and these are the clocks.
import type { AgentNodeData } from "./types";

/** How far apart two identical prompt submissions can land and still be one
 *  submission arriving twice rather than the user typing the same thing again.
 *  Every copy is stamped by the process that handled it: a log replay carries
 *  the original writer's `receivedAt` and lands on the same millisecond, while
 *  the hook's fan-out has each deck stamp its own arrival — milliseconds apart,
 *  and bounded by the hook's own 1500ms hard cap on that whole fan-out. A
 *  genuine second submission of the same text cannot land inside this window:
 *  the turn the first one opened has to end first. */
export const PROMPT_REDELIVERY_WINDOW_MS = 2_000;

/** True when `text` is already on this agent's prompt list from a submission
 *  close enough in time to be the same one. Walks newest-first and stops at the
 *  first entry that predates the window — the list is in arrival order, so
 *  everything before it is older still. Entries *newer* than the window are
 *  skipped rather than stopped on: a boot replay re-delivers a whole log, so
 *  the copy of an old prompt arrives after every later prompt is recorded. */
export function promptAlreadyRecorded(a: AgentNodeData, at: number, text: string): boolean {
  for (let i = a.prompts.length - 1; i >= 0; i--) {
    const prev = a.prompts[i];
    if (prev.at < at - PROMPT_REDELIVERY_WINDOW_MS) return false;
    if (prev.text === text && prev.at <= at + PROMPT_REDELIVERY_WINDOW_MS) return true;
  }
  return false;
}

/** How far apart two events with no payload of their own to tell them apart can
 *  land and still be ONE moment reaching the deck twice rather than two.
 *
 *  Deliberately the same number as `PROMPT_REDELIVERY_WINDOW_MS`, and arrived at
 *  the same way: it is a bound on the WIRE, not on the work. Every copy is
 *  stamped by the process that handled it — a log replay carries the original
 *  writer's `receivedAt` and lands on the same millisecond, while the hook's
 *  fan-out has each deck stamp its own arrival, bounded by the hook's 1500 ms
 *  hard cap on that whole fan-out. Two separate hook processes racing each other
 *  (`SubagentStart` and `SubagentStop` are two, each spending up to 800 ms in
 *  `prove()`'s challenge before posting) are bounded by the same cap.
 *
 *  The number has to be SMALL, because what it refuses is legitimate the rest of
 *  the time. A `Stop` hook that blocks and lets the agent carry on emits a
 *  second genuine `Stop`; Claude Code reuses an `agent_id` for a second Task and
 *  that Task must bring the node back fully. Neither fits inside two seconds:
 *  a turn that opens and closes again, or a subagent's whole life plus the next
 *  dispatch of it, is a model round trip at minimum. Everything inside this
 *  window is the wire talking twice. */
export const HOOK_REDELIVERY_WINDOW_MS = 2_000;

/** The newest moment this root holds FIRST-HAND evidence of, in the one shape a
 *  terminal event can be checked against: when the session began, and when its
 *  newest turn was opened.
 *
 *  Deliberately not "the newest event of any kind" (`lastEventAt`). Tool traffic
 *  lands milliseconds either side of a `Stop` — several decks' fan-out copies of
 *  one `PostToolUse` are stamped by whichever process handled them — so ranking a
 *  `Stop` against it would refuse ordinary turn endings over millisecond jitter
 *  and leave the root `active` for ever, which is worse than the bug being fixed.
 *  A session's own start and its prompts are coarse: the gap from a prompt to the
 *  `Stop` that answers it is a model turn, seconds at the very least. An event
 *  claiming to end a turn that had not been opened yet is out of order, and there
 *  is no jitter narrow enough to make that reading wrong. */
export function sessionEvidenceAt(root: AgentNodeData): number {
  // Scanned rather than read off the end: the list is in ARRIVAL order, and
  // `promptAlreadyRecorded`'s own note records that a replay can append an old
  // prompt after newer ones when the original copy was never seen.
  let newest = root.startedAt;
  for (const prompt of root.prompts) if (prompt.at > newest) newest = prompt.at;
  return newest;
}
