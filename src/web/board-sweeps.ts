// What changes the board without an event of its own: the two stale sweeps and
// the two pruners the deck's tick runs (`sweepTick` in prune.ts, and the tray
// over its own copy of the board), and the note the pause gate writes when a
// resume drops events.
//
// Each one mutates the state in place and answers whether anything changed,
// through `bump`, so a sweep that changed something is also one every memo can
// see.
import { forgetParkedEnrichment } from "./parked-enrichment";
import { rootAgentId, subagentIdFor, type GraphState } from "./graph-state";
import { releaseToolIds, settleUnanswered } from "./tool-calls";
import type { AgentNodeData } from "./types";

/** Record that a sweep changed something, and pass its answer through.
 *
 *  Every sweep here returns a boolean the caller uses to decide whether to
 *  re-render, and every one of them used to return it without moving anything a
 *  memo could see — see `revision` on GraphState for what that cost. One helper
 *  rather than four `state.revision += 1` lines, so the next sweep written here
 *  has an obvious thing to return through and no way to half-do it. */
function bump(state: GraphState, changed: boolean): boolean {
  if (changed) state.revision += 1;
  return changed;
}

/** Told which sessions left the board entirely, so somebody can say so.
 *
 *  BOTH PRUNERS TAKE IT, and they take the same one (#1024). The server keeps
 *  two caches that gate an emit on "has this changed" — `nameBySession` and
 *  `modelBySession` — and `handleClear`'s comment states the rule they live
 *  under: "anything answering 'has this changed' has to appear in BOTH places
 *  that mean the client no longer has it". There was a third place, and it is
 *  here: a session pruned out of `state.agents` is a session this page has
 *  forgotten, and the server has no way to know it. So it is told, and
 *  `forgetSession` on the other end drops the signature and the read stamps,
 *  and the session's name arrives again on its next event.
 *
 *  CALLED ONLY FOR A SESSION WITH NOTHING LEFT ON THE BOARD. `pruneOldAgents`
 *  evicts individual subtrees, and a root that goes while a sibling subagent
 *  stays is not a session the page has forgotten — it still holds the name it
 *  was sent. Reporting it would cost a transcript re-read for no change. */
export type ForgetSession = (sessionId: string) => void;

/** Evict the oldest "done" agents when the agents map exceeds `cap`. Only
 *  considers agents whose endedAt is older than `graceMs` so freshly-done
 *  agents (still in fade-out) aren't yanked from under the user. Mutates
 *  state in place. Returns true when at least one agent was removed.
 *
 *  A PARENT NEVER GOES BEFORE ITS CHILDREN (#445). This evicts individual
 *  agents in `endedAt` order and nothing tied a subagent's fate to its root's,
 *  so a root that finished BEFORE one of its subagents was deleted first — which
 *  happens whenever a background subagent outlives the turn that dispatched it,
 *  and on this machine's log that is every announced subagent — leaving
 *  `S::A.parentId` pointing at nothing. The result is a card that belongs to
 *  nowhere: canvas-flow.ts draws no edge for it because there is no parent node
 *  to draw to, `SessionList.buildRows` skips it because it is not a root, so it has no
 *  sidebar row and no cost roll-up, and it floats on the canvas with nothing to
 *  explain it. `pruneDoneSessions` has held the opposite invariant since it was
 *  written — it evicts whole subtrees and has a test asserting no agent is left
 *  pointing at a deleted parent — and this is the same invariant. It is kept the
 *  same way, too: an agent that has children leaves WITH them, so the eviction
 *  order stays "oldest ended first" and a root's departure is never something a
 *  later pass has to finish.
 *
 *  Skipping rather than cascading when a child is NOT a candidate, because that
 *  child is the reason to keep the parent. Everything in `stale` is `done`, but
 *  a subagent can still be `active` under a `done` root — a background Task, or
 *  a `SubagentStop` that was lost — and one inside `graceMs` is still fading out
 *  on screen. Taking the root then would delete the card the user is watching
 *  work, or yank one mid-animation; leaving the whole tree alone costs a pass,
 *  and the pass comes round every 250ms.
 *
 *  The one price is that the cap can undershoot: a tree leaves whole, so
 *  evicting a root with six subagents to get one node back under the cap removes
 *  seven. That is the trade `pruneDoneSessions` has always made for the same
 *  reason, and undershooting a memory bound is the harmless direction. */
export function pruneOldAgents(
  state: GraphState, now: number, cap: number, graceMs: number, onForget?: ForgetSession,
): boolean {
  if (state.agents.size <= cap) return false;
  // Evictable on its own terms: finished, and finished long enough ago that it
  // is not still fading out under the user's eyes.
  const evictable = (a: AgentNodeData): boolean =>
    a.state === "done" && a.endedAt != null && now - a.endedAt > graceMs;

  const stale: Array<{ id: string; endedAt: number }> = [];
  // Children per parent, over the WHOLE map rather than over the candidates —
  // the agents that are not candidates are exactly the ones whose parent has to
  // stay, so they have to be visible here.
  const childrenOf = new Map<string, string[]>();
  for (const [id, a] of state.agents) {
    if (a.parentId != null) {
      const kids = childrenOf.get(a.parentId);
      if (kids) kids.push(id); else childrenOf.set(a.parentId, [id]);
    }
    if (evictable(a)) stale.push({ id, endedAt: a.endedAt! });
  }
  if (stale.length === 0) return false;
  stale.sort((x, y) => x.endedAt - y.endedAt); // oldest first

  let removed = 0;
  // The sessions an eviction here touched, answered at the end rather than per
  // agent: whether a session is gone is a question about the map AFTER the
  // pass, not about the agent being deleted. See `ForgetSession`.
  const touched = new Set<string>();
  const drop = (id: string): void => {
    const a = state.agents.get(id);
    if (!a) return;
    // #443: the agent's in-flight ids go with it. See `releaseToolIds`.
    releaseToolIds(state, a);
    state.agents.delete(id);
    // A root never leaves before its subagents, so this is the session going:
    // and nothing it was waiting for may outlive it.
    if (a.kind === "root") forgetParkedEnrichment(state, a.sessionId);
    touched.add(a.sessionId);
    removed++;
  };

  for (const c of stale) {
    if (state.agents.size <= cap) break;
    // Already gone — a subagent whose root came up first left with it.
    if (!state.agents.has(c.id)) continue;
    // Read the children out of the live map rather than the snapshot: some of
    // them may have been evicted by an earlier iteration already.
    const kids = (childrenOf.get(c.id) ?? [])
      .map(id => state.agents.get(id))
      .filter((k): k is AgentNodeData => k != null);
    if (kids.some(k => !evictable(k))) continue;
    for (const k of kids) drop(k.id);
    drop(c.id);
  }
  if (onForget && touched.size > 0) {
    const left = new Set<string>();
    for (const a of state.agents.values()) left.add(a.sessionId);
    for (const sid of touched) if (!left.has(sid)) onForget(sid);
  }
  return bump(state, removed > 0);
}

/** Keep at most `cap` finished sessions on the board, dropping the ones that
 *  finished longest ago. A day of heavy use leaves hundreds of completed
 *  sessions parked on the canvas, which buries the handful that are actually
 *  current; the total-agent cap above doesn't help because it only fires at
 *  200 nodes and counts running work too.
 *
 *  Sessions are evicted whole — a session counts as finished only when every
 *  agent in it is done, so a subagent still running keeps its whole tree, and
 *  removing a root never orphans a child. `graceMs` after the last agent
 *  finishes, the session is still exempt so nothing vanishes mid-fade-out.
 *  Mutates state in place; returns true when anything was removed.
 *
 *  CLOSED SESSIONS GO FIRST, and that is the whole of #445. "Finished" here has
 *  only ever meant `endedAt` is set, and `endedAt` on a root is written by
 *  `Stop`, which is a TURN boundary on both providers — so the queue this
 *  function evicted from was mostly terminals the user was still sitting in
 *  front of, thinking. With the shipped constants (cap 6, grace 2 minutes) that
 *  is not theoretical: replaying this machine's two event logs through this
 *  reducer with the real tick, 20 sessions were evicted and 7 of them went on to
 *  produce more events afterwards — a still-open terminal vanishing from canvas
 *  and sidebar two minutes into thinking time and coming back on the next prompt
 *  as a brand-new node, with its prompts, its tool history, its `firstPrompt`,
 *  its model and its elapsed time all gone and `startedAt` reset to now. The
 *  same replay with the ranking below evicts 17 and gets 4 of them wrong, and
 *  all four had been silent for at least six minutes when they went — the
 *  residue is sessions that came back after hours, which no rule here can tell
 *  from a session that is over.
 *
 *  `closedAt` (types.ts) is what makes the two distinguishable, and ordering is
 *  all it is allowed to do. The cap still holds exactly and the count of
 *  evictions per pass is unchanged, so a board of nothing but idle sessions
 *  still settles at `cap` with the oldest going first — which it must, because
 *  absence of `closedAt` means "not known to be closed" and never "still open":
 *  a killed CLI sends no `SessionEnd`, and Codex has no such record at all. What
 *  changes is that a genuinely closed session is spent first when there is one,
 *  and an idle-but-open one is only spent when nothing better is available. */
export function pruneDoneSessions(
  state: GraphState, now: number, cap: number, graceMs: number, onForget?: ForgetSession,
): boolean {
  // sessionId -> { agent ids, latest endedAt, whether anything is still live,
  //                whether the session itself is known to be over }
  const sessions = new Map<string, { ids: string[]; endedAt: number; live: boolean; closed: boolean }>();
  for (const [id, a] of state.agents) {
    let s = sessions.get(a.sessionId);
    if (!s) { s = { ids: [], endedAt: 0, live: false, closed: false }; sessions.set(a.sessionId, s); }
    s.ids.push(id);
    // Only the root carries `closedAt`, for the same reason it is the only one
    // carrying `waiting` and `lastEventAt`: being over is a property of the
    // session and not of any one agent inside it.
    if (a.kind === "root" && a.closedAt != null) s.closed = true;
    if (a.state === "done" && a.endedAt != null) s.endedAt = Math.max(s.endedAt, a.endedAt);
    else s.live = true;
  }

  // Kept as [id, session] pairs rather than values alone: the id is what a
  // session that leaves the board has to be reported by. See `ForgetSession`.
  const finished = [...sessions]
    .filter(([, s]) => !s.live && s.endedAt > 0 && now - s.endedAt > graceMs)
    // Genuinely-closed sessions first, and oldest-finished first within each
    // group — so the old ordering is exactly what remains when nothing on the
    // board is known to be closed, which is every board a Codex-only or a
    // kill-the-terminal user ever sees.
    .sort(([, x], [, y]) => (x.closed === y.closed ? x.endedAt - y.endedAt : x.closed ? -1 : 1));

  // Sessions still inside the grace period already count against the cap, so
  // the board settles at `cap` rather than briefly overshooting it.
  const finishedTotal = [...sessions.values()].filter(s => !s.live).length;
  let over = finishedTotal - cap;
  if (over <= 0) return false;

  let removed = false;
  for (const [sid, s] of finished) {
    if (over <= 0) break;
    for (const id of s.ids) {
      // #443: the session is evicted whole, so every agent in it releases the
      // tool ids it still holds open. See `releaseToolIds`.
      const a = state.agents.get(id);
      if (a) releaseToolIds(state, a);
      state.agents.delete(id);
    }
    // Enrichment still waiting for this session's card goes with it.
    forgetParkedEnrichment(state, sid);
    // A model still waiting for its subagent's Start goes with the session: it
    // is filed under that subagent's id, and every one of those starts with
    // the session's own prefix.
    const subPrefix = subagentIdFor(sid, "");
    for (const id of state.pendingSubagentModels.keys()) {
      if (id.startsWith(subPrefix)) state.pendingSubagentModels.delete(id);
    }
    // Whole, so there is nothing left to check: the page has forgotten this
    // session and the server has to be told. See `ForgetSession`.
    onForget?.(sid);
    over--;
    removed = true;
  }
  return bump(state, removed);
}


/** Tell the graph that the deck is about to apply a run with a hole in it, so
 *  that a call left unanswered by that run is described as a gap rather than
 *  blamed on its session. Returns true when anything was flagged. Mutates in
 *  place, like the sweeps.
 *
 *  #676. The pause gate bounds its hold, and a hold at its ceiling drops events
 *  the stream will never offer again — `through` and the browser's
 *  `Last-Event-ID` both moved past them when they were offered. The reducer
 *  cannot see that from the envelopes it gets: a run with 201 envelopes missing
 *  from the middle is a run of strictly increasing seqs, exactly like a quiet
 *  minute. So the drain says so, here, before it feeds the run in.
 *
 *  Every call in flight is flagged, not a guessed subset. The deck genuinely
 *  does not know what was in the events it dropped, and the honest claim is
 *  about all of them; the flag then burns off on the first real outcome for
 *  each call, so what is still flagged an hour later is exactly the set nothing
 *  ever answered. `agent.tools` rather than `toolIndex` because that is what
 *  `sweepStaleTools` walks, and a call that fell out of the index but is still
 *  drawn in-flight is one the sweep will still pass a verdict on. */
export function noteDroppedEvents(state: GraphState): boolean {
  let changed = false;
  for (const a of state.agents.values()) {
    for (const t of a.tools) {
      if (t.endedAt != null || t.outcomeGap) continue;
      t.outcomeGap = true;
      changed = true;
    }
  }
  return bump(state, changed);
}

/** Finalise every in-flight tool call belonging to a CLAUDE session that has
 *  gone completely silent for `maxMs` — the session was killed mid-call and the
 *  PostToolUse that would have settled the call is never coming. Without this
 *  those calls pulse forever in the burst layer and pollute the in-flight
 *  counter. Codex agents are skipped, because there a missing result means the
 *  call has not finished rather than that its result was lost — see the note
 *  inside. The clock is the SESSION's last event and never the call's own age;
 *  see the note on the guard below for why that distinction is the whole point.
 *  Returns true when at least one tool was staled, so callers can trigger
 *  a re-render. Mutates state in place. */
export function sweepStaleTools(state: GraphState, now: number, maxMs: number): boolean {
  let changed = false;
  for (const a of state.agents.values()) {
    // #397: not Codex, because on Codex the premise of this sweep is false.
    //
    // The sweep reads "no PostToolUse after 90s" as "the event was lost", and on
    // Claude that inference is sound: Claude emits PostToolUse for every call it
    // completes, so a missing one really does mean a session that died mid-call.
    // Codex does not work that way. It appends the CALL line to its rollout at
    // request time, before the tool has run — proven by the events that land
    // strictly between a call line and its output line, and by the call/output
    // gap tracking the command's real duration (117 windows on this machine,
    // 0 unanswered, p50 134ms, max 3936ms). So a Codex call sitting here with no
    // output line is not a call whose result went missing. It is a call that has
    // not produced one yet: a long command still running, or — the case this
    // costs the most — one parked on an approval prompt, waiting for the human.
    //
    // Ninety seconds later this used to stamp that call `ok = false` with
    // `errorPreview = "stale (no PostToolUse received)"`, and the deck told the
    // user a command had errored while Codex was politely waiting for them to
    // say yes. Both halves were wrong: nothing failed, and the cause named is an
    // internal one that never applied to this provider. Leaving the call alone
    // leaves it in-flight, which is the one description of it that is true, and
    // if the human approves at minute five the output line settles it normally
    // through `toolIndex` with its real outcome.
    //
    // Nothing runs away as a result. `trimTools` evicts an in-flight call from
    // `toolIndex` once it falls out of the 200-per-agent window, and the bubble
    // goes with the agent when the session is pruned — as, since #443, do that
    // agent's entries in `toolIndex`, which is what this sentence had been
    // claiming for two releases while both pruners deleted the agent and left
    // the index alone. Codex is where that mattered: this `continue`
    // is what makes pruning the only bound left here. Only an explicit "codex"
    // is exempt — an event recorded before `provider` existed replays without
    // one and must keep the Claude behaviour it was swept with.
    if (a.provider === "codex") continue;

    // #436: the clock is the SESSION's silence, not the call's age.
    //
    // Claude does emit a PostToolUse for every call it completes, so a call that
    // will never get one is a real thing to draw. But "no PostToolUse yet" and
    // "no PostToolUse ever" are not the same state, and a timestamp on the call
    // alone cannot tell them apart: at any age, a silent call is either a session
    // that died mid-call or a command that is simply still running. Judged on age
    // this sweep guessed "died", and on this machine's log it guessed wrong far
    // more often than right — of the 16 Claude calls it would have stamped failed
    // at the old ninety seconds, 13 went on to return normally (12 `Bash`, one
    // `AskUserQuestion`; longest 776.2s, drawn red and counted as an error for
    // 686.2s of that) and only 3 were genuinely lost. Four in five of its verdicts
    // were false, and a call drawn as failed while it is still working is a lie
    // the user acts on — they go and kill the build the deck says already broke.
    //
    // No threshold on the call's own age can fix that, which is why this is not
    // simply a bigger number. Ninety seconds sat below Claude Code's own Bash
    // timeout (120s default, up to 600s), so the sweep fired inside the CLI's
    // documented operating range; but 600s does not save it either — two of the
    // measured honest calls ran past that, because PreToolUse fires before the
    // permission decision, so a call parked on a human is unbounded in exactly the
    // way #397's Codex approval prompt is. There is no number that is above every
    // legitimate call and below every dead one, because the two overlap.
    //
    // The discriminator that does separate them is a different fact entirely, and
    // it is already on the node: `lastEventAt` (#350) is when this session was
    // last heard from at all. A session still emitting events is alive, so its
    // quiet call is slow; a session that has emitted nothing is the case this
    // sweep was built for. That is the same judgement `sweepStaleSessions` makes
    // one level up, so it is made here on the same clock and the same window
    // rather than on a second, shorter one that contradicts it — the deck used to
    // call a session dead enough to fail its tools at ninety seconds while still
    // calling it alive at ninety minutes.
    //
    // Both halves are load-bearing, and swapping the clock WITHOUT also adopting
    // that window would have fixed nothing. A foreground tool call is the whole of
    // what its session is doing, so the session is silent for the length of the
    // call by construction: all 13 false positives above ran on sessions whose
    // longest silence inside the call window was the call itself (776.2s of call,
    // 769.9s of silence). Read against a ninety-second window, `lastEventAt` would
    // have condemned every one of them exactly as `startedAt` did. What it buys is
    // the case the age clock cannot see at all — a session whose subagents are
    // still reporting is alive no matter how old one of its calls is — and, more
    // than that, it makes the window mean something: ninety minutes is not a
    // bigger guess, it is the number this file already defends for "presumed
    // dead", and this sweep is now asking that question and no other.
    //
    // The direction this is now wrong in is the cheap one. A genuinely lost call
    // stays drawn in-flight until its session goes quiet for the full window
    // instead of settling at ninety seconds — a spinner that lingers rather than a
    // failure that never happened. Nothing is lost by waiting: all 3 genuinely
    // orphaned calls measured here belong to sessions that did eventually fall
    // silent, so every one of them still settles, just later and only once there is
    // evidence for it. #397 made the same trade for Codex.
    //
    // Falling back to the call's own start when the root is gone keeps a subagent
    // orphaned by `pruneOldAgents` from holding an in-flight call forever; a
    // session whose root has already been pruned is over by definition.
    const root = state.agents.get(rootAgentId(a.sessionId));
    const heardAt = root?.lastEventAt ?? root?.startedAt;

    for (const t of a.tools) {
      // `heardAt` cannot precede the call's own PreToolUse in practice — that
      // event stamped it — but `Math.max` makes the guard hold anyway rather than
      // depending on an invariant enforced somewhere else in the file.
      const silentSince = Math.max(t.startedAt, heardAt ?? t.startedAt);
      if (t.endedAt == null && now - silentSince > maxMs) {
        // Stamped at the last moment there is any evidence the call was running,
        // exactly as `sweepStaleSessions` stamps the session's own `endedAt`, so
        // the call and the session it died with agree about when that was. The
        // old `startedAt + maxMs` was a duration invented by the sweep.
        //
        // Says what was observed rather than naming an internal mechanism the
        // reader has never heard of. The old string — "stale (no PostToolUse
        // received)" — described the sweep's own plumbing and was untrue in every
        // false positive above; #397 settled the same wording question for Codex
        // by not asserting a cause at all, and this is the Claude equivalent for
        // the one case where a cause is actually known.
        //
        // #676: known, as long as nothing went missing on the deck's own side.
        // The whole argument for naming a cause here is that Claude emits a
        // PostToolUse for every call it completes, so total silence for the full
        // window leaves one explanation. A pause that overflowed its hold breaks
        // that premise: the event was emitted, delivered and then discarded by
        // this tab, and the stream will not offer it again. The sweep cannot
        // detect that from the graph — a run with a hole in it is a run of
        // increasing seqs like any other — so `noteDroppedEvents` records it at
        // the moment the hole is applied, and the two strings are the two things
        // the deck can honestly say. Naming the session in the second case is
        // the expensive kind of wrong: a missing result is a gap the user can
        // see through, a cause that never happened is a bug hunt.
        //
        // Also out of the live tool index, so the id is not held open by a
        // session that is gone — which does not make the call unsettleable: when
        // the sweep guessed wrong and the session comes back, its late
        // PostToolUse resurrects the call, the way `noteSessionHeard` un-reaps
        // the root. See `settleUnanswered`.
        settleUnanswered(state, a, t, silentSince, "session ended before this call returned");
        changed = true;
      }
    }
  }
  return bump(state, changed);
}

/**
 * How long a session may go COMPLETELY silent before the deck stops believing
 * it is there.
 *
 * The clock is the session's last event, never a block's own `since`. Those are
 * different numbers and only one of them is about being alive: `since` is when
 * the permission prompt arrived, and the session it arrived on may be working
 * the entire time the human takes to answer — the other tool calls of the same
 * turn, a subagent still running underneath. Measured against `since`, any
 * threshold shorter than the longest a human might take cancels blocks that are
 * real. Measured against the last event, a session that is still moving is never
 * touched at all, however long it has been blocked.
 *
 * Ninety minutes is what is left once the workloads that produce genuine silence
 * are ruled out. A single foreground tool call is the longest of the mechanical
 * ones and CC caps Bash at 600_000ms, so ten minutes already covers the longest
 * build or `sleep` one call can hold; a slower MCP tool with no cap of its own is
 * still minutes rather than hours, and a subagent doing long work emits its own
 * Pre/PostToolUse under the same session id throughout. The long pole is not a
 * tool at all, it is the human: a permission prompt left standing through a
 * meeting is an hour of silence on a session that is entirely alive, which is
 * the case #350 explicitly warns against cancelling. Ninety minutes clears that
 * hour by half again.
 *
 * It is deliberately not longer. No finite number survives a session left
 * overnight, so every threshold here is only choosing which way to be wrong, and
 * past roughly two hours the choice stops buying anything while the cost keeps
 * rising: the tab title, the favicon and the topbar chip are worth having only
 * while they are rare AND true, and a dead session holding all three through a
 * working day is the exact failure #348 was built to avoid. Being wrong this way
 * is also the cheap direction — a reaped session is not a lost one, because the
 * next event from it puts it straight back (see `reaped` in types.ts).
 */
export const STALE_SESSION_MS = 90 * 60_000;

/**
 * Settle every session that has not been heard from in `maxMs`, and drop its
 * waiting block with it. Returns true when anything changed, so the caller can
 * re-render. Mutates state in place.
 *
 * This is the sweep the other three decline. `sweepStaleTools` finalises
 * ToolCalls and never looks above them; `pruneOldAgents` wants `state === "done"`
 * and `pruneDoneSessions` wants a session with nothing live in it — and the
 * session this exists for is `active`, because a permission prompt arrives
 * mid-turn and the event that would have ended that turn is the one that never
 * came. So it sat there forever, and since #348 a `permission` block is what
 * lights the tab title and the favicon: two surfaces with no age printed on them
 * that a killed session could hold indefinitely.
 *
 * Staleness is fixed here rather than by giving `waiting` a TTL of its own,
 * because the stale block and the stale `active` beside it are one bug and not
 * two. Settling the state clears the block on the way past, so the alarm counts
 * fall out for free — #348 reads `kind` off a block that is gone.
 *
 * `endedAt` is stamped at the last event rather than at `now`: that is the last
 * moment there is any evidence the session existed, and it lets the two pruners
 * treat a two-hour-dead session as the oldest thing on the board, which it is.
 * Only `active` agents are settled — an `err` node keeps its error — and the
 * subagents go with the root, since a session nothing has been heard from has no
 * live children either.
 *
 * The session's attribution stack goes with them, for the reason `Stop` gives
 * for dropping it there (#442). See the note at the delete below.
 */
export function sweepStaleSessions(state: GraphState, now: number, maxMs: number): boolean {
  let changed = false;
  for (const root of state.agents.values()) {
    if (root.kind !== "root") continue;
    // `startedAt` is the fallback for a root built before this field existed —
    // a replayed log, a tab that survived an upgrade — and it is the right one:
    // a session with no stamped event has been heard from exactly once.
    const heardAt = root.lastEventAt ?? root.startedAt;
    if (now - heardAt <= maxMs) continue;

    // The block goes whether or not there is any state left to settle, so an
    // idle_prompt parked on a session that stopped hours ago stops claiming to
    // be news. One rule — "a session nobody has heard from is not current" —
    // rather than a rule for the state and a second one for the badge.
    if (root.waiting) { root.waiting = null; changed = true; }

    // The session is over, and this is the sweep saying so about the SESSION
    // rather than about a turn (#445) — which makes it the second writer of
    // `closedAt` and the one that matters for a terminal the user closed
    // without exiting cleanly, since a killed CLI sends no `SessionEnd` at all.
    // It is stamped for every root past `maxMs`, not only for the ones settled
    // below: a root that a `Stop` already left `done` is skipped by that branch,
    // so without this line an idle-but-open session that turned out to be gone
    // would sit at the back of the eviction queue forever and the board would
    // fill with this morning's terminals while today's honest endings were
    // evicted around them. `heardAt`, not `now`, for the same reason `endedAt`
    // uses it: that is the last moment there is evidence the session existed.
    //
    // `changed` is deliberately not touched, exactly as for the stack delete
    // below — nothing on screen is drawn from this field, so writing it is not a
    // reason to re-render this tick.
    if (root.closedAt == null) root.closedAt = heardAt;

    if (root.state === "active") {
      root.state = "done";
      root.endedAt = heardAt;
      root.reaped = true;
      changed = true;
    }
    for (const a of state.agents.values()) {
      if (a.sessionId !== root.sessionId || a.kind === "root" || a.state !== "active") continue;
      a.state = "done";
      a.endedAt = heardAt;
      changed = true;
    }

    // #442: the attribution stack goes with the nodes the loop above just
    // settled. This sweep is the stand-in for a `Stop` that never arrived, and
    // `Stop` drops the stack for a reason that applies here word for word: keys
    // land on it at `SubagentStart` and come off only at `SubagentStop`, hook
    // POSTs are fire-and-forget, and one sent while the server was restarting is
    // gone for good. A key left behind is not inert — `resolveOwner` reads the
    // stack top for every event that carries no `agent_id`, which is all the real
    // `Pre`/`PostToolUse` traffic, so every root-level tool call of the next turn
    // renders under a subagent that finished two hours ago.
    //
    // Nothing downstream repairs it, which is why this has to happen here. The
    // human's next PROMPT is no longer part of the damage — `UserPromptSubmit`
    // reads the root directly since #675 — but until it did, that case made
    // things worse rather than better: its retirement loop stamped `exitAt` on
    // the settled subagent and the `resolveOwner` call four lines later cleared
    // `exitAt`, `endedAt` and `state` on the very same node in the very same
    // event, so the zombie was un-retired by the act of typing. Both pruners then
    // declined it at cap 0 and grace 0 because it was `active` again, and
    // `popActive` only ever removes its own key — so the stale one sat
    // UNDERNEATH any later `SubagentStart` and resurfaced as stack top the moment
    // that newer, legitimate subagent stopped. It was not confined to one turn.
    //
    // Clearing is safe on the premise this sweep is built on, and the premise is
    // stronger here than at `Stop`. A subagent doing long work emits its own
    // Pre/PostToolUse under this same session id, and every one of those stamps
    // `lastEventAt` on this root — so a session that reached `maxMs` of TOTAL
    // silence has no subagent still working under it by construction, whatever
    // the stack still says.
    //
    // It is also the only choice that agrees with the un-reap in `applyEvent`
    // (#350). A late event puts the ROOT back — `reaped` cleared, `state` active,
    // `endedAt` undone — and deliberately leaves the settled subagents `done`,
    // because a subagent that was mid-flight when its session went quiet is
    // genuinely over and `SubagentStart` is the documented way one comes back.
    // Restoring the stack alongside the root would therefore hand a `done` node
    // the whole of the resumed session's traffic: exactly the zombie above, now
    // re-created by the recovery path. The stack stays empty, the resumed session
    // attributes to its root, and a subagent that really did survive re-announces
    // itself and is pushed back on by `pushActive` as usual.
    //
    // `changed` is not touched: the stack is attribution state for events that
    // have not arrived yet, and nothing on screen is drawn from it, so removing a
    // key is not a reason to re-render this tick. `Map.delete` on a session that
    // never had a stack — the common case — is a no-op, so the sweep stays free
    // for the sessions this is not about.
    state.activeSubagentStack.delete(root.sessionId);
  }
  return bump(state, changed);
}
