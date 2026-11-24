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
// Updates are the deck's too. The title bar says when the deck names one, in
// its page's words, and u takes it through the deck's own install and restart
// — never npm from here. And this screen follows them: a process left open for
// days keeps the code it started with, so once the deck runs a newer version
// and this screen's own package on disk says that same version, it reopens
// itself on the new code, on the tab it was on (see `follow` below).
//
// The view and the keys are pure (src/server/tui-view.mjs) and the painting is
// a row diff over the alternate screen (src/server/tui-screen.mjs). This file is
// the rest: the readings, on a timer each, the effects a key asks for, and the
// terminal handed back on every way out — q, a signal, a closed connection, a
// throw.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import {
  EXIT, ask, autoRules, deckTrouble, load, rosterTrouble, silentDecks, switchHere, switchThroughDeck,
} from "./commands.js";
import { oneLine } from "../../src/server/cli-lines.mjs";
import { stripAnsi } from "../../src/server/term.mjs";
import { COMMAND, PKG_ROOT, PKG_VERSION, versionOnDisk } from "./package.js";
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
  // The deck's update report: the deck asks npm at most hourly and caches the
  // answer, so every ten minutes says a release within the hour it is seen —
  // and asks npm nothing; only u asks it now. And this screen's own package on
  // disk, for the version an install left there.
  update: 600_000, disk: 10_000,
});

/** How long each part of an update is waited for: the install (an npm
 *  install on a slow line), the restart onto files already here, and npx's,
 *  which fetches the new version before it hands the port over. The deck's
 *  report is asked every `poll` while one runs. */
export const UPDATE_WAIT_MS = Object.freeze({ install: 300_000, restart: 90_000, npx: 180_000, poll: 2_000 });

/** How long the screen has to be left alone before it reopens itself on new
 *  code: a key in that time is somebody in the middle of something. */
export const REST_MS = 5_000;

/**
 * INTERNAL, not a flag anybody types: set on the screen this one reopens as,
 * `{"side":"codex","from":"4.3.10"}` — the tab to open on and the version it
 * came from — read once at its start and taken out of its environment, so a
 * deck started from it, or the next reopen, does not carry it on.
 */
export const RESUMED_ENV = "AGENTS_DECK_TUI_RESUMED";

/** How long a deck started from here is waited for before saying it did not
 *  come up. A first run installs hooks and claude-swap before it listens. */
export const START_WAIT_MS = 90_000;

/**
 * Run the screen until q, resolving to the exit code. `deps` replaces the
 * terminal, the clock and the deck for a test: `input`, `output`, `now`,
 * `source` (see deckSource), `tone`, `g`, `unicode`, `profile`, `links`,
 * `tickMs` — and the reopen onto new code: `own` (this screen's version),
 * `versionOnDisk`, `newCodeStarts(version)`, `reopen({ port, side, from, to })`
 * resolving to the new screen's exit code, and `resumed` (RESUMED_ENV's text).
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
  const { isOlder } = await load("src/server/version-order.mjs");
  const own = deps.own ?? PKG_VERSION;
  const onDisk = deps.versionOnDisk ?? versionOnDisk;
  // Read once, and out of the environment: see RESUMED_ENV.
  const resumed = resumedFrom(deps.resumed !== undefined ? deps.resumed : process.env[RESUMED_ENV]);
  if (deps.resumed === undefined) delete process.env[RESUMED_ENV];
  const port = flags.port != null ? Number(flags.port) : null;
  const base = deps.source ?? deckSource(port);
  const look = {
    tone: deps.tone ?? P, g: deps.g ?? G, unicode: deps.unicode ?? UNICODE, profile: deps.profile ?? PROFILE, links: deps.links ?? LINKS,
  };
  const g = look.g;
  const clock = deps.now ?? Date.now;

  // The deck is looked for before the screen is taken, so a `--port` nobody
  // listens on is answered on the command line, the way the commands answer it.
  let deck = await base.find();
  if (!deck && port != null) {
    return out.fail(EXIT.NO_DECK, "no_deck", `no deck is listening on ${port} ${G.dash} \`${COMMAND} status\` lists them`);
  }

  let state = { ...view.initialState(), own, deck: deck ? { port: deck.port, version: deck.version ?? null } : null };
  const last = { roster: 0, auto: 0, sessions: 0, system: 0, history: 0, signin: 0, codex: 0, codexQuota: 0, codexSignin: 0, lan: 0, update: 0, find: clock() };
  const inflight = new Set();
  const screen = createScreen(s => output.write(s));
  let done = null;

  const set = (patch) => { state = { ...state, ...patch }; };
  const tell = (tone, text, short = null) => set({ notice: { ...view.note(tone, text, clock()), ...(short ? { short } : {}) } });
  /** A notice the view worked out: `{ tone, text, short? }`. */
  const say = (n) => tell(n.tone, n.text, n.short ?? null);

  // Opened by the screen before this one, on older code: back on its tab, once
  // the deck has said it serves it, and said that the update took.
  let resumeSide = resumed && resumed.side !== "claude" ? resumed.side : null;
  if (resumed) tell("ok", resumed.from && isOlder(resumed.from, own) ? `updated to ${own}` : `reopened on ${own}`);
  /** The tab the screen before this one was on, once the deck has answered
   *  for it — or never, when it answered without it. */
  const landSide = (side) => {
    if (resumeSide !== side) return;
    resumeSide = null;
    state = view.showSide(state, side);
  };

  /**
   * The deck held here, looked up again (#100). A deck that restarts — an
   * update, the banner's Restart, a CLI installed while it ran, a crash its
   * supervisor brought back — is up again on the same port within a second,
   * with a new token (request-gates.mjs makes one per start). Every reading
   * this screen asked with the old one was refused 401 from then on, and none
   * of the refusals looked like a deck gone, so the numbers stopped where they
   * were until the screen was quit and opened again, which is a fresh look.
   *
   * One look at a time, shared by every reading refused at once. Answers the
   * record to ask now, or null when there is none other than the one held.
   */
  let refinding = null;
  const refind = () => (refinding ??= (async () => {
    const held = deck;
    const found = await base.find().catch(() => null);
    if (deck !== held) return deck;
    if (!found || !held || (found.port === held.port && found.token === held.token)) return null;
    deck = found;
    set({ deck: { port: found.port, version: found.version ?? null }, silent: [] });
    // A deck that restarted may have restarted into an update: its report is
    // asked for again at the next tick.
    last.update = 0;
    return found;
  })().finally(() => { refinding = null; }));

  /** Whether an answer is the deck's token gate refusing the one asked with. */
  const refused = (r) => r?.status === 401;

  /**
   * The source, its asks answered by the deck now running. A 401 is the token
   * gate, which answers before a route runs, so the deck did nothing with the
   * request and asking it again of the deck found again is safe — a POST too.
   */
  const src = {
    ...base,
    ask: async (d, opts) => {
      const r = await base.ask(d, opts);
      if (!refused(r) || !d) return r;
      const now = d === deck ? await refind() : deck;
      return now && now !== d && now.token !== d.token ? base.ask(now, opts) : r;
    },
  };
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
    set({ deck: null, auto: null, sessions: null, codexAuto: null, lanPrefs: null, update: null });
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

  // What the last failed roster reading said, so the next good one can take
  // its notice down: an error notice otherwise stays until a key, and stood
  // beside "live" and fresh numbers long after the deck answered again.
  let rosterSaid = null;
  const readRoster = once("roster", async (force = false) => {
    if (deck) {
      const r = await src.ask(deck, { path: force ? "/api/claude-accounts?refresh=1" : "/api/claude-accounts" });
      if (r.ok && r.body) {
        state = view.withRoster(state, r.body, r.body.ok ? null : [].concat(rosterTrouble(r.body)));
        set({ source: "deck", silent: [], readAt: clock() });
        if (rosterSaid && state.notice?.text === rosterSaid) set({ notice: null });
        rosterSaid = null;
      } else if (r.status === 0) lost();
      else tell("err", (rosterSaid = deckTrouble(deck, r)));
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
    landSide("codex");
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
    last.update = 0;
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
        last.update = 0;
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
    let result = deck ? await src.switchDeck(deck, row.num) : await src.switchHere(row.num);
    // Refused by the token gate: a deck that restarted since the last reading.
    // The gate answers before the route, so nothing was switched; the deck
    // found again is asked once more.
    if (deck && result?.error === "unauthenticated") {
      const now = await refind();
      if (now) result = await src.switchDeck(now, row.num);
    }
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
        ? state.sessions.filter(s => (s.provider ?? "claude") === "claude" && s.state !== "ended").length
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
        last.update = 0;
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
      // Read from the tab, said as the tab, so the deck counts the Network
      // tab as used today (feature-use.mjs); the reading off it says `tui`.
      src.ask(deck, { path: "/api/lan", ...(tab ? { client: "tui-network" } : {}) }),
      tab ? src.ask(deck, { path: "/api/prefs" }) : null,
    ]);
    if (r.status === 0) return lost();
    if (r.status === 404) { state = view.withLan(state, null, { missing: true }); landSide("lan"); return; }
    if (!r.ok || !r.body || typeof r.body !== "object") return;
    landLan(r.body);
    landSide("lan");
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

  // ── an update, through the deck's own routes ────────────────────────────
  //
  // What the page's chip and banner do (use-version-check.ts,
  // use-deck-upgrade.ts, VersionBanner.tsx), one key: GET /api/version for
  // what is out, POST /api/upgrade for the install, POST /api/restart for the
  // restart onto it. The deck decides everything the page leaves to it — which
  // package, which prefix, whether npx relaunches — and refuses for itself
  // what would cost the canvas. A restart is then the one this screen already
  // lives through: the readings are refused or go unanswered, and the deck is
  // found again on its port (refind, lost, lookForDeck).

  /**
   * The deck's report, landed when the deck that answered is the one still
   * held: `{ body }`, `{ changed: true }` when the deck changed under the ask
   * — a restart, mid-request — or `{ r }`, the answer that was not one.
   * `force` is ?refresh=1: npm asked now, which only u does.
   */
  // The deck whose report was last answered, 404 and silence included: what
  // is on disk is said beside it only once the deck has had its say.
  let reportFrom = null;
  async function report(force = false) {
    const asked = deck;
    const r = await src.ask(asked, { path: force ? "/api/version?refresh=1" : "/api/version", timeoutMs: force ? 20_000 : 15_000 });
    // From the deck before a restart, it says what was true of that one.
    if (deck !== asked) { last.update = 0; return { changed: true }; }
    reportFrom = asked;
    if (r.ok && r.body && typeof r.body === "object" && !Array.isArray(r.body)) {
      state = view.withUpdate(state, r.body);
      last.update = clock();
      return { body: r.body };
    }
    return { r };
  }

  // Every ten minutes, and as soon as a deck is found: never ?refresh=1. A
  // deck from before the report answers 404, and says nothing; one too slow to
  // answer — the report can wait on npm — keeps what it said last, since a
  // deck that is gone is noticed by the readings every few seconds.
  const readUpdate = once("update", async () => {
    if (!deck) return;
    const a = await report();
    if (a.r?.status === 404) state = view.withUpdate(state, null);
  });

  /** The update landed: the deck answers on `to`. */
  function landed(to) {
    set({ busy: null });
    tell("ok", `the deck runs ${to}`);
    last.update = 0;
  }

  /** Why the deck would not restart, when it said so by name. */
  const RESTART_REFUSED = {
    unsupervised: `the deck was started without its launcher ${g.dash} it cannot restart itself`,
    no_persist: `a restart would lose the canvas ${g.dash} this deck runs with --no-persist`,
    log_unwritable: `a restart would lose the canvas ${g.dash} the deck cannot write its event log`,
  };
  /** Why the deck would not install, when it said so by name — the banner's
   *  reasons (shell.banner.block), for an install refused after the report. */
  const UPGRADE_REFUSED = {
    git_checkout: "this deck runs from a git checkout",
    npx: "npx runs from a cache that cannot be upgraded in place",
    one_off: "this deck runs from a one-off copy that cannot be upgraded in place",
    not_writable: "the install directory is not writable by this user",
    opted_out: "installs are off (AGENTS_DECK_NO_INSTALL=1)",
    retired_name: "this install came from a name that is no longer published",
    spawn_failed: "npm could not be started",
  };

  /**
   * u. With no update named: npm asked now, and what it said. With one: the
   * report asked again first — the one on screen can be ten minutes old, and
   * an update the deck took by itself since, while nobody looked, is not one
   * to install twice — and then the install, or the restart, it names.
   */
  async function doUpdate() {
    if (!deck) return;
    const named = view.updateNotice(state);
    set({ busy: { text: "checking for an update", since: clock() }, notice: null });
    render();
    const a = await report(!named);
    if (!a.body) {
      set({ busy: null });
      if (a.changed) return tell("info", `the deck restarted while it was asked ${g.dash} u asks again`);
      return tell("err", `could not check for an update ${g.dash} ${deckTrouble(deck ?? { port: state.deck?.port ?? "?" }, a.r)}`);
    }
    const u = state.update;
    const n = u?.notice;
    if (!named || !n) {
      set({ busy: null });
      return say(view.updateChecked(u, g));
    }
    const held = view.updateHeld(u, g);
    if (held) {
      set({ busy: null });
      return say(held);
    }
    if (n.kind === "restart") return doRestart(n.to);
    if (u.mode === "install") return doInstall(n.to);
    return doRestart(n.to, { npx: true });
  }

  /** Whether the report now says an install or a relaunch failed — one that
   *  failed since `before`, not the last attempt's note still standing. */
  const failedSince = (before) => state.update?.state === "failed" && state.update.at !== before;

  /**
   * The deck's install, then the restart onto it. The deck answers at once
   * and installs in the background; its report says how it went, and that
   * the newer files are there — a notice that turned to "restart".
   */
  async function doInstall(to) {
    set({ busy: { text: `installing ${to}`, since: clock() }, notice: null });
    render();
    const before = state.update?.state === "failed" ? state.update.at : undefined;
    const r = await src.ask(deck, { method: "POST", path: "/api/upgrade", timeoutMs: 30_000 });
    const b = r.body && typeof r.body === "object" ? r.body : {};
    if (!r.ok || b.ok === false) {
      set({ busy: null });
      const why = UPGRADE_REFUSED[b.reason] ?? b.reason ?? deckTrouble(deck ?? { port: state.deck?.port ?? "?" }, r);
      const cmd = b.command ? `: ${oneLine(b.command)}` : "";
      // Short of room, the reason and the command to run by hand stay.
      return tell("err", `could not install ${to} ${g.dash} ${why}${cmd}`, cmd ? `${why}${cmd}` : null);
    }
    const until = clock() + UPDATE_WAIT_MS.install;
    while (!done && clock() < until) {
      await src.wait(UPDATE_WAIT_MS.poll);
      if (done) return;
      // Taken by the deck itself meanwhile: the away-update restarts onto an
      // install the moment nobody is looking, and this screen is not looking.
      if (state.deck?.version === to) return landed(to);
      if (!deck) { last.find = 0; continue; }
      const a = await report();
      if (!a.body) continue;
      if (state.update?.running === to) return landed(to);
      if (failedSince(before)) {
        set({ busy: null });
        return tell("err", `could not install ${to} ${g.dash} ${state.update.error ?? "npm gave no reason"}`);
      }
      const n = state.update?.notice;
      if (n?.kind === "restart") {
        const held = view.updateHeld(state.update, g);
        if (held) {
          set({ busy: null });
          return say(held);
        }
        return doRestart(n.to);
      }
    }
    if (done) return;
    set({ busy: null });
    tell("err", `${to} did not finish installing in ${UPDATE_WAIT_MS.install / 60_000} minutes ${g.dash} the deck's page says how it went`);
  }

  /**
   * The deck's restart onto `to`: the files already here, or with `npx`
   * npx's relaunch, which fetches the new version beside the deck still
   * serving and only then hands the port over. Waited for until the deck
   * answers on `to` — found again by the readings, as any restart is.
   */
  async function doRestart(to, { npx = false } = {}) {
    set({ busy: { text: `restarting the deck on ${to}`, since: clock() }, notice: null });
    render();
    const before = state.update?.state === "failed" ? state.update.at : undefined;
    const command = state.update?.command;
    const r = await src.ask(deck, { method: "POST", path: "/api/restart", ...(npx ? { body: { upgrade: true } } : {}), timeoutMs: 15_000 });
    const b = r.body && typeof r.body === "object" ? r.body : {};
    if (!r.ok || b.ok === false) {
      set({ busy: null });
      if (b.reason === "not_npx") {
        return tell("warn", `this deck cannot update through npx ${g.dash} ${command ? `run: ${command}` : "update it the way it was installed"}`);
      }
      if (RESTART_REFUSED[b.reason]) return tell("warn", RESTART_REFUSED[b.reason]);
      return tell("err", `could not restart the deck ${g.dash} ${b.reason ?? deckTrouble(deck ?? { port: state.deck?.port ?? "?" }, r)}`);
    }
    const until = clock() + (npx ? UPDATE_WAIT_MS.npx : UPDATE_WAIT_MS.restart);
    let asked = clock();
    while (!done && clock() < until) {
      await src.wait(1_000);
      if (done) return;
      if (state.deck?.version === to) return landed(to);
      // Away: looked for again now, rather than at the next five seconds.
      if (!deck) { last.find = 0; continue; }
      if (clock() - asked < UPDATE_WAIT_MS.poll) continue;
      asked = clock();
      const a = await report();
      if (!a.body) continue;
      if (state.update?.running === to) return landed(to);
      // npx's fetch failed, and the deck went on serving: its report says why.
      if (npx && failedSince(before)) {
        set({ busy: null });
        return tell("err", `could not update to ${to} ${g.dash} ${state.update.error ?? "npx gave no reason"}`);
      }
    }
    if (done) return;
    set({ busy: null });
    if (!state.deck) tell("err", `the deck did not come back ${g.dash} \`${COMMAND} --logs\` shows what it wrote`);
    else tell("warn", `the deck is still on ${state.deck.version ?? "the version it ran"} ${g.dash} \`${COMMAND} --logs\` shows what it wrote`);
  }

  const effects = {
    update: () => doUpdate(),
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
    // The sign-in's link or code, to the terminal's clipboard: written to the
    // terminal alone, never to the deck, a log or a count.
    copy: (e) => screen.copy(e.text),
  };

  return new Promise(resolve => {
    const wasRaw = input.isRaw === true;
    let timer = null;
    /** The terminal handed back as it was found: what q does, and what the
     *  reopen onto new code does before the new screen takes the terminal. */
    const release = () => {
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
      // Paused, process.stdin also stops reading the terminal, a tick later
      // (Node does that for stdin alone) — before any key typed into the
      // screen reopened after us could be read here instead of there.
      input.pause();
      try { input.setRawMode?.(wasRaw); } catch { /* the terminal went away */ }
      screen.leave();
    };
    const finish = (code = EXIT.OK) => {
      if (done) return;
      done = { code };
      release();
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
      lastKey = clock();
      // A key before the tab came back: the person has moved on from it.
      resumeSide = null;
      const { state: next, effect } = view.tuiKey(state, str, key ?? {}, { now: clock(), g });
      // The Local network's tab opened: read it now, with the settings it needs.
      const opened = view.onLan(next) && !view.onLan(state);
      state = next;
      if (opened) readLan();
      if (effect?.type === "quit") return leave(EXIT.OK);
      if (effect?.type === "redraw") screen.invalidate();
      else if (effect && effects[effect.type]) {
        keyWork++;
        let work;
        try { work = effects[effect.type](effect); } catch (e) { work = Promise.reject(e); }
        Promise.resolve(work).catch(e => tell("err", String(e?.message ?? e))).finally(() => { keyWork--; render(); });
      }
      render();
    }

    // ── following an update onto the new code ─────────────────────────────
    //
    // Node runs the code a process started with until the process ends. A
    // screen left open for days — the usual thing over SSH — kept its old code
    // through every update the deck took, its own fixes on disk unused, and
    // nothing said so. So once the deck runs a newer version than this screen
    // AND this screen's own package on disk says that same version — proof it
    // is this install that moved, not another one, such as the desktop app's
    // deck — the screen reopens itself on the new code, at a moment it can
    // interrupt nobody: nothing over the list, nothing under way, no key for
    // REST_MS. Its tab comes back, and the new screen says it was updated.

    /** When the last key came, and how many of the requests a key started are
     *  still out. The screen opening counts as a key. */
    let lastKey = clock();
    let keyWork = 0;
    // The version on disk, when it was read, and for which deck version: read
    // again when the deck's changes, and every POLL_MS.disk besides.
    let disk = null;
    let diskAt = -Infinity;
    let diskFor;
    // Said once each: an install the screen will not follow, and a new code
    // that would not start.
    let toldDisk = null;
    let failedFor = null;

    const follow = (now) => {
      if (done || leaving) return;
      const dv = state.deck?.version ?? null;
      if (diskFor !== dv || now - diskAt >= POLL_MS.disk) {
        disk = onDisk();
        diskAt = now;
        diskFor = dv;
      }
      if (!disk || disk === own) return;
      if (dv === disk && isOlder(own, dv)) {
        if (failedFor === disk || keyWork > 0 || now - lastKey < REST_MS || !view.screenAtRest(state)) return;
        return reopen(disk);
      }
      // Installed, and not the deck's: another install's deck, a downgrade, no
      // deck at all. Said, not followed — except while the deck is about to
      // restart onto it, or is being asked to, when the reopen above follows.
      const coming = state.update?.notice?.kind === "restart" && state.update.notice.to === disk;
      if (toldDisk === disk || (deck && reportFrom !== deck) || coming || state.busy) return;
      toldDisk = disk;
      tell("warn", `ccdeck ${disk} is installed ${g.dash} q, then open the tui again`);
    };

    /** This screen handed over to the same command on the new code. */
    const reopen = (to) => {
      // Proved first, while the screen is still up: a new code that does not
      // start would leave the person at a shell prompt with no screen at all.
      if (!(deps.newCodeStarts ?? newCodeStarts)(to)) {
        failedFor = to;
        tell("warn", `could not open the new screen ${g.dash} q, then open the tui again`);
        return;
      }
      const port = state.deck.port;
      const side = state.side;
      done = { code: null, reopened: to };
      release();
      Promise.resolve()
        .then(() => (deps.reopen ?? reopenScreen)({ port, side, from: own, to }))
        .then(code => resolve(Number.isInteger(code) ? code : EXIT.FAILED), (e) => {
          process.stderr.write(`${COMMAND} tui: could not open the new screen (${e?.message ?? e}) ${G.dash} open the tui again\n`);
          resolve(EXIT.FAILED);
        });
    };
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
        if (now - last.update >= POLL_MS.update) readUpdate();
      }
      follow(now);
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

// ── the screen reopened on new code ─────────────────────────────────────────

/**
 * The script to start the new screen with: bin/deck.js in this package, by
 * its real path — the worker every `ccdeck` command runs in, under the
 * supervisor (bin/agent-dag.js → bin/deck.js → bin/cli/commands.js → here).
 * Started straight it answers `tui` and `--version` as it does under the
 * supervisor, which adds nothing to a command. Always this package's, never a
 * script outside the package whose version was just proved; and never worked
 * out from argv, which names what was typed (invoked-as.mjs) rather than which
 * code is on disk.
 */
export function tuiEntry({ pkgRoot = PKG_ROOT, real = realpathSync } = {}) {
  const realOr = (p) => { try { return real(p); } catch { return resolve(p); } };
  return join(realOr(pkgRoot), "bin", "deck.js");
}

/** The environment the new code starts in: this one, read as a first start
 *  — a respawn's worker reads no word as a command (bin/deck.js) — and without
 *  the note this screen itself was opened with. */
function childEnv(extra = {}) {
  const env = { ...process.env, AGENTS_DECK_RESPAWN: "", ...extra };
  if (!(RESUMED_ENV in extra)) delete env[RESUMED_ENV];
  return env;
}

/**
 * Whether the new code starts: `node <entry> --version`, as the screen will be
 * started, answers 0 and names `version`. Synchronous, so the screen stands
 * still for the fraction of a second it takes — fifteen at the most — rather
 * than taking keys it would then drop.
 */
function newCodeStarts(version) {
  try {
    const r = spawnSync(process.execPath, [tuiEntry(), "--version"], {
      encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: childEnv({ NO_COLOR: "1" }),
    });
    return r.status === 0 && String(r.stdout ?? "").split(/\r?\n/).some(l => l.trim() === version);
  } catch {
    return false;
  }
}

/**
 * The same command on the new code, owning the terminal until it ends:
 * `tui --port <the deck's>`, its tab and the version it came from in
 * RESUMED_ENV. Resolves to its exit code, which this process exits with.
 *
 * This process stays, the parent of the new one, and ignores SIGINT, SIGTERM,
 * SIGQUIT and SIGHUP while it waits. It has nothing left to tidy, and gone
 * before the child, it would hand the shell its prompt back over a screen
 * still running — two readers of one terminal. The child is in the same
 * process group, so whatever the terminal sends — a Ctrl+C outside raw mode,
 * the hangup of an SSH connection closing — reaches it directly; forwarding
 * would deliver it twice.
 */
function reopenScreen({ port, side, from }) {
  const ignore = () => {};
  const signals = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])];
  for (const sig of signals) {
    try { process.on(sig, ignore); } catch { /* not a signal this platform has */ }
  }
  return new Promise(resolveCode => {
    const end = (code) => {
      for (const sig of signals) process.off(sig, ignore);
      resolveCode(code);
    };
    const failed = (e) => {
      process.stderr.write(`${COMMAND} tui: could not open the new screen (${e?.message ?? e}) ${G.dash} open the tui again\n`);
      end(EXIT.FAILED);
    };
    let child;
    try {
      child = spawn(process.execPath, [tuiEntry(), "tui", "--port", String(port)], {
        stdio: "inherit",
        env: childEnv({ [RESUMED_ENV]: JSON.stringify({ side, from }) }),
      });
    } catch (e) {
      failed(e);
      return;
    }
    child.on("error", failed);
    // Killed by a signal, the screen did not end by itself: 1, as any failure.
    child.on("exit", (code, signal) => end(signal ? EXIT.FAILED : code ?? EXIT.FAILED));
  });
}

/** RESUMED_ENV's note, or null for none, or one that is not one. */
export function resumedFrom(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return {
    side: ["claude", "codex", "lan"].includes(v.side) ? v.side : "claude",
    from: typeof v.from === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(v.from) ? v.from : null,
  };
}

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
    // Said as this screen, so the deck counts `ccdeck tui` as used today
    // (feature-use.mjs); the one-shot commands say nothing. The Network tab's
    // own reading says so, and nothing else can be said from here.
    ask: (deck, opts) => ask(deck, { ...opts, client: opts?.client === "tui-network" ? "tui-network" : "tui" }),
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
