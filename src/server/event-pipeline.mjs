// pushEvent, the one door every event comes through — a hook's POST, a Codex
// rollout line, the boot replay and the synthetic events the enrichment sends
// back — and what it does to each on the way in: the deck's token taken out,
// the model stamped, the ring, one serialization shared by the SSE fan-out and
// the log, the desktop notification when no page is open, the away-update's
// activity, and the transcript scans that answer through it.
//
// These lived in src/server/index.mjs, after the ring. The modules this one
// imports reach pushEvent through event-sink.mjs, connected below as this
// module loads; index.mjs's routes import it from here. The bodies are
// unchanged.
import { PRODUCT } from "./brand.mjs";
import { createBlockNotifier } from "./block-notify.mjs";
import { notify as osNotify } from "./browser-react.mjs";
import { notificationsOn } from "./deck-prefs.mjs";
// The settings as this process holds them — see prefs-state.mjs.
import { heldPrefs } from "./prefs-state.mjs";
// The deck's own token, taken back out of every event before the ring, the
// SSE fan-out or the log can hold it — see token-redact.mjs.
import { redactDeckToken } from "./token-redact.mjs";
// The ring every event is numbered and held in — see event-ring.mjs.
import { admitEvent } from "./event-ring.mjs";
// The SSE subscribers every event is broadcast to — see sse-clients.mjs.
import { notifyTrays, pageCount, sseClients, trayClients, writeSse } from "./sse-clients.mjs";
// Where the log is, which sessions this deck writes to it, and when it rolls
// over — see event-log.mjs.
import { eventLogPath, maybeRotatePersistFile, writesLogFor } from "./event-log.mjs";
import { appendLogLine } from "./log-writer.mjs";
// The away-update's word on whether a turn is running — see lifecycle.mjs.
import { activity } from "./lifecycle.mjs";
// The session LRU and the transcript watch — see session-tracking.mjs.
import { outputWatch, touchSession } from "./session-tracking.mjs";
// What the deck learns about a session that its hooks never say, read off the
// transcript and sent back through pushEvent — see session-enrichment.mjs.
import { knownModelId, maybeResolveContext, maybeResolveModel, maybeResolveSessionName, maybeResolveUsage } from "./session-enrichment.mjs";
// The Codex half: a session's rollout, found by id — see codex-enrichment.mjs.
import { maybeResolveCodex } from "./codex-enrichment.mjs";
// The gate pushEvent asks before a transcript path is followed — see
// transcript-gate.mjs.
import { isClaudeTranscriptPath, noteRefusedTranscript } from "./transcript-gate.mjs";
// How the enrichment reaches pushEvent without importing this file — see
// event-sink.mjs. Connected below, as this module loads.
import { connectEventSink } from "./event-sink.mjs";

// The modules that emit synthetic events send them here. pushEvent is a
// function declaration, so it already exists as this line runs, and nothing
// emits until a request or a timer startServer arms asks it to.
connectEventSink(pushEvent);

/**
 * The desktop notifier, built once per process.
 *
 * `enabled` is read here and not per event, so a switch cannot change under a
 * running server and let two events in the same second disagree about it. The
 * OS call is browser-react.mjs's — the same one Browser Watch has shipped on
 * all three platforms — so this is a second caller, not a second
 * implementation, and the platform quirks it already handles (argv rather than
 * interpolation on macOS, the WinRT toast on Windows, a missing notify-send on
 * Linux) are handled once.
 *
 * A failure goes to stderr and no further. The user cannot act on "your desktop
 * has no notification daemon" mid-session, the deck is not broken by it, and
 * every in-page surface still says everything it said before.
 */
const blockNotifier = createBlockNotifier({
  // The desktop app, while it is connected, raises the notification itself —
  // under its own name, icon and permission, with a click that opens its
  // window. Only when no app is listening does the OS helper speak.
  notify: (title, body, meta) => (trayClients.size > 0 ? notifyTrays(title, body, meta) : osNotify(title, body)),
  product: PRODUCT,
  // A function, not a boolean: this is a switch a person flips from the sound
  // menu while the deck is running, and a mute that waited for a restart would
  // not be a mute. The env var still wins inside `notificationsOn`.
  enabled: () => notificationsOn(heldPrefs.current()),
  // Asked again when the burst cap's window reopens, for the one notice that
  // stands for what it held back — see BURST_MAX.
  pages: () => pageCount(),
  onError: err => console.error(`${PRODUCT}: could not raise a desktop notification:`, err?.message ?? err),
});

export function pushEvent(raw, source, opts = {}) {
  // First, before anything below can see it: the deck's own credential does not
  // belong in a store that is served without one. Every entry point to the
  // buffer, the SSE fan-out and events.jsonl passes through here, so this is
  // the single line that keeps it out of all three. See redactDeckToken.
  raw = redactDeckToken(raw);

  // Synchronous enrichment: if we already know this session's model, stamp
  // it on the payload so the client's recursive scanner picks it up.
  if (raw && typeof raw === "object" && raw.session_id && !raw.model) {
    const modelId = knownModelId(raw.session_id);
    if (modelId) raw.model = modelId;
  }

  // Numbered, charged, held, and the ring evicted behind it — see admitEvent.
  const evt = admitEvent(raw, source, opts.receivedAt ?? Date.now());
  const seq = evt.seq;

  // Does this event reach the log at all? Not on a replay (it came from
  // there), not when the hook told us another deck owns this session's log,
  // and not when we have no log. Decided before serializing because it is half
  // of the answer to whether serializing is worth doing.
  const persisting = eventLogPath() && !opts.replay && opts.persist !== false && writesLogFor(raw);

  // One serialization, shared by both consumers — and skipped entirely when
  // neither wants it. This used to stringify the whole envelope twice on the
  // hottest path in the process (once for the SSE frame, once for the persist
  // line), and built the frame even with nobody subscribed: a headless deck
  // paid a full stringify per event for a string no one read, and boot replay
  // — which runs before the listener exists and never broadcasts — paid one
  // for every line of a log that rotates at 50MB. An event this deck is not
  // logging is still broadcast, so a subscriber alone is reason enough.
  //
  // Contained, because this line was fatal. `JSON.stringify` walks a value
  // recursively while `JSON.parse` does not, and the gap between the two is
  // enormous: measured on Node 22.14, parse accepts a body nested 4,194,303
  // deep and stringify gives up on the result at 4,021. So a payload in that
  // window parses cleanly and then throws `RangeError: Maximum call stack size
  // exceeded` out of here — and there is no promise on this path for the
  // route's `guard` to catch, because pushEvent is reached from inside a raw
  // `req.on("end")` listener. It was an uncaughtException, and Node's answer to
  // those is to exit. Measured against the real server: one POST of 24,378
  // bytes, nested 4,050 deep, to the credential-free `/api/event` — a
  // two-hundredth of the 5,000,000-character ingest cap — and the deck was
  // gone, with nothing on the socket to tell the poster why.
  //
  // The payload leaves the ring, not just this string, and that is the point.
  // admitEvent above already took the envelope, and a value nothing can
  // serialize is a value no reader can ever deliver: every `Last-Event-ID`
  // resume that replays it and every `GET /api/events` that writes it would
  // meet the same throw for as long as it stayed in the buffer, so one small
  // POST would poison both routes for the life of the entry. The envelope
  // therefore keeps its `seq` and loses its payload — the same replacement
  // envelopeJson makes for a reader, made once at the write instead of on every
  // read, and the same bargain about `seq`: a caller paging with `?since=`
  // walks past the hole rather than asking forever for what it cannot be given.
  //
  // Admitted as a stub rather than refused at ingest with a 400, deliberately.
  // Three of pushEvent's four callers have no HTTP peer to answer — Codex
  // rollout lines read off disk, the boot replay of events.jsonl, the synthetic
  // events the transcript scanners emit — so the containment has to live here
  // whatever the ingest route does, and a 400 on top would be a second
  // mechanism for a case this one already covers. It would also have to be paid
  // for: knowing a payload will not serialize means serializing it, which is
  // the second stringify per event on the hottest path in the process that the
  // paragraph above exists to have removed. The reason goes to stderr and not
  // to the wire, under the rule sendInternalError explains.
  let json = null;
  if (sseClients.size > 0 || persisting) {
    try {
      json = JSON.stringify(evt);
    } catch (err) {
      console.error(`${PRODUCT}: event ${seq} could not be serialized:`, err);
      evt.payload = null;
      evt.unserializable = true;
      json = JSON.stringify(evt);
    }
  }

  if (sseClients.size > 0) {
    const line = `id: ${seq}\nevent: hook\ndata: ${json}\n\n`;
    // writeSse may drop a client mid-loop; deleting from a Set while iterating
    // it is well defined and skips only the entry removed.
    for (const res of sseClients) writeSse(res, line);
  }

  // The desktop, when there is no page to tell.
  //
  // Placed here rather than in a route handler because every path that can
  // produce a permission prompt comes through pushEvent — the hook POST, a
  // replay, and the transcript scanners — and `sseClients.size` read at this
  // exact point is the honest answer to "is anybody being shown this by any
  // other means". The web notifier owns the case where a page exists, and this
  // owns the case where none does; the two never both fire, and neither has to
  // know the other exists. block-notify.mjs holds the gates and the cooldown.
  blockNotifier.consider(raw, { clients: pageCount(), replay: !!opts.replay });

  // Whether a turn is running, for the away-update. Not from a replay: the log
  // is history, and a turn it shows open is one that ended in another process.
  if (!opts.replay) activity.note(raw, evt.receivedAt);

  if (persisting) {
    // Fire-and-forget append. JSONL = newline-delimited JSON, so the whole line
    // has to reach the file as one write — this used to be `appendFile`, which
    // splits anything over 512 KiB into separate appends and let another
    // event land in the middle of a large tool response. See appendLogLine.
    //
    // Note this runs AFTER redactDeckToken above, as every path to the log
    // does: the string being written is the one serialization of the event the
    // SSE frame also used, and the token was taken out of the payload before
    // either existed.
    const line = json + "\n";
    appendLogLine(eventLogPath(), line);
    // Throttled check — every 30s, or every fifth of the threshold written,
    // whichever comes first. The byte arm is what keeps the 50 MB cap from
    // being advisory at any real ingest rate; see maybeRotatePersistFile.
    maybeRotatePersistFile(Buffer.byteLength(line));
  }

  // Note the session so the caches the scanners below fill can expire by
  // least-recent use. Replays are excluded: they fill nothing, and a boot
  // replay of a log spanning weeks would otherwise churn the whole LRU through
  // dead session ids before the first live event even arrives.
  if (!opts.replay && raw && typeof raw === "object") touchSession(raw.session_id);

  // Kick off async transcript scans. Model and usage are both re-read
  // periodically (throttled to 2.5s per session) so the cost columns track
  // running totals as the session progresses and late subagent models still
  // land; ModelObserved is only emitted when the resolved set changes. Both
  // result in synthetic events.
  // Provider gates the path: Claude reads transcript_path; Codex reads its
  // rollout JSONL under ~/.codex/sessions/. The Claude scanners short-circuit
  // when transcript_path is absent (always the case for Codex hooks).
  if (source === "hook" && !opts.replay) {
    if (raw && raw.provider === "codex") {
      maybeResolveCodex(raw);
    } else if (!raw?.transcript_path || isClaudeTranscriptPath(raw.transcript_path)) {
      // The gate is here, once, rather than repeated in the four scanners
      // below it: this is the single door a caller-chosen path comes through,
      // and all four read the same field off the same payload. A payload with
      // no transcript_path at all still goes through — every one of them
      // early-returns without it, and Codex hooks never send one — so the
      // ordinary event costs nothing but the absent-field test.
      maybeResolveModel(raw);
      maybeResolveUsage(raw);
      maybeResolveContext(raw);
      maybeResolveSessionName(raw);
      // Where the transcript IS, learned from the one place it is free. The
      // four scanners above read it on this event; the watch reads it between
      // events, which is the whole of what it adds.
      if (raw?.transcript_path) outputWatch.note(raw.session_id, raw.transcript_path);
    } else {
      noteRefusedTranscript(raw.transcript_path);
    }
  }

  return evt;
}
