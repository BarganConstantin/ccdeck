// The Command Panel's six HTTP routes, and the wiring that hands its socket
// to the upgrade in terminal-socket.mjs.
//
//   GET  /api/terminal/status   is tmux here, and new enough? No paths.
//   GET  /api/terminal/target   can this session be attached to, and how?
//   POST /api/terminal/open     attach: a ticket for the socket, or why not
//   POST /api/terminal/adopt    reopen a session started outside the deck, here
//   POST /api/terminal/launch   start a new agent in a deck-owned tmux session
//   POST /api/terminal/claim    is this new Codex the one a launch started?
//
// SWITCHED OFF, THEY ARE NOT THERE. Every handler asks terminalOn first and,
// when it says no, answers exactly what index.mjs answers for an /api path
// with no route — the same status and the same body — so a deck with the
// panel off is indistinguishable from one built before it existed, and none of
// this asks anything of anyone. A POST asks again once its body is in, right
// before the engine would be asked (`answer`): a switch-off that lands while
// the body arrives is a switch-off before the request. The request gates still run first, as they do
// for every path: the two reads are in GUARDED_READS and the four POSTs are
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
// THE PAGE NEVER NAMES A PANE. It names a session — an id, a provider, a
// folder — and the engine works the rest out. Where its answer carries a
// ticket, the engine gives an opaque handle instead, and the ticket is minted
// here over it: the handle never reaches the page, and nothing the page sends
// is ever used as a pane.
import { PRODUCT } from "./brand.mjs";
import { commandPanel } from "./command-panel-engine.mjs";
import { terminalOn } from "./deck-prefs.mjs";
import { readBody, send } from "./http-io.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { engineRefusal } from "./pro-engine-terminal.mjs";
import { createTicketStore } from "./terminal-socket.mjs";

/** The bodies here are an id, a provider and a folder. A few kilobytes is far
 *  above any of them, and readBody answers 413 for anything larger. */
const BODY_LIMIT = 8 * 1024;

// The tickets every route here mints and the upgrade redeems. One per
// process, like the deck's token: a restarted deck has none of the old ones,
// and a panel that reconnects asks for a new ticket first.
const TICKETS = createTicketStore();

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
 */
export function terminalDeps(overrides = {}) {
  return {
    enabled: () => terminalOn(heldPrefs.current()),
    tickets: TICKETS,
    engine: commandPanel,
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

/** POST /api/terminal/claim `{ key, sessionId, provider, cwd }` → `{ ok: true,
 *  claimed, target }`: whether the session runs in the pane the page launched
 *  under `key`. */
export async function handleTerminalClaim(req, res, options) {
  return posted(req, res, options, "claim");
}

/** POST /api/terminal/open `{ sessionId, provider, cwd }` → a ticket, or `{
 *  ok: false, target }` with HTTP 200: not attachable is a state. */
export async function handleTerminalOpen(req, res, options) {
  return posted(req, res, options, "open");
}

/** POST /api/terminal/adopt `{ sessionId, provider, cwd }`: reopen an ended
 *  session in a deck pane. 409 `still-running` while its process lives. */
export async function handleTerminalAdopt(req, res, options) {
  return posted(req, res, options, "adopt");
}

/** POST /api/terminal/launch `{ agent, cwd, key? }` → `{ ok: true, sessionId,
 *  name, ticket }`. The key makes asking again safe: one agent per key. */
export async function handleTerminalLaunch(req, res, options) {
  return posted(req, res, options, "launch");
}

// ---------------------------------------------------------------------------

/** A POST route: the switch, then the body under its cap, then the answer. */
async function posted(req, res, options, method) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  const body = await jsonBody(req, res);
  return answer(d, req, res, method, body);
}

/** The answer index.mjs gives an /api path with no route, byte for byte. */
function notFound(res) {
  return send(res, 404, { error: "not found" });
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
 * log, never to the page. An engine that could not take the question answers
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
  if (d.jsBackend) return d.jsBackend[method](req, res, question, d);
  const said = d.engine?.enabled === true ? await d.engine.route(method, question) : engineRefusal("not-installed");
  if (said.log) console.error(`${PRODUCT}: terminal: ${said.log}`);
  let out = said.body;
  if (said.handle) {
    const origin = typeof req?.headers?.origin === "string" ? req.headers.origin.trim().toLowerCase() : "";
    out = { ...out, ticket: d.tickets.mint({ handle: said.handle, ...(origin ? { origin } : {}) }) };
  }
  return send(res, said.status, out);
}
