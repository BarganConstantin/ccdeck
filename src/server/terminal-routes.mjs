// The Command Panel's eight HTTP routes the engine answers, the folder check
// and the Codex update check the deck answers itself (terminal-folder.mjs,
// codex-update.mjs), and the wiring that hands its socket to the upgrade in
// terminal-socket.mjs.
//
//   GET  /api/terminal/status     is tmux here, and new enough? No paths.
//   GET  /api/terminal/target     can this session be attached to, and how?
//   GET  /api/terminal/hosts      sessions still on an older session host
//   POST /api/terminal/open       attach: a ticket for the socket, or why not
//   POST /api/terminal/adopt      reopen a session started outside the deck, here
//   POST /api/terminal/launch     start a new agent in a deck-owned tmux session
//   POST /api/terminal/claim      is this new Codex the one a launch started?
//   POST /api/terminal/hosts/end  end the sessions on one older host, as reviewed
//   POST /api/terminal/folder     can an agent start in this folder? (the deck answers)
//   POST /api/terminal/codex-updated  did the Codex that just ended update itself? (the deck answers)
//
// And the engine's own install, which the page offers where the engine is not
// here (engine-install.mjs), under the same switch and the same gates:
//
//   GET  /api/terminal/engine               which engine is here, an install's progress
//   POST /api/terminal/engine/install       download the pinned package and install it
//   POST /api/terminal/engine/install-file  install a package file sent as the body
//   POST /api/terminal/engine/cancel        cancel a download
//   POST /api/terminal/engine/remove        remove the installed engine
//
// The two hosts routes are the Windows session host's: an engine with no
// session host answers that it cannot (`no-terminal`), which the page reads
// as nothing to show.
//
// SWITCHED OFF, THEY ARE NOT THERE. Every handler asks terminalOn first and,
// when it says no, answers exactly what index.mjs answers for an /api path
// with no route — the same status and the same body — so a deck with the
// panel off is indistinguishable from one built before it existed, and none of
// this asks anything of anyone. A POST asks again once its body is in, right
// before the engine would be asked (`answer`): a switch-off that lands while
// the body arrives is a switch-off before the request. And once more when the
// engine has answered: a switch-off that lands while it works on the question
// mints no ticket, and the page is told what was done (answeredAfterOff).
// The request gates still run first, as they do
// for every path: the three reads are in GUARDED_READS and the five POSTs are
// mutations, so what is refused there is refused whatever the switch says.
//
// THE ENGINE ANSWERS THEM. Everything HTTP stays here — the switch, the gates,
// the body under its cap, the ticket store — and each route's question goes
// to the optional local engine (`engine`, pro-engine-terminal.mjs), which
// answers the status and body the page reads. There is no other terminal
// behind it: a deck whose engine cannot take the question answers `{ ok:
// false, error, code }` (engineRefusal), 409 for a state of this machine the
// panel can say, 503 for a moment it waits out, and never serves the route
// some other way. The JS backend these routes once ran is a test's
// (terminal-js-routes.mjs, handed in as `jsBackend`); nothing here imports it.
//
// THE DECK STILL FETCHES ITS OWN TMUX. On Linux and macOS the engine runs each
// session inside the deck's own tmux server, which needs tmux 3.2 or newer,
// and many machines have none: no Mac ships one. The engine's status says so
// with `fixable`, and the deck then does what it did before the engine: it
// fetches ccdeck's own build (tmux-download.mjs: pinned SHA-256, into
// <data>/tools/tmux, the folder the engine's lookup also reads), answers
// "installing" with how far it has got, and once the build has landed tells
// the engine to look again (`terminal.forgetTmux`). That download is the one
// piece of the JS backend's tmux handling on the product's path;
// terminal-js-offpath.test.ts holds that nothing else of it is. A machine
// whose tmux is 3.2–3.5 gets the same download, behind a status that keeps
// saying that tmux works (fetchBehind): the engine says `fixable` there too,
// and moves to the build once it has landed.
//
// THE PAGE NEVER NAMES A PANE. It names a session — an id, a provider, a
// folder — and the engine works the rest out. Where its answer carries a
// ticket, the engine gives an opaque handle instead, and the ticket is minted
// here over it: the handle never reaches the page, and nothing the page sends
// is ever used as a pane.
import { backgroundInGhostty, handoffSent, rememberHandoff } from "./ghostty-handoff.mjs";
import { existsSync } from "node:fs";
import { PRODUCT } from "./brand.mjs";
import { commandPanel } from "./command-panel-engine.mjs";
import { deckDataDir } from "./deck-home.mjs";
import { terminalOn } from "./deck-prefs.mjs";
import { ENGINE_TARBALL_MAX } from "./engine-download.mjs";
import { readBody, readBytes, send } from "./http-io.mjs";
import { panelProvenance, withProvenance } from "./panel-provenance.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { engineRefusal } from "./pro-engine-terminal.mjs";
import { checkFolder } from "./terminal-folder.mjs";
import { codexReplaced, liveForOf } from "./codex-update.mjs";
import { discoverProjects } from "./project-discovery.mjs";
import { createTicketStore } from "./terminal-socket.mjs";
import {
  PREFERRED_TMUX_VERSION, TMUX_BUILD, ensureManagedTmux, managedTmuxPath, recentTmuxFailure, tmuxDownloadBlocked,
  tmuxDownloadProgress,
} from "./tmux-download.mjs";

/** The bodies here are an id, a provider and a folder. A few kilobytes is far
 *  above any of them, and readBody answers 413 for anything larger. */
const BODY_LIMIT = 8 * 1024;

// The tickets every route here mints and the upgrade redeems. One per
// process, like the deck's token: a restarted deck has none of the old ones,
// and a panel that reconnects asks for a new ticket first.
const TICKETS = createTicketStore();

/**
 * ccdeck's own tmux (tmux-download.mjs), as the status route asks about it:
 *
 *   blocked()        why no download may start here, or null: switched off
 *                    (AGENTS_DECK_NO_INSTALL=1, AGENTS_DECK_NO_DOWNLOAD=1), or
 *                    no build for this machine (Windows, an arch other than
 *                    x64 and arm64);
 *   landed()         whether the build is in its folder already;
 *   recentFailure()  the last download's failure while it is believed;
 *   out              whether a download started here is still out;
 *   progress()       how far that one has got, "checking" once its build has
 *                    landed and the engine is being told, or null;
 *   start(then)      start one unless one is out, and run `then` once its
 *                    build has landed. Never awaited, never rejects.
 *
 * The download itself is ensureManagedTmux's, shared by everyone who asks
 * while it is out. `env`, `platform` and `arch` say where it goes and which
 * build it is; `build`, `fetchImpl` and `execImpl` are for tests.
 */
export function ownTmux({
  env = process.env, platform = process.platform, arch = process.arch, build = TMUX_BUILD, fetchImpl, execImpl,
} = {}) {
  const dataDir = () => deckDataDir(platform, env);
  let out = null; // { landed }
  return Object.freeze({
    blocked: () => tmuxDownloadBlocked({ env, platform, arch, build }),
    landed: () => existsSync(managedTmuxPath(dataDir(), build)),
    recentFailure: () => recentTmuxFailure(),
    get out() { return out !== null; },
    progress: () => (out ? tmuxDownloadProgress() ?? (out.landed ? { stage: "checking" } : null) : null),
    start(then) {
      if (out) return;
      const run = { landed: false };
      out = run;
      void ensureManagedTmux({
        env, platform, arch, build, dataDir: dataDir(),
        ...(fetchImpl ? { fetchImpl } : {}), ...(execImpl ? { execImpl } : {}),
      })
        .then(async (r) => {
          if (!r?.ok) return;
          run.landed = true;
          await then();
        })
        .catch(() => {})
        .finally(() => { if (out === run) out = null; });
    },
  });
}

/** The deck's own: the default `ownTmux` of the routes below. */
const OWN_TMUX = ownTmux();

/**
 * Everything these routes reach outside themselves, with the real ones as
 * defaults: the switch, the ticket store and the engine. startServer passes
 * its `terminal` option through here; the product passes nothing.
 *
 * `engine` is the optional local engine's terminal, as engineTerminals in
 * pro-engine-terminal.mjs builds it for a client. The deck's own is the
 * Command Panel's (command-panel-engine.mjs), which looks for an engine only
 * once a route asks it — so only with the switch on. A caller may hand
 * another; with none, or one that is switched off, every route answers that
 * the engine is not installed and nothing is asked of it.
 *
 * `jsBackend` is TESTS ONLY: the JS backend (terminal-js-routes.mjs'
 * jsTerminalBackend), which a test hands startServer to run the routes on a
 * tmux of its own — the parity oracle the engine is checked against. Nothing
 * the deck runs imports it, so no setting, variable, flag or request can turn
 * it on; when it is there, it answers in the engine's place.
 *
 * `provenance` is the deck's record of the sessions its panel started
 * (panel-provenance.mjs): told of each launch, adopt and claim the engine
 * answers, and asked for the provenance a case C target carries. Never asked
 * whether anything may be done.
 *
 * `ownTmux` is ccdeck's own tmux download (ownTmux above), which a status the
 * engine calls `fixable` runs (withOwnTmux). A test hands one that fetches
 * from a stand-in, never from the network.
 */
export function terminalDeps(overrides = {}) {
  return {
    enabled: () => terminalOn(heldPrefs.current()),
    tickets: TICKETS,
    engine: commandPanel,
    provenance: panelProvenance,
    ownTmux: OWN_TMUX,
    jsBackend: null,
    ...(overrides ?? {}),
  };
}

/**
 * What terminal-socket's installTerminalUpgrade needs from this side: the
 * switch, the ticket store the routes mint into, and the engine. A test's JS
 * backend adds its bridge, for the tickets it minted. Same `overrides` as
 * terminalDeps.
 */
export function terminalUpgradeOptions(overrides = {}) {
  const d = terminalDeps(overrides);
  return {
    enabled: () => d.enabled(),
    tickets: d.tickets,
    ...(d.engine ? { engine: d.engine } : {}),
    ...(d.jsBackend ? { openBridge: d.jsBackend.openBridge(d) } : {}),
  };
}

/** GET /api/terminal/status → `{ ok: true, platform, tmux }`, or why not. */
export async function handleTerminalStatus(req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  return answer(d, req, res, "status", null);
}

/** Guarded, bounded suggestions from this user's working folders. */
export async function handleTerminalProjects(_req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  if (!d.jsBackend && d.engine?.enabled !== true) {
    const { status, body } = engineRefusal("not-installed");
    return send(res, status, body);
  }
  const result = await (d.discoverProjects ?? discoverProjects)();
  if (!d.enabled()) return notFound(res);
  return send(res, 200, { ok: true, ...result });
}

/** GET /api/terminal/target?session=&provider=&cwd= → `{ ok: true, target }`. */
export async function handleTerminalTarget(req, res, url, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  const query = {
    sessionId: url?.searchParams.get("session") ?? "",
    provider: url?.searchParams.get("provider") ?? "",
    cwd: url?.searchParams.get("cwd") ?? "",
  };
  return answer(d, req, res, "target", query);
}

/** GET /api/terminal/hosts → `{ ok: true, hosts, launchesRefused }`: the
 *  older session hosts still running sessions, each `{ generation, state,
 *  sessions }`, and why new sessions are refused while they run, or null. */
export async function handleTerminalHosts(req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  return answer(d, req, res, "hosts", null);
}

/** POST /api/terminal/hosts/end `{ generation, sessions }` → `{ ok: true,
 *  ended }`: end exactly the sessions the reader reviewed on that host. 409
 *  `consent-outdated` when its sessions changed since, `host-gone` when it no
 *  longer runs. */
export async function handleTerminalEndHosts(req, res, options) {
  return posted(req, res, options, "endHosts");
}

/** POST /api/terminal/claim `{ key, sessionId, provider, cwd }` → `{ ok: true,
 *  claimed, target }`: whether the session runs in the pane the page launched
 *  under `key`. */
export async function handleTerminalClaim(req, res, options) {
  return posted(req, res, options, "claim");
}

/** POST /api/terminal/open `{ sessionId, provider, cwd, cols?, rows?, colours?
 *  }` → a ticket, or `{ ok: false, target }` with HTTP 200: not attachable is
 *  a state. The optional pane size and colours are adopt's, passed on as they
 *  came: when the engine opens the session by starting a client, the client
 *  starts at that size and in those colours. */
export async function handleTerminalOpen(req, res, options) {
  return posted(req, res, options, "open");
}

/** POST /api/terminal/adopt `{ sessionId, provider, cwd }`: reopen an ended
 *  session in a deck pane. 409 `still-running` while its process lives. */
export async function handleTerminalAdopt(req, res, options) {
  return posted(req, res, options, "adopt");
}

// Moves being asked right now, by session: one at a time each.
const backgroundRequests = new Set();

/** backgroundInGhostty's answer, or a stand-in's plain boolean, as `{ ok, reason }`. */
function backgroundOutcome(value) {
  if (value === true || (value && typeof value === "object" && value.ok === true)) return { ok: true };
  const reason = value && typeof value === "object" && typeof value.reason === "string" ? value.reason : "failed";
  return { ok: false, reason };
}

/** A local request to use Claude's background shortcut on its exact Ghostty surface.
 *  With `check: true` it sends nothing and answers `{ ok: true, movable }`, with
 *  `reason` when it is not: whether the same request without `check` could be
 *  made. The pane offers the move only when `movable` is true.
 *
 *  Without `check`: 200 `{ ok: true }` once Ghostty took the shortcut, or 409
 *  `{ ok: false, reason }` (ghostty-handoff.mjs names the reasons). A move
 *  already sent for the session answers `already-sent` and sends nothing until
 *  its continued session is found or HANDOFF_SENT_FOR passes; one still being
 *  asked answers the same. */
export async function handleTerminalBackground(req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) {
    return send(res, 403, { ok: false });
  }
  const body = await jsonBody(req, res);
  if (res.headersSent) return;
  if (!d.enabled()) return notFound(res);
  if (body?.provider !== "claude" || typeof body.cwd !== "string" || !body.cwd.startsWith("/") ||
      typeof body.sessionId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.sessionId)) {
    return send(res, 400, { ok: false });
  }
  const session = { sessionId: body.sessionId.toLowerCase(), provider: "claude", cwd: body.cwd };
  const background = d.background ?? backgroundInGhostty;
  // The engine's word first: only a session in a terminal of its own (C) is
  // Ghostty's to move.
  const external = async () => {
    if (d.engine?.enabled !== true) return { ok: false, reason: "failed" };
    const answer = await d.engine.route("target", session);
    return answer.status === 200 && answer.body?.target?.kind === "C" ? { ok: true } : { ok: false, reason: "not-ghostty" };
  };
  if (body.check === true) {
    let outcome = await external();
    if (outcome.ok) outcome = backgroundOutcome(await background(session, { enabled: d.enabled, check: true }));
    return send(res, 200, outcome.ok ? { ok: true, movable: true } : { ok: true, movable: false, reason: outcome.reason });
  }
  if (handoffSent(session.sessionId) || backgroundRequests.has(session.sessionId)) {
    return send(res, 409, { ok: false, reason: "already-sent" });
  }
  backgroundRequests.add(session.sessionId);
  try {
    let outcome = await external();
    if (outcome.ok) outcome = backgroundOutcome(await background(session, { enabled: d.enabled }));
    if (outcome.ok) rememberHandoff(session.sessionId);
    return send(res, outcome.ok ? 200 : 409, outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason });
  } finally {
    backgroundRequests.delete(session.sessionId);
  }
}

/** POST /api/terminal/launch `{ agent, cwd, key? }` → `{ ok: true, sessionId,
 *  name, ticket }`. The key makes asking again safe: one agent per key. */
export async function handleTerminalLaunch(req, res, options) {
  return posted(req, res, options, "launch");
}

/** POST /api/terminal/folder `{ cwd }` → `{ ok: true, cwd }`, or `{ ok: false,
 *  code }` with why an agent could not start there (terminal-folder.mjs). The
 *  New session picker's question before a launch; answered here, by the deck,
 *  since it is about this machine's folders and not a terminal's. */
export async function handleTerminalFolder(req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  let raw;
  try { raw = await readBody(req, res, BODY_LIMIT); } catch { return; } // answered 413 already
  // Off while the body came in: the route is not there.
  if (!d.enabled()) return notFound(res);
  // As the engine's own routes: a deck with no engine to start an agent has
  // no folder to check for one, and says so in the same words and bytes
  // (pro-engine-routes-off.test.ts), before it reads the question.
  if (!d.jsBackend && d.engine?.enabled !== true) {
    const { status, body } = engineRefusal("not-installed");
    return send(res, status, body);
  }
  let cwd = null;
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === "object" && typeof body.cwd === "string") cwd = body.cwd;
  } catch {}
  if (cwd === null) return send(res, 400, { ok: false, code: "bad-request" });
  return send(res, 200, await (d.checkFolder ?? checkFolder)(cwd));
}

/** POST /api/terminal/codex-updated `{ liveForMs }` → `{ ok: true, updated }`:
 *  whether the codex the deck starts was replaced while the pane that just
 *  ended was live, `liveForMs` being how long it was (codex-update.mjs). The
 *  pane asks when a Codex it watched exits with status 0, to tell Codex's own
 *  "Update now" from /exit and start the new version in its place. Answered
 *  here, by the deck, behind the folder check's switch, gates and cap; a body
 *  with no duration in it is 400 `bad-request`, which the page reads as no. */
export async function handleTerminalCodexUpdated(req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  let raw;
  try { raw = await readBody(req, res, BODY_LIMIT); } catch { return; } // answered 413 already
  if (!d.enabled()) return notFound(res);
  // A deck with no engine has no pane a Codex ran in, and says nothing new
  // about this machine: the same words and bytes as every route here.
  if (!d.jsBackend && d.engine?.enabled !== true) {
    const { status, body } = engineRefusal("not-installed");
    return send(res, status, body);
  }
  let liveForMs = null;
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === "object") liveForMs = liveForOf(body.liveForMs);
  } catch {}
  if (liveForMs === null) return send(res, 400, { ok: false, code: "bad-request" });
  const updated = await (d.codexReplaced ?? codexReplaced)(liveForMs);
  return send(res, 200, { ok: true, updated: updated === true });
}

/** GET /api/terminal/engine → `{ ok: true, engine }`: the engine's install
 *  state on this machine (engine-install.mjs' status, never the network), or
 *  null for an engine handed in by a caller, which has no installer. */
export async function handleEngineStatus(req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  const installer = d.engine?.installer;
  return send(res, 200, { ok: true, engine: installer ? await installer.status() : null });
}

const ENGINE_ACTIONS = new Set(["install", "install-file", "cancel", "remove"]);

/** POST /api/terminal/engine/<action> → `{ ok: true, id? }`, or 409 `{ ok:
 *  false, code }` naming why not (engine-install.mjs). `install-file` takes
 *  the package file as the body, up to the size a download may be. */
export async function handleEngineAction(req, res, action, options) {
  const d = terminalDeps(options);
  if (!d.enabled() || !ENGINE_ACTIONS.has(action)) return notFound(res);
  let bytes = null;
  try {
    if (action === "install-file") bytes = await readBytes(req, res, ENGINE_TARBALL_MAX, { ok: false, code: "too-large" });
    else await readBody(req, res, BODY_LIMIT);
  } catch {
    return; // answered 413 already
  }
  // Off while the body came in: the route is not there.
  if (!d.enabled()) return notFound(res);
  const installer = d.engine?.installer;
  if (!installer) return send(res, 409, { ok: false, code: "unavailable" });
  const out = action === "install" ? await installer.install()
    : action === "install-file" ? await installer.installFile(bytes)
      : action === "cancel" ? installer.cancel()
        : await installer.remove();
  return send(res, out.ok ? 200 : 409, out);
}

// ---------------------------------------------------------------------------

/** A POST route: the switch, then the body under its cap, then the answer. */
async function posted(req, res, options, method) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  const body = await jsonBody(req, res);
  return answer(d, req, res, method, body);
}

/** The routes that only ask: answered after the switch-off, they changed nothing. */
const READS = new Set(["status", "target", "hosts"]);
/** The routes that start an agent: the deck notes each before the engine is asked. */
const LAUNCHES = new Set(["launch", "adopt"]);

/** The answer index.mjs gives an /api path with no route, byte for byte. */
function notFound(res) {
  return send(res, 404, { error: "not found" });
}

/** What the page is told of a launch or an adopt the engine ran, when the switch went off before it answered. */
export const STARTED_TURNED_OFF = "The session was started, but the Command Panel was turned off in Settings. Switch it on to open the session.";
/** And of an open or a claim that went through: what an open panel is told at the switch-off (prefs-routes.mjs). */
export const REACHED_TURNED_OFF = "The Command Panel was turned off in Settings. The session is still running.";
/** And of an end of an older host's sessions that went through. */
export const ENDED_TURNED_OFF = "The sessions were ended, but the Command Panel was turned off in Settings.";

/**
 * A question asked while on, answered by the engine after the switch went off. Nothing is minted — the socket
 * is refused while off — and the page is told what is now true: what a launch, an adopt, an open or a claim
 * did is not undone, so the page hears that its session runs and the panel is off (409 `turned-off`, a state
 * it shows and stops at); anything else, which changed nothing, is the 404 a request after the switch-off gets.
 */
function answeredAfterOff(res, method, said) {
  const body = said.body && typeof said.body === "object" ? said.body : {};
  const done = !READS.has(method) && said.status >= 200 && said.status < 300
    && body.ok === true && (method !== "claim" || body.claimed === true);
  if (!done) return notFound(res);
  const error = method === "launch" || method === "adopt" ? STARTED_TURNED_OFF
    : method === "endHosts" ? ENDED_TURNED_OFF : REACHED_TURNED_OFF;
  return send(res, 409, { ok: false, error, code: "turned-off" });
}

/** The body as a plain object, or null for anything else. A body over the cap
 *  has already been answered 413 by readBody, and nothing is sent after it. */
async function jsonBody(req, res) {
  let raw;
  try { raw = await readBody(req, res, BODY_LIMIT); } catch { return null; }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The route answered by the engine (or by a test's JS backend in its place).
 * `question` is the route's parsed question: the body, the query's three
 * values, or null for status.
 *
 * The engine answers `{ status, body, handle?, log? }`: the status and body
 * are sent as they are. Where the body's ticket is null and a `handle` stands
 * beside it, the ticket is minted here, in the same store, 30 s and single
 * use, bound to `{ handle, origin }` — the page's origin, as for any ticket —
 * and the upgrade relays it to the engine. The `log` line goes to the deck's
 * log, never to the page. A status it calls `fixable` runs the deck's own tmux
 * download first (withOwnTmux), or behind the answer where that status's tmux
 * works (fetchBehind). An engine that could not take the question answers
 * its refusal in the same shape (routeThroughEngine); one that failed in a way
 * that must not be asked again throws, which is `guard`'s 500.
 */
async function answer(d, req, res, method, question) {
  if (res.headersSent) return;
  // The switch again, now that the question is whole: a POST's body is read after the route's first look, and
  // the switch can go off while it arrives. Off by now, the route is not there, as for a request sent after
  // the switch-off: nothing is asked of the engine, which would otherwise run a launch the switch had already
  // closed and put off the engine's stop (command-panel-engine.mjs) with the switch off.
  if (!d.enabled()) return notFound(res);
  if (d.jsBackend) {
    // The test's tmux has no session host: what an engine without one answers.
    if (typeof d.jsBackend[method] !== "function") {
      const { status, body } = engineRefusal("no-terminal");
      return send(res, status, body);
    }
    return d.jsBackend[method](req, res, question, d);
  }
  // A launch or an adopt is noted before the engine is asked, so that one it ran and never answered (the
  // deck stopped in between) leaves its session "unknown" rather than "external" (panel-provenance.mjs).
  const engineOn = d.engine?.enabled === true;
  const ref = engineOn && d.provenance && LAUNCHES.has(method) ? d.provenance.started(method, question) : null;
  let said = engineOn ? await d.engine.route(method, question) : engineRefusal("not-installed");
  if (said.log) console.error(`${PRODUCT}: terminal: ${said.log}`);
  // What the engine did, it did whatever the switch now says: noted before the switch is asked again.
  d.provenance?.answered(method, question, ref, said.status, said.body);
  // And once more, now that the engine has answered: a question asked while on can be answered after the
  // switch-off, since the engine is stopped only once it has answered (command-panel-engine.mjs).
  if (!d.enabled()) return answeredAfterOff(res, method, said);
  if (method === "status" && fixable(said)) {
    said = await withOwnTmux(d, said);
    // It may have asked the engine again on the way: the switch once more.
    if (!d.enabled()) return answeredAfterOff(res, method, said);
  } else if (method === "status" && fixableBehind(said)) {
    fetchBehind(d);
  }
  let out = withProvenance(d.provenance, question, said.body);
  if (said.handle) {
    const origin = typeof req?.headers?.origin === "string" ? req.headers.origin.trim().toLowerCase() : "";
    out = { ...out, ticket: d.tickets.mint({ handle: said.handle, ...(origin ? { origin } : {}) }) };
  }
  return send(res, said.status, out);
}

/** The tmux states the deck's own build answers: none at all, or one older than 3.2. */
const FETCHABLE = new Set(["missing", "too-old"]);

/** Whether the engine's answer is a status it calls `fixable`: no tmux here it
 *  can use, and one the deck could fetch. Asked of the body too, so an answer
 *  that says fixable beside a tmux that works fetches nothing. */
function fixable(said) {
  const tmux = said?.body?.tmux;
  return said?.fixable === true && said.status === 200 && said.body.ok === true
    && !!tmux && typeof tmux === "object" && tmux.ok !== true && FETCHABLE.has(tmux.reason);
}

/** `said` with its body's `tmux` replaced by `tmux`. */
function withTmux(said, tmux) {
  return { ...said, body: { ...said.body, tmux } };
}

/**
 * A status the engine called `fixable`, answered as the deck answered it
 * before the engine served the panel:
 *
 *   - no download may start here (switched off, or no build for this
 *     machine): the engine's answer as it is, the install line included;
 *   - a download out: `reason: "installing"`, with `progress` once it has
 *     said, and the page asks again;
 *   - the build already in its folder: the engine may remember a miss from
 *     before it landed (this deck's, a moment ago, or another deck's), so it
 *     is told to forget it and asked once more. Still none, and the build is
 *     not fetched again — the same bytes would land in the same place, every
 *     time the page asks — but answered as the plain fact with `download:
 *     "not_used"`;
 *   - a download that failed lately (RETRY_AFTER_MS): the plain fact with
 *     `download: <why>`, so the panel offers the install line instead;
 *   - otherwise one starts, not awaited, and is answered `installing`: once
 *     its build lands the engine is told to look again (`terminal.forgetTmux`),
 *     and the page's next ask finds it.
 *
 * The deck never decides on its own that tmux is missing: only the engine's
 * `fixable` starts any of this.
 */
async function withOwnTmux(d, said) {
  const own = d.ownTmux;
  if (!own || own.blocked()) return said;
  if (!own.out) {
    if (own.landed()) {
      await d.engine.forgetTmux?.();
      const again = await d.engine.route("status", null);
      if (again.log) console.error(`${PRODUCT}: terminal: ${again.log}`);
      return fixable(again) ? withTmux(again, { ...again.body.tmux, download: "not_used" }) : again;
    }
    const failed = own.recentFailure();
    if (failed) return withTmux(said, { ...said.body.tmux, download: failed.reason });
    own.start(() => d.engine.forgetTmux?.());
  }
  const progress = own.progress();
  return withTmux(said, { ok: false, reason: "installing", ...(progress ? { progress } : {}) });
}

/** Whether the engine's answer is a status it calls `fixable` beside a tmux
 *  that works and is older than PREFERRED_TMUX_VERSION: one the engine runs
 *  only until ccdeck's own build is in place. Asked of the body too, so
 *  fixable beside a tmux that new, or one whose version it does not say,
 *  fetches nothing. */
function fixableBehind(said) {
  const tmux = said?.body?.tmux;
  if (said?.fixable !== true || said.status !== 200 || said.body?.ok !== true) return false;
  if (!tmux || typeof tmux !== "object" || tmux.ok !== true || typeof tmux.version !== "string") return false;
  const m = /^(\d+)\.(\d+)$/.exec(tmux.version);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const [pMajor, pMinor] = PREFERRED_TMUX_VERSION;
  return major < pMajor || (major === pMajor && minor < pMinor);
}

/**
 * A status the engine called `fixable` beside a tmux 3.2–3.5 that works:
 * ccdeck's own build is fetched behind it — the same download as for a
 * machine with none — and the answer is sent as it is. Nothing tells the page:
 * the tmux it has keeps working meanwhile, so there is no "installing", and a
 * download that fails is no news either (offline, the older tmux simply
 * stays). Once the build lands the engine is told to look again
 * (`terminal.forgetTmux`), and moves to it unless the deck's server still runs
 * sessions under the older tmux. Nothing starts where no download may, while
 * one is out, for a build already in place — the engine knows it is there,
 * and keeps the older tmux for its sessions — or for RETRY_AFTER_MS after one
 * failed. Never awaited, never rejects.
 */
function fetchBehind(d) {
  const own = d.ownTmux;
  if (!own || own.blocked() || own.out || own.landed() || own.recentFailure()) return;
  own.start(() => d.engine.forgetTmux?.());
}
