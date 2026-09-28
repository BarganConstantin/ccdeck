// A subagent's life on the board: the Start that creates its node and pushes it
// onto the session's attribution stack, and the Stop that settles it and pops
// it off again.
//
// The two are separate hook processes, so the wire delivers them in either
// order and more than once. Both land at the same end state whichever way they
// arrive, which is the reducer's first rule; the tombstones and the redelivery
// window are how.
import { ensureSubagent, explicitSubagentKey, lookupSubagent, popActive, pushActive, subagentLabel } from "./agent-attribution";
import { subagentIdFor, type GraphState } from "./graph-state";
import { HOOK_REDELIVERY_WINDOW_MS } from "./redelivery";
import type { HookPayload } from "./types";

/** A subagent announcing itself — the only event that creates a subagent node.
 *  A Start whose Stop is already in (a tombstone, or a node that ended inside
 *  the redelivery window) settles the node rather than bringing it back. */
export function applySubagentStart(state: GraphState, p: HookPayload, sessionId: string, now: number): void {
  const key = explicitSubagentKey(p);
  if (!key) return;
  const sub = ensureSubagent(state, sessionId, key, p, now);
  const lbl = subagentLabel(p);
  if (lbl) sub.label = lbl;

  // THE ENDING THIS START ALREADY HAS, WHEREVER IT CAME FROM (#1023).
  //
  // Two arrivals reach this line looking identical to the one the
  // resurrection below is for, and neither of them is a second Task:
  //
  //   THE STOP GOT HERE FIRST. `SubagentStart` and `SubagentStop` are two
  //   separate hook processes, each spending up to 800 ms in `prove()`'s
  //   two-attempt challenge before it posts, so a fast subagent's Stop
  //   overtaking its own Start needs no unusual conditions at all. The Stop
  //   left a tombstone rather than being discarded; this reads it.
  //
  //   THIS START IS A RE-DELIVERY, landing after the Stop it belongs to.
  //   Same end state, same cause — several decks on one events.jsonl, a hook
  //   retry, a replayed log region.
  //
  // Either way the node was `done` a moment ago and this event resurrects
  // it: `active`, no `endedAt`, and its key back on the attribution stack
  // with no second Stop coming for it. `pruneOldAgents` needs `done` and
  // `pruneDoneSessions` needs nothing live, so THE WHOLE SESSION becomes
  // unevictable for the life of the tab, `runningSessionCount` has the tab
  // strip and the favicon claiming work in progress with nothing behind it,
  // and the stranded stack key hands every unkeyed Pre/PostToolUse of the
  // next turn to a subagent that finished. That last part is what
  // `pushActive` was hardened against in #675 — that fix covered the stack
  // and not the node, and this order gets past it because the key is
  // genuinely not on the stack at the time.
  //
  // The reducer cannot read intent off these payloads, so it does what
  // `promptAlreadyRecorded`, `Notification`'s `Math.min(prev.since, now)`
  // and `outcomeApplied` all do with the same ambiguity: it puts a clock on
  // it. Inside the window, this is the wire delivering one subagent's life
  // out of order. Outside it, a genuine second Task — CC does reuse a key
  // for one — and the resurrection below runs exactly as it always has.
  const tombstonedAt = state.subagentTombstones.get(sub.id);
  if (tombstonedAt != null) state.subagentTombstones.delete(sub.id);
  const endedRecently = sub.endedAt != null && now - sub.endedAt <= HOOK_REDELIVERY_WINDOW_MS;
  const stoppedFirst = tombstonedAt != null && now - tombstonedAt <= HOOK_REDELIVERY_WINDOW_MS;
  if (endedRecently || stoppedFirst) {
    // Settled, and settled at the same numbers whichever order the pair
    // arrived in — which is the whole point, reducer.ts's first line
    // being "same events in any order = same end state". The Stop's own
    // stamp is the ending; the Start's is the beginning, pulled back to it
    // when the wire delivered them the wrong way round so the card cannot
    // print a node that ended before it began.
    const endedAt = stoppedFirst ? tombstonedAt : sub.endedAt!;
    sub.state = "done";
    sub.endedAt = endedAt;
    sub.startedAt = Math.min(sub.startedAt, endedAt);
    popActive(state, sessionId, key);
    return;
  }

  sub.state = "active";
  sub.startedAt = sub.startedAt || now;
  // Resurrected subagent: a prior UserPromptSubmit flagged exitAt while
  // this slot was "done". If CC reuses the key (common when Task is
  // re-invoked with the same parent_tool_use_id), the agent must come
  // back fully visible — not get filtered out after EXIT_ANIM_MS.
  sub.exitAt = undefined;
  sub.endedAt = undefined;
  pushActive(state, sessionId, key);
}

/** A subagent finishing. A Stop for a subagent the board has not met yet
 *  leaves a tombstone for the Start that may still be on its way (#1023). */
export function applySubagentStop(state: GraphState, p: HookPayload, sessionId: string, now: number): void {
  const key = explicitSubagentKey(p);
  if (!key) return;
  // Lookup, don't create — a Stop without a prior Start is a no-op,
  // not a reason to manifest a phantom node.
  const sub = lookupSubagent(state, sessionId, key, p);
  if (!sub) {
    // ...but it is no longer FORGOTTEN (#1023). Refusing to manifest a
    // phantom node at end-of-life is right — a stray `parent_tool_use_id`
    // on somebody else's terminal event must not conjure a subagent — and
    // throwing the fact away was not. The Start this Stop belongs to may
    // still be in flight behind it, and it is the only thing that can act
    // on this: see the note there. One line per orphaned Stop, dropped when
    // consumed or when it is too old to be about the same subagent.
    for (const [id, at] of state.subagentTombstones) {
      if (now - at > HOOK_REDELIVERY_WINDOW_MS) state.subagentTombstones.delete(id);
    }
    state.subagentTombstones.set(subagentIdFor(sessionId, key), now);
    return;
  }
  sub.state = "done";
  // EARLIEST, not latest, for the reason `Notification` keeps the earliest
  // `since`: the ending belongs to the moment it happened, and a second copy
  // of one Stop landing later is not the subagent working for longer. Left
  // as `= now`, a re-delivery moved the node to the back of `pruneOldAgents`
  // eviction queue and lengthened the duration printed on its card — 3000 to
  // 9000 in the run #1023 filed. `Math.min` rather than "keep whichever
  // arrived first" so the answer does not depend on delivery order either.
  //
  // A genuine second Task is unaffected: `SubagentStart` clears `endedAt`
  // when it re-arms the node, so the second life's Stop finds nothing to be
  // earlier than.
  sub.endedAt = Math.min(sub.endedAt ?? now, now);
  popActive(state, sessionId, key);
}
