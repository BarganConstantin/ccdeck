// The one place the deck makes the Command Panel's engine: the optional local
// engine, started for the panel only once somebody has switched the panel on
// and asked it something, on the one platform it runs on.
//
// NOTHING HAPPENS UNTIL A ROUTE ASKS. Importing this does no I/O. The routes
// (terminal-routes.mjs) ask only while the panel's switch is on — with it off
// they are a 404 and never get here — so a deck with the switch off, the
// default, never looks at the install folder, never builds a client, never
// starts anything and never touches the network. Off Linux, a route is
// answered `unsupported` without looking either.
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
import { promises as fsp } from "node:fs";
import { join } from "node:path";
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

/** Whether `platform` has the Command Panel: Linux only, in this release. */
export function commandPanelSupported(platform = process.platform) {
  return platform === "linux";
}

/** The one folder the Command Panel's engine is installed in. */
export function engineInstallDir(platform = process.platform, env = process.env) {
  return join(deckDataDir(platform, env), "engine");
}

/**
 * The Command Panel's engine as the routes and the upgrade take it (the shape
 * engineTerminals gives, with `route` answering a refusal of its own while
 * there is no client), plus `switchedOff()` and `stop()`.
 *
 * `platform`, `env`, `keys`, `lstat`, `createClient` and `graceMs` are there
 * for tests; the deck uses the defaults (`commandPanel`, below).
 */
export function commandPanelEngine({
  platform = process.platform,
  env = process.env,
  keys = ENGINE_PUBLIC_KEYS,
  lstat = (path) => fsp.lstat(path),
  createClient = createProEngineClient,
  graceMs = STOP_GRACE_MS,
} = {}) {
  let held = null; // { client, terminals }
  let making = null; // the question that is making it, so two make one
  let stopping = null;
  // Counts stops: a client being made when one came is not made after it.
  let stops = 0;

  const cancelStop = () => {
    clearTimeout(stopping);
    stopping = null;
  };

  /** The engine's terminals, or why there is none. */
  async function ready() {
    if (!commandPanelSupported(platform)) return { refusal: "unsupported" };
    if (held) return held;
    making ??= (async () => {
      const directory = engineInstallDir(platform, env);
      const at = stops;
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
      held = { client, terminals: engineTerminals(client) };
      return held;
    })().finally(() => { making = null; });
    return making;
  }

  function drop() {
    const was = held;
    held = null;
    stops += 1;
    if (was) was.client.close().catch(() => {});
  }

  return Object.freeze({
    get enabled() { return true; },
    async route(method, body) {
      cancelStop();
      const r = await ready();
      return r.refusal ? engineRefusal(r.refusal) : r.terminals.route(method, body);
    },
    async attach(handle, socket) {
      // A ticket outlives nothing: with no engine there is nothing it names.
      return held ? held.terminals.attach(handle, socket) : { ok: false, status: 503 };
    },
    /** The switch went off: stop the engine once its panels have closed —
     *  one running, or one a question asked while on is making now, which
     *  is stopped the same grace later (or, made after it, not made). */
    switchedOff() {
      if ((!held && !making) || stopping) return;
      stopping = setTimeout(() => { stopping = null; drop(); }, graceMs);
      stopping.unref?.();
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
