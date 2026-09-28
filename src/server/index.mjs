// agent-dag server: HTTP ingest + SSE broadcast + static file serving.
// This file is the startup and the route table; the handlers, and the state
// they share, live in the modules imported below.
// Pure Node HTTP server, zero deps. Nothing in this file talks to anything but
// 127.0.0.1 clients. It used to import `request` for challengeDeck, which asks
// another deck's port to prove it is the deck its discovery record describes;
// that moved to deck-probe.mjs, and the client half went with it.
import { createServer } from "node:http";
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
// The gates in front of the route table — see src/server/request-gates.mjs,
// which also holds the per-process token the strictest of them checks.
import { GUARDED_READS, OPEN_MUTATIONS, isAuthorizedDataRead, isAuthorizedMutation, isTrustedMutation, isTrustedRead } from "./request-gates.mjs";
// How much the event ring may hold and what one event is charged against it —
// see ring-bounds.mjs. The four it exported from this file, it still exports.
export { MAX_BUFFER, MAX_BUFFER_CHARS, MAX_RING_ENTRIES, payloadChars } from "./ring-bounds.mjs";
// The ring itself — what it holds, how it numbers them, and the eviction that
// keeps those bounds — private behind its operations. See event-ring.mjs.
import { eventsSince } from "./event-ring.mjs";
// Exported from this file before they moved, and still.
export { eventBufferStats, eventsSince } from "./event-ring.mjs";
// The one door every event comes through, and what it does to each on the way
// in — see event-pipeline.mjs. Imported for its effect as well as through the
// routes below: it connects pushEvent to event-sink.mjs as it loads, and the
// boot replay pushes through that sink before any route has run.
import "./event-pipeline.mjs";
// POST /api/event, GET /events and GET /api/events — see event-routes.mjs.
import { handleEventIngest, handleSse, writeJsonArray } from "./event-routes.mjs";
// Exported from this file before it moved, and still.
export { writeJsonArray };
// GET and POST /api/clear — see clear-route.mjs.
import { handleClear, handleClearPreview } from "./clear-route.mjs";
// GET /api/health — see health-route.mjs.
import { handleHealth } from "./health-route.mjs";
// GET /api/hook-challenge, and the token it proves knowledge of — see
// hook-challenge.mjs. hookToken was exported from this file before it moved,
// and still is.
import { handleHookChallenge, hookToken } from "./hook-challenge.mjs";
export { hookToken };
// The discovery records of decks that have died, swept once at boot — see
// stale-discovery.mjs.
import { sweepStaleDiscovery } from "./stale-discovery.mjs";
// Which tree this deck captures and which CLIs it watches, set once below —
// see deck-scope.mjs.
import { deckProviders, deckWorkspace, setDeckScope } from "./deck-scope.mjs";
// The SSE subscribers — pages and the desktop app's tray connections — and the
// backpressure every frame to them is written under; see sse-clients.mjs.
// These two were exported from this file before they moved, and still are.
export { MAX_CLIENT_BUFFER_BYTES, queuedBytes } from "./sse-clients.mjs";
// The built page and its assets, with the SPA fallback for everything else —
// see static-serve.mjs. The route table hands it every GET nothing above took.
import { serveStatic } from "./static-serve.mjs";
// Which sessions the deck still keeps anything for — the LRU cap, the
// transcript watch between hook events, and POST /api/forget. See
// session-tracking.mjs.
import { handleForget, startOutputWatch } from "./session-tracking.mjs";
// Exported from this file before it moved, and still.
export { HARD_TRACKED_SESSIONS } from "./session-tracking.mjs";
// The desktop app's update as its window sees it — the state the app reports
// and the window's answers relayed back to it. See desktop-update-routes.mjs.
import { handleDesktopUpdateRead, handleDesktopUpdateReport, handleDesktopUpdateRequest } from "./desktop-update-routes.mjs";
// The one spelling of `--workspace`, and of a rollout's cwd — see
// canonical-path.mjs. Both were exported from this file before they moved,
// and still are.
export { canonicalCwd, canonicalWorkspace } from "./canonical-path.mjs";
import { ccProjectSlug } from "./claude-dir.mjs";
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
import { eventLogPath, openEventLog } from "./event-log.mjs";
// Exported from this file before they moved, and still.
export { logSharing, rotateCheckDue, writesLogFor } from "./event-log.mjs";
// What the deck learns about a session that its hooks never say — model,
// spend, name, recap, context — read off the transcript and sent back through
// pushEvent; see session-enrichment.mjs. The readers it exported from this
// file before they moved, it still exports.
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
  // Which tree and which CLIs, normalised once — see setDeckScope.
  setDeckScope({ workspace, claude, codex });
  // A boot is the one moment the file, and not the engine, is the authority on
  // the key, the pairings and the port. See lanApplyFields.
  resetLanLoaded();
  // The away-update's clock starts here — see startAwayUpdate.
  startAwayUpdate();
  // The repair a paused Claude account used to wait on a `resume` press for:
  // handed to the roster read here, by the server that is actually running,
  // rather than wired at import — see repairStaleCopyWith.
  if (deckProviders().claude) {
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
    // `deckWorkspace()`, not `workspace`: setDeckScope has normalised the
    // field above, and the replay has to answer the same question the live
    // paths answer with the same string. Passed rather than read off
    // deck-scope.mjs so replayLog states what it depends on. See replayScope.
    //
    // `deckProviders()` goes with it, and for the same reason: it gates the two
    // live capture paths a few lines down (`if (codex) startCodexWatcher`, and
    // the hook install above), and until #1004 it reached neither the replay
    // nor anything else but the health payload.
    const replayed = await replayLog(eventLogPath(), deckWorkspace(), { providers: deckProviders() });
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
    // See handleClearPreview.
    if (req.method === "GET" && url.pathname === "/api/clear") return guard(handleClearPreview(res), res);

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
