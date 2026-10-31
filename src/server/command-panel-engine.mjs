// The one place the deck makes the Command Panel's engine: the optional local
// engine, started for the panel only once somebody has switched the panel on
// and asked it something, on the platforms it runs on (Linux and macOS).
//
// NOTHING HAPPENS UNTIL A ROUTE ASKS. Importing this does no I/O. The routes
// (terminal-routes.mjs) ask only while the panel's switch is on — with it off
// they are a 404 and never get here — so a deck with the switch off, the
// default, never looks at the install folder, never builds a client, never
// starts anything and never touches the network. Off Linux and macOS (on
// Windows), a route is answered `unsupported` without looking either.
//
// SUPPORTED IS NOT SERVED. On Linux and macOS a route still goes nowhere
// unless the engine's own hello advertises a terminal backend
// (routeThroughEngine in pro-engine-terminal.mjs answers `no-terminal`
// otherwise): the engine decides, behind its own opt-in, whether it serves
// the panel on this machine.
//
// ONE FOLDER, AND ONLY KEYS SHIPPED IN THIS FILE. The engine is looked for in
// `<deck data folder>/engine` (CCDECK_HOME when set; deck-home.mjs) and
// nowhere else: not on PATH, not beside the package, never downloaded or
// installed by the deck. Its manifest must be signed by one of
// ENGINE_PUBLIC_KEYS, which is empty in this release — so a folder that is
// there answers `not-verified` without the deck reading the executable, and
// one that is not answers `not-installed`. A deck that is handed an engine by
// its caller instead (startServer's `terminal.engine`) never uses this.
//
// THE ENGINE IS TOLD IT MAY SERVE THE PANEL, and only this one. The client
// made here is the only one constructed with `terminal: true`, which is what
// sets CCDECK_ENGINE_TERMINAL=1 in the engine's environment
// (pro-engine-client.mjs); any value the deck itself inherited is removed
// first, for this engine and every other.
//
// IT STOPS WHEN THE PANEL IS SWITCHED OFF, a moment after the panels it
// served have been told (STOP_GRACE_MS, the time those panels' sockets are
// given to close), and at once when the deck shuts down. Stopping detaches
// the engine; the sessions it showed keep running. The next question after a
// stop starts a new one.
//
// NEVER UNDER A QUESTION, NEVER TWO. A question asked while on that the
// engine is still answering when the grace runs out — a launch whose tmux is
// still making its session — is answered first, and the stop follows: the
// session is made and labelled with its launch key, not left half made by an
// engine stopped under it (each question has the client's own deadline, so
// this ends). Switched back on before the stop has begun, the stop is called
// off and the engine kept. A question asked while an engine is stopping waits
// for its process to exit before the next is started (EXIT_WAIT_MS at most,
// and `restarting` after that), so two never run at once.
import { promises as fsp } from "node:fs";
import { posix as posixPath, win32 as winPath } from "node:path";
import { deckDataDir } from "./deck-home.mjs";
import { createProEngineClient } from "./pro-engine-client.mjs";
import { engineRefusal, engineTerminals } from "./pro-engine-terminal.mjs";
import { RUNNING_VERSION } from "./running-version.mjs";

/** The Ed25519 public keys an engine's manifest may be signed with, as PEM or
 *  KeyObjects. None in this release: no engine verifies yet. Frozen, so
 *  nothing at run time can add one. */
export const ENGINE_PUBLIC_KEYS = Object.freeze([]);

/** How long after the switch goes off the engine is stopped: the time a
 *  relayed panel's socket is given to close once it has been told
 *  (pro-engine-terminal.mjs' SHUTDOWN_GRACE_MS). */
export const STOP_GRACE_MS = 1_500;

/** How long a question waits for a stopped engine's process to exit before
 *  it is answered `restarting` (a moment the page waits out) rather than
 *  have a second engine started beside it. The client gives the engine a
 *  second to answer its shutdown and then ends it (pro-engine-client.mjs
 *  close); this is far above that, and is the engine's own drain, the
 *  longest it takes to go by itself. */
export const EXIT_WAIT_MS = 5_000;

/** Whether `platform` has the Command Panel: Linux and macOS, in this
 *  release; never Windows. Only where the engine's hello also advertises a
 *  terminal backend does a route reach it (`no-terminal` otherwise). */
export function commandPanelSupported(platform = process.platform) {
  return platform === "linux" || platform === "darwin";
}

/** The one folder the Command Panel's engine is installed in. Joined with
 *  `platform`'s separator, not the host's, as deckDataDir is: a bare `join`
 *  answers `\x\deck\engine` on a Windows runner for a question about Linux. */
export function engineInstallDir(platform = process.platform, env = process.env) {
  const { join } = platform === "win32" ? winPath : posixPath;
  return join(deckDataDir(platform, env), "engine");
}

/** Whether `promise` settles within `ms`. */
function settlesWithin(promise, ms) {
  let timer;
  const out = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  return Promise.race([promise.then(() => true, () => true), out]).finally(() => clearTimeout(timer));
}

/**
 * The Command Panel's engine as the routes and the upgrade take it (the shape
 * engineTerminals gives, with `route` answering a refusal of its own while
 * there is no client), plus `switchedOff()`, `switchedOn()` and `stop()`.
 *
 * `platform`, `env`, `keys`, `lstat`, `createClient`, `graceMs` and
 * `exitWaitMs` are there for tests; the deck uses the defaults
 * (`commandPanel`, below).
 */
export function commandPanelEngine({
  platform = process.platform,
  env = process.env,
  keys = ENGINE_PUBLIC_KEYS,
  lstat = (path) => fsp.lstat(path),
  createClient = createProEngineClient,
  graceMs = STOP_GRACE_MS,
  exitWaitMs = EXIT_WAIT_MS,
} = {}) {
  let held = null; // { client, terminals, asking: the questions it is answering }
  let making = null; // the question that is making it, so two make one
  // A stop asked for and not begun: its grace, then the questions it waits
  // for. Called off by a question or by the switch going on again.
  let stopping = null; // { timer }
  // The last engine stopped, until its process has exited: the next waits.
  let exiting = null;
  // Counts stops: a client being made when one came is not made after it.
  let stops = 0;

  const cancelStop = () => {
    if (stopping) clearTimeout(stopping.timer);
    stopping = null;
  };

  /** The engine's terminals, or why there is none. */
  async function ready() {
    if (!commandPanelSupported(platform)) return { refusal: "unsupported" };
    if (held) return held;
    making ??= (async () => {
      const directory = engineInstallDir(platform, env);
      const at = stops;
      // Never one beside another: the one stopped last is let go first.
      if (exiting && !(await settlesWithin(exiting, exitWaitMs))) return { refusal: "restarting" };
      try {
        await lstat(directory);
      } catch (error) {
        return { refusal: error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "not-installed" : "not-verified" };
      }
      // Nothing to verify a manifest against: the executable is never read.
      if (keys.length === 0) return { refusal: "not-verified" };
      if (at !== stops) return { refusal: "restarting" };
      const client = createClient({
        enabled: true,
        directory,
        publicKey: [...keys],
        hostVersion: RUNNING_VERSION ?? "0.0.0",
        terminal: true,
      });
      held = { client, terminals: engineTerminals(client), asking: new Set() };
      return held;
    })().finally(() => { making = null; });
    return making;
  }

  function drop() {
    const was = held;
    held = null;
    stops += 1;
    if (!was) return;
    // close() answers once the engine's process has exited (pro-engine-client.mjs).
    const gone = was.client.close().catch(() => {});
    exiting = gone;
    gone.then(() => { if (exiting === gone) exiting = null; });
  }

  /** The stop the switch-off asked for, once its grace is out: after the
   *  questions the engine is answering, unless called off meanwhile. */
  async function stopOnceAnswered(wanted) {
    while (stopping === wanted && held?.asking.size) await Promise.allSettled([...held.asking]);
    if (stopping !== wanted) return;
    stopping = null;
    drop();
  }

  return Object.freeze({
    get enabled() { return true; },
    async route(method, body) {
      cancelStop();
      const r = await ready();
      if (r.refusal) return engineRefusal(r.refusal);
      // Kept while the engine answers it: a stop waits for it (stopOnceAnswered).
      const asked = r.terminals.route(method, body);
      r.asking.add(asked);
      try {
        return await asked;
      } finally {
        r.asking.delete(asked);
      }
    },
    async attach(handle, socket) {
      // A ticket outlives nothing: with no engine there is nothing it names.
      return held ? held.terminals.attach(handle, socket) : { ok: false, status: 503 };
    },
    /** The switch went off: stop the engine once its panels have closed —
     *  one running, or one a question asked while on is making now, which
     *  is stopped the same grace later (or, made after it, not made) — and
     *  once it has answered the questions it was asked while on. */
    switchedOff() {
      if ((!held && !making) || stopping) return;
      const wanted = { timer: null };
      wanted.timer = setTimeout(() => { void stopOnceAnswered(wanted); }, graceMs);
      wanted.timer.unref?.();
      stopping = wanted;
    },
    /** The switch went on again: a stop that has not begun is called off,
     *  and the engine kept. One already stopping goes; the next question
     *  waits for its process to exit (ready). */
    switchedOn() {
      cancelStop();
    },
    /** The deck is going: stop it now, without waiting for it. */
    stop() {
      cancelStop();
      drop();
    },
    /** Whether a client is held, for tests. */
    get running() { return held !== null; },
  });
}

/** The deck's own: the default `engine` of terminal-routes.mjs. */
export const commandPanel = commandPanelEngine();

/** For bin/deck.js's shutdown, beside closeAllTerminals: never awaited. */
export function stopCommandPanelEngine() {
  commandPanel.stop();
}
