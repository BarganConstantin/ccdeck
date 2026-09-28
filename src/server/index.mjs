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
import { GUARDED_READS, HOOK_TOKEN, OPEN_MUTATIONS, isAuthorizedDataRead, isAuthorizedMutation, isTrustedMutation, isTrustedRead } from "./request-gates.mjs";
// How much the event ring may hold and what one event is charged against it —
// see ring-bounds.mjs. The four it exported from this file, it still exports.
export { MAX_BUFFER, MAX_BUFFER_CHARS, MAX_RING_ENTRIES, payloadChars } from "./ring-bounds.mjs";
// The ring itself — what it holds, how it numbers them, and the eviction that
// keeps those bounds — private behind its operations. See event-ring.mjs.
import { clearEventBuffer, eventsSince, lastSeq } from "./event-ring.mjs";
// Exported from this file before they moved, and still.
export { eventBufferStats, eventsSince } from "./event-ring.mjs";
// The one door every event comes through, and what it does to each on the way
// in — see event-pipeline.mjs. It connects itself to event-sink.mjs as it
// loads, which is how the modules it imports reach it.
import { pushEvent } from "./event-pipeline.mjs";
// POST /api/event, GET /events and GET /api/events — see event-routes.mjs.
import { handleEventIngest, handleSse, writeJsonArray } from "./event-routes.mjs";
// Exported from this file before it moved, and still.
export { writeJsonArray };
// The SSE subscribers — pages and the desktop app's tray connections — and the
// backpressure every frame to them is written under. See sse-clients.mjs.
import { pageCount, trayClients } from "./sse-clients.mjs";
// Exported from this file before they moved, and still.
export { MAX_CLIENT_BUFFER_BYTES, queuedBytes } from "./sse-clients.mjs";
// The built page and its assets, with the SPA fallback for everything else —
// see static-serve.mjs. The route table hands it every GET nothing above took.
import { serveStatic } from "./static-serve.mjs";
// Which sessions the deck still keeps anything for — the LRU cap, the
// transcript watch between hook events, and POST /api/forget. See
// session-tracking.mjs.
import { handleForget, outputWatch, startOutputWatch } from "./session-tracking.mjs";
// Exported from this file before it moved, and still.
export { HARD_TRACKED_SESSIONS } from "./session-tracking.mjs";
// The desktop app's update as its window sees it — the state the app reports
// and the window's answers relayed back to it. See desktop-update-routes.mjs.
import { handleDesktopUpdateRead, handleDesktopUpdateReport, handleDesktopUpdateRequest } from "./desktop-update-routes.mjs";
// The one spelling of `--workspace`, and of a rollout's cwd — see
// canonical-path.mjs. Both were exported from this file before they moved,
// and still are.
import { canonicalCwd } from "./canonical-path.mjs";
export { canonicalCwd, canonicalWorkspace } from "./canonical-path.mjs";
import { ccProjectSlug, claudeConfigDir } from "./claude-dir.mjs";
// Moved to claude-dir.mjs so the Projects rollup can read transcript folders
// without importing this file; re-exported under the name it always had.
export { ccProjectSlug };
// The Codex half of capture: the rollouts directory tailed for its events —
// see codex-watch.mjs.
import { startCodexWatcher } from "./codex-watch.mjs";
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
import { eventLogPath, logSharing, logWritableNow, openEventLog } from "./event-log.mjs";
// Exported from this file before they moved, and still.
export { logSharing, rotateCheckDue, writesLogFor } from "./event-log.mjs";
// What the deck learns about a session that its hooks never say — model,
// spend, name, recap, context — read off the transcript and sent back through
// pushEvent. Clear drops the gates on its emits. See session-enrichment.mjs.
import { clearEnrichmentGates } from "./session-enrichment.mjs";
// The readers it exported from this file before they moved, and still.
export { cachedModelId, readContextFromTranscript, readModelFromTranscript, readUsageByModelFromTranscript, readUsageFromTranscript, scanAgentsMdFiles, scanClaudeMdFiles, sessionUsageByModel, sessionUsageTotals } from "./session-enrichment.mjs";
// What a starting deck reads back out of its log, and which of those events
// are in its scope — see log-replay.mjs. Both were exported from this file
// before they moved, and still are.
import { replayLog } from "./log-replay.mjs";
export { replayLog, replayScope } from "./log-replay.mjs";
import { PRODUCT } from "./brand.mjs";
// Exported from this file before they moved, and still: the tests that pin
// them import them by this file's name.
export { MAX_SCAN_CHUNK, foldSessionNamingLine, isClaudeTranscriptPath, readAppendedLines, transcriptSessionKey } from "./transcript-scan.mjs";
// How this process is replaced or ended — the version, upgrade, restart,
// stop and presence routes, the restart latch, and the away-update that
// presses Upgrade or Restart by itself — see lifecycle.mjs. startServer arms
// it, the route table calls into it and pushEvent (event-pipeline.mjs) feeds
// its `activity`.
import { armLifecycle, handlePresence, handleRestart, handleStop, handleUpgrade, handleVersion, startAwayUpdate } from "./lifecycle.mjs";
// The launcher's two calls into the latch, exported from this file before
// they moved, and still: bin/deck.js imports them by this file's name.
export { markDeckReady, releaseRestart } from "./lifecycle.mjs";
// The settings as this process holds them, and every write that changes them —
// see prefs-state.mjs.
import { prefsRead } from "./prefs-state.mjs";
// This deck's LAN engine, what the settings may tell it, and the probe that
// asks whether other decks can reach it — see lan-deck.mjs. startServer hands
// it the prefs at boot; the settings route does after every write.
import { applyLanPrefs, resetLanLoaded } from "./lan-deck.mjs";
// The Local network panel's four routes — see lan-routes.mjs.
import { handleLanInvite, handleLanPeer, handleLanStatus, handleLanSync } from "./lan-routes.mjs";
// GET and POST /api/prefs — see prefs-routes.mjs.
import { handlePrefsRead, handlePrefsWrite } from "./prefs-routes.mjs";
import { MANIFEST_PATH, offerManifest } from "./app-manifest.mjs";
import { appendFailureStats, emptyLog } from "./log-writer.mjs";
import { historySnapshot, readProcesses, startSystemMetrics, systemSnapshot } from "./system-metrics.mjs";
// How every route reads a body and answers, and the answer for one that threw
// — see http-io.mjs. sendInternalError was exported from this file before it
// moved, and still is.
import { send, sendInternalError } from "./http-io.mjs";
export { sendInternalError };
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
// is free to be a constant — which is what every route handler that parses
// `req.url` for itself already does. Anything else unparseable answers 400
// instead.
export function requestUrl(rawUrl) {
  try { return new URL(rawUrl ?? "/", "http://localhost"); }
  catch { return null; }
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
