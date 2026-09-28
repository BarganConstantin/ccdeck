// How this process is replaced or ended: the version, upgrade, restart and
// stop routes, the latches that keep two asks from starting two of either, and
// the away-update that presses Upgrade or Restart by itself while nobody is
// looking.
//
// These lived in src/server/index.mjs — the latches beside startServer, the
// routes after the SSE stream, the away-update before pushEvent. They share one
// piece of state, the restart latch, which a press and the away-update both
// take, and none of them reads the ring, the SSE fan-out or the scanners; so
// they moved together and the latch stayed private. index.mjs arms them once
// per boot (armLifecycle, startAwayUpdate), routes to the five handlers, feeds
// `activity` from pushEvent, and re-exports the launcher's two calls,
// releaseRestart and markDeckReady. The bodies are unchanged.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createActivity } from "./activity.mjs";
import { AWAY_BOOT_GRACE_MS, AWAY_RECHECK_MS, AWAY_TICK_MS, awayGate, awayUpdateStep } from "./auto-update.mjs";
import { PRODUCT } from "./brand.mjs";
import { logWritableNow } from "./event-log.mjs";
import { readBody, send } from "./http-io.mjs";
import { invokedName, renameNotice } from "./invoked-as.mjs";
// The build this process runs, loaded before an install can replace it: the
// Upgrade press and the away-update wait on it, and markDeckReady starts it —
// see pinned-build.mjs.
import { pinRunningBuild } from "./pinned-build.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { createPresence } from "./presence.mjs";
import { presentsDeckToken } from "./request-gates.mjs";
// The version this process runs, read at boot by a leaf so that the LAN
// engine's card and /api/version give one answer — see running-version.mjs.
import { RUNNING_VERSION } from "./running-version.mjs";

// Resolved the way index.mjs resolves it, from a file in the same directory, so
// every lazy import below is the URL the pin has already evaluated.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Set from startServer's options. The server cannot restart itself — the
// process lifecycle belongs to the supervisor in bin/agent-dag.js, which is the
// only thing that can bring a replacement up on the same port without racing
// the dying listener. Absent (running the module directly, or under an older
// launcher), /api/restart answers 501 and the UI hides the control rather than
// offering a button that does nothing.
let _onRestart = null;
// How this process ends itself, handed down by bin/deck.js for the same reason
// _onRestart is: the server does not own the process lifecycle and must be told
// how to leave. Absent when nothing handed one down — running the module
// directly, or an embedder — and /api/shutdown then answers 501 rather than
// pretending.
let _onStop = null;
// A stop is in flight. Two sockets asking at once must not both start one, and
// the response's 'finish' and 'close' can both fire for the same request.
let _stopping = false;
// A restart is in flight. Several browser tabs watching the same deck will each
// ask; the second ask must not re-enter the shutdown.
let _restarting = false;
// Whether the launcher has finished booting — see markDeckReady. False for the
// whole window between this listener accepting its first connection and
// bin/deck.js reaching the end of its startup, which is a window /api/restart
// is reachable in and cannot answer for on its own.
let _deckReady = false;

/**
 * What this boot's launcher handed down, and the latches reset for it.
 *
 * Lifted out of startServer, which calls it first, once per boot: the restart
 * and the stop it may hand to, whether a restart would have a log to replay,
 * and the two in-flight flags and the ready flag, all back to a fresh boot's.
 */
function armLifecycle({ onRestart, onStop, persist }) {
  _onRestart = typeof onRestart === "function" ? onRestart : null;
  _onStop = typeof onStop === "function" ? onStop : null;
  _stopping = false;
  _canRestart = _onRestart != null && persist != null;
  // A new listener is a new boot, whatever a previous one had got as far as
  // reporting. Nothing but bin/deck.js ever sets this, and it does so once, at
  // the end of the startup that begins with this call.
  _deckReady = false;
}

// True only when a supervisor is listening AND the event log is being written.
// Without persistence a restart wipes the canvas irrecoverably — replayLog has
// no file to read — so the deck must not offer to do it. Whether the log is
// being written is event-log.mjs's to answer; see logWritableNow.
let _canRestart = false;

/**
 * Can this deck be restarted without losing the canvas?
 *
 * Asked at the moment of the press rather than read off a boot-time flag,
 * because the writable half of it changes while the deck runs, and in both
 * directions: a drive unmounted or a volume filled mid-session is discovered by
 * the appender, not by the probe, and so is one that comes back. See
 * logWritableNow.
 */
function canRestartNow() {
  return _canRestart && logWritableNow();
}

async function handleVersion(req, res) {
  const { versionReport } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href
  );
  // ?refresh=1 asks npm now rather than reusing the cached answer — what the
  // version chip does when clicked, for the user who has just published or is
  // wondering whether the check is working at all.
  const force = new URL(req.url, "http://localhost").searchParams.get("refresh") === "1";
  const report = await versionReport({ running: RUNNING_VERSION, pkgRoot: PKG_ROOT, force });
  // Attached here rather than inside versionReport for the same reason
  // canRestart is: the report is what this package root says about itself,
  // while both of these are facts about the process serving it — the command
  // the user typed lives in this process's environment and argv, not on disk.
  //
  // It is deliberately not folded into `name`, which is documented as the
  // package an upgrade would install and is load-bearing for the update flow.
  // The two answer different questions and give different answers: `name` is
  // read off the install on disk and is always known, while this one is the
  // command that was typed and is silent wherever it cannot be proven — every
  // Windows global install, and every `npm i -g ccdeck`, whose stub spawns the
  // deck by absolute path and leaves nothing in argv to read.
  const invoked = invokedName({ pkgRoot: PKG_ROOT });
  // The second half of that notice, computed here rather than in the browser.
  //
  // The banner needs one more fact than the name: whether typing `ccdeck` is
  // enough (a global install ships all three commands, so it already is) or
  // whether the whole answer is `npx ccdeck`. The browser used to derive that
  // from `upgradeMode`, which reads like the same question and is not — it
  // answers "may this copy install over itself", and `AGENTS_DECK_NO_INSTALL=1`
  // makes it null for EVERY shape including npx, because upgradeBlockedReason
  // tests the opt-out before it tests npx. So an npx user who opted out of
  // installs was told the global-install line and sent to a command that does
  // not exist on their machine, while the terminal row two feet away said
  // `npx ccdeck` — one fact, two surfaces, opposite answers (#363).
  //
  // renameNotice is where that fact is decided for the terminal, so it decides
  // it here too and the browser renders the string rather than a branch. No
  // `dash` argument on purpose: the glyph tier is a terminal concern, and the
  // default em dash is what a browser should get.
  const rename = renameNotice({ invoked, pkgRoot: PKG_ROOT });
  send(res, 200, {
    ...report, canRestart: canRestartNow(), invokedAs: invoked, renameFix: rename?.fix ?? null,
  });
}

// Runs `npm i -g <this deck>@latest`, and only that: the argument vector is
// fixed inside self-update.mjs — including which of the three published names
// it installs, which comes from the layout npm built rather than from the
// request. Answers immediately — progress is read back from /api/version.
async function handleUpgrade(_req, res) {
  const { startUpgrade } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href
  );
  // Every module this process will ever load, loaded BEFORE npm starts
  // rewriting the tree they come from — see pinned-build.mjs. On a deck that
  // has finished booting this settled long ago; it only waits for a press that
  // lands in the first moments of a boot, or on a server nothing marked ready.
  await pinRunningBuild();
  const out = startUpgrade({ pkgRoot: PKG_ROOT });
  send(res, out.ok ? 200 : 409, out);
}

// Restart is a two-party act: this half answers before it stops listening, so
// the caller learns it was accepted rather than losing the socket mid-reply.
//
// `{ upgrade: true }` asks for the npx variant: come back through
// `npx -y <spec>@latest` instead of re-running the files already here. Granted
// only where that is genuinely how this copy updates — the mode is decided from
// the install on disk, never from the request.
async function handleRestart(req, res) {
  if (!_onRestart) return send(res, 501, { ok: false, reason: "unsupervised" });
  // Enforced here and not only in the UI. Under --no-persist a restart destroys
  // the whole canvas — replayLog has no file to read — and a destructive act
  // must not be prevented by a hidden button alone.
  if (!_canRestart) return send(res, 409, { ok: false, reason: "no_persist" });
  // A configured log that cannot be written is the same destruction by another
  // route, and it deserves its own word: "no_persist" would tell a user who
  // passed `--history` that they had not, which is the sort of answer that
  // sends someone looking in the wrong place. See canRestartNow.
  if (!canRestartNow()) return send(res, 409, { ok: false, reason: "log_unwritable" });

  let wantUpgrade = false;
  if (req.method === "POST") {
    const body = await readBody(req, res).catch(() => null);
    try { wantUpgrade = JSON.parse(body ?? "")?.upgrade === true; } catch { /* a plain restart */ }
  }
  let mode = null;
  if (wantUpgrade) {
    const { upgradeBlock, upgradeMode, npxRestartSpec } = await import(
      pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href
    );
    if (upgradeMode(upgradeBlock(PKG_ROOT)) !== "npx" || !npxRestartSpec(PKG_ROOT)) {
      return send(res, 409, { ok: false, reason: "not_npx" });
    }
    mode = "npx";
  }

  if (_restarting) return send(res, 202, { ok: true, already: true });
  _restarting = true;
  // Accepted either way — the ask is good and the launcher holds on to it — but
  // the two are not the same event and answering 200 to both would be this
  // window's second untruth rather than its first. Between this listener
  // accepting its first connection and bin/deck.js finishing the rest of its
  // startup there is a real stretch during which a restart cannot be run yet,
  // and a caller that reads the body should be able to tell that it is waiting
  // on a boot rather than on a supervisor. See markDeckReady, and requestRestart
  // in bin/deck.js for the half that does the waiting.
  if (_deckReady) send(res, 200, { ok: true, mode });
  else send(res, 202, { ok: true, mode, booting: true, detail: "the deck is still starting up; the restart runs as soon as it has finished booting" });
  // Let the response flush before the listener goes away.
  handOffRestart(mode);
}

/**
 * Hand a restart the latch has already admitted to the launcher — from a press
 * (handleRestart, once its answer is on its way) or from the away-update
 * (awayUpdateTick). The delay is the press's: its response has to leave before
 * the listener does.
 */
function handOffRestart(mode) {
  setTimeout(() => {
    try { _onRestart(mode); }
    catch (err) {
      // This catch is where #448 lived: it released the server's half of the
      // latch and said nothing, while the launcher's half stayed set with
      // nothing left to clear it, and every later restart answered "ok" and did
      // nothing for the rest of the process's life. The launcher now owns its
      // own failures; this stays as the outer net, and it says so — one line,
      // message only, because the terminal underneath is repainted every 800ms
      // by the pulse and a stack dumped into it is a stack nobody can read.
      _restarting = false;
      console.error(`${PRODUCT}: restart request failed: ${err?.message ?? err}`);
    }
  }, 120).unref();
}

/** The other end of the latch above, for the upgrade that never happened.
 *
 * An npx upgrade is now fetched before anything is torn down, so a fetch that
 * fails leaves this process serving — with `_restarting` still set from a
 * restart that is not coming. Nothing would ever clear it: the only path that
 * did was the process ending. Every later click, from any tab, answered 202
 * "already restarting" for the rest of the deck's life. */
export function releaseRestart() {
  _restarting = false;
}

/** The launcher saying its boot is over: everything a shutdown would have to
 *  tear down now exists.
 *
 *  This server starts accepting from inside startServer, before that call has
 *  even returned to bin/deck.js — so /api/restart is answerable for the whole
 *  of the startup that follows it, which on a cold boot includes the discovery
 *  file's first fsynced write and spawning the browser. The listener cannot see
 *  any of that from here; it has to be told. Called once, from bin/deck.js.
 *
 *  Only /api/restart reads it, and only to answer honestly. Nothing is refused
 *  on the strength of it: the restart is still handed to the launcher, which
 *  holds it until it can run it (#448).
 *
 *  IT IS ALSO WHERE THE BUILD IS PINNED (#1042) — see pinned-build.mjs. After
 *  the boot, so the laziness still keeps that work off the path to the socket;
 *  and before anything can replace the tree, because `npm i -g` typed in a
 *  terminal rewrites it exactly as startUpgrade's does, and the drift path then
 *  leaves this process serving until an idle moment just the same. The promise
 *  is handed back for the test that has to know when the pin has landed;
 *  bin/deck.js has no reason to wait for it, and it never rejects. */
export function markDeckReady() {
  _deckReady = true;
  return pinRunningBuild();
}

/**
 * POST /api/shutdown — end this deck, from `ccdeck --stop`.
 *
 * THE TOKEN AND NOTHING ELSE. Every other mutating route accepts either the
 * token or the deck's own page (isAuthorizedMutation), and this one must not:
 * there is no button for it, so a page asking to end the deck is a page doing
 * something no part of this product asks it to do. Refusing the browser half
 * costs nothing and removes the whole class.
 *
 * WHY A ROUTE AND NOT A SIGNAL. Windows has none. `process.kill(pid, "SIGTERM")`
 * there is TerminateProcess: the deck stops mid-instruction, its discovery file
 * is left for the next boot to sweep, and its LAN beacon never says goodbye — so
 * every paired colleague watches it time out instead of seeing it leave. One
 * loopback POST behaves identically on all three platforms and ends in the
 * deck's own shutdown(), which closes the listener, unlinks the registration and
 * stops the beacon. The pid ladder still exists in `--stop`, as the fallback for
 * a deck too wedged to answer this.
 *
 * ANSWERED BEFORE ANYTHING IS TORN DOWN. shutdown() calls
 * server.closeAllConnections(), which would cut this very socket — so the
 * teardown is hung off the response having left rather than run beside it, and
 * the caller gets a 200 instead of a dropped connection it has to interpret.
 */
async function handleStop(req, res) {
  if (!presentsDeckToken(req?.headers ?? {})) return send(res, 401, { ok: false, reason: "unauthenticated" });
  if (!_onStop) return send(res, 501, { ok: false, reason: "no_launcher" });
  if (_stopping) return send(res, 200, { ok: true, pid: process.pid, already: true });
  _stopping = true;
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    // A throw here must still end the process: the caller has already been told
    // this deck is going, and a deck that answered "ok" and stayed up is worse
    // than one that never answered.
    try { _onStop(); } catch { process.exit(0); }
  };
  // 'finish' is the response handed to the OS; 'close' covers the caller that
  // hung up before it got there. Either one means nothing is left to flush.
  res.once("finish", leave);
  res.once("close", leave);
  send(res, 200, { ok: true, pid: process.pid });
}

// The two facts the away-update waits on (awayUpdateTick): whether a turn is
// running, fed from pushEvent, and whether a tab is being looked at, fed from
// POST /api/presence. They sat at the top of index.mjs while pushEvent was
// that file's, because pushEvent can run before the module holding it has
// finished evaluating; made here, they exist before event-pipeline.mjs's own
// body runs at all.
const activity = createActivity();
const presence = createPresence();

// ── updating while nobody is looking ────────────────────────────────────────
//
// auto-update.mjs has the why and the rules; this is the timer and the three
// effects — install, restart, npx relaunch — each through the code a press
// uses.
let _awayTry = null;
let _awayTimer = null;
let _bootedAt = Date.now();
// Until when a report that found nothing newer stands — see AWAY_RECHECK_MS.
let _awayNothingUntil = 0;

/**
 * One tick of the away-update. Returns what it did, or null.
 *
 * Every clock is the real one: presence and activity are stamped with it, and
 * the boot grace is AWAY_BOOT_GRACE_MS. This used to be exported and take the
 * grace as an argument, so a test could drive it without waiting that out; the
 * tests drive awayGate and awayUpdateStep in auto-update.mjs instead, and the
 * one caller left is the `_awayTimer` interval.
 */
async function awayUpdateTick() {
  const now = Date.now();
  if (!awayGate({
    enabled: heldPrefs.current()?.autoUpdate !== false,
    supervised: _onRestart != null && _canRestart,
    restarting: _restarting,
    sinceBootMs: now - _bootedAt,
    looking: presence.looking(now),
    busy: activity.busy(now),
    quietMs: activity.quietMs(now),
    graceMs: AWAY_BOOT_GRACE_MS,
  })) return null;
  // A standing "nothing newer", unless the clock has moved back past it.
  if (now < _awayNothingUntil && _awayNothingUntil - now <= AWAY_RECHECK_MS) return null;
  const su = await import(pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href);
  const report = await su.versionReport({ running: RUNNING_VERSION, pkgRoot: PKG_ROOT });
  if (!report.notice) {
    _awayNothingUntil = now + AWAY_RECHECK_MS;
    return null;
  }
  const step = awayUpdateStep({
    notice: report.notice, mode: report.upgradeMode,
    installing: report.upgrade?.state === "running", lastTry: _awayTry, now,
  });
  if (!step.act) return null;
  // Asked again, because the lookup above can take seconds on a slow line and
  // somebody may have sat down, or started a turn, in them.
  const again = Date.now();
  if (presence.looking(again) || activity.busy(again) || _restarting) return null;
  _awayTry = { target: step.target, at: again };
  if (step.act === "install") {
    // Pinned before npm is spawned, never after it — see pinned-build.mjs. On a
    // deck bin/deck.js has marked ready this is a promise that settled long ago.
    await pinRunningBuild();
    su.startUpgrade({ pkgRoot: PKG_ROOT });
    return step.act;
  }
  // handleRestart's own check for the npx path, for the same reason: the mode
  // comes from the install on disk, and a spec it cannot name is no relaunch.
  if (step.act === "npx" && !su.npxRestartSpec(PKG_ROOT)) return null;
  _restarting = true;
  handOffRestart(step.act === "npx" ? "npx" : null);
  return step.act;
}

/**
 * The away-update's clock. The boot grace counts from here, and the timer is
 * unref'd so it never keeps a process alive on its own. It does nothing until
 * the launcher has handed down a restart — see awayGate's `supervised`.
 *
 * Lifted out of startServer, which calls it once per boot; a second boot in the
 * same process replaces the timer rather than adding one.
 */
function startAwayUpdate() {
  _bootedAt = Date.now();
  clearInterval(_awayTimer);
  _awayTimer = setInterval(() => { awayUpdateTick().catch(() => {}); }, AWAY_TICK_MS);
  _awayTimer.unref?.();
}

/** POST {tab, looking} — a tab saying whether it is being looked at. See
 *  presence.mjs, and src/web/presence.ts for the sender. */
async function handlePresence(req, res) {
  const raw = await readBody(req, res).catch(() => null);
  let body = null;
  try { body = JSON.parse(raw ?? ""); } catch { /* handled below */ }
  if (!body || typeof body !== "object") return send(res, 400, { ok: false, reason: "bad_request" });
  const ok = presence.report(body.tab, body.looking === true, Date.now());
  return send(res, ok ? 200 : 400, { ok });
}

// What index.mjs calls besides the two exported above. Listed rather than
// marked at each declaration, so the declarations read as they did where they
// came from.
export {
  activity, armLifecycle, handlePresence, handleRestart, handleStop,
  handleUpgrade, handleVersion, startAwayUpdate,
};
