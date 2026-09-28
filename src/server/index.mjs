// agent-dag server: HTTP ingest + SSE broadcast + static file serving.
// Pure Node HTTP server, zero deps. Nothing in this file talks to anything but
// 127.0.0.1 clients. It used to import `request` for challengeDeck, which asks
// another deck's port to prove it is the deck its discovery record describes;
// that moved to deck-probe.mjs, and the client half went with it.
import { createServer } from "node:http";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
// Moved out to a leaf so that a one-shot `ccdeck --stop`, the boot-path module
// that finds a running deck, and the tests that pin the handshake against
// hook/hook.js can all ask these questions without importing this file and
// arming everything in it. Re-exported below under the names they have always
// had — see src/server/deck-probe.mjs.
import { challengeDeck, challengeProof, isProcessAlive } from "./deck-probe.mjs";
// The three this file's own callers and tests already name. `sameProof` and the
// challenge deadline stay private to the leaf: they were private here too, and
// re-exporting them would be inventing API on the way out of a move.
export { challengeDeck, challengeProof, isProcessAlive };
// The gates in front of the route table, and the per-process token the
// strictest of them checks — see src/server/request-gates.mjs.
import { GUARDED_READS, HOOK_TOKEN, OPEN_MUTATIONS, isAuthorizedDataRead, isAuthorizedMutation, isTrustedMutation, isTrustedRead, presentsDeckToken } from "./request-gates.mjs";
// How much the event ring may hold and what one event is charged against it —
// see ring-bounds.mjs. The four it exported from this file, it still exports.
export { MAX_BUFFER, MAX_BUFFER_CHARS, MAX_RING_ENTRIES, payloadChars } from "./ring-bounds.mjs";
// The ring itself — what it holds, how it numbers them, and the eviction that
// keeps those bounds — private behind its operations. See event-ring.mjs.
import { SEQ_EPOCH, admitEvent, clearEventBuffer, eventsSince, lastSeq, ringHoldsNewerThan, ringSnapshot } from "./event-ring.mjs";
// Exported from this file before they moved, and still.
export { eventBufferStats, eventsSince } from "./event-ring.mjs";
// The SSE subscribers — pages and the desktop app's tray connections — and the
// backpressure every frame to them is written under. See sse-clients.mjs.
import { dropSse, notifyTrays, pageCount, sseClients, trayClients, writeResume, writeSse } from "./sse-clients.mjs";
// Exported from this file before they moved, and still.
export { MAX_CLIENT_BUFFER_BYTES, queuedBytes } from "./sse-clients.mjs";
// The built page and its assets, with the SPA fallback for everything else —
// see static-serve.mjs. The route table hands it every GET nothing above took.
import { serveStatic } from "./static-serve.mjs";
// Which sessions the deck still keeps anything for — the LRU cap, the
// transcript watch between hook events, and POST /api/forget. See
// session-tracking.mjs.
import { handleForget, outputWatch, startOutputWatch, touchSession } from "./session-tracking.mjs";
// Exported from this file before it moved, and still.
export { HARD_TRACKED_SESSIONS } from "./session-tracking.mjs";
// The desktop app's update as its window sees it — the state the app reports
// and the window's answers relayed back to it. See desktop-update-routes.mjs.
import { handleDesktopUpdateRead, handleDesktopUpdateReport, handleDesktopUpdateRequest } from "./desktop-update-routes.mjs";
// The deck's own token, taken back out of every event before the ring, the
// SSE fan-out or the log can hold it — see token-redact.mjs.
import { redactDeckToken } from "./token-redact.mjs";
// The one spelling of `--workspace`, and of a rollout's cwd — see
// canonical-path.mjs. Both were exported from this file before they moved,
// and still are.
import { canonicalCwd } from "./canonical-path.mjs";
export { canonicalCwd, canonicalWorkspace } from "./canonical-path.mjs";
import { ccProjectSlug, claudeConfigDir } from "./claude-dir.mjs";
// Moved to claude-dir.mjs so the Projects rollup can read transcript folders
// without importing this file; re-exported under the name it always had.
export { ccProjectSlug };
// The Codex half of capture: a session's rollout, found by id for its usage,
// and the rollouts directory tailed for its events — see codex-watch.mjs.
import { maybeResolveCodex, startCodexWatcher } from "./codex-watch.mjs";
// Exported from this file before they moved, and still.
export { readCodexRollout, sidFromRolloutName, startCodexWatcher } from "./codex-watch.mjs";
// Re-exported because bin/deck.js prints this path in the boot banner, and it
// used to build its own `join(homedir(), ".codex", "sessions")` for the purpose
// — which ignored CODEX_HOME and so named a directory that does not exist on any
// machine that sets it. Handing out the binding the watcher itself reads, rather
// than a second computation of the same rule, is what makes the printed path and
// the tailed path unable to disagree.
export { CODEX_SESSIONS_DIR } from "./codex-dir.mjs";
// The events.jsonl this deck keeps: where it is, which sessions this deck
// writes to it, who shares it, when it rolls over and whether it is being
// written at all — see event-log.mjs.
import { eventLogPath, logSharing, logWritableNow, maybeRotatePersistFile, noteLogWriter, openEventLog, writesLogFor } from "./event-log.mjs";
// Exported from this file before they moved, and still.
export { logSharing, rotateCheckDue, writesLogFor } from "./event-log.mjs";
// What the deck learns about a session that its hooks never say — model,
// spend, name, recap, context — read off the transcript and sent back through
// pushEvent. See session-enrichment.mjs.
import { clearEnrichmentGates, knownModelId, maybeResolveContext, maybeResolveModel, maybeResolveSessionName, maybeResolveUsage } from "./session-enrichment.mjs";
// The readers it exported from this file before they moved, and still.
export { cachedModelId, readContextFromTranscript, readModelFromTranscript, readUsageByModelFromTranscript, readUsageFromTranscript, scanAgentsMdFiles, scanClaudeMdFiles, sessionUsageByModel, sessionUsageTotals } from "./session-enrichment.mjs";
// What a starting deck reads back out of its log, and which of those events
// are in its scope — see log-replay.mjs. Both were exported from this file
// before they moved, and still are.
import { replayLog } from "./log-replay.mjs";
export { replayLog, replayScope } from "./log-replay.mjs";
// How the enrichment reaches pushEvent without importing this file — see
// event-sink.mjs. Connected below, as this module loads.
import { connectEventSink } from "./event-sink.mjs";
import { PRODUCT } from "./brand.mjs";
import { createBlockNotifier } from "./block-notify.mjs";
// The gate pushEvent asks before a transcript path is followed — see
// transcript-scan.mjs.
import { isClaudeTranscriptPath, noteRefusedTranscript } from "./transcript-scan.mjs";
// Exported from this file before they moved, and still: the tests that pin
// them import them by this file's name.
export { MAX_SCAN_CHUNK, foldSessionNamingLine, isClaudeTranscriptPath, readAppendedLines, transcriptSessionKey } from "./transcript-scan.mjs";
// How this process is replaced or ended — the version, upgrade, restart,
// stop and presence routes, the restart latch, and the away-update that
// presses Upgrade or Restart by itself — see lifecycle.mjs. startServer arms
// it, the route table calls into it and pushEvent feeds its `activity`.
import { activity, armLifecycle, handlePresence, handleRestart, handleStop, handleUpgrade, handleVersion, startAwayUpdate } from "./lifecycle.mjs";
// The launcher's two calls into the latch, exported from this file before
// they moved, and still: bin/deck.js imports them by this file's name.
export { markDeckReady, releaseRestart } from "./lifecycle.mjs";
import { notificationsOn } from "./deck-prefs.mjs";
// The settings as this process holds them, and every write that changes them —
// see prefs-state.mjs.
import { heldPrefs, prefsRead } from "./prefs-state.mjs";
// This deck's LAN engine, what the settings may tell it, and the probe that
// asks whether other decks can reach it — see lan-deck.mjs. startServer hands
// it the prefs at boot; the settings route does after every write.
import { applyLanPrefs, resetLanLoaded } from "./lan-deck.mjs";
// The Local network panel's four routes — see lan-routes.mjs.
import { handleLanInvite, handleLanPeer, handleLanStatus, handleLanSync } from "./lan-routes.mjs";
// GET and POST /api/prefs — see prefs-routes.mjs.
import { handlePrefsRead, handlePrefsWrite } from "./prefs-routes.mjs";
import { notify as osNotify } from "./browser-react.mjs";
import { MANIFEST_PATH, offerManifest } from "./app-manifest.mjs";
import { appendFailureStats, appendLogLine, emptyLog } from "./log-writer.mjs";
import { historySnapshot, readProcesses, startSystemMetrics, systemSnapshot } from "./system-metrics.mjs";
// How every route reads a body and answers — see http-io.mjs.
import { OVERSIZE_DRAIN_MS, send } from "./http-io.mjs";
// The accounts surface's routes — see account-routes.mjs. The boot reaches the
// admin and auto-switch modules through the same two loaders.
import { cswapAdminModule, cswapAutoModule, getProjectRollup, handleAccountLoginState, handleAccountProjects, handleClaudeAccountAdmin, handleClaudeAccountSwitch, handleClaudeAccounts, handleCswapAuto, handleCswapAutoAction } from "./account-routes.mjs";
// Browser Watch's three routes — see browser-watch-routes.mjs.
import { handleBrowserWatch, handleBrowserWatchDismiss, handleBrowserWatchSettings } from "./browser-watch-routes.mjs";
// The music routes, every one behind AGENTS_DECK_NO_MUSIC — see music-routes.mjs.
import { handleBestOfNostalgia, handleCafeMusicBgm, handleClaudeFm, handleFmStation, handleGoodLifeRadio, handleLiveRadioMix, handleLofiGirl } from "./music-routes.mjs";
// The usage panel's quota and history reads — see usage-routes.mjs.
import { handleCcusage, handleCodexQuota, handleCodexUsage, handleQuota } from "./usage-routes.mjs";
// The port fallback, one listen attempt, and the words for a failed one — see
// listen.mjs. The loop that uses them is startServer's.
import { listenFailure, portRetryable, randomPort, tryListen } from "./listen.mjs";
// The build this process runs, loaded before an install can replace it — see
// pinned-build.mjs. Exported from this file before it moved, and still.
export { pinRunningBuild } from "./pinned-build.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..", "..");

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
  onError: err => console.error(`${PRODUCT}: could not raise a desktop notification:`, err?.message ?? err),
});

function pushEvent(raw, source, opts = {}) {
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

/**
 * Serialize one envelope, or a stub standing in for it.
 *
 * `JSON.stringify` throws on more than size. V8 walks a value recursively, so a
 * payload nested about five thousand deep overflows the C++ stack and comes
 * back as `RangeError: Maximum call stack size exceeded` — and a 36 KB POST to
 * the open ingest route is enough to put one of those in the ring, measured on
 * Node 22.14. Letting that throw escape would truncate the array mid-write and
 * leave every later read of that ring answering with invalid JSON for as long
 * as the event survives, which is a 36 KB way to poison a route permanently.
 *
 * So the envelope is replaced rather than dropped, and it keeps its `seq`: a
 * caller paging with `?since=` still walks past it, instead of asking again for
 * a hole it can never be given — the same bargain resumeSse makes about the
 * events it cannot deliver. The reason is written to stderr and not to the
 * wire, under the rule sendInternalError explains: this body is readable by a
 * DNS-rebound page and error detail is not.
 */
function envelopeJson(evt) {
  try {
    // `JSON.stringify(undefined)` is undefined, not a string, and inside an
    // array literal that would be the text "undefined" — which is not JSON.
    // `JSON.stringify([undefined])` says "null"; so does this.
    return JSON.stringify(evt) ?? "null";
  } catch (err) {
    console.error(`${PRODUCT}: event ${evt?.seq} could not be serialized:`, err);
    // Every field here is read defensively and typed to a primitive, because
    // this is the path that must not throw twice: the status line has gone out
    // and a second failure would leave the caller a truncated array.
    return JSON.stringify({
      seq: Number(evt?.seq) || 0,
      epoch: typeof evt?.epoch === "string" ? evt.epoch : SEQ_EPOCH,
      receivedAt: Number(evt?.receivedAt) || 0,
      source: typeof evt?.source === "string" ? evt.source : "unknown",
      payload: null,
      unserializable: true,
    });
  }
}

/**
 * Answer with a JSON array without ever holding it as one string.
 *
 * `send` finishes a response by handing the whole body to a single
 * `JSON.stringify`, which for every other route is a few hundred bytes and for
 * `GET /api/events` is the entire ring buffer. V8 will not build a string
 * longer than `2^29 - 24` characters, so past 536,870,888 characters of
 * serialised envelopes that call throws `RangeError: Invalid string length`
 * straight out of the request listener — and there, as requestUrl and `guard`
 * both say in their own words, nothing catches it and the worker exits.
 * Measured on Node 22.14 / macOS: 112 posts of 4,900,061 characters, which
 * `POST /api/event` accepts from anyone with no credential at all, then one
 * plain unauthenticated GET, and the deck was gone — SSE stream, hook ingest
 * and event log with it. 112 events is a twentieth of MAX_BUFFER, so this is
 * not an exotic ring: a deck watching sessions whose Read and Bash responses
 * are "routinely a good fraction of" the five-million-character ingest cap
 * reaches it on its own at an average of 268 KB an event.
 *
 * Writing the array element by element removes the ceiling rather than raising
 * it. One envelope's worth of string exists at a time, so the limit applies per
 * envelope — and ingest caps an envelope at a hundredth of it — and the peak
 * cost is the ring plus one event instead of the ring plus a contiguous copy of
 * itself, which is the quieter half of the same bug: a 400 MB ring used to need
 * 800 MB and a synchronous stall on a route that feels free on a quiet deck.
 * This is the shape resumeSse already uses for the SSE replay, for the same
 * reason, and it borrows the same writeResume, so a caller that stops reading
 * is held at MAX_CLIENT_BUFFER_BYTES here too rather than having the whole ring
 * queued in userland on its behalf.
 *
 * `items` must be a snapshot the caller owns — eventsSince returns one, `filter`
 * always allocating — because each await lets pushEvent splice the head off the
 * live ring, and iterating that while it is spliced skips entries.
 *
 * No Content-Length: it is not knowable without building the string this exists
 * to avoid, so the answer is chunked. HTTP/1.1 requires nothing more and every
 * consumer reads to EOF.
 *
 * Exported so the one property that matters can be asserted directly, on a stub
 * rather than through a socket — the same reason queuedBytes is. "Never builds
 * the whole array as one string" is invisible from outside a real response,
 * which is how it went unnoticed here for as long as it did.
 */
export async function writeJsonArray(res, items) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  let frame = "[";
  for (const item of items) {
    if (res.destroyed) return;
    if (!await writeResume(res, frame + envelopeJson(item))) {
      // Stalled past REPLAY_DRAIN_MS with the cap full. Nothing useful can be
      // said in-band — the status line went out long ago and the array is half
      // written — so hang up, exactly as the replay does.
      try { res.destroy(); } catch {}
      return;
    }
    frame = ",";
  }
  if (res.destroyed) return;
  res.end(frame === "[" ? "[]" : "]");
}

// `persist` is false when the hook posted this event to another deck as well
// and elected that one to write it to the log they share. The event is still
// buffered and broadcast here — every matching deck draws it — it is only the
// second copy on disk that is dropped.
function handleEventIngest(req, res, persist = true) {
  let body = "";
  // Set once the cap is hit, because everything after that point is about an
  // exchange that is already over: more `data` may still be in flight, and
  // `end` must not go on to parse the truncated half.
  let refused = false;
  req.setEncoding("utf8");
  req.on("data", c => {
    if (refused) return;
    body += c;
    if (body.length > 5_000_000) {
      refused = true;
      body = "";              // nothing will read it now; let it go
      // ANSWER, rather than vanish. `req.destroy()` on its own tore the socket
      // down with no status line on it at all, so the poster learned only that
      // the connection had gone — indistinguishable from a deck that died or
      // was never there, and nothing in the exchange to tell those apart. `end`
      // never fires on a destroyed request either, so the handler below got no
      // second chance to speak. readBody was believed to get this right
      // by rejecting into a caller that replies; it destroyed the socket first,
      // so all eleven of its routes answered an oversized body with the same
      // bare reset. It answers and drains now, in this shape.
      send(res, 413, { error: "event too large" });
      // Then keep reading, and throw it away. Answering is not enough on its
      // own, because the poster is still mid-upload when the answer goes out:
      // hang up now and its next write lands on a dead socket, it aborts with
      // EPIPE, and the 413 that was already sitting in its receive buffer is
      // discarded unread — the same disappearance in a different costume.
      // `Connection: close` is the tempting version of hanging up and has
      // exactly that effect: Node destroys the socket the moment such a
      // response flushes. Draining lets the poster finish and then read the
      // answer, which is the whole point of answering. `body` no longer grows,
      // so it costs no memory.
      req.resume();
      // Bounded, because draining forever is its own denial of service: a
      // poster that stops without ending would otherwise hold the socket for as
      // long as it liked.
      const grace = setTimeout(() => req.destroy(), OVERSIZE_DRAIN_MS);
      grace.unref?.();
      req.on("close", () => clearTimeout(grace));
    }
  });
  req.on("end", () => {
    if (refused) return;
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return send(res, 400, { error: "invalid json" }); }
    // Everything past the parse is inside one net, because this listener is the
    // one place in the route table `guard` cannot reach. The route does wrap the
    // call — `guard(handleEventIngest(req, res, …), res)` — but this function
    // returns undefined and hands its work to a listener the event loop calls
    // later, so `guard` has nothing to attach to and a synchronous throw in here
    // is an uncaughtException: the whole deck, for one POST. That is exactly
    // what the serialization inside pushEvent was until it was contained at the
    // line itself, and this catch is what stops the next thing added below from
    // costing a process the same way. sendInternalError puts the reason on
    // stderr and a bare 500 on the wire, and does nothing but end the response
    // if the status line has already gone out.
    try {
      noteLogWriter(parsed, persist);
      const evt = pushEvent(parsed, "hook", { persist });
      send(res, 200, { ok: true, seq: evt.seq });
    } catch (err) {
      sendInternalError(res, err);
    }
  });
  // Guarded for the same reason `end` is, and more sharply: destroying the
  // request above is itself what raises this, and answering a second time on a
  // response already sent throws ERR_HTTP_HEADERS_SENT out of an error handler,
  // where nothing is waiting to catch it. `refused` covers the 413 that
  // destroyed the request; `headersSent` covers the other half of that
  // sentence, an error arriving after `end` has already answered. That half
  // resisted every attempt to drive it from a socket — once `end` has fired the
  // message is complete and the failure goes to the socket rather than to the
  // request — so it carries no test, and is guarded anyway on the strength of
  // the hazard the sentence above already names: one condition against an
  // uncaughtException, if it turns out to be reachable at all.
  req.on("error", () => { if (!refused && !res.headersSent) send(res, 400, { error: "bad request" }); });
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 1500\n\n`);

  // A stale or absent id replays the whole ring, and so does a malformed one:
  // Number("nonsense") is NaN, every `seq <= NaN` is false, and the catch-up
  // loop below would rather compare against a number.
  //
  // An id OLDER than the ring's oldest event is a stale id and takes exactly
  // that path — nothing special-cases it, and #625 deliberately did not add a
  // second answer when it gave the ring a byte budget. Every `e.seq <=
  // sentThrough` test simply fails, so the client is handed everything still
  // held, contiguously, and the sentinel behind it; the events that were
  // evicted are missing from its HISTORY, never from its stream. The reducer's
  // guard is `env.seq <= state.lastSeq`, so the gap costs it a step forward and
  // nothing else. What the byte budget changed is how often and how far the
  // head moves, not what happens to a client that lands behind it.
  const asked = Number(req.headers["last-event-id"] ?? 0);
  const lastId = Number.isFinite(asked) ? asked : 0;

  // The replay waits on the socket now, so it can no longer be part of this
  // synchronous handler. Nothing is waiting on the result here — the response
  // is already committed to a 200 and its own failure path is to hang up — so
  // start it, keep the router's contract of returning nothing, and make sure a
  // rejection ends the stream rather than the process.
  resumeSse(req, res, lastId, { tray: isTrayRequest(req) }).catch(() => dropSse(res));
}

/**
 * Drain the ring buffer into a newly connected client, then subscribe it.
 *
 * Two things had to change when this stopped being one synchronous burst.
 * `close` is registered before the first frame, because a tab closed mid-replay
 * has to stop it. And the replay repeats until it reaches the live tail: an
 * actual wait lets pushEvent run, and an event that lands after we have walked
 * past its place but before the client is in `sseClients` would otherwise be in
 * neither stream — a hole the client cannot even ask for again, its last id
 * having moved past it.
 */
/**
 * Is this the desktop app's tray connection? Only with the deck's own token:
 * a page cannot opt itself out of being counted, because that would let any
 * tab switch on the closed-deck notifications over itself.
 */
function isTrayRequest(req) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  return url.searchParams.get("role") === "tray" && presentsDeckToken(req.headers ?? {});
}

async function resumeSse(req, res, lastId, { tray = false } = {}) {
  let sentThrough = lastId;
  let ping = null;
  let closed = false;
  req.on("close", () => {
    closed = true;
    if (ping) clearInterval(ping);
    sseClients.delete(res);
    trayClients.delete(res);
  });

  for (;;) {
    // A snapshot per pass, because a wait lets pushEvent splice the head of
    // `events` off, and iterating an array being spliced from the front skips
    // entries. Events evicted that way are gone for this client, which is the
    // same bargain every resume against a rotated ring already makes.
    //
    // The snapshot earns more since #625 gave the ring a byte budget as well as
    // a count. Under the count alone the head moved one entry per push; under
    // the budget a single 5 MB event can evict hundreds at once. A replay
    // already walking this array would have skipped every one of them — but the
    // snapshot holds its own references, so the pass in flight still delivers
    // what it was given and only a LATER pass sees the shortened ring. It also
    // means a slow resumer pins one ring's worth of envelopes for as long as its
    // pass lasts, which the budget bounds too: that pin used to be unbounded for
    // the same reason the ring was.
    const batch = ringSnapshot();
    for (const e of batch) {
      if (e.seq <= sentThrough) continue;
      if (closed || res.destroyed) return;
      // Marked with `replay:true` on the envelope for the page, which reads it in
      // two places: the SSE handler coalesces renders while it is set and draws
      // once at `replay-end`, and `chimeFor` stays quiet for it, so a reconnect
      // does not play every Stop in the ring. The reducer never reads it — its
      // turn cleanup keys on each event's own time, which comes out right for
      // replayed and live events alike (HookEnvelope.replay in types.ts, and
      // dead-surface-993 pins it). This used to say the reducer's
      // UserPromptSubmit handler depended on the tag to tell a replayed prompt
      // from a new turn; nothing there reads it.
      const tagged = { ...e, replay: true };
      // Through envelopeJson for the reason writeJsonArray is: the ring may be
      // holding an envelope `JSON.stringify` cannot walk. pushEvent takes the
      // payload out of every envelope it serializes, but it serializes nothing
      // when there is no subscriber and no log — which is precisely the deck a
      // browser is about to connect to — so the first read of such an entry can
      // still be this one. Uncontained it rejected into handleSse's `.catch`,
      // which drops the client; the browser reconnects on its own 1.5s timer,
      // replays the same entry, and is dropped again, so a single small POST
      // kept the canvas from ever loading. The stub loses the `replay` tag and
      // nothing turns on that: it carries no payload for the reducer to act on,
      // and the client's own replay gate runs until the `replay-end` sentinel
      // regardless of what any one envelope says.
      if (!await writeResume(res, `id: ${e.seq}\nevent: hook\ndata: ${envelopeJson(tagged)}\n\n`)) {
        return dropSse(res);
      }
      sentThrough = e.seq;
    }
    // Caught up with the tail as it stands right now. Reached in one pass
    // unless a wait let new events in, and it terminates for the same reason
    // the client is still here at all: either it is taking bytes, in which case
    // loopback outruns any hook, or it is not, in which case writeResume gives
    // up on it.
    if (!ringHoldsNewerThan(sentThrough)) break;
  }

  if (closed || res.destroyed) return;

  // Sentinel: tells client "ring buffer drained, live stream starts now". It
  // goes out under the same rule as the frames before it, so a client that has
  // just been handed a large replay is not hung up on over the last 30 bytes of
  // it before it has had the chance to read any.
  //
  // Subscribing before waiting on that write, rather than after, is what closes
  // the last hole: writeResume puts the bytes on the socket before it returns,
  // so the sentinel still precedes every live frame, and an event pushed while
  // we wait reaches this client through the live fan-out instead of falling
  // into the gap between the two. If the wait then ends in a drop, dropSse
  // takes it back out of the set — the same exit writeSse uses.
  const flushed = writeResume(res, `event: replay-end\ndata: {}\n\n`);
  sseClients.add(res);
  if (tray) trayClients.add(res);
  // Through writeSse like every other frame: on a client that has stopped
  // reading, the ping is the one thing still being written between events, and
  // it is what eventually reveals the socket as unrecoverable.
  ping = setInterval(() => writeSse(res, `: ping\n\n`), 15000);
  if (!await flushed) dropSse(res);
}

// The tree this deck was told to capture, "" when it captures the whole
// machine. Set by startServer and never changed afterwards.
//
// The browser had no way to learn it: the launcher prints the scope on stdout
// and the hook reads it out of the discovery file, but nothing put it in an
// HTTP response — so the deck's own empty state guessed, and guessed wrong for
// everyone who passed --workspace or --scope. Health is where it belongs: it
// already answers "which deck am I talking to", and it is the one route the UI
// can read before a single event has arrived.
let _workspace = "";

// Which CLIs this deck is actually watching. Decided in bin/deck.js — from
// whether each one is on the machine, and from --claude/--no-claude and
// --codex/--no-codex — and passed in here, because the browser had no way to
// learn it and so drew both sides of the UI on every machine.
//
// That is the whole of #402 and its mirror. A Codex-only machine got the
// accounts panel open on first run, telling it to sign into a CLI it does not
// have; a Claude-only machine permanently carried "Quota unavailable. / Run
// codex login to authenticate." Same missing fact, two directions.
//
// Defaults are both true, which is what an older deck effectively reported by
// saying nothing — and the browser reads a missing field as "could not say" and
// shows both, so the two agree.
let _providers = { claude: true, codex: true };

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
async function handleClear(res) {
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

function handleHealth(_req, res) {
  send(res, 200, {
    ok: true,
    name: "agent-dag",
    seq: lastSeq(),
    clients: pageCount(),
    // The desktop app's tray connections, which are not pages (#1160).
    trays: trayClients.size,
    uptimeMs: Math.round(process.uptime() * 1000),
    workspace: _workspace,
    providers: _providers,
    // WHETHER THE EVENTS BEING DRAWN ARE BEING KEPT. `seq` above counts what
    // the deck accepted, and it counted a deck whose every append was failing
    // exactly the same as one whose every append landed. `log` is the other
    // half of that sentence: `writable` is the newest evidence about the log —
    // the boot probe's answer until a line lands after it and the appender's
    // from then on, the same answer the Restart gate reads (#1130) — `failing`
    // says the appender is inside a failure episode right now, and
    // `failedLines` / `failedChars` are what has been attempted and lost since
    // this deck started.
    //
    // No path. The health probe is a deliberately open route and this is the
    // smallest set of facts that answers the question; the path is already in
    // the banner for anyone standing at the terminal.
    log: eventLogPath() ? { writable: logWritableNow(), ...appendFailureStats(eventLogPath()) } : null,
  });
}

/** The token this deck expects to be challenged on. Written by writeDiscovery. */
export function hookToken() { return HOOK_TOKEN; }

// GET /api/hook-challenge?nonce=… — answer a hook's challenge.
//
// The nonce is the caller's, so the answer proves knowledge of the token
// without disclosing it, and proves it for this exchange only. Answering
// freely is what the exchange requires: the hook is asking whether the process
// on this port is the deck that wrote the discovery file, and it asks precisely
// because it does not yet know — a deck that demanded credentials before
// answering could not be told apart from a stranger that refuses.
//
// So this route is an oracle, and it must stay one. That makes its answer
// useless as a credential FOR this server, and nothing here may ever accept it
// as one: a caller who can GET this can obtain a valid proof for any nonce, so
// a gate honouring proofs is a gate honouring anybody. See presentsDeckToken,
// which takes the token itself and refuses the hashed form for this reason.
//
// What the free answer does NOT give away is the token: the response is a
// one-way hash of it, and after the read gate above a rebound page cannot see
// even that.
function handleHookChallenge(_req, res, url) {
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!nonce || nonce.length > 256) return send(res, 400, { error: "bad nonce" });
  send(res, 200, { proof: challengeProof(HOOK_TOKEN, nonce) });
}

async function sweepStaleDiscovery() {
  // Same directory the installer writes and the hooks read — see claude-dir.mjs.
  const dir = join(claudeConfigDir(), "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    try {
      const d = JSON.parse(await readFile(p, "utf8"));
      if (d && typeof d.pid === "number" && !isProcessAlive(d.pid)) {
        await unlink(p).catch(() => {});
        removed++;
      }
    } catch { /* corrupt — leave it */ }
  }
  return removed;
}

// Parse a request target into a URL, or null when it cannot be parsed.
//
// The base is the constant "http://localhost", never the Host header. Node's
// HTTP parser hands the header through verbatim, so a client sending
// `Host: bad host` used to produce `new URL("/", "http://bad host")`, which
// throws ERR_INVALID_URL synchronously inside the request listener. Nothing
// catches that — it becomes an uncaughtException, the worker exits 1 and the
// supervisor tears the whole deck down for a single malformed request. Only
// the path and the query are ever read from this URL, so the authority half
// is free to be a constant — which is what every other new URL call site in
// this file already does. Anything else unparseable answers 400 instead.
export function requestUrl(rawUrl) {
  try { return new URL(rawUrl ?? "/", "http://localhost"); }
  catch { return null; }
}

// A request handler rejected. Two audiences, two different amounts of detail:
// the operator, who needs the whole error — stack included — to find the bug,
// and the HTTP client, which needs to know only that the request failed.
//
// They used to get the same string, on the theory that this server binds
// 127.0.0.1 and its only client is the user's own tab. A DNS-rebound page
// reaches a loopback server as same-origin and can read the body, and the
// errors that land here carry absolute paths out of the user's home directory
// — a failed rename of ~/.claude/settings.json, an ENOENT from an import. So
// stderr keeps every byte and the response body carries none of it; nothing is
// swallowed, it just stops travelling over the wire.
export function sendInternalError(res, err, log = console.error) {
  log(`${PRODUCT}: request handler failed:`, err);
  if (!res.headersSent) send(res, 500, { error: "internal error" });
  else res.end();
}

export async function startServer({ port = 4317, host = "127.0.0.1", persist = null, portRange = [4318, 4400], workspace = "", codex = true, claude = true, onRestart = null, onStop = null, cswapQuiet = null } = {}) {
  armLifecycle({ onRestart, onStop, persist });
  _workspace = typeof workspace === "string" ? workspace : "";
  // `!== false` rather than a cast: a caller that omits the field means "yes",
  // which is how every embedder that predates this option keeps working.
  _providers = { claude: claude !== false, codex: codex !== false };
  // A boot is the one moment the file, and not the engine, is the authority on
  // the key, the pairings and the port. See lanApplyFields.
  resetLanLoaded();
  // The away-update's clock starts here — see startAwayUpdate.
  startAwayUpdate();
  // The repair a paused Claude account used to wait on a `resume` press for:
  // handed to the roster read here, by the server that is actually running,
  // rather than wired at import — see repairStaleCopyWith.
  if (_providers.claude) {
    // THIS WIRING IS WHERE AN IMPORT CYCLE SHOWED UP AS A SILENT NO-OP, and it
    // is the cycle that has been fixed rather than this line — see
    // claude-identity.mjs.
    //
    // claude-accounts.mjs used to take `currentIdentity` from cswap-admin.mjs
    // while cswap-admin.mjs took `backupRoot`, `invalidateClaudeAccountsCache`
    // and `verdictNow` back, which was the only static import cycle in
    // src/server. Two dynamic imports entering a cycle concurrently are each
    // handed the other module's HALF-BUILT namespace rather than waiting for
    // it, and a half-built namespace has no exports on it at all: measured on
    // CI, both came back with zero keys, so `accounts.repairStaleCopyWith` was
    // a TypeError in a promise nothing awaits. The repair was never wired and
    // nothing said so — every test passed, and the run exited 1 on an unhandled
    // rejection alone.
    //
    // Several importers reach this pair within a few ticks at boot —
    // `cswapAutoModule()` below imports claude-accounts.mjs too, and
    // `startServer` can be called again before this has settled — so it was a
    // timing defect that any change to those import lists could trip, and
    // sequencing one call site was never going to be enough.
    //
    // Asked for one at a time anyway, which is now belt as well as braces: with
    // no cycle left, a concurrent pair would simply wait for each other.
    // boot-module-graph.test.ts asserts the braces — that src/server has no
    // import cycles at all — rather than trying to police call sites.
    void (async () => {
      let accounts, admin;
      // An import that genuinely fails stays tolerated, exactly as the
      // `() => {}` this replaced tolerated it: the wiring is best-effort. A
      // namespace that arrives WITHOUT the function is a different thing and
      // must stay loud, because that is the failure described above.
      try {
        accounts = await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href);
        admin = await cswapAdminModule();
      } catch { return; }
      accounts.repairStaleCopyWith(admin.autoRecapture);
    })();
  }
  const removed = await sweepStaleDiscovery();
  if (removed > 0) console.log(`  swept ${removed} stale discovery file(s)`);
  // Where the log is and whether it can be written, asked before the first
  // event — see openEventLog.
  await openEventLog(persist);
  if (persist) {
    // `_workspace`, not `workspace`: the field has just been normalised on the
    // line above, and the replay has to answer the same question the live paths
    // answer with the same string. Passed rather than read off the module scope
    // so replayLog states what it depends on. See replayScope.
    //
    // `_providers` goes with it, and for the same reason: it gates the two live
    // capture paths a few lines down (`if (codex) startCodexWatcher`, and the
    // hook install above), and until #1004 it reached neither the replay nor
    // anything else but the health payload.
    const replayed = await replayLog(eventLogPath(), _workspace, { providers: _providers });
    if (replayed > 0) {
      // Don't broadcast replays as live; SSE clients catch up via Last-Event-ID
      // already. Just keep the buffer + seq counter primed.
    }
  }
  // The async handlers below are dispatched as floating promises. Node's
  // default for an unhandled rejection is to kill the process, which would
  // take the whole deck down — SSE stream, hook ingest and all — because one
  // background quota poll hit a network error. Answer the request instead.
  const guard = (p, res) => Promise.resolve(p).catch(err => sendInternalError(res, err));

  // Which of the eleven candidates below this deck ended up on, set the moment
  // one of them binds. Declared here rather than beside the loop that fills it
  // so it is above the route that reads it — see the manifest gate.
  let boundPort = null;

  const route = (req, res) => {
    const url = requestUrl(req.url);
    // Unparseable request target. Nothing below can route it, and throwing here
    // would be an uncaughtException inside the listener — i.e. the whole deck.
    if (!url) return send(res, 400, { error: "bad request target" });

    // Three gates in front of the whole table, so every route is covered and
    // any route added later is covered too, without the author having to
    // remember. They ask three different questions and they run in the order
    // that answers the cheapest first.

    // Was this addressed to this machine? Every method, because a rebound page
    // reads a reply as readily as it writes a request. See isTrustedRead.
    if (!isTrustedRead({
      origin: req.headers.origin,
      host: req.headers.host,
      secFetchSite: req.headers["sec-fetch-site"],
      referer: req.headers.referer,
    })) {
      return send(res, 403, { error: "cross-site request blocked" });
    }

    // Did a page choose this? Mutations only — the same-site read this refuses
    // is an ordinary navigation. See isTrustedMutation.
    if (req.method !== "GET" && req.method !== "HEAD" && !isTrustedMutation({
      origin: req.headers.origin,
      host: req.headers.host,
      secFetchSite: req.headers["sec-fetch-site"],
    })) {
      return send(res, 403, { error: "cross-site request blocked" });
    }

    // And who is asking? Refusing by default is the point: a mutating route
    // added later is protected until someone deliberately lists it as open,
    // which is the direction this has to fail in. See isAuthorizedMutation.
    if (req.method !== "GET" && req.method !== "HEAD"
      && !OPEN_MUTATIONS.has(url.pathname) && !isAuthorizedMutation(req)) {
      return send(res, 401, { error: "unauthenticated" });
    }

    // And the reads that carry the same secrets. See isAuthorizedDataRead: the
    // gate above was written for a sandboxed subprocess with loopback egress,
    // and that caller was reading the ring through a GET the whole time.
    if ((req.method === "GET" || req.method === "HEAD")
      && GUARDED_READS.has(url.pathname) && !isAuthorizedDataRead(req)) {
      return send(res, 401, { error: "unauthenticated" });
    }

    // `?persist=0` — another deck was elected to write this event to the log
    // the two of them share. Absent, this deck writes it.
    if (req.method === "POST" && url.pathname === "/api/event") return guard(handleEventIngest(req, res, url.searchParams.get("persist") !== "0"), res);
    if (req.method === "GET"  && url.pathname === "/api/health") return handleHealth(req, res);
    if (req.method === "GET"  && url.pathname === "/api/hook-challenge") return handleHookChallenge(req, res, url);
    if (req.method === "GET"  && url.pathname === "/events")     return handleSse(req, res);
    if (req.method === "GET"  && url.pathname === "/api/version")     return guard(handleVersion(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/desktop-update") return handleDesktopUpdateRead(req, res);
    if (req.method === "POST" && url.pathname === "/api/desktop-update") return guard(handleDesktopUpdateReport(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/desktop-update/restart") return guard(handleDesktopUpdateRequest(req, res, "desktop-update-restart"), res);
    if (req.method === "POST" && url.pathname === "/api/desktop-update/seen") return guard(handleDesktopUpdateRequest(req, res, "desktop-update-seen"), res);
    if (req.method === "POST" && url.pathname === "/api/upgrade")     return guard(handleUpgrade(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/restart")     return guard(handleRestart(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/presence")    return guard(handlePresence(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/shutdown")    return guard(handleStop(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/quota")       return guard(handleQuota(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/codex-usage")  return guard(handleCodexUsage(req, res), res);
    // Machine state, not session state: sampled on the server's own timer and
    // deliberately kept out of the event stream. See src/server/system-metrics.mjs.
    if (req.method === "GET"  && url.pathname === "/api/prefs")        return handlePrefsRead(req, res);
    if (req.method === "GET"  && url.pathname === "/api/lan")          return handleLanStatus(req, res);
    if (req.method === "POST" && url.pathname === "/api/lan/peer")     return guard(handleLanPeer(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/lan/invite")   return guard(handleLanInvite(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/lan/sync")     return guard(handleLanSync(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/prefs")        return guard(handlePrefsWrite(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/system")       return send(res, 200, systemSnapshot());
    // On demand only — the process list costs a subprocess on every platform,
    // so it is fetched while the detail panel is open and never on the timer.
    if (req.method === "GET"  && url.pathname === "/api/system/processes") {
      // `total` is how many the machine is running, against the candidates
      // actually sent. The modal says both, so a reader can see this is a
      // selection rather than a task manager pretending to be complete.
      // `detail=1` adds threads, uptime and the redacted command tail, and it
      // is the modal that asks for it. Three reasons it is not the default,
      // measured rather than assumed: it is a second `ps` child per poll (240ms
      // against 100), it is 12 KB of the 14 KB payload, and it is the only part
      // of this reading that has ever been near an argument vector. The panel
      // draws four columns and needs none of it, so on a deck where the modal
      // is never opened the argv is never read at all.
      const detail = url.searchParams.get("detail") === "1";
      return guard(readProcesses(process.platform, detail).then(r => send(res, 200, { ok: true, ...r })), res);
    }
    // A day of minute buckets, which is far too much to ride along on
    // /api/system's three-second poll for a chart that is usually closed. Its
    // own route, fetched only while a modal is open — the same arrangement the
    // process list has for the same reason. One section per request, because
    // four sections of a day would be four times too much again.
    if (req.method === "GET"  && url.pathname === "/api/system/history") {
      const group = url.searchParams.get("group") ?? "";
      // An allowlist, not a pass-through: the parameter names a section of this
      // panel and nothing else, so an unknown one is a 400 rather than an empty
      // chart that looks like a machine with nothing to report.
      if (!["thermal", "cores", "memory", "load", "network"].includes(group)) {
        return send(res, 400, { ok: false, error: "unknown_group" });
      }
      return send(res, 200, historySnapshot(group));
    }
    if (req.method === "GET"  && url.pathname === "/api/codex-quota") return guard(handleCodexQuota(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/ccusage")     return guard(handleCcusage(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/browser-watch") return guard(handleBrowserWatch(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/browser-watch") return guard(handleBrowserWatchSettings(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/browser-watch/dismiss") return guard(handleBrowserWatchDismiss(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/account-projects") return guard(handleAccountProjects(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/claude-accounts") return guard(handleClaudeAccounts(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/claude-accounts/switch") return guard(handleClaudeAccountSwitch(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/claude-accounts/login")  return guard(handleAccountLoginState(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/claude-accounts/admin")  return guard(handleClaudeAccountAdmin(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/cswap-auto")  return guard(handleCswapAuto(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/cswap-auto")  return guard(handleCswapAutoAction(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/claude-fm")   return guard(handleClaudeFm(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/fm-station") return guard(handleFmStation(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/lofi-girl")   return guard(handleLofiGirl(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/live-radio-mix") return guard(handleLiveRadioMix(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/best-of-nostalgia") return guard(handleBestOfNostalgia(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/good-life-radio") return guard(handleGoodLifeRadio(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/cafe-music-bgm") return guard(handleCafeMusicBgm(req, res), res);

    // Through writeJsonArray rather than `send`, and through `guard` like every
    // route above it: this is the one answer whose size is the ring's size, and
    // `send` would build all of it as a single string. See writeJsonArray.
    if (req.method === "GET" && url.pathname === "/api/events") {
      return guard(writeJsonArray(res, eventsSince(url.searchParams.get("since") ?? 0)), res);
    }

    // GET /api/clear — what a POST to this path would do, and to whose log.
    // Asked by the confirmation dialog as it opens, on demand rather than on a
    // timer, for the reason /api/system/processes is: the answer costs a
    // directory read, changes only when a deck starts or stops, and matters at
    // exactly one moment. See logSharing.
    if (req.method === "GET" && url.pathname === "/api/clear") {
      return guard(logSharing().then(s => send(res, 200, {
        ok: true, path: s.path, decks: s.decks, mine: s.mine,
        owner: s.owner ? { port: s.owner.port } : null,
      })), res);
    }

    // POST /api/clear — wipe in-memory buffer + persistence file (UI reset)
    if (req.method === "POST" && url.pathname === "/api/clear") return guard(handleClear(res), res);

    // POST /api/forget — the sessions the page's own pruners dropped. The same
    // sentence as `__clear`, about part of the board rather than all of it.
    // Above the 404 below, which is what every real route has to be.
    if (req.method === "POST" && url.pathname === "/api/forget") return guard(handleForget(req, res), res);

    // AN UNMATCHED /api/ PATH IS A 404, not the SPA shell.
    //
    // serveStatic falls back to index.html for a path it cannot find, which is
    // right for a client-side route and wrong for this namespace: nothing under
    // dist/web is served from /api/, so the fallback could only ever answer a
    // route that does not exist — with 200 and text/html.
    //
    // That made every status-code probe against this server vacuous. The Node
    // 18 floor job asks four endpoints for a 200, and one of them (/api/state)
    // has never been a route: the string appears exactly once in the repo, in
    // that loop. It reported 200 anyway, and so would the other three if the
    // whole route table were deleted, as long as index.html was in the tarball.
    // Measured before this line existed:
    //
    //   /api/state                200  text/html; charset=utf-8
    //   /api/definitely-not-a-route  200  text/html; charset=utf-8
    //   /api/health/bogus         200  text/html; charset=utf-8
    //
    // The repo already builds machinery against checks that cannot fail —
    // skip-gate-inventory.test.ts exists because "a probe can start answering
    // the other way and take its case off ALL THREE legs at once". A probe that
    // cannot answer the other way is the limiting case of the same thing.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return send(res, 404, { error: "not found" });
    }

    // THE MANIFEST IS WITHDRAWN WHEN THE PORT WAS INVENTED, not served and
    // then apologised for. An installed app is pinned to an origin and an
    // origin includes the port, so offering one from a random fallback port
    // promises a shortcut that the next boot breaks — and leaves a dead tile
    // behind for every launch, because the browser keys an app by origin. See
    // app-manifest.mjs, which is where the rule and its reasoning live.
    //
    // A 404 rather than a route that answers `{}`: an unparseable manifest is
    // a console error on every page load, and "absent" is exactly what this
    // means.
    if (url.pathname === MANIFEST_PATH && !offerManifest({ asked: port, bound: boundPort })) {
      return send(res, 404, { error: "not found" });
    }

    if (req.method === "GET") return serveStatic(req, res, url);
    send(res, 405, { error: "method not allowed" });
  };

  // `guard` covers the routes dispatched as promises. This covers the rest of
  // them — and, more to the point, covers a route added later by someone who
  // did not think to reach for `guard` because their handler looked
  // synchronous and cheap. That was the whole of #626: `GET /api/events` read
  // as a one-liner, and it was a one-liner that ended the process, because a
  // synchronous throw inside the listener is an uncaughtException and Node's
  // answer to those is to exit. `/api/system` and `/api/clear` are called the
  // same bare way and are covered here for free.
  //
  // Deliberately the last line of defence and not the first: a 500 with the
  // detail on stderr is a worse answer than a handler that knew what went
  // wrong, and much better than a dead deck. sendInternalError already knows
  // to keep the detail off the wire and to do nothing but end the response
  // when the headers have gone out — which is the case that matters for a
  // streamed answer, where the throw can arrive after the status line.
  const server = createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  // Try requested port first, then up to 10 random ports from portRange.
  const candidates = [port];
  for (let i = 0; i < 10; i++) candidates.push(randomPort(portRange[0], portRange[1]));

  // The errno the exhaustion message ends up naming, and the port it happened
  // on. Kept because the last candidate's reason is the only one still worth
  // saying by then — the nine before it were random ports nobody asked for.
  let lastErr = null;
  let lastPort = port;
  for (const candidate of candidates) {
    try {
      await tryListen(server, candidate, host);
      // What actually bound, read by the manifest gate above. `address()`
      // rather than `candidate`, and the difference is the whole point of the
      // gate: `port: 0` means "any ephemeral port", so the candidate and the
      // request agree at 0 while the deck is listening on a number nobody chose
      // and that will differ on the next boot. Every test in this suite boots
      // that way. Comparing the candidate would hand those decks a manifest.
      boundPort = server.address()?.port ?? candidate;
      // Codex has no working hooks on Windows — tail its rollout files instead.
      if (codex) startCodexWatcher(workspace);
      // What a session is producing between its tool calls. Claude only — it
      // reads `transcript_path`, which Codex hooks never send — and unref'd
      // like its neighbours.
      startOutputWatch();
      // Every timer is unref'd, so this never holds the process open. `probe`
      // lets the network section time the API and read the route while the
      // Machine panel is open — the only caller allowed to reach out.
      startSystemMetrics({ probe: true });
      // LAN sync, from the prefs the import read — and only from here, so a
      // deck that had it on comes back with it on, and a launcher that only
      // asked the registry never binds a port it is about to walk away from.
      prefsRead.then(() => applyLanPrefs()).catch(() => {});
      // Auto-switch resumes only if the user previously turned it on; the
      // module reads its own persisted flag and does nothing otherwise. Its
      // ticks wait for `cswapQuiet`, the launcher's word that claude-swap is not
      // being installed or upgraded underneath them (#1043) — null from every
      // caller with nothing to wait for.
      cswapAutoModule().then(m => m.initCswapAuto({ after: cswapQuiet })).catch(() => {});
      // The account-projects rollup: fold Claude transcripts into a per-account,
      // per-project token tally, incrementally. Claude only — it reads Claude
      // transcripts — best effort, and its timer is unref'd so it never holds
      // the process open.
      if (claude) getProjectRollup().catch(() => {});
      return server;
    } catch (err) {
      lastErr = err;
      lastPort = candidate;
      // "This port is unavailable" — which Windows spells EACCES for a port
      // inside a reserved exclusion range. See portRetryable.
      if (portRetryable(err)) continue;
      // Anything else is about the host or the socket, and the next candidate
      // would fail identically. Say why instead of trying ten more times.
      throw listenFailure(err, { host, port: candidate });
    }
  }
  throw listenFailure(lastErr, { host, port: lastPort, exhausted: true });
}

// Allow running this file directly for dev (`npm run dev:server`). The port
// variable is the CLI's, deliberately: this block spent two renames reading a
// name from the project's first identity that no README ever documented, so
// the one variable people know worked everywhere except here.
//
// argv[1] is a string only when node was handed a script path. `node -e`,
// `--input-type=module` on stdin and a worker started from eval source all
// leave it undefined, and pathToFileURL(undefined) throws instead of answering
// false — which fails the whole import, in the one file whose job is to export
// startServer. Guard the argument, not the comparison (#481).
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const port = Number(process.env.AGENT_DAG_PORT ?? 4317);
  startServer({ port }).then(s => {
    const addr = s.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    console.log(`${PRODUCT} server: http://127.0.0.1:${p}`);
  }).catch(e => {
    console.error(`${PRODUCT} server failed:`, e.message);
    process.exit(1);
  });
}
