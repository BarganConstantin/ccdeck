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
import { randomUUID } from "node:crypto";
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
export const POLL_MS = Object.freeze({
  sessions: 3_000, system: 3_000, auto: 10_000, roster: 15_000, find: 5_000, history: 60_000,
  // The Codex side, as its panel reads it (CodexProfilesSection.tsx,
  // codex-accounts.ts): the list every 15 s and every 2 while a switch waits
  // on the running Codex; the default's quota every minute, the others' every
  // five; the sign-in every second and a half.
  codex: 15_000, codexWaiting: 2_000, codexQuota: 15_000, quotaDefault: 60_000, quotaOther: 300_000, codexSignin: 1_500,
  // The Local network as its section reads it while on screen (every 5 s,
  // use-lan-section.ts); off its tab often enough that a deck asking to pair
  // is said within half a minute.
  lan: 5_000, lanAway: 30_000,
});

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
  const { HISTORY_GROUPS, historyMachine, withReading } = await load("src/server/tui-machine.mjs");
  const { CODEX_REFUSED, codexLiveSaid, codexSigninRunning } = await load("src/server/tui-codex.mjs");
  const { LAN_REFUSED } = await load("src/server/tui-network.mjs");
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
  const last = { roster: 0, auto: 0, sessions: 0, system: 0, history: 0, signin: 0, codex: 0, codexQuota: 0, codexSignin: 0, lan: 0, find: clock() };
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
    set({ deck: null, auto: null, sessions: null, codexAuto: null, lanPrefs: null });
    state = view.withLan(state, null);
    state = view.withCodex(state, null);
    if (codexSigninRunning(state.codexSignin)) {
      set({ codexSignin: { ...state.codexSignin, login: { state: "failed", reason: "the deck stopped answering, and the sign-in ended with it" } } });
    }
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

  // The machine, as the deck samples it: one answer a reading, kept. An answer
  // that did not come is a gap in the charts, not a zero.
  const readSystem = once("system", async () => {
    if (!deck) return;
    const r = await src.ask(deck, { path: "/api/system", timeoutMs: 3_000 });
    if (r.ok && r.body && typeof r.body === "object") set({ machine: withReading(state.machine, r.body, clock()) });
    else if (r.status === 0) lost();
  });

  // The deck's minutes, while the hours are on screen: a day at the most, one
  // section a request, the way its history charts ask.
  const readHistory = once("history", async () => {
    if (!deck || state.machineView !== "hours") return;
    const answers = await Promise.all(HISTORY_GROUPS.map(group => src.ask(deck, { path: `/api/system/history?group=${group}`, timeoutMs: 5_000 })));
    if (answers.some(r => r.status === 0)) return lost();
    const history = historyMachine(answers.map(r => (r.ok ? r.body : null)), state.machine, clock());
    if (state.machineView === "hours") set({ history });
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

  // ── the Codex side ───────────────────────────────────────────────────────

  /** When each Codex account's quota was last asked for, and for which login. */
  const quotaAt = new Map();
  const codexWaiting = () => {
    const live = state.codex?.live;
    return live?.state === "waiting" || live?.continuation === "waiting";
  };

  // The accounts and Codex Auto-switch together, as the panel reads them. A
  // deck from before the Codex accounts answers 404: no Codex side at all.
  const readCodex = once("codex", async () => {
    if (!deck) return;
    const [r, a] = await Promise.all([src.ask(deck, { path: "/api/codex-profiles" }), src.ask(deck, { path: "/api/codex-auto" })]);
    if (r.status === 0 || a.status === 0) return lost();
    state = view.withCodex(state, r.ok && Array.isArray(r.body?.profiles) ? r.body : null);
    set({ codexAuto: a.ok && a.body && typeof a.body === "object" && a.body.ok !== false ? a.body : null });
    last.codexQuota = 0;
  });

  // Each account's quota when it is due: at once for one new or signed in
  // again, then the default's every minute and the others' every five. A
  // failed reading keeps the last good one to draw, marked stale.
  const readCodexQuotas = once("codexQuota", async () => {
    if (!deck) return;
    const now = clock();
    const every = (p) => (p.active ? POLL_MS.quotaDefault : POLL_MS.quotaOther);
    const due = (state.codex?.profiles ?? []).filter(p => p.available !== false && typeof p.id === "string" && (() => {
      const seen = quotaAt.get(p.id);
      return !seen || seen.identity !== p.identityVersion || now - seen.at >= every(p);
    })());
    if (!due.length) return;
    const answers = await Promise.all(due.map(p => src.ask(deck, { path: `/api/codex-profile-quota?id=${encodeURIComponent(p.id)}`, timeoutMs: 20_000 })));
    if (answers.some(r => r.status === 0)) return lost();
    const next = { ...state.codexQuota };
    due.forEach((p, i) => {
      const r = answers[i];
      const body = r.body && typeof r.body === "object" ? r.body : { ok: false, reason: "unknown" };
      // A login that moved while it was read is asked again in 15 s, as the panel does.
      const at = body.reason === "profile_changed" ? clock() - every(p) + 15_000 : clock();
      quotaAt.set(p.id, { at, identity: p.identityVersion });
      if (r.ok && body.ok !== false) next[p.id] = body;
      else {
        const prev = next[p.id];
        next[p.id] = { ...body, ok: false, lastGood: prev?.ok === false ? prev.lastGood ?? null : prev ?? null };
      }
    });
    set({ codexQuota: next });
  });

  // Where the deck's codex login is, while the page waits on it.
  const readCodexSignin = once("codexSignin", async () => {
    const si = state.codexSignin;
    if (!deck || !si?.id || !si.login) return;
    const r = await src.ask(deck, { path: `/api/codex-profile-login-state?id=${encodeURIComponent(si.id)}` });
    if (r.status === 0) return lost();
    if (!r.ok || typeof r.body?.state !== "string" || state.codexSignin?.id !== si.id) return;
    // The deck says "idle" for a flow it no longer has: one that ended before
    // this read, which only a fresh start can tell apart.
    if (r.body.state === "idle") return;
    set({ codexSignin: { ...state.codexSignin, login: r.body } });
    if (r.body.state === "done") {
      await readCodex();
      const who = (state.codex?.profiles ?? []).find(p => p.id === si.id);
      if (state.codexSignin) set({ codexSignin: { ...state.codexSignin, account: who?.account ?? null } });
      quotaAt.delete(si.id);
    }
  });

  const readAll = (force) => Promise.all([readRoster(force), readAuto(), readSessions(), readSystem(), readCodex(), readLan()]);

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

  // ── an account's actions, through the deck's own routes ─────────────────
  //
  // The ones the Accounts panel's menu posts (use-account-menu.ts,
  // AccountsPanel.tsx): home and rotation are Auto-switch's, the alias, the
  // slot and the removal are claude-swap's, behind the deck's store lock. A
  // refusal keeps the menu up, the reason under its items; what worked closes
  // it and says so.

  /** Why the deck would not, when it said so by name and gave no sentence. */
  const ACTION_REFUSED = {
    bad_value: "claude-swap takes letters, digits, spaces and . _ - only",
    bad_slot: "a slot is a number from 1 to 999",
    bad_account: "the deck does not know that slot any more",
    not_confirmed: "claude-swap did not remove it",
  };

  async function act(text, body, path, timeoutMs = 60_000) {
    set({ busy: { text, since: clock() }, notice: null });
    render();
    const r = await src.ask(deck, { method: "POST", path, body, timeoutMs });
    set({ busy: null });
    if (r.ok && r.body?.ok !== false) return { ok: true, body: r.body };
    if (r.status === 0) lost();
    const b = r.body && typeof r.body === "object" ? r.body : {};
    const why = b.detail ?? ACTION_REFUSED[b.reason] ?? CODEX_REFUSED[b.reason] ?? b.error ?? b.reason ?? deckTrouble(deck ?? { port: "?" }, r);
    return { ok: false, why: String(why) };
  }

  /** What worked: the menu closed and a notice. What did not: the menu up, saying why. */
  function settle(result, said, tone = "ok") {
    if (result.ok) {
      set({ menu: null });
      tell(tone, said);
    } else if (state.menu) set({ menu: { ...state.menu, error: result.why } });
    else tell("err", result.why);
  }

  async function doHome(row, home) {
    if (!deck) return;
    const name = accountName(row);
    const r = await act(home ? `making ${name} home` : `taking home away from ${name}`, { action: "home", account: home ? row.num : null }, "/api/cswap-auto");
    settle(r, home ? `${name} is home ${g.dash} Auto-switch comes back to it once its 5-hour window resets` : `${name} is no longer home`);
    last.auto = 0;
    await readAuto();
  }

  async function doHold(row, out) {
    if (!deck) return;
    const name = accountName(row);
    const r = await act(out ? `holding ${name} out` : `putting ${name} back`, { action: "account", account: row.num, enabled: !out }, "/api/cswap-auto");
    settle(r, out ? `${name} is held out of rotation ${g.dash} o puts it back` : `${name} is back in rotation`);
    last.auto = 0;
    await Promise.all([readRoster(true), readAuto()]);
  }

  async function doAlias(row, alias) {
    if (!deck) return;
    const r = await act(`renaming #${row.num}`, { action: "alias", account: row.num, alias }, ADMIN);
    settle(r, alias ? `#${row.num} is ${alias}` : `#${row.num} has no alias now`);
    await readRoster(true);
  }

  async function doMove(row, slot) {
    if (!deck) return;
    const name = accountName(row);
    const r = await act(`moving ${name} to slot ${slot}`, { action: "move", account: row.num, slot }, ADMIN);
    const to = r.body?.to ?? null;
    settle(r, r.body?.swapped ? `${name} is in slot ${slot} ${g.dash} the account there took slot ${row.num}` : `${name} is in slot ${to ?? slot}`);
    await readRoster(true);
    // The selection follows the account to its new slot.
    if (r.ok) state = view.selectSlot(state, Number(to ?? slot));
  }

  async function doRemove(row) {
    if (!deck) return;
    const name = accountName(row);
    const r = await act(`removing ${name}`, { action: "remove", account: row.num }, ADMIN);
    settle(r, `removed ${name}`);
    await readRoster(true);
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

  // ── the Codex side's actions, through the deck's own routes ─────────────
  //
  // The ones the Codex panel posts: every change names the list's revision it
  // was made against, and one the deck has moved since is refused, not
  // applied to the wrong account.

  async function doCodexSelect(row) {
    if (!deck) return;
    const name = accountName(row);
    const r = await act(`switching Codex to ${name}`, { id: row.id, expectedRevision: state.codex?.revision, operationId: randomUUID() }, "/api/codex-profile-select", 30_000);
    if (r.ok) {
      const said = codexLiveSaid(r.body?.live, name);
      tell(said.tone, said.text);
    } else tell("err", `could not switch Codex to ${name} ${g.dash} ${r.why}`);
    await readCodex();
  }

  async function doCodexAuto(enabled) {
    if (!deck) return;
    const r = await act(`turning Codex Auto-switch ${enabled ? "on" : "off"}`, { action: "enable", enabled }, "/api/codex-auto");
    if (r.ok) tell("ok", `Codex Auto-switch ${enabled ? "on" : "off"}`);
    else tell("err", `could not turn Codex Auto-switch ${enabled ? "on" : "off"} ${g.dash} ${r.why}`);
    await readCodex();
  }

  async function doCodexHold(row, out) {
    if (!deck) return;
    const name = accountName(row);
    const r = await act(out ? `holding ${name} out` : `putting ${name} back`, { action: "account", id: row.id, enabled: !out }, "/api/codex-auto");
    settle(r, out ? `${name} is held out of Codex's rotation ${g.dash} o puts it back` : `${name} is back in Codex's rotation`);
    await readCodex();
  }

  async function doCodexHome(row, home) {
    if (!deck) return;
    const name = accountName(row);
    const r = await act(home ? `making ${name} home` : `taking home away from ${name}`, { action: "home", id: home ? row.id : null }, "/api/codex-auto");
    settle(r, home ? `${name} is home ${g.dash} Codex Auto-switch comes back to it once it has room again` : `${name} is no longer home`);
    await readCodex();
  }

  async function doCodexRename(row, label) {
    if (!deck) return;
    const r = await act(`renaming #${row.num}`, { id: row.id, label: label || null, expectedRevision: state.codex?.revision }, "/api/codex-profile-rename");
    settle(r, label ? `#${row.num} is ${label}` : `#${row.num} has no name now`);
    await readCodex();
  }

  async function doCodexRemove(row) {
    if (!deck) return;
    const name = accountName(row);
    const r = await act(`removing ${name}`, { id: row.id, expectedRevision: state.codex?.revision, operationId: randomUUID() }, "/api/codex-profile-remove");
    settle(r, `removed ${name} ${g.dash} its sign-in and history are kept aside in the deck's data folder`);
    quotaAt.delete(row.id);
    await readCodex();
  }

  /** The Codex sign-in: a new account made first when it is one, then the
   *  deck's codex login for it, which the page follows until it ends. */
  async function doCodexSigninStart() {
    const si = state.codexSignin;
    if (!si || !deck) return;
    const failed = (r) => {
      const b = r.body && typeof r.body === "object" ? r.body : {};
      const reason = CODEX_REFUSED[b.reason] ?? b.reason ?? deckTrouble(deck, r);
      if (state.codexSignin) set({ codexSignin: { ...state.codexSignin, login: { state: "failed", reason } } });
    };
    let id = si.id;
    if (!id) {
      const made = await src.ask(deck, { method: "POST", path: "/api/codex-profile-add", body: { operationId: randomUUID(), expectedRevision: state.codex?.revision }, timeoutMs: 15_000 });
      if (made.status === 0) return lost();
      if (!made.ok || made.body?.ok === false || typeof made.body?.id !== "string") return failed(made);
      id = made.body.id;
      if (!state.codexSignin) return;
      set({ codexSignin: { ...state.codexSignin, id } });
      readCodex();
    }
    const r = await src.ask(deck, { method: "POST", path: "/api/codex-profile-login-start", body: { id }, timeoutMs: 15_000 });
    if (r.status === 0) return lost();
    if (!state.codexSignin || state.codexSignin.id !== id) return;
    if (r.ok && r.body?.ok !== false && typeof r.body?.state === "string") {
      set({ codexSignin: { ...state.codexSignin, login: r.body.state === "idle" ? { state: "starting" } : r.body } });
      last.codexSignin = clock();
    } else failed(r);
  }

  async function doCodexSigninCancel(id) {
    if (!deck) return;
    await src.ask(deck, { method: "POST", path: "/api/codex-profile-login-cancel", body: { id }, timeoutMs: 3_000 }).catch(() => null);
    await readCodex();
  }

  async function doCodexSigninDone() {
    await readCodex();
    tell("ok", "signed in to Codex");
  }

  // ── the Local network ────────────────────────────────────────────────────

  /** The decks that asked to pair, so each one is said once. */
  const askedBefore = new Set();

  /** A Local network status in, as every write of it answers with one too:
   *  drawn, and a deck newly asking to pair said while the list is elsewhere. */
  const landLan = (body) => {
    const status = { ...body };
    for (const k of ["ok", "added", "done", "peer", "tried"]) delete status[k];
    state = view.withLan(state, status);
    for (const p of status.enabled ? status.pending ?? [] : []) {
      if (!p?.fp || askedBefore.has(p.fp)) continue;
      askedBefore.add(p.fp);
      if (!view.onLan(state)) tell("warn", `${p.name || p.addr || "a deck"} wants to pair ${g.dash} answer it on the Network tab`);
    }
  };

  // The status, and on its tab the settings it does not carry — the addresses
  // this deck calls. A deck from before Local network answers 404.
  const readLan = once("lan", async () => {
    if (!deck) return;
    const tab = view.onLan(state);
    const [r, p] = await Promise.all([
      src.ask(deck, { path: "/api/lan" }),
      tab ? src.ask(deck, { path: "/api/prefs" }) : null,
    ]);
    if (r.status === 0) return lost();
    if (r.status === 404) { state = view.withLan(state, null, { missing: true }); return; }
    if (!r.ok || !r.body || typeof r.body !== "object") return;
    landLan(r.body);
    const prefs = p?.ok ? p.body?.prefs?.lan : null;
    if (prefs && typeof prefs === "object") set({ lanPrefs: prefs });
  });

  /** One Local network write, its refusal in the deck's words. */
  async function lanAct(doing, path, body) {
    set({ busy: { text: doing, since: clock() }, notice: null });
    render();
    const r = await src.ask(deck, { method: "POST", path, body, timeoutMs: 30_000 });
    set({ busy: null });
    if (r.status === 0) { lost(); return { ok: false, why: "the deck stopped answering" }; }
    const b = r.body && typeof r.body === "object" ? r.body : {};
    if (r.ok && b.ok !== false) return { ok: true, body: b };
    const why = LAN_REFUSED[b.reason] ?? (b.reason ? `the deck refused it (${b.reason})` : b.error ?? deckTrouble(deck ?? { port: "?" }, r));
    return { ok: false, why: String(why), body: b };
  }

  function lanSettle(result, said) {
    if (result.ok) {
      if (state.lanForm && state.lanForm.view !== "invite") set({ lanForm: null });
      if (said) tell("ok", said);
    } else if (state.lanForm) {
      set({ lanForm: { ...state.lanForm, error: result.why, ...(Array.isArray(result.body?.tried) ? { tried: result.body.tried } : {}) } });
    } else tell("err", result.why);
  }

  /** What a settings write changes in the status, drawn before the next read
   *  confirms it. */
  const PREF_IN_STATUS = { tailscale: ["tailscale", "on"], tailscaleAsk: ["tailscale", "ask"], tailscaleAccept: ["tailscale", "accept"] };

  async function doLanPrefs(e) {
    if (!deck) return;
    const r = await lanAct(e.doing, "/api/prefs", { lan: e.patch });
    if (r.ok && state.lan) {
      let lan = { ...state.lan };
      for (const [k, v] of Object.entries(e.patch)) {
        const [obj, field] = PREF_IN_STATUS[k] ?? [];
        if (obj) lan = { ...lan, [obj]: { ...lan[obj], [field]: v } };
        else if (k !== "manual") lan[k] = v;
      }
      state = view.withLan(state, lan);
      if (e.patch.manual) set({ lanPrefs: { ...state.lanPrefs, manual: e.patch.manual } });
    }
    lanSettle(r, e.said);
    last.lan = 0;
  }

  async function doLanPeer(e) {
    if (!deck) return;
    const r = await lanAct(e.doing, "/api/lan/peer", { action: e.action, fp: e.fp, ...(e.name != null ? { name: e.name } : {}) });
    if (r.ok) landLan(r.body);
    lanSettle(r, e.said);
    last.lan = 0;
  }

  async function doLanInvite(e) {
    if (!deck) return;
    const r = await lanAct(e.doing, "/api/lan/invite", { action: e.action, ...(e.token ? { token: e.token } : {}) });
    if (r.body && typeof r.body.enabled === "boolean") landLan(r.body);
    if (e.action === "join") {
      if (r.ok) {
        set({ lanForm: null });
        tell("ok", `paired with ${r.body.peer?.name || "that deck"} ${g.dash} logins go between the two from the next round`);
      } else lanSettle(r);
    } else if (e.action === "make") {
      if (!r.ok) lanSettle(r);
    } else lanSettle(r, e.said);
    last.lan = 0;
  }

  async function doLanSync(e) {
    if (!deck) return;
    const r = await lanAct(e.doing, "/api/lan/sync", e.fp ? { fp: e.fp } : {});
    if (r.ok) landLan(r.body);
    lanSettle(r, e.said);
    last.lan = 0;
  }

  const effects = {
    "lan-prefs": (e) => doLanPrefs(e),
    "lan-peer": (e) => doLanPeer(e),
    "lan-invite": (e) => doLanInvite(e),
    "lan-sync": (e) => doLanSync(e),
    switch: (e) => (e.account?.codex ? doCodexSelect(e.account) : doSwitch(e.account)),
    best: () => doBest(),
    auto: (e) => (e.codex ? doCodexAuto(e.enabled) : doAuto(e.enabled)),
    refresh: () => { quotaAt.clear(); return readAll(true); },
    history: () => readHistory(),
    home: (e) => (e.account?.codex ? doCodexHome(e.account, e.set) : doHome(e.account, e.set)),
    hold: (e) => (e.account?.codex ? doCodexHold(e.account, e.out) : doHold(e.account, e.out)),
    alias: (e) => (e.account?.codex ? doCodexRename(e.account, e.alias) : doAlias(e.account, e.alias)),
    move: (e) => doMove(e.account, e.slot),
    remove: (e) => (e.account?.codex ? doCodexRemove(e.account) : doRemove(e.account)),
    "codex-signin-start": () => doCodexSigninStart(),
    "codex-signin-cancel": (e) => doCodexSigninCancel(e.id),
    "codex-signin-done": () => doCodexSigninDone(),
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
      const csi = state.codexSignin;
      const claude = deck && si?.started && si.login?.state !== "done" && !si.login?.local;
      const codex = deck && csi?.id && csi.started && codexSigninRunning(csi);
      if (!claude && !codex) return finish(code);
      leaving = true;
      set({ busy: { text: "cancelling the sign-in", since: clock() } });
      render();
      const cancel = claude
        ? src.ask(deck, { method: "POST", path: ADMIN, body: { action: "login-cancel" }, timeoutMs: 3_000 })
        : src.ask(deck, { method: "POST", path: "/api/codex-profile-login-cancel", body: { id: csi.id }, timeoutMs: 3_000 });
      Promise.race([cancel.catch(() => null), src.wait(3_500)]).then(() => finish(code));
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
      // The Local network's tab opened: read it now, with the settings it needs.
      const opened = view.onLan(next) && !view.onLan(state);
      state = next;
      if (opened) readLan();
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
        if (now - last.system >= POLL_MS.system) readSystem();
        if (state.machineView === "hours" && now - last.history >= POLL_MS.history) readHistory();
        if (now - last.auto >= POLL_MS.auto) readAuto();
        if (now - last.roster >= POLL_MS.roster) readRoster(false);
        if (view.signinRunning(state.signin) && now - last.signin >= view.signinPollMs(state.signin)) readSignin();
        if (now - last.codex >= (codexWaiting() ? POLL_MS.codexWaiting : POLL_MS.codex)) readCodex();
        if (state.codex && now - last.codexQuota >= POLL_MS.codexQuota) readCodexQuotas();
        if (state.codexSignin?.login && codexSigninRunning(state.codexSignin) && now - last.codexSignin >= POLL_MS.codexSignin) readCodexSignin();
        if (now - last.lan >= (view.onLan(state) ? POLL_MS.lan : POLL_MS.lanAway)) readLan();
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
const READINGS = Object.freeze({ roster: "the accounts", auto: "Auto-switch", sessions: "the sessions", lan: "the Local network" });

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
