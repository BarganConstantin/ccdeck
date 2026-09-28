// POST /api/clear, the deck's one irreversible action: the ring emptied, the
// log and its archive emptied when this deck is the one writing them, and the
// `__clear` marker that tells every open page to forget what it drew.
//
// This lived in src/server/index.mjs, after the SSE resume. It empties the
// ring through event-ring.mjs, drops the output watch's and the enrichment's
// emit gates, and sends the marker through pushEvent. GET /api/clear, the
// question the dialog asks before the press, is still answered in the route
// table. The body is unchanged.
import { PRODUCT } from "./brand.mjs";
import { send } from "./http-io.mjs";
// The ring the press empties — see event-ring.mjs.
import { clearEventBuffer } from "./event-ring.mjs";
// The one door every event comes through, the marker's included — see
// event-pipeline.mjs.
import { pushEvent } from "./event-pipeline.mjs";
// Which deck owns the log, and so may empty it — see event-log.mjs.
import { logSharing } from "./event-log.mjs";
import { emptyLog } from "./log-writer.mjs";
import { outputWatch } from "./session-tracking.mjs";
import { clearEnrichmentGates } from "./session-enrichment.mjs";

/**
 * The deck's one irreversible action: empty the ring, and empty the log — both
 * of its generations, the live file and the archive rotation leaves beside it —
 * but only the log this deck is the one writing.
 *
 * The gate is the whole of #698. `truncate(persistPath, 0)` ran from whichever
 * deck was asked, and `persistPath` is one file several decks share by default,
 * so Clear on a deck scoped to a single tree deleted the machine-wide deck's
 * entire history while its canvas showed no change at all. Ownership is
 * electWriters, the election that already decides which of those decks appends a
 * line, so nothing new gets to disagree with it: the deck that fills the file is
 * the deck that may empty it, and a deck that writes nothing to it cannot
 * destroy it. See logSharing.
 *
 * A deck that does not own the log still clears its own canvas — that is what
 * the user pressed, and the ring is this deck's alone — and says which deck's
 * file it declined to touch, so the answer is a fact the UI can show rather than
 * a silent partial success. The dialog asked `GET /api/clear` before the press
 * and has already said the same thing in words.
 *
 * The `__clear` marker is broadcast and NOT persisted. It never belonged on
 * disk: replaying an empty log and then a marker that empties it produces the
 * same empty state, and appending it was how a deck that writes nothing else to
 * the shared file still left 134 bytes in it — the reproduction's whole
 * remainder. `{ persist: false }` is the same flag the hook sets on the decks it
 * did not elect.
 */
export async function handleClear(res) {
  const sharing = await logSharing();
  const mineToEmpty = Boolean(sharing.path && sharing.mine);
  // THE PRESS IS ONE SYNCHRONOUS MOMENT, from the ring being emptied to the
  // marker being pushed, and the log's turn on the append queue is taken
  // inside it. Nothing from here awaits until the marker is out, so no event
  // can be pushed in the middle: every event is on one side of the press, and
  // it is the same side for the board, the ring and the file.
  //
  //   * Pushed before it: out of the ring by clearEventBuffer, numbered below
  //     the marker so the reducer forgets it, and queued before the truncate —
  //     written, then erased.
  //   * Pushed after it: numbered above the marker so the board keeps it, and
  //     queued AFTER the truncate, so its write cannot begin until the file has
  //     been emptied. That is why a Clear cannot take an event posted after it
  //     along with it: the chain in log-writer.mjs is the only way this process
  //     writes the log, and it starts each step only when the one before it has
  //     settled.
  //
  // Both halves were broken in turn. #1005: the truncate consulted the queue in
  // neither direction, so the queue drained PRE-CLEAR lines into the freshly
  // emptied file — 564 bytes and three events of a cleared session, 2.5s after
  // a Clear that answered `{"log":"cleared"}`. Its fix waited for the queue and
  // then truncated beside it, but the wait was for the queue as it stood when
  // the wait began, and the session went on posting through it: MEASURED
  // (#1130), five runs, 4, 5, 3, 3 and 2 events the Clear had taken off the
  // board were in the file a restart replays. See emptyLog.
  //
  // This is #698's residue by a different route, and it survives the ownership
  // gate that fixed #698 precisely because it happens on the deck that DOES own
  // the file.
  //
  // Not `events.length = 0`: the ring is measured by a running total now, and
  // emptying the array without the total leaves a debt that never clears. See
  // clearEventBuffer.
  clearEventBuffer();
  // THE ARCHIVE GOES WITH IT. Since #1062 the replay reads events.jsonl.1
  // whenever the live log cannot fill the ring, and a live log a Clear has just
  // emptied never can — so a Clear on a log that had rotated once came back,
  // whole, at the next boot. MEASURED (#1130): three events in the archive and
  // one in the live log, `/api/clear` answering `log: "cleared"` over a live
  // file of 0 bytes, and replayLog on the same path returning the three
  // archived sessions.
  //
  // Removed, rather than fenced off by a `__clear` line the replay stops at,
  // and the confirmation is why: it tells the user the history is gone and
  // cannot be undone, and a marker would leave a whole rotated generation of it
  // on disk behind a line asking readers not to look — readable by anything
  // else that opens the file. It would also put back on disk the line #698
  // took off it on purpose, and it would need a stopping rule the forwards
  // replay does not have: that branch reads the archive FIRST, so it would push
  // the cleared generation into the ring before it ever met the line saying to
  // discard it. The ownership gate is the truncate's, and it covers the archive
  // exactly: only the deck that writes a log may rotate it (#1062), so only
  // that deck ever made its archive.
  //
  // Nothing else of the log's bookkeeping is reset, deliberately.
  // `failedLines` / `failedChars` count what the DISK refused since this deck
  // started, which a Clear does not change — `/api/health` documents them that
  // way, and zeroing them would hide a volume that is still failing — and an
  // open failure episode ends only on a line that lands, the one evidence that
  // the condition is over, which a Clear is not. The rotation's byte count is
  // a trigger for a `stat`, not a size: over-counting after a truncate costs at
  // most one early look, which finds a small file and resets it. And a
  // rotation running at the same moment needs nothing from here; emptyLog says
  // why the order inside the turn is enough.
  const emptyOutcome = {};
  const emptied = mineToEmpty ? emptyLog(sharing.path, [sharing.path + ".1"], undefined, emptyOutcome) : null;
  // Drop the caches that gate an emit on "has this changed", because the
  // client is about to forget what they are comparing against: __clear makes
  // the reducer return a fresh state, so every session's name and every
  // subagent's model label go with it. maybeResolveSessionName then computes
  // the same signature, takes its early return, and emits nothing — so the
  // card falls back to cwd/prompt for the rest of that session while the
  // server is sitting on the name.
  //
  // The root model survives without help because pushEvent stamps
  // `raw.model` on every payload; there is no equivalent stamp for the name
  // or for a subagent's model, which is why those two are listed and the
  // rest of the per-session state is not.
  //
  // The rule, for the next cache that gates an emit: anything answering
  // "has this changed" has to appear in BOTH places that mean the client no
  // longer has it — here (clearEnrichmentGates), and in forgetSession
  // (forgetEnrichment).
  outputWatch.clear();
  clearEnrichmentGates();
  pushEvent({ hook_event_name: "__clear", cwd: "" }, "internal", { persist: false });
  // The end of the press. Awaited, where the truncate used to be fired and
  // forgotten, so the answer does not go out before the file has actually
  // reached zero — and bounded by emptyLog, so a disk that does not come back
  // in time still gets an answer, with the turn left on the chain in order.
  if (emptied) await emptied;
  // WHAT THE FILE ACTUALLY DID (#1140). This answered "cleared" for any log this
  // deck owns, whatever the truncate had done: emptyLog keeps the queue moving
  // by swallowing its error, and nothing read it back, so on a read-only volume
  // the page was told the history was gone and the next boot replayed all of
  // it. The canvas IS clear either way — the ring was emptied above — so this
  // stays `ok`, and says which half did not happen, here and in the terminal.
  // A turn still on the chain at the deadline has no error yet and keeps the
  // answer it always had.
  //
  // AND THE ARCHIVE, for the same reason: one that survives a Clear is the whole
  // history again at the next boot, because the replay falls back to it once the
  // live log is empty (#1130). Either half failing makes the answer "failed", and
  // each says which it was.
  const truncateFailed = mineToEmpty && emptyOutcome.error ? emptyOutcome.error : null;
  const archiveFailed = mineToEmpty && emptyOutcome.archiveError ? emptyOutcome.archiveError : null;
  const failed = truncateFailed ?? archiveFailed;
  if (truncateFailed) {
    console.error(`${PRODUCT}: Clear could not empty the event log ${sharing.path} (${truncateFailed.code ?? truncateFailed.message}) — the canvas is clear, but that history will come back at the next boot`);
  }
  if (archiveFailed) {
    console.error(`${PRODUCT}: Clear could not remove the event log's archive ${sharing.path}.1 (${archiveFailed.code ?? archiveFailed.message}) — the canvas is clear, but that history will come back at the next boot`);
  }
  return send(res, 200, {
    ok: true,
    log: !sharing.path ? "none" : sharing.mine ? (failed ? "failed" : "cleared") : "kept",
    ...(failed ? { error: failed.code ?? "EIO" } : {}),
    path: sharing.path,
    decks: sharing.decks,
    mine: sharing.mine,
    owner: sharing.owner ? { port: sharing.owner.port } : null,
  });
}
