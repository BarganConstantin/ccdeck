// `ccdeck tui`: the deck's accounts and the sessions waiting on you, on one
// screen that stays up, for somebody who reached the machine over SSH.
//
// The one-shot commands (commands.js) answer and leave. This keeps the answer
// on screen and lets the next question be a key: move to an account, Enter
// switches to it, b selects what Auto-switch would pick, a turns Auto-switch on
// or off. It is a CLIENT of the running deck, as they are, and asks it through
// their own helpers — so a switch from here takes the deck's route, its store
// lock and its refusals, and a deck that is alive but silent is never switched
// behind. With no deck it reads claude-swap's store, as `ccdeck accounts` does,
// and offers to start one.
//
// What it does not do: start, attach to, resume or stop an agent. That is the
// Command Panel's, and a second way of doing it here would be a second set of
// rules to keep in step.
//
// The view and the keys are pure (src/server/tui-view.mjs) and the painting is
// a row diff over the alternate screen (src/server/tui-screen.mjs). This file is
// the rest: the readings, on a timer each, the effects a key asks for, and the
// terminal handed back on every way out — q, a signal, a closed connection, a
// throw.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import {
  EXIT, ask, autoRules, deckTrouble, load, rosterTrouble, silentDecks, switchHere, switchThroughDeck,
} from "./commands.js";
import { oneLine } from "../../src/server/cli-lines.mjs";
import { stripAnsi } from "../../src/server/term.mjs";
import { COMMAND, PKG_ROOT } from "./package.js";
import { G, LINKS, P, PROFILE, UNICODE } from "./screen.js";

/** How often each reading is taken while the screen is up. The sessions are
 *  the ones a person is waiting to see change; the roster is the deck's own
 *  cached read, which its panel polls about as often. */
export const POLL_MS = Object.freeze({ sessions: 3_000, auto: 10_000, roster: 15_000, find: 5_000 });

/** How long a deck started from here is waited for before saying it did not
 *  come up. A first run installs hooks and claude-swap before it listens. */
export const START_WAIT_MS = 90_000;

/**
 * Run the screen until q, resolving to the exit code. `deps` replaces the
 * terminal, the clock and the deck for a test: `input`, `output`, `now`,
 * `source` (see deckSource), `tone`, `g`, `unicode`, `profile`, `links`,
 * `tickMs`.
 */
export async function runTui(flags, out, deps = {}) {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  if (out.json) {
    return out.fail(EXIT.USAGE, "interactive_only", [
      `\`${COMMAND} tui\` is a screen for a person ${G.dash} \`${COMMAND} accounts --json\` and \`${COMMAND} sessions --json\` are the ones for a script`,
    ]);
  }
  if (!input.isTTY || !output.isTTY) {
    return out.fail(EXIT.USAGE, "not_a_terminal", [
      `\`${COMMAND} tui\` needs a terminal at both ends ${G.dash} \`${COMMAND} accounts\` and \`${COMMAND} sessions\` print the same thing once`,
    ]);
  }
  const view = await load("src/server/tui-view.mjs");
  const { createScreen } = await load("src/server/tui-screen.mjs");
  const { accountName, bestAccount } = await load("src/server/account-pick.mjs");
  const port = flags.port != null ? Number(flags.port) : null;
  const src = deps.source ?? deckSource(port);
  const look = {
    tone: deps.tone ?? P, g: deps.g ?? G, unicode: deps.unicode ?? UNICODE, profile: deps.profile ?? PROFILE, links: deps.links ?? LINKS,
  };
  const g = look.g;
  const clock = deps.now ?? Date.now;

  // The deck is looked for before the screen is taken, so a `--port` nobody
  // listens on is answered on the command line, the way the commands answer it.
  let deck = await src.find();
  if (!deck && port != null) {
    return out.fail(EXIT.NO_DECK, "no_deck", `no deck is listening on ${port} ${G.dash} \`${COMMAND} status\` lists them`);
  }

  let state = { ...view.initialState(), deck: deck ? { port: deck.port, version: deck.version ?? null } : null };
  const last = { roster: 0, auto: 0, sessions: 0, signin: 0, find: clock() };
  const inflight = new Set();
  const screen = createScreen(s => output.write(s));
  let done = null;

  const set = (patch) => { state = { ...state, ...patch }; };
  const tell = (tone, text) => set({ notice: view.note(tone, text, clock()) });
  const size = () => ({
    columns: Number.isInteger(output.columns) && output.columns > 0 ? output.columns : 80,
    rows: Number.isInteger(output.rows) && output.rows > 0 ? output.rows : 24,
  });
  const render = () => {
    if (done) return;
    const frame = view.tuiFrame(state, { ...size(), ...look, now: clock() });
    if (frame.top !== state.top) set({ top: frame.top });
    screen.paint(frame.lines, frame.run);
  };

  /** One reading at a time of each kind: a slow deck answers late, not twice.
   *  Timed from when it was asked, so a reading that finds the deck gone can
   *  make the next one due at once (`lost`). */
  const once = (kind, work) => async (...args) => {
    if (inflight.has(kind)) return;
    inflight.add(kind);
    last[kind] = clock();
    try { await work(...args); } catch (e) {
      if (READINGS[kind]) tell("err", `could not read ${READINGS[kind]} ${g.dash} ${e?.message ?? e}`);
    } finally {
      inflight.delete(kind);
      render();
    }
  };

  /** The deck stopped answering: back to looking for one, and to the store
   *  in the meantime. */
  const lost = () => {
    deck = null;
    set({ deck: null, auto: null, sessions: null });
    // A sign-in lives in the deck; one that stopped answering took it along.
    if (view.signinRunning(state.signin)) {
      state = view.withLogin(state, { state: "failed", error: "the deck stopped answering, and the sign-in ended with it", local: true });
    }
    last.find = 0;
    last.roster = 0;
  };

  const readRoster = once("roster", async (force = false) => {
    if (deck) {
      const r = await src.ask(deck, { path: force ? "/api/claude-accounts?refresh=1" : "/api/claude-accounts" });
      if (r.ok && r.body) {
        state = view.withRoster(state, r.body, r.body.ok ? null : [].concat(rosterTrouble(r.body)));
        set({ source: "deck", silent: [], readAt: clock() });
      } else if (r.status === 0) lost();
      else tell("err", deckTrouble(deck, r));
      return;
    }
    const silent = await src.silent();
    const roster = await src.localRoster();
    state = view.withRoster(state, roster, roster?.ok ? null : [].concat(rosterTrouble(roster)));
    set({ source: "local", silent });
  });

  const readAuto = once("auto", async () => {
    if (!deck) return;
    const r = await src.ask(deck, { path: "/api/cswap-auto" });
    if (r.ok && r.body && typeof r.body === "object") set({ auto: r.body, readAt: clock() });
    else if (r.status === 0) lost();
    else set({ auto: null });
  });

  const readSessions = once("sessions", async () => {
    if (!deck) return;
    const r = await src.ask(deck, { path: "/api/sessions", timeoutMs: 3_000 });
    if (r.ok && Array.isArray(r.body?.sessions)) {
      set({ sessions: r.body.sessions, skew: typeof r.body.now === "number" ? r.body.now - clock() : 0, readAt: clock() });
    } else if (r.status === 0) lost();
  });

  // Where the deck's sign-in is, while the page is up and the deck has one —
  // never before the start was answered, when "idle" would only mean "not yet".
  const readSignin = once("signin", async () => {
    if (!deck || !state.signin?.login) return;
    const r = await src.ask(deck, { path: "/api/claude-accounts/login" });
    if (r.ok && typeof r.body?.state === "string" && view.signinRunning(state.signin)) {
      state = view.withLogin(state, r.body);
    } else if (r.status === 0) lost();
  });

  const readAll = (force) => Promise.all([readRoster(force), readAuto(), readSessions()]);

  const lookForDeck = once("find", async () => {
    const found = await src.find();
    if (!found) return;
    deck = found;
    set({ deck: { port: found.port, version: found.version ?? null }, silent: [] });
    readAll(true);
  });

  // ── what a key asks for ──────────────────────────────────────────────────

  async function doSwitch(row) {
    // A deck that came up since the last look owns the switch now.
    if (!deck) {
      const found = await src.find();
      if (found) {
        deck = found;
        set({ deck: { port: found.port, version: found.version ?? null } });
      } else {
        const silent = await src.silent();
        if (silent.length) {
          set({ silent });
          tell("err", `the deck on ${silent.map(d => d.port).join(", ")} is running but did not answer ${g.dash} not switching behind its back`);
          return;
        }
      }
    }
    set({ busy: { text: `switching to ${accountName(row)}`, since: clock() }, notice: null });
    render();
    const result = deck ? await src.switchDeck(deck, row.num) : await src.switchHere(row.num);
    set({ busy: null });
    if (!result.ok && result.reason === "deck_timeout") {
      tell("warn", `the deck has not finished switching to ${accountName(row)} ${g.dash} it may still land`);
    } else if (!result.ok && result.reason === "login_expired") {
      tell("err", `${accountName(row)}'s login expired ${g.dash} switching to it would sign every running session out`);
    } else if (!result.ok) {
      const why = result.reason === "no_cswap" ? `claude-swap is not installed`
        : result.reason === "timeout" ? `claude-swap took too long to answer`
        : result.output ? String(result.output).trim().split("\n").pop()
        : result.reason ?? "the switch failed";
      tell("err", `could not switch to ${accountName(row)} ${g.dash} ${why}`);
    } else {
      // Who follows the switch: every running Claude session, from its next
      // message — the whole effect, and nowhere else on screen (? says when).
      const live = Array.isArray(state.sessions)
        ? state.sessions.filter(s => s.provider !== "codex" && s.state !== "ended").length
        : 0;
      const follows = live > 0
        ? ` ${g.bullet} ${live} Claude session${live === 1 ? " moves" : "s move"} with it`
        : "";
      tell("ok", `switched to ${accountName(row)}${follows}`);
    }
    await readRoster(true);
  }

  async function doBest() {
    const rows = state.roster?.ok ? state.roster.accounts : [];
    const best = bestAccount(rows, await src.rules(deck, rows));
    if (best.none) return tell("err", `no account can take the login ${g.dash} every one is disabled or needs a fresh sign-in`);
    // What to do first, then why: the notice is one row, and at 80 columns
    // its end is what a long email cuts off.
    if (best.already) {
      state = view.selectSlot(state, best.already.num);
      return tell("ok", `already on ${KEPT[best.rule] ?? KEPT["most-room"]}: ${accountName(best.already)}`);
    }
    state = view.selectSlot(state, best.account.num);
    tell("info", `enter switches to ${accountName(best.account)} ${g.dash} ${PICKED[best.rule] ?? PICKED["most-room"]}`);
  }

  async function doAuto(enabled) {
    if (!deck) return;
    set({ busy: { text: `turning Auto-switch ${enabled ? "on" : "off"}`, since: clock() }, notice: null });
    render();
    const r = await src.ask(deck, { method: "POST", path: "/api/cswap-auto", body: { action: "enable", enabled } });
    set({ busy: null });
    if (r.ok && r.body?.ok !== false) tell("ok", `Auto-switch ${enabled ? "on" : "off"}`);
    else tell("err", `could not turn Auto-switch ${enabled ? "on" : "off"} ${g.dash} ${r.body?.reason ?? (r.status ? `the deck answered ${r.status}` : r.reason ?? "no reply")}`);
    last.auto = 0;
    await readAuto();
  }

  // ── adding an account, through the deck's sign-in ───────────────────────

  const ADMIN = "/api/claude-accounts/admin";
  /** Why the deck would not start a sign-in, when it said so by name. */
  const START_REFUSED = {
    already_running: "another sign-in is saving an account right now — try again in a moment",
    bad_email: "the deck would not sign in with that address",
    no_url: "the claude CLI did not print a sign-in link",
  };

  /** Why the deck would not take a code, when it said so by name and gave no
   *  sentence of its own. */
  const CODE_REFUSED = {
    not_prompted: "the claude CLI has not asked for a code yet — paste it once the page shows one",
    not_waiting: "the deck is no longer waiting for a code",
  };
  // Which start is the latest: a page closed while the deck was still starting
  // its sign-in is cancelled again once the deck answers, unless a newer one
  // has the deck by then.
  let attempt = 0;

  async function doSigninStart() {
    if (!deck || !state.signin) return;
    const mine = ++attempt;
    const { email } = state.signin;
    set({ signin: { ...state.signin, started: true, login: null, code: "", sending: false, lastLive: "link" }, notice: null });
    render();
    // The deck answers once the CLI has printed its link, or has died trying.
    const r = await src.ask(deck, { method: "POST", path: ADMIN, body: email ? { action: "login", email } : { action: "login" }, timeoutMs: 30_000 });
    const body = r.body && typeof r.body === "object" ? r.body : null;
    if (mine !== attempt || !view.signinRunning(state.signin)) {
      // The cancel sent when the page closed can have found nothing to cancel
      // yet, and the CLI would sit on its five minutes.
      if (mine === attempt && deck && body?.state === "awaiting_code") {
        src.ask(deck, { method: "POST", path: ADMIN, body: { action: "login-cancel" }, timeoutMs: 15_000 }).catch(() => {});
      }
      return;
    }
    if (r.ok && body?.ok !== false && typeof body?.state === "string") {
      state = view.withLogin(state, body);
    } else {
      const why = body?.detail ?? (body?.reason ? START_REFUSED[body.reason] ?? body.error ?? body.reason : null)
        ?? (r.status === 0 ? `the deck did not answer (${r.reason ?? "no reply"})` : deckTrouble(deck, r));
      // `local`: the deck holds no sign-in of ours to let go of — only for a
      // missing link did it start one, and fail it.
      state = view.withLogin(state, { state: "failed", error: why, url: null, step: null, local: body?.reason !== "no_url" });
    }
    last.signin = clock();
  }

  async function doSigninCode(code) {
    if (!deck || !state.signin) return;
    // Answered when the CLI took it and the account is saved, or asked again —
    // a minute at the most for the CLI, and the store's lock on top of it.
    const r = await src.ask(deck, { method: "POST", path: ADMIN, body: { action: "login-code", code }, timeoutMs: 150_000 });
    if (!state.signin?.started) return;
    // The code is not kept, whatever the answer: a wrong one is copied again.
    set({ signin: { ...state.signin, code: "", sending: false } });
    const body = r.body && typeof r.body === "object" ? r.body : null;
    if (body?.reason === "empty_code") return;
    const why = () => body?.error ?? CODE_REFUSED[body?.reason] ?? body?.reason ?? deckTrouble(deck, r);
    // A refusal names its reason even when the deck wrote no sentence for it:
    // a code sent before the CLI asked for one would otherwise just vanish.
    if (typeof body?.state === "string" && (body.ok !== false || body.state !== "idle")) {
      state = view.withLogin(state, body.ok === false ? { ...body, error: why() } : body);
    } else if (r.status === 0) lost();
    else state = view.withLogin(state, { ...state.signin.login, error: why() });
    last.signin = 0;
  }

  /** Let go of the deck's sign-in, and say so when the account in use did not
   *  go back — the one outcome the person must not miss. */
  async function doSigninCancel({ quiet = false } = {}) {
    if (!deck) return;
    const r = await src.ask(deck, { method: "POST", path: ADMIN, body: { action: "login-cancel" }, timeoutMs: 15_000 });
    const a = r.body?.activeAccount;
    if (r.body?.restored === false) {
      const who = a?.email || (a?.num != null ? `account ${a.num}` : null);
      tell("warn", who ? `this machine is now signed in as ${who} ${g.dash} the account you were using could not be put back`
        : `the account you were using could not be put back ${g.dash} check which one is in use`);
    } else if (!quiet) tell("info", "sign-in cancelled");
    await readRoster(true);
  }

  async function doSigninDone(account) {
    await readRoster(true);
    if (account?.num != null) state = view.selectSlot(state, Number(account.num));
    if (account?.email) tell("ok", `${account.added === false ? "signed in again" : "added"}: ${account.email}`);
  }

  async function doStart() {
    set({ starting: true, busy: { text: "starting the deck", since: clock() }, notice: null });
    render();
    let launcher;
    try {
      launcher = src.startDeck();
    } catch (e) {
      set({ starting: false, busy: null });
      return tell("err", `could not start the deck ${g.dash} ${e?.message ?? e}`);
    }
    // The launcher stays until the deck answers and leaves with an error when
    // it will not — a UI that was never built, a port it cannot have — so its
    // last line is the reason, said at once rather than after the wait.
    let failed = null;
    launcher?.exited?.then(r => { if (r && r.code !== 0) failed = r; });
    const until = clock() + START_WAIT_MS;
    while (!done && clock() < until && !failed) {
      await src.wait(1_000);
      const found = await src.find();
      if (found) {
        deck = found;
        set({ deck: { port: found.port, version: found.version ?? null }, starting: false, busy: null, silent: [] });
        tell("ok", `the deck is running on ${found.port}`);
        await readAll(true);
        return;
      }
    }
    set({ starting: false, busy: null });
    if (done) return;
    if (failed?.said) tell("err", `the deck did not start ${g.dash} ${failed.said}`);
    else tell("err", `the deck did not come up ${g.dash} \`${COMMAND} --logs\` shows what it wrote`);
  }

  const effects = {
    switch: (e) => doSwitch(e.account),
    best: () => doBest(),
    auto: (e) => doAuto(e.enabled),
    refresh: () => readAll(true),
    start: () => doStart(),
    "signin-start": () => doSigninStart(),
    "signin-code": (e) => doSigninCode(e.code),
    "signin-cancel": (e) => doSigninCancel(e),
    "signin-done": (e) => doSigninDone(e.account),
  };

  return new Promise(resolve => {
    const wasRaw = input.isRaw === true;
    let timer = null;
    const finish = (code = EXIT.OK) => {
      if (done) return;
      done = { code };
      clearInterval(timer);
      input.off("keypress", onKey);
      output.off?.("resize", onResize);
      output.off?.("error", onGone);
      for (const sig of SIGNALS) process.off(sig, onSignal);
      process.off("exit", onExit);
      process.off("uncaughtException", onCrash);
      process.off("unhandledRejection", onCrash);
      // The keys stop being read before the mode goes back. On Windows, raw
      // mode ended while they were still read left the PowerShell that ran us
      // dead behind us: not one more line ran, and an SSH session closed.
      input.pause();
      try { input.setRawMode?.(wasRaw); } catch { /* the terminal went away */ }
      screen.leave();
      resolve(code);
    };
    // Every way out hands the terminal back: a signal (the SSH connection
    // closing is a SIGHUP), the process ending under us, and a throw — which
    // is printed after the screen is left, or the alternate screen would take
    // the only account of it away with it.
    // Out, with the deck's sign-in let go of first when this screen started
    // one: left running, `claude auth login` would hold the next attempt for
    // the rest of its five minutes. Not one refused before it began — the deck
    // has only the sign-in somebody else is running then.
    let leaving = false;
    const leave = (code) => {
      if (done || leaving) return;
      const si = state.signin;
      if (!deck || !si?.started || si.login?.state === "done" || si.login?.local) return finish(code);
      leaving = true;
      set({ busy: { text: "cancelling the sign-in", since: clock() } });
      render();
      const cancel = src.ask(deck, { method: "POST", path: ADMIN, body: { action: "login-cancel" }, timeoutMs: 3_000 }).catch(() => null);
      Promise.race([cancel, src.wait(3_500)]).then(() => finish(code));
    };
    const onSignal = () => leave(EXIT.OK);
    const onExit = () => screen.leave();
    const onGone = () => finish(EXIT.FAILED);
    const onCrash = (e) => {
      finish(EXIT.FAILED);
      process.stderr.write(`${COMMAND} tui: ${e?.stack ?? e}\n`);
    };
    const onResize = () => { screen.invalidate(); render(); };
    function onKey(str, key) {
      if (done || leaving) return;
      const { state: next, effect } = view.tuiKey(state, str, key ?? {}, { now: clock(), g });
      state = next;
      if (effect?.type === "quit") return leave(EXIT.OK);
      if (effect?.type === "redraw") screen.invalidate();
      else if (effect && effects[effect.type]) {
        Promise.resolve(effects[effect.type](effect)).catch(e => tell("err", String(e?.message ?? e))).finally(render);
      }
      render();
    }
    // The timer that keeps the screen current: the readings when they are due,
    // and a repaint for the clock — the ages and the resets move, and a
    // spinner while something is under way.
    const tick = () => {
      if (done) return;
      const now = clock();
      if (!deck) {
        if (!state.starting && now - last.find >= POLL_MS.find) lookForDeck();
        if (now - last.roster >= POLL_MS.roster * 2) readRoster(false);
      } else {
        if (now - last.sessions >= POLL_MS.sessions) readSessions();
        if (now - last.auto >= POLL_MS.auto) readAuto();
        if (now - last.roster >= POLL_MS.roster) readRoster(false);
        if (view.signinRunning(state.signin) && now - last.signin >= view.signinPollMs(state.signin)) readSignin();
      }
      render();
    };

    emitKeypressEvents(input);
    try { input.setRawMode?.(true); } catch { /* not a terminal after all: the keys still arrive */ }
    input.resume();
    input.on("keypress", onKey);
    output.on?.("resize", onResize);
    output.on?.("error", onGone);
    for (const sig of SIGNALS) process.on(sig, onSignal);
    process.on("exit", onExit);
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);
    screen.enter();
    render();
    readAll(true);
    timer = setInterval(tick, deps.tickMs ?? 100);
  });
}

/** Why b went where it went, and where it stayed — `switch --best`'s rules
 *  (account-pick.mjs bestAccount), in the fewer words one row has room for. */
const PICKED = Object.freeze({ "most-room": "the most room", home: "your home account", "weekly-reset": "the soonest weekly reset" });
const KEPT = Object.freeze({
  "most-room": "the account with the most room",
  home: "your home account",
  rules: "the account Auto-switch's rules keep",
});

/** What each reading is called when it fails; looking for a deck that is not
 *  there is not a failure. */
const READINGS = Object.freeze({ roster: "the accounts", auto: "Auto-switch", sessions: "the sessions" });

// SIGHUP is a closed SSH connection, and on Windows a closed console window;
// SIGBREAK is Windows' Ctrl+Break.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])];

/**
 * Where the screen's answers come from: the running deck through the commands'
 * own helpers, and — with none — claude-swap's store in this process.
 */
export function deckSource(port) {
  return {
    find: async () => {
      const { findDeck } = await load("src/server/deck-client.mjs");
      return findDeck({ port });
    },
    silent: () => silentDecks(port).catch(() => []),
    ask: (deck, opts) => ask(deck, opts),
    localRoster: async () => {
      const { fetchClaudeAccounts } = await load("src/server/claude-accounts.mjs");
      return fetchClaudeAccounts({ force: true });
    },
    switchDeck: (deck, num) => switchThroughDeck(deck, num),
    switchHere: (num) => switchHere(num),
    rules: (deck, accounts) => autoRules(deck, accounts),
    // The bare start, as typed: it detaches itself and its launcher leaves
    // once the deck is up. Never a browser — over SSH there is none to open,
    // and at a desk the person asked for this screen, not a tab. `exited` is
    // the launcher's code and the last line it printed, which on a failure is
    // the reason.
    startDeck: () => {
      const child = spawn(process.execPath, [join(PKG_ROOT, "bin", "agent-dag.js"), "--no-open"], {
        stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
        env: { ...process.env, NO_COLOR: "1" },
      });
      let tail = "";
      const keep = (d) => { tail = (tail + String(d)).slice(-4_000); };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      const exited = new Promise(resolve => {
        child.on("error", e => resolve({ code: -1, said: e.message }));
        child.on("exit", code => {
          const lines = tail.split(/\r?\n/).map(l => oneLine(stripAnsi(l))).filter(Boolean);
          resolve({ code, said: lines.at(-1) ?? "" });
        });
      });
      child.unref();
      child.stdout.unref?.();
      child.stderr.unref?.();
      return { exited };
    },
    wait: (ms) => new Promise(r => setTimeout(r, ms)),
  };
}
