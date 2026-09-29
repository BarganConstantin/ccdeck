// A session's life on the board: the start that retracts the joined-late
// marker, the prompt that opens a turn, the Stop that closes one and the
// SessionEnd that closes the session — and the late event that brings back a
// session the stale sweep had given up on.
//
// All of them write to the ROOT rather than to whichever agent `resolveOwner`
// picked: a human types into a session, and a turn or a session ends for the
// whole of it, never for the Task that happened to be running.
import { adoptCwd, adoptRootLabel, ensureRoot } from "./agent-attribution";
import { rootAgentId, type GraphState } from "./graph-state";
import { injectedPrompt } from "./injected-prompt";
import { HOOK_REDELIVERY_WINDOW_MS, promptAlreadyRecorded, sessionEvidenceAt } from "./redelivery";
import { settleUnanswered, shortPreview } from "./tool-calls";
import type { HookPayload } from "./types";

/** That this session was heard from, whatever the event says: the root's
 *  `lastEventAt`, and a root the stale sweep reaped put back (#350).
 *
 *  Kept on the root because that is where `sweepStaleSessions` reads it, and
 *  guarded on being NEWER rather than stamped unconditionally: order
 *  independence is this reducer's contract, so a copy of an old event arriving
 *  late from another deck's fan-out must not make the session look fresher than
 *  its newest event. That guard is also what makes the un-reap below safe —
 *  "newer than anything we had" is exactly "newer than the moment we gave up". */
export function noteSessionHeard(state: GraphState, sessionId: string, now: number): void {
  const heard = state.agents.get(rootAgentId(sessionId));
  if (heard && now > (heard.lastEventAt ?? 0)) {
    heard.lastEventAt = now;
    if (heard.reaped) {
      // The sweep guessed and the guess was wrong: the terminal was alive all
      // along, the human just took their time. Put it back the way a late
      // PostToolUse resurrects a tool the stale sweep had marked failed. Only
      // the root — a subagent that was mid-flight when the session went quiet is
      // genuinely over, and SubagentStart is what brings one of those back.
      heard.reaped = false;
      heard.state = "active";
      heard.endedAt = undefined;
      // And the sweep's other conclusion goes with it (#445): it stamped
      // `closedAt` because it had decided the SESSION was gone, not just the
      // turn, and an ending that has been withdrawn was not an ending. Only the
      // reaped case is undone here — a `closedAt` a real `SessionEnd` wrote is
      // not a guess, and on this machine's logs no session ever emitted another
      // event after one (0 of 22).
      heard.closedAt = undefined;
    }
  }
}

/** A session beginning — or beginning again, after `/clear` or `--resume`. The
 *  one event that retracts the joined-late marker (#677). */
export function applySessionStart(state: GraphState, p: HookPayload, sessionId: string, now: number): void {
  const root = ensureRoot(state, sessionId, now, false);
  // The one thing that clears the "joined late" marker, and the reason it
  // is cleared here rather than only seeded at creation: order independence
  // is this reducer's contract, so a `SessionStart` that arrives AFTER the
  // event that created the root — a racing hook POST, an out-of-order
  // replay — retracts the marker instead of leaving it standing on a
  // session whose beginning we did, in the end, receive (#677).
  root.synthetic = false;
  root.state = "active";
  // A session that is starting is not a closed one, whatever an earlier
  // `SessionEnd` or a stale sweep concluded (#445). `/clear` is the case
  // that reaches here — it emits SessionEnd and then SessionStart with
  // `source: "clear"` — and while CC hands the fresh session a new id on
  // this machine (12 of 12 in the log), `--resume` is documented to keep
  // one, and a resumed terminal ranked as closed forever is the exact
  // mistake this flag exists to stop making.
  root.closedAt = undefined;
  // `endedAt` travels with `closedAt` here for the same reason it does at
  // `UserPromptSubmit`, and it was the one field this branch
  // forgot: a session that is starting has not ended. Without it a second
  // `SessionStart` — `/clear` on a resumed id, or a re-attached terminal —
  // left an `active` card whose elapsed clock was frozen at the previous
  // ending, counting from a moment the card no longer claims.
  root.endedAt = undefined;
  // The EARLIEST beginning we have heard of, not the first one recorded.
  // `root.startedAt || now` kept whichever event happened to create the node,
  // and that is not always the earliest: hook POSTs are fire-and-forget and
  // separately stamped, so a `SessionStart` can land behind the first tool
  // call of the session it starts. The old form then held a start time later
  // than the session's real one and printed a duration short by the delay,
  // on the one card that had just stopped saying it joined late. `Math.min`
  // is also what makes this line order-independent, which is the property
  // the retraction above it exists to preserve.
  root.startedAt = Math.min(root.startedAt ?? now, now);
  adoptCwd(root, p);
  adoptRootLabel(root, p);
}

/** The human typing into the session: a new turn on the ROOT, with the prompt
 *  recorded once however many copies of the submission arrive. */
export function applyUserPromptSubmit(state: GraphState, p: HookPayload, sessionId: string, now: number): void {
  // New turn — retire done subagents from prior turns so canvas focuses
  // on the current request. Same logic works for live AND replay:
  //   - live: exitAt = wall-clock now → 600ms fade-out animation
  //   - replay: exitAt = event time (old) → already past EXIT_ANIM_MS
  //     window when first render hits → prior turns never visually
  //     appear on refresh (no flash-then-vanish)
  // The previous "exitAt-stamping causes vanish" suspicion was wrong;
  // real cause was ReactFlow wiping width/height on every setNodes (fix
  // in snapshotToFlow). With that fixed, retirement is safe.
  for (const other of state.agents.values()) {
    if (
      other.sessionId === sessionId && other.kind === "subagent" &&
      other.state === "done" && other.exitAt == null &&
      other.endedAt != null && other.endedAt < now
    ) {
      other.exitAt = now;
    }
  }
  const root = ensureRoot(state, sessionId, now, false);
  root.state = "active";
  root.endedAt = undefined;
  // `closedAt` travels with `endedAt` everywhere except at `Stop`, which is
  // the whole of the distinction (#445). Somebody typing into a session is
  // the least ambiguous evidence there is that it is not closed, and it is
  // cleared HERE rather than on any newer event because the server starts a
  // transcript scan for every payload carrying a `transcript_path` — the
  // SessionEnd's own included — so the three *Observed events land after a
  // real ending and would wipe the flag a second after it was set.
  root.closedAt = undefined;
  root.exitAt = undefined;

  // Everything below is the ROOT's, and it is spelled `root` rather than
  // `resolveOwner(state, p, now)` on purpose (#675). That helper is the
  // stack heuristic: it hands an event that names no subagent to the
  // deepest live one, because CC's tool-call hooks carry no agent_id of
  // their own and their traffic has to reach the node that made the call.
  // A `UserPromptSubmit` carries no agent_id for the opposite reason — a
  // human types into a session, never into a subagent — so reading the
  // stack here treats an absence that is a FACT as if it were ambiguity,
  // and the turn the human typed lands on whichever Task happened to be
  // running: into `sub.prompts`, setting `sub.firstPrompt`, with the root's
  // own list never seeing it. `Notification` states the same rule, and for
  // the same reason.
  //
  // The stack is non-empty at a prompt more often than it looks. A
  // `SubagentStop` POST that never landed leaves its key behind — the
  // premise the reducer already builds on twice, at `Stop` and in
  // `sweepStaleSessions`, both of which drop the stack precisely so the
  // human's next prompt cannot be swallowed by a subagent that finished
  // hours ago — and a prompt that overtakes its turn's `Stop` on the wire
  // sees a stack those two have not cleared yet.
  //
  // The three `state`/`exitAt`/`endedAt` writes that used to ride on the
  // resolved node are gone rather than re-pointed: the reset just above
  // already says all three about the root, so on the no-subagent path
  // they were duplicates, and on the subagent path they forced a node back
  // to `active` with its ending erased — typing un-finishing an agent.
  // Nothing wants that on the stack top's behalf: a subagent that is
  // genuinely live is `active` already, and one that is not should stay
  // where its own `SubagentStart` will put it back.
  const text = (typeof p.prompt === "string" ? p.prompt : typeof p.message === "string" ? p.message : "") ?? "";
  // One submission can be delivered more than once — the hook posts it to
  // every deck whose workspace matches, a restart replays the log region it
  // already streamed live, and each copy carries a fresh seq so the
  // seq/epoch guard lets it through. Appending unconditionally recorded the
  // same turn once per copy: the detail panel counted 'Prompts 3' and listed
  // the text three times, SessionSummary's promptCount reported three times
  // the turns the session actually had, and nothing ever trims the list, so
  // every surplus copy of the full prompt text was retained for the agent's
  // lifetime. A prompt has no id of its own, so identity is its text plus
  // the moment it arrived.
  // Read and written on the same node for the same reason: a copy that
  // arrived while a subagent was live used to be compared against the
  // SUBAGENT's list, find nothing, and record the turn a second time — one
  // submission counted twice across the session, which is the very thing
  // the paragraph above exists to prevent.
  if (text && !promptAlreadyRecorded(root, now, text)) {
    root.prompts.push({ at: now, text });
    // A background task's notice is not the session's opening words (#834).
    if (!root.firstPrompt && !injectedPrompt(text)) root.firstPrompt = shortPreview(text, 120);
  }
}

/** `Stop` or `SessionEnd`, which `name` says: the root's turn is over, and for
 *  `SessionEnd` the session with it. Refused whole when it is a re-delivery or
 *  out of order (#1022). */
export function applyTurnEnd(state: GraphState, name: string, sessionId: string, now: number): void {
  // Mark the root done; leave the subagent nodes alone (they have their
  // own Stop), but drop the session's attribution stack. Keys land there
  // on SubagentStart and used to come off only on SubagentStop, and hook
  // POSTs are fire-and-forget — one sent while the server was restarting
  // is gone for good. A key left behind then swallows every later event
  // that carries no agent_id, which is all the real UserPromptSubmit and
  // Pre/PostToolUse traffic: the user's next prompt and the root's tool
  // calls render under a subagent that finished long ago, and replay
  // rebuilds the same wrong state on refresh.
  //
  // The stack is dropped, and the subagent NODES are still left alone, and
  // those two are not the same decision. #442 left a question here — a Stop
  // arriving while a SubagentStop was lost leaves that subagent `active`
  // forever, and `runningSessionCount` counts any active agent, so the tab
  // strip and the favicon would claim work in progress with nothing behind
  // it. Settling every still-active subagent here would fix that case and
  // break a bigger one, because the sentence this comment used to end on —
  // "the root's turn cannot end while a Task is still running" — is no longer
  // true of Claude Code. Subagents dispatched to run in the background
  // outlive the turn that dispatched them: on this machine's log a `Stop`
  // stepped over a still-open subagent 65 times, and in 65 of those 65 the
  // subagent went on to emit its OWN Pre/PostToolUse afterwards — a median
  // of 606s more work, up to 10455s. Settling them here would draw all 36
  // announced subagents on this log `done` while their tool bubbles kept
  // firing underneath. So the node stays `active`, which is what it is, and
  // the genuinely lost SubagentStop is left to `sweepStaleSessions`, which
  // settles every active agent of a session that has gone silent for
  // STALE_SESSION_MS and is the only thing here holding evidence rather than
  // an assumption.
  //
  // The stack is a different matter: it is read only for events that carry
  // NO agent_id, and a background subagent's own traffic all carries one
  // (3346 PreToolUse and 3280 PostToolUse on this log, every one of them
  // keyed). Clearing it costs those events nothing and keeps the root's own
  // next turn from being attributed to them.
  const root = ensureRoot(state, sessionId, now, false);

  // THIS WAS THE ONE TERMINAL HANDLER WITH NO RE-DELIVERY GUARD (#1022).
  //
  // `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Notification` and
  // `pushActive` all carry one, each with a comment asserting that
  // duplicates are routine on this wire — several live decks appending to
  // one events.jsonl, a hook retry, the whole history replayed into every
  // tab that opens. Everything below this line is destructive, and a second
  // copy used to run all of it again: re-stamp `endedAt`, settle whatever
  // the session was holding as failed, and drop the attribution stack.
  //
  // The damage needs the next turn to have already started, and nothing
  // stops it doing so — 223 of 250 `Stop`s on this machine's logs were
  // followed by another prompt on the same session. Turn one's `Stop`
  // arriving twice, three seconds into turn two, drew a live `npm test` red
  // with "the turn ended before this call returned", flipped the card to
  // `done`, raised the error count and dropped the stack mid-turn — healing
  // only when the command's real `PostToolUse` landed, which for that
  // command is four minutes.
  //
  // Two readings, and they are separate facts:
  //
  //   OUT OF ORDER. The event reports a boundary older than evidence this
  //   root already holds — a `Stop` stamped before the prompt that opened
  //   the turn now running. A replayed copy carries the original writer's
  //   `receivedAt`, so this is what the common re-delivery looks like, and
  //   it used to drag `endedAt` BACKWARDS past the prompt. It is also the
  //   symmetric check `SessionStart` has had since #445 and `SessionEnd`
  //   never did: `closedAt` is what ranks the eviction queue, and a
  //   `SessionEnd` that predates the session's own newest turn spends a
  //   terminal the human is sitting in front of.
  //
  //   A DUPLICATE OF THE ENDING ALREADY RECORDED. Same boundary, fresh
  //   stamp, inside the window the wire can scramble things by — and a
  //   prompt opened a turn AFTER that recorded ending, so this copy cannot
  //   be the new turn's own ending: no turn opens and closes again inside
  //   the re-delivery window. Both halves are required. A `Stop` hook that
  //   blocks and lets the agent continue produces a second, genuine `Stop`
  //   moments after the first with NO prompt in between, and that one must
  //   still end the turn.
  //
  // Refusing the event outright rather than half of it, because every line
  // below is written from the same false premise. A turn whose real ending
  // is refused is left `active`, which is what `sweepStaleSessions` is for;
  // a live command drawn red is not recoverable for the length of the
  // command.
  const evidenceAt = sessionEvidenceAt(root);
  if (now < evidenceAt) return;
  const lastEnd = root.lastTurnEndAt;
  if (lastEnd != null && evidenceAt > lastEnd && now <= lastEnd + HOOK_REDELIVERY_WINDOW_MS) return;

  root.state = "done";
  root.endedAt = now;
  root.lastTurnEndAt = now;
  // A TURN THAT ENDED CANNOT STILL BE HOLDING ITS OWN TOOL CALL.
  //
  // The hook POSTs are fire-and-forget, so a call whose PostToolUse fired
  // while this deck was not listening — restarted, or killed by the very
  // command being reported — loses its outcome for good. `sweepStaleTools`
  // is the existing answer and it cannot reach this case: its clock is the
  // SESSION's silence, and a session that carried on working after the lost
  // event never goes silent. Measured on this machine's log, every one of
  // those calls was a Bash, and all of them sat in-flight from the moment
  // they were lost to the end of the log — pulsing on a card whose work
  // finished hours earlier.
  //
  // `Stop` is the evidence the clock could not supply. It is the root's own
  // turn boundary, so a call the ROOT made and is still holding cannot be
  // running once it lands. Measured before writing this: 75 Stops, 6 root
  // calls open across one, and 0 of the 6 ever answered afterwards — no
  // false positive to trade against.
  //
  // ONLY the root's own calls, and that restriction is the whole of the
  // safety. The note above this block records that background subagents
  // outlive the turn that dispatched them, 65 times out of 65 — so their
  // calls are still genuinely running here and are left exactly alone.
  //
  // WHAT THE PAYLOAD SAID, NOT WHICH NODE THE CALL WAS DRAWN ON (#1022).
  // This used to walk `root.tools` and nothing else, and the sentence
  // justifying that — "they carry an agent id and live on their own node" —
  // was only half true. The agent id half is; the node half is not. While a
  // Task is live, the root's OWN tool calls carry no `agent_id` at all, and
  // `resolveOwner`'s stack heuristic hands an unkeyed event to the deepest
  // live subagent — which is right for drawing it on the canvas and fatal
  // here, because the same log that measures 65 background subagents open
  // across a `Stop` measures them open across 65 of 65. So for every session
  // with a Task running at the turn boundary the sweep walked an empty list,
  // and the lost `Bash` this rule exists to settle went on pulsing in flight
  // exactly as it did before the rule was written. `sweepStaleTools` cannot
  // reach it either: its clock is the SESSION's silence, and a background
  // subagent keeps the session loud.
  //
  // `explicitSubagentId` is the honest discriminator and is recorded for
  // precisely this kind of question — see its declaration in types.ts, and
  // #361, which reads it for the same reason. Absent means the payload named
  // nobody, which is what the root's own calls look like wherever they were
  // drawn; present means the payload named a subagent, whose work outlives
  // this boundary even when its `SubagentStart` was lost and the call landed
  // on the root by fallback.
  //
  // CLAUDE ONLY, for the reason `sweepStaleTools` carries the same guard:
  // on Codex a missing result means the call has NOT finished — it is
  // parked on a human who has not approved it yet — rather than that its
  // result was lost. Codex maps `task_complete` / `turn_aborted` onto this
  // same `Stop`, so without this the deck would tell the user a command had
  // errored while Codex was politely waiting for them to say yes. An event
  // recorded before `provider` existed replays without one and keeps the
  // Claude behaviour it was swept with, so only an explicit "codex" is
  // exempt.
  // EVERY AGENT OF THIS SESSION, settled by what the PAYLOAD said rather
  // than by which node the call was drawn on. `resolveOwner` hands an event
  // with no agent_id to the deepest live subagent, so while a background
  // Task is live the root's OWN calls are not on `root.tools` — which is
  // exactly the configuration this sweep claimed safety from. The boundary
  // is unchanged: a call carrying an explicit agent_id is a subagent's own
  // and is still left alone.
  for (const owner of root.provider === "codex" ? [] : state.agents.values()) {
    if (owner.sessionId !== sessionId) continue;
    for (const t of owner.tools) {
      if (t.endedAt != null) continue;
      if (t.explicitSubagentId != null) continue;
      // Says what was seen, and never why. The deck knows the turn ended
      // without a result; it does not know whether the tool failed, or
      // succeeded into a socket that had gone. Asserting the second is the
      // expensive kind of wrong — see the sweep's own note on this. Out of the
      // live index for the same reason the sweep drops it; a late outcome still
      // lands and un-says this. See `settleUnanswered`.
      settleUnanswered(state, owner, t, now, "the turn ended before this call returned");
    }
  }
  // ...and only `SessionEnd` says the SESSION is over (#445). `Stop` is a
  // turn boundary on both providers — Claude fires it when the main agent
  // finishes responding, and the Codex watcher maps `task_complete` /
  // `turn_aborted` onto it per turn on purpose (#395) — so an idle terminal
  // between turns lands here just as a closed one does, and only this line
  // tells them apart afterwards. `pruneDoneSessions` is the reader; see
  // `closedAt` in types.ts for why absence never means "still open".
  if (name === "SessionEnd") root.closedAt = now;
  state.activeSubagentStack.delete(sessionId);
}
