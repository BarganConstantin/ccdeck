// The terminal panel's six HTTP routes, and the wiring that hands its socket
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
// this asks tmux anything. The request gates still run first, as they do for
// every path: the two reads are in GUARDED_READS and the three POSTs are
// mutations, so what is refused there is refused whatever the flag says.
//
// THE PAGE NEVER NAMES A PANE. It names a session — an id, a provider, a
// folder — and the server works out the rest on every request
// (terminal-target.mjs): which tmux, which pane, whether the session runs at
// all. The answer the page gets is describeTarget's one sentence; the pane,
// the socket and the tmux binary go into the ticket's binding and stay in
// this process. A forged event in the ring (POST /api/event takes no
// credential) can put a session on the board; it cannot point the panel at a
// pane, because nothing the page sends is ever used as one.
//
// ERRORS ARE SENTENCES. A refusal carries `error`, one short sentence with no
// path in it — terminal-sessions.mjs writes them that way — and the deck's
// log gets what tmux actually said. "Not attachable" is not an error: open
// answers it with HTTP 200 and `{ ok: false, target }`, a state for the panel
// to draw.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { PRODUCT } from "./brand.mjs";
import { terminalOn } from "./deck-prefs.mjs";
import { readBody, send } from "./http-io.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import {
  AGENTS, checkCwd, findDeckSession, findLaunchedSession, isLaunchKey, killDeckSession, labelDeckSession, launchSession,
  listDeckSessions, pruneDeadDeckSessions, resolveAgentBin,
} from "./terminal-sessions.mjs";
import { TICKET_TTL_MS, createTicketStore, terminalBridge } from "./terminal-socket.mjs";
import { checkTargetQuery, describeTarget, resolveTarget } from "./terminal-target.mjs";
import { DECK_SOCKET, findTmux, resetTmuxCache } from "./tmux.mjs";
import { ensureManagedTmux, recentTmuxFailure, tmuxDownloadBlocked, tmuxDownloadProgress } from "./tmux-download.mjs";
import { deckDataDir } from "./deck-home.mjs";

/** Adopt's refusal while the session's own process still runs: two agents
 *  resuming one conversation would write one log from two places. The page
 *  matches on this word (terminal-api.ts STILL_RUNNING), not on a sentence. */
export const STILL_RUNNING = "still-running";

/** The bodies here are an id, a provider and a folder. A few kilobytes is far
 *  above any of them, and readBody answers 413 for anything larger. */
const BODY_LIMIT = 8 * 1024;

/** What claude attach may be handed. terminal-target's attachIdOf already
 *  holds the short id to this; it is asked again here because this is where
 *  the value becomes an argument, and an argument that starts with a dash is
 *  a flag. */
const ATTACH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** How each TerminalSessionError code is answered. A caller's mistake is a
 *  400; the machine not having what it takes is a 409, a state the panel can
 *  say; tmux failing in a way it did not explain is the deck's 500. */
const SESSION_STATUS = Object.freeze({
  "bad-agent": 400, "bad-kind": 400, "bad-cwd": 400, "bad-session-id": 400, "bad-argv": 400, "bad-name": 400, "bad-options": 400, "bad-launch-key": 400,
  "agent-missing": 409, "tmux-unavailable": 409, "exists": 409,
  "tmux-failed": 500,
});

// The tickets every route here mints and the upgrade redeems. One per
// process, like the deck's token: a restarted deck has none of the old ones,
// and a panel that reconnects asks for a new ticket first.
const TICKETS = createTicketStore();

// Sessions an adopt is resuming right now. A double click must not start two
// agents on one conversation, and resolveTarget cannot see the first one
// until its tmux session exists.
const adopting = new Set();

// Launches starting right now, by the page's key for them (launchOnce).
const launching = new Map();

/** How often the deck clears old dead sessions off its server, at most: on
 *  the first status or launch after this long. Dead panes pile up over days,
 *  not minutes, and the prune is a listing plus a kill per corpse. */
export const PRUNE_EVERY_MS = 60 * 60_000;
let lastPrune = -Infinity;

/** For tests: let the next status or launch prune again. */
export function resetPruneClock() { lastPrune = -Infinity; }

/** Start a prune of dead deck sessions if none ran for PRUNE_EVERY_MS. Not
 *  awaited: the answer the panel is waiting for never waits on cleanup. */
function maybePrune(d, tmux) {
  const now = d.now();
  if (!tmux?.ok || now - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = now;
  void Promise.resolve()
    .then(() => d.pruneDeadDeckSessions({ tmux, socket: d.deckSocket, env: d.env }))
    .catch(() => {});
}

/**
 * Everything these routes reach outside themselves, with the real ones as
 * defaults: the flag, the platform and environment, the deck's tmux socket,
 * the ticket store, tmux itself and the session and target modules (the
 * session module's launch, list, kill and label).
 * startServer passes its `terminal` option through here, which is how the
 * suite runs the routes on a tmux server of its own, or with no tmux at all.
 * The product passes nothing.
 */
export function terminalDeps(overrides = {}) {
  const d = {
    enabled: () => terminalOn(heldPrefs.current()),
    platform: process.platform,
    env: process.env,
    deckSocket: DECK_SOCKET,
    tickets: TICKETS,
    findTmux: null,
    resolveTarget,
    launchSession,
    listDeckSessions,
    killDeckSession,
    labelDeckSession,
    pruneDeadDeckSessions,
    now: Date.now,
    claudeBin: null,
    isDir,
    home: homedir,
    ttySize: null,
    openControl: null,
    // ccdeck's own tmux, for a machine with none (tmux-download.mjs).
    downloadBlocked: null,
    downloadTmux: null,
    downloadProgress: tmuxDownloadProgress,
    recentDownloadFailure: recentTmuxFailure,
    forgetTmux: resetTmuxCache,
    ...(overrides ?? {}),
  };
  d.downloadBlocked ??= () => tmuxDownloadBlocked({ env: d.env, platform: d.platform });
  // Into the folder tmuxCandidates looks in, which is decided by the same env.
  d.downloadTmux ??= () => ensureManagedTmux({ env: d.env, platform: d.platform, dataDir: deckDataDir(d.platform, d.env) });
  d.findTmux ??= () => findTmux({ env: d.env, platform: d.platform });
  d.claudeBin ??= () => resolveAgentBin("claude", { env: d.env, platform: d.platform });
  d.ttySize ??= (tty) => ttySize(tty, d.platform);
  return d;
}

/**
 * What terminal-socket's installTerminalUpgrade needs from this side: the
 * flag, the ticket store the routes mint into, and the bridge for a socket it
 * admitted. Same `overrides` as terminalDeps.
 */
export function terminalUpgradeOptions(overrides = {}) {
  const d = terminalDeps(overrides);
  return {
    enabled: () => d.enabled(),
    tickets: d.tickets,
    openBridge: (ctx) => {
      const bridge = terminalBridge(d.openControl ? { ...ctx, open: d.openControl } : ctx);
      if (ctx.binding?.kind !== "D") return bridge;
      const gone = showWrapper(ctx.binding, d);
      return {
        ...bridge,
        closed: (...args) => {
          try { return bridge.closed(...args); } finally { gone(); }
        },
      };
    },
  };
}

/**
 * THE WRAPPER GOES WHEN THE LAST PANEL ON IT DOES. Every view of a background
 * session shares one pty, and it takes the size of whichever `claude attach`
 * came last; a wrapper left attached went on holding the session at the
 * stage's size after the stage had closed, so the user's own `claude agents`
 * drew it for a width it did not have — words run together, lines broken
 * mid-word — until they resized their window. So a wrapper no panel shows is
 * closed, and the session goes back to the views still on it. After a grace:
 * a reopen closes one socket and then opens the next, and should find the
 * wrapper still there. The background session itself keeps running.
 */
export const WRAPPER_GRACE_MS = 3_000;
/** Wrapper name → how many panels show it, and the close waiting to happen. */
const wrappers = new Map();

function wrapperEntry(name) {
  let w = wrappers.get(name);
  if (!w) { w = { open: 0, timer: null }; wrappers.set(name, w); }
  return w;
}

/** Close `binding`'s wrapper in `ms`, unless a panel shows it by then. */
function closeWrapperIn(binding, d, ms) {
  const w = wrapperEntry(binding.target);
  clearTimeout(w.timer);
  w.timer = setTimeout(() => {
    if (wrappers.get(binding.target) !== w || w.open > 0) return;
    wrappers.delete(binding.target);
    // Already gone, or tmux would not: the next open replaces a dead one.
    try {
      void Promise.resolve(d.killDeckSession({ tmux: binding.tmux, name: binding.target, socket: binding.socket, env: d.env })).catch(() => {});
    } catch { /* see above */ }
  }, ms);
  w.timer.unref?.();
}

/** A panel now shows `binding`'s wrapper; answers the call for when it stops. */
function showWrapper(binding, d) {
  const w = wrapperEntry(binding.target);
  clearTimeout(w.timer);
  w.timer = null;
  w.open += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    w.open -= 1;
    if (w.open <= 0) closeWrapperIn(binding, d, WRAPPER_GRACE_MS);
  };
}

/** A ticket for `binding`'s wrapper was handed out: it stays while the ticket
 *  can still be redeemed, and goes after it if no panel ever opened. */
function holdWrapper(binding, d) {
  const w = wrapperEntry(binding.target);
  if (w.open === 0) closeWrapperIn(binding, d, TICKET_TTL_MS + WRAPPER_GRACE_MS);
}

/** Forget every wrapper this process was counting; for tests. */
export function resetWrappers() {
  for (const w of wrappers.values()) clearTimeout(w.timer);
  wrappers.clear();
}

/**
 * The size of the terminal at `tty`, as `stty size` reads it, or null.
 *
 * What a wrapper for a background session starts at: the session's own pty is
 * at the size its viewers gave it, and a `claude attach` at any other size
 * would take it there.
 */
export function ttySize(tty, platform = process.platform) {
  return new Promise((resolve) => {
    if (!/^\/dev\/[A-Za-z0-9/]+$/.test(String(tty ?? ""))) return resolve(null);
    execFile("stty", [platform === "linux" ? "-F" : "-f", String(tty), "size"], { timeout: 1_000 }, (err, out) => {
      const m = /^(\d+) (\d+)\s*$/.exec(String(out ?? ""));
      const rows = m ? Number(m[1]) : 0, cols = m ? Number(m[2]) : 0;
      resolve(err || !rows || !cols ? null : { cols, rows });
    });
  });
}

/**
 * The tmux half of GET /api/terminal/status, from findTmux's answer: whether
 * it works, its version, and why not with the line that installs it. Never
 * the path or the raw `-V` text — the panel needs neither, and a path is a
 * fact about the machine a page has no business holding.
 */
export function tmuxStatus(found) {
  const version = Array.isArray(found?.version) ? found.version.join(".") : "";
  return {
    ok: found?.ok === true,
    ...(version ? { version } : {}),
    ...(found?.ok === true ? {} : { reason: typeof found?.reason === "string" && found.reason ? found.reason : "missing" }),
    ...(typeof found?.warning === "string" && found.warning ? { warning: found.warning } : {}),
    ...(typeof found?.install === "string" && found.install ? { install: found.install } : {}),
  };
}

/**
 * GET /api/terminal/status → `{ ok: true, platform, tmux }`.
 *
 * With no usable tmux, the first ask starts fetching ccdeck's own build
 * (tmux-download.mjs) and answers `reason: "installing"`, with `progress` once
 * the download has said how far it is; the panel asks again until it is `ok`. A download that failed is answered for RETRY_AFTER_MS as
 * the plain missing or too-old state with `download: <why>`, so the panel can
 * offer the install line instead, and is tried again after that.
 */
export async function handleTerminalStatus(req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  const found = await d.findTmux();
  const fixable = !found?.ok && (found?.reason === "missing" || found?.reason === "too-old");
  if (fixable && !d.downloadBlocked()) {
    const failed = d.recentDownloadFailure();
    if (failed) return send(res, 200, { ok: true, platform: d.platform, tmux: { ...tmuxStatus(found), download: failed.reason } });
    // Not awaited: a download is seconds, a status is answered now. The
    // answer it remembers is forgotten when the build lands, so the next ask
    // finds it.
    void d.downloadTmux().then((r) => { if (r?.ok) d.forgetTmux(); });
    const progress = d.downloadProgress();
    return send(res, 200, { ok: true, platform: d.platform, tmux: { ok: false, reason: "installing", ...(progress ? { progress } : {}) } });
  }
  maybePrune(d, found);
  return send(res, 200, { ok: true, platform: d.platform, tmux: tmuxStatus(found) });
}

/** GET /api/terminal/target?session=&provider=&cwd= → `{ ok: true, target }`,
 *  where target is describeTarget's answer. */
export async function handleTerminalTarget(req, res, url, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  const q = checkTargetQuery({
    sessionId: url?.searchParams.get("session") ?? "",
    provider: url?.searchParams.get("provider") ?? "",
    cwd: url?.searchParams.get("cwd") ?? "",
  });
  if (!q.ok) return send(res, 400, { ok: false, error: q.error });
  const { target } = await locate(q, d);
  return send(res, 200, { ok: true, target: describeTarget(target) });
}

/**
 * POST /api/terminal/claim `{ key, sessionId, provider, cwd }` → `{ ok: true,
 * claimed, target }`: whether the session runs in the pane the page launched
 * under `key` — and, when it does, that pane is labelled with its id.
 *
 * A Codex chooses its own id once it starts writing, so the launch route
 * cannot name it; the page asks this of each new Codex the board hears of
 * while the stage shows the launch (codex-launch.ts). Only the deck can tell
 * two of them apart, and it says yes or no, never which pane. The label is
 * what keeps the next launch in the same folder recognisable: an unlabelled
 * pane is one more that the next session could have begun in
 * (terminal-target's launchedCodexPane), and the stage keeps the connection
 * it has, so no open comes along to write it.
 */
export async function handleTerminalClaim(req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  const body = await jsonBody(req, res);
  if (!body) return send(res, 400, { ok: false, error: "The request did not name a session." });
  if (!isLaunchKey(body.key)) return send(res, 400, { ok: false, error: "The launch's key is not one the deck can keep." });
  const q = checkTargetQuery(body);
  if (!q.ok) return send(res, 400, { ok: false, error: q.error });
  try {
    const { tmux, target } = await locate(q, d);
    const claimed = target.kind === "A" && target.launchKey === body.key;
    if (claimed) await learn(target, tmux, d);
    return send(res, 200, { ok: true, claimed, target: describeTarget(target) });
  } catch (err) {
    return sessionFailure(res, err);
  }
}

/**
 * POST /api/terminal/open `{ sessionId, provider, cwd }`.
 *
 * A session in a deck pane (A) or in the user's own tmux (B) is answered with
 * a ticket for that pane. A Claude background session (D) is reached through
 * a deck pane running `claude attach` — the live one for that session when
 * there is one, else a new one — and the ticket is for that pane. Anything
 * else is `{ ok: false, target }` with HTTP 200: not attachable is a state.
 */
export async function handleTerminalOpen(req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  const body = await jsonBody(req, res);
  if (!body) return send(res, 400, { ok: false, error: "The request did not name a session." });
  const q = checkTargetQuery(body);
  if (!q.ok) return send(res, 400, { ok: false, error: q.error });
  try {
    const { tmux, target } = await locate(q, d);
    let binding;
    if (target.kind === "A") {
      await learn(target, tmux, d);
      binding = { kind: "A", socket: target.socket, target: target.name, pane: target.pane, ignoreSize: false };
    } else if (target.kind === "B") {
      // The user's own tmux: their terminal owns the pane's size, and the
      // panel joins it at that size rather than resizing it under them.
      binding = { kind: "B", socket: target.socket, target: target.pane, pane: target.pane, ignoreSize: true };
    } else if (target.kind === "D") {
      // Joined at the size the wrapper started at, which is the session's:
      // the panel never resizes it, since the session's other views would be
      // drawn at whatever size it took (see WRAPPER_GRACE_MS).
      const wrapper = target.wrapper ?? await attachWrapper(q, target, tmux, d);
      binding = { kind: "D", socket: d.deckSocket, target: wrapper.name, pane: wrapper.pane, ignoreSize: true };
    } else if (target.kind === "gone" && target.deadSessions?.length) {
      // An ended session whose deck pane is still there under remain-on-exit:
      // its last frame is the most useful thing the stage can show, so the
      // panel attaches to that pane and the bridge seeds it and says `ended`
      // at once — the frozen frame with "Reopen here" under it, instead of a
      // sentence over an empty stage. The newest pane is the latest word on
      // the conversation. Read-only, because nothing typed reaches a dead
      // pane; at the pane's own size, because resizing it would only cut the
      // frame it kept.
      const newest = target.deadSessions[target.deadSessions.length - 1];
      binding = { kind: "A", socket: d.deckSocket, target: newest, ignoreSize: true, readOnly: true };
    } else {
      return send(res, 200, { ok: false, target: describeTarget(target) });
    }
    const ticket = mint(d, req, tmux, binding);
    if (binding.kind === "D") holdWrapper({ ...binding, tmux }, d);
    return send(res, 200, { ok: true, ticket, target: describeTarget(target) });
  } catch (err) {
    return sessionFailure(res, err);
  }
}

/**
 * POST /api/terminal/adopt `{ sessionId, provider, cwd }`: reopen a session
 * that ended, or that was started outside the deck and has since stopped, in
 * a deck pane with `--resume` (Claude) or `resume` (Codex).
 *
 * Refused with 409 `still-running` while any process still holds the session
 * — the C case, but also A, B and D, which a panel that raced the session's
 * own start could ask about. The check is terminal-target's, with the blind
 * spot its header names: an idle plain `codex` outside the deck holds nothing
 * this can see, and reads as ended.
 *
 * The dead deck panes the session left behind are closed first (clearDead):
 * the reopened session is the one the panel shows from now on.
 */
export async function handleTerminalAdopt(req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  const body = await jsonBody(req, res);
  if (!body) return send(res, 400, { ok: false, error: "The request did not name a session." });
  const q = checkTargetQuery(body);
  if (!q.ok) return send(res, 400, { ok: false, error: q.error });
  if (!q.cwd) return send(res, 400, { ok: false, error: "The project folder has to be a full path." });
  if (adopting.has(q.sessionId)) return send(res, 409, { ok: false, error: "This session is already being reopened." });
  adopting.add(q.sessionId);
  try {
    const { tmux, target } = await locate(q, d);
    if (["A", "B", "C", "D"].includes(target.kind)) return send(res, 409, { ok: false, error: STILL_RUNNING });
    if (target.kind !== "gone" || !target.adoptable) {
      const said = describeTarget(target);
      return send(res, 409, { ok: false, error: said.label, ...(said.install ? { install: said.install } : {}) });
    }
    await clearDead(target, tmux, d);
    const started = await d.launchSession({
      tmux, agent: q.provider, kind: "resume", sessionId: q.sessionId, cwd: q.cwd,
      // At the panel's size and in its colours from its first frame (see
      // the launch below).
      cols: body.cols, rows: body.rows, colours: body.colours ?? null,
      socket: d.deckSocket, env: d.env, platform: d.platform,
    });
    const opened = { kind: "A", socket: d.deckSocket, pane: started.pane, name: started.name };
    const ticket = mint(d, req, tmux, { kind: "A", socket: d.deckSocket, target: started.name, pane: started.pane, ignoreSize: false });
    return send(res, 200, { ok: true, ticket, target: describeTarget(opened) });
  } catch (err) {
    return sessionFailure(res, err);
  } finally {
    adopting.delete(q.sessionId);
  }
}

/**
 * POST /api/terminal/launch `{ agent, cwd }` → `{ ok: true, sessionId, name,
 * ticket }`: a new Claude or Codex in a deck-owned tmux session, and a ticket
 * to attach to it. `sessionId` is the id the new Claude was told to use, or ""
 * for Codex, which chooses its own once it starts writing. An optional `key`,
 * the page's name for this launch, makes asking again safe (launchOnce).
 */
export async function handleTerminalLaunch(req, res, options) {
  const d = terminalDeps(options);
  if (!d.enabled()) return notFound(res);
  const body = await jsonBody(req, res);
  if (!body) return send(res, 400, { ok: false, error: "The request did not say what to start." });
  if (!AGENTS.includes(body.agent)) {
    return send(res, 400, { ok: false, error: "The deck can start Claude or Codex sessions only." });
  }
  if (body.key !== undefined && !isLaunchKey(body.key)) {
    return send(res, 400, { ok: false, error: "The launch's key is not one the deck can keep." });
  }
  try {
    // The folder before tmux: "that folder does not exist" is the answer a
    // person can act on, whether or not tmux is installed.
    await checkCwd(body.cwd);
    const tmux = await d.findTmux();
    if (!tmux?.ok) {
      const said = describeTarget({ kind: "unsupported", reason: tmux?.reason || "missing", install: tmux?.install });
      return send(res, 409, { ok: false, error: said.label, ...(said.install ? { install: said.install } : {}) });
    }
    const key = body.key ?? "";
    const started = await launchOnce(d, tmux, key, () => d.launchSession({
      tmux, agent: body.agent, cwd: body.cwd, socket: d.deckSocket, env: d.env, platform: d.platform,
      // The panel's size, so the agent draws its first screen at the size it
      // is shown at. Started at the fallback instead, Claude Code drew its
      // banner, was resized the moment the panel attached, and drew it again:
      // every launched session began with the header twice in its scrollback.
      // clampSize holds whatever arrives to a sane terminal.
      cols: body.cols, rows: body.rows,
      // And in its colours, so a program asking its terminal's background at
      // its first frame is told the deck's (terminal-sessions.mjs).
      colours: body.colours ?? null,
      options: body.options ?? null,
      ...(key ? { launchKey: key } : {}),
    }));
    const ticket = mint(d, req, tmux, { kind: "A", socket: d.deckSocket, target: started.name, pane: started.pane, ignoreSize: false });
    maybePrune(d, tmux);
    return send(res, 200, { ok: true, sessionId: started.sessionId ?? "", name: started.name, ticket });
  } catch (err) {
    return sessionFailure(res, err);
  }
}

/**
 * What a launch named `key` started, starting it with `start` only if nothing
 * has yet. A launch whose answer never reached the page — the deck restarting
 * under it, a connection dropped — leaves an agent running behind an error,
 * and Try again asks with the same key: started again, a second agent opened
 * in the same folder. The key is on the session's labels, so a restarted deck
 * finds it there; a launch still on its way here is waited for, since tmux
 * may not have labelled its session yet. No key, no lookup: every launch new.
 */
async function launchOnce(d, tmux, key, start) {
  if (!key) return start();
  let list = [];
  try { list = await d.listDeckSessions({ tmux, socket: d.deckSocket, env: d.env }); } catch { /* the launch says what is wrong */ }
  const found = findLaunchedSession(list, key);
  if (found) return { name: found.name, sessionId: found.sessionId, pane: found.pane };
  // After the listing, not before: one started while it was being read is
  // not in it.
  const running = launching.get(key);
  if (running) return running;
  const started = start();
  launching.set(key, started);
  const done = () => { if (launching.get(key) === started) launching.delete(key); };
  started.then(done, done);
  return started;
}

// ---------------------------------------------------------------------------

/** The answer index.mjs gives an /api path with no route, byte for byte. */
function notFound(res) {
  return send(res, 404, { error: "not found" });
}

/** The body as a plain object, or null for anything else. A body over the cap
 *  has already been answered 413 by readBody, and the caller's own 400 after
 *  it is a no-op in `send`, so the one null covers both. */
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

/** Find tmux, then the session. The deck's own sessions are listed on the
 *  socket the deps name, so the suite's private server stands in for the
 *  product's everywhere at once. */
async function locate(q, d) {
  const tmux = await d.findTmux();
  const target = await d.resolveTarget(q, {
    platform: d.platform,
    tmux,
    deckSocket: d.deckSocket,
    listDeckSessions: () => d.listDeckSessions({ tmux, socket: d.deckSocket, env: d.env }),
  });
  return { tmux, target };
}

/** A ticket for `binding`, with the tmux that found the pane and the page's
 *  own origin added — the socket must be opened by the page that asked. */
function mint(d, req, tmux, binding) {
  const origin = typeof req?.headers?.origin === "string" ? req.headers.origin.trim().toLowerCase() : "";
  return d.tickets.mint({ ...binding, tmux: tmux?.path, ...(origin ? { origin } : {}) });
}

/**
 * Write the id a deck pane was just recognised by into its `@ccdeck-session`
 * (terminal-target's `learnedId`): a Codex the deck launched, found by the
 * rollout its process holds open because its label was still empty. Once
 * written, the next lookup of that session is the listing alone instead of a
 * walk over every process on the machine.
 *
 * On the attach, not on GET /api/terminal/target, so the read stays a read.
 * And never the reason an attach fails: the label is a shortcut for the next
 * lookup, and a tmux that cannot set it now is asked again on the next open.
 */
async function learn(target, tmux, d) {
  if (!target.learnedId) return;
  try {
    await d.labelDeckSession({ tmux, name: target.name, sessionId: target.learnedId, socket: d.deckSocket, env: d.env });
  } catch { /* see above: a missed label costs one more process walk, no more */ }
}

/**
 * Close the dead deck panes an ended session left behind (terminal-target's
 * `deadSessions`), before it is reopened in a new one.
 *
 * remain-on-exit keeps a pane for its last frame, and every reopen would
 * otherwise add one more to the deck's server for good: once the session runs
 * again, nothing can show the old frame. killDeckSession refuses any name the
 * deck did not give, and these names came from the deck's own listing. A pane
 * that will not close is left where it is — the reopen is what was asked for,
 * and the next one tries again.
 */
async function clearDead(target, tmux, d) {
  for (const name of target.deadSessions ?? []) {
    try {
      await d.killDeckSession({ tmux, name, socket: d.deckSocket, env: d.env });
    } catch { /* see above */ }
  }
}

/**
 * The deck pane that runs `claude attach` for a background session: a new one,
 * or — when its name is taken because one is already there — that one if it is
 * alive, else a fresh one in place of the dead. One wrapper per session, by
 * name (terminal-sessions' deckSessionName), so two panels on one background
 * session share a pane instead of running two attaches.
 */
async function attachWrapper(q, target, tmux, d) {
  const bin = d.claudeBin();
  if (!bin) {
    const err = new Error("Claude Code is not installed on this machine.");
    err.code = "agent-missing";
    throw err;
  }
  // The short id terminal-target found, which is what `claude attach` takes.
  const attachId = ATTACH_ID.test(String(target.attachId ?? "")) ? target.attachId : q.sessionId.slice(0, 8);
  // At the session's own size, or `claude attach` takes the session to the
  // wrapper's (see WRAPPER_GRACE_MS). Unread, tmux's default.
  let size = null;
  try { size = target.tty ? await d.ttySize(target.tty) : null; } catch { size = null; }
  const launch = () => d.launchSession({
    tmux, agent: "claude", kind: "attach", sessionId: q.sessionId, cwd: wrapperCwd(q, d),
    argv: [bin, "attach", attachId], socket: d.deckSocket, env: d.env, platform: d.platform,
    ...(size ? { cols: size.cols, rows: size.rows } : {}),
  });
  try {
    return await launch();
  } catch (err) {
    if (err?.code !== "exists") throw err;
    const list = await d.listDeckSessions({ tmux, socket: d.deckSocket, env: d.env });
    const found = findDeckSession(list, q.sessionId, { kinds: ["attach"] });
    if (!found) throw err;
    if (!found.dead) return { name: found.name, pane: found.pane };
    // A wrapper whose `claude attach` has exited is only a frozen frame of a
    // session that is still running elsewhere; it is replaced, not reused.
    await d.killDeckSession({ tmux, name: found.name, socket: d.deckSocket, env: d.env });
    return await launch();
  }
}

/** Where the attach wrapper starts. `claude attach` does not care, so the
 *  session's own folder when it is still there, else the home directory. */
function wrapperCwd(q, d) {
  return q.cwd && d.isDir(q.cwd) ? q.cwd : d.home();
}

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** A TerminalSessionError answered as its sentence; anything else is not a
 *  state of the machine and goes on to `guard`'s 500. tmux's own words go to
 *  the deck's log, never to the page. */
/** What tmux's stderr means for the person, for the failures with a fix they
 *  can make; null for the rest. Never a path. */
export function tmuxFailureHint(stderr) {
  const t = String(stderr ?? "");
  if (/File name too long|ENAMETOOLONG/i.test(t)) return "The path to tmux's socket is too long here. Point TMUX_TMPDIR at a shorter folder and restart the deck.";
  if (/protocol version mismatch/i.test(t)) return "Another version of tmux is already running the deck's sessions. Restarting the deck after they end fixes it.";
  if (/No space left on device/i.test(t)) return "The disk is full, so tmux could not write its socket.";
  if (/Permission denied|EACCES/i.test(t)) return "tmux may not write its socket folder. Check the permissions of TMUX_TMPDIR, or /tmp.";
  return null;
}

function sessionFailure(res, err) {
  const status = typeof err?.code === "string" ? SESSION_STATUS[err.code] : undefined;
  if (!status) throw err;
  if (err.detail) console.error(`${PRODUCT}: terminal: ${err.message} (${err.detail})`);
  // tmux's own words stay in the deck's log — they carry paths, and nothing a
  // route here answers does — but the reasons a person can act on are named:
  // "tmux could not start the session" alone left "File name too long" (a
  // socket folder past the limit) in a log the reader never opens.
  const hint = typeof err.detail === "string" ? tmuxFailureHint(err.detail) : null;
  return send(res, status, { ok: false, error: err.message, code: err.code, ...(hint ? { hint } : {}) });
}
