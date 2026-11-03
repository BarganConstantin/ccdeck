// What `ccdeck tui` shows, and what each key does to it.
//
// The view is for somebody on the machine over SSH who wants the deck's
// Accounts panel without a browser: every Claude account with its room, which
// one is live, Auto-switch's state, and the sessions waiting on them — and the
// switch, through the deck, a key away.
//
// Pure, both halves. `tuiFrame` is a state and a screen size in and the rows to
// paint out, every one inside the width and exactly as many as the screen has,
// so the layout can be pinned at 40 columns and at 160 without a terminal.
// `tuiKey` is a state and a key in and the next state out, with the one thing
// the app has to go and do (`effect`) when the key asks for more than a
// redraw. Neither reads the clock, the deck or the terminal: bin/cli/tui.js
// does that and hands the answers in.
//
// The words, the marks and the colours are the commands' own (cli-lines.mjs,
// term.mjs), so the screen reads like `ccdeck accounts` and `ccdeck sessions`
// do. What the screen adds is the frame around them — panels, a lit
// selection, finer meters — drawn as far as the terminal's colour tier
// reaches, and in plain ASCII on a console that cannot draw a box.
import { accountName, switchable } from "./account-pick.mjs";
import {
  accountTrouble, clip, fitPainted, meter, oneLine, pctTone, shortModel, sliceCells, textWidth, untilReset,
} from "./cli-lines.mjs";
import { accountKey } from "./lan-copies.mjs";
import { fg, link, sinceLabel, spinnerFrames, stripAnsi } from "./term.mjs";
import {
  CODEX_LOGIN_FAILED, codexMenuItems, codexNameTrouble, codexRows, hasCodex,
} from "./tui-codex.mjs";
import { machinePanel } from "./tui-machine.mjs";

/** Text from elsewhere — the deck's own sentences, an alias — on a console
 *  that draws ASCII alone: its punctuation in ASCII's, anything else a "?". */
const ASCII_FOR = Object.freeze({ "—": "-", "–": "-", "…": "...", "‘": "'", "’": "'", "“": '"', "”": '"', "·": ".", "×": "x" });
export const asciiOnly = (s) => s.replace(/[^\x00-\x7f]/gu, (c) => ASCII_FOR[c] ?? "?");

/** Below this the view says so instead of drawing a screen nothing fits on. */
export const MIN_COLUMNS = 40;
export const MIN_ROWS = 12;

/** How long a notice that something worked stays on screen. A failure stays
 *  until the next key, since it may be the only account of what happened. */
export const NOTICE_MS = 8_000;

/** The state before anything has been read. */
export function initialState() {
  return {
    deck: null,         // { port, version } while a deck answers
    readAt: null,       // when the deck last answered a reading, for "live"
    source: null,       // "deck" | "local": where the roster was read
    silent: [],         // decks alive but not answering, which hold the store's lock
    roster: null,       // the roster as the deck serves it
    trouble: null,      // why the roster has no rows, as lines, when it has none
    auto: null,         // GET /api/cswap-auto, or null
    sessions: null,     // GET /api/sessions' rows, or null
    machine: null,      // the deck's machine readings, kept (tui-machine.mjs withReading)
    machineView: "live", // "live" | "hours": what the Machine panel's charts reach back over
    history: null,      // the deck's minute history, while the hours are shown (historyMachine)
    skew: 0,            // the deck's clock minus this one, for the sessions' ages
    at: 0,              // the selected account, by index
    top: 0,             // the first account row on screen
    help: false,
    notice: null,       // { tone, text, until }
    busy: null,         // { text, since } while a switch or a start is under way
    starting: false,
    signin: null,       // the sign-in page while it is up (openSignin)
    menu: null,         // an account's menu while it is up: { num, id, view, at, draft, error }
    side: "claude",     // "claude" | "codex": whose accounts the list shows
    codex: null,        // GET /api/codex-profiles, or null: no Codex side to show
    codexQuota: {},     // each Codex account's GET /api/codex-profile-quota answer, by id
    codexAuto: null,    // GET /api/codex-auto, or null
    codexAt: null,      // the selected Codex account, by index; null until the side is first shown
    codexSignin: null,  // the Codex sign-in page while it is up: { id, name, adding, started, login }
  };
}

/** A notice. `until` null keeps it until the next key. */
export function note(tone, text, now) {
  return { tone, text, until: tone === "err" || tone === "warn" ? null : now + NOTICE_MS };
}

const claudeRowsOf = (state) => (state.roster?.ok && Array.isArray(state.roster.accounts) ? state.roster.accounts : []);

/** Whether the list shows the Codex accounts. */
export const onCodex = (state) => state.side === "codex";

/** The rows of the side on screen. `now` only ages the Codex readings. */
const accountsOf = (state, now = null) => (onCodex(state) ? codexRows(state, now) : claudeRowsOf(state));

/** The selected row's index on the side on screen. */
const atOf = (state) => (onCodex(state) ? state.codexAt ?? 0 : state.at);

/** The selection moved to index `i` on the side on screen. */
const withAt = (state, i) => (onCodex(state) ? { ...state, codexAt: i } : { ...state, at: i });

/** The row an open menu is about: a Codex account by its id, which keeps
 *  when the list's order does not; a Claude one by its slot. */
const menuRow = (state, m) => accountsOf(state).find(a => (m.id != null ? a.id === m.id : a.num === m.num)) ?? null;

/** Auto-switch's home account, by slot, or null. Codex has no home. */
export function homeSlot(state) {
  if (onCodex(state)) return null;
  const home = state.auto?.choice?.home;
  if (!home || typeof home.email !== "string") return null;
  const key = accountKey(home.email, home.orgUuid);
  return claudeRowsOf(state).find(a => accountKey(a.email, a.orgUuid) === key)?.num ?? null;
}

/** The selection moved onto the Claude account in slot `num`, if there is one. */
export function selectSlot(state, num) {
  const i = claudeRowsOf(state).findIndex(a => a.num === num);
  return i === -1 ? state : { ...state, at: i };
}

/** The selection moved onto the Codex account `id`, if there is one. */
export function selectCodex(state, id) {
  const i = codexRows(state).findIndex(a => a.id === id);
  return i === -1 ? state : { ...state, codexAt: i };
}

/**
 * The deck's Codex accounts in place of the old answer, the selection kept on
 * the account it was on, or — until the side has been shown — put on the
 * default. An answer with no accounts leaves the side; a side left showing
 * goes back to Claude's.
 */
export function withCodex(state, codex) {
  const before = state.codexAt == null ? null : codexRows(state)[state.codexAt]?.id ?? null;
  const next = { ...state, codex };
  const rows = codexRows(next);
  if (!rows.length) return { ...next, codexAt: null, side: onCodex(state) && !codex ? "claude" : state.side };
  const kept = before == null ? -1 : rows.findIndex(a => a.id === before);
  if (kept !== -1) return { ...next, codexAt: kept };
  if (state.codexAt == null) return { ...next, codexAt: null };
  return { ...next, codexAt: Math.max(0, Math.min(state.codexAt, rows.length - 1)) };
}

/**
 * A fresh roster in place of the old one, the selection kept on the account it
 * was on — the list's order is the rotation's and can change under it — or,
 * on the first read, put on the account in use.
 */
export function withRoster(state, roster, trouble = null) {
  const before = claudeRowsOf(state)[state.at]?.num;
  const next = { ...state, roster, trouble };
  const rows = claudeRowsOf(next);
  const kept = before == null ? -1 : rows.findIndex(a => a.num === before);
  const at = kept !== -1 ? kept : Math.max(0, rows.findIndex(a => a.active));
  return { ...next, at: Math.min(at, Math.max(0, rows.length - 1)) };
}

// ── the keys ────────────────────────────────────────────────────────────────

/**
 * What a key does: `{ state, effect }`. `effect` is null or one of
 *
 *   { type: "quit" }        q, Esc, Ctrl+C
 *   { type: "redraw" }      Ctrl+L
 *   { type: "switch", account }
 *   { type: "best" }        select what Auto-switch would pick
 *   { type: "auto", enabled }
 *   { type: "refresh" }
 *   { type: "start" }       start a deck, when none is running
 *   { type: "signin-start" }            ask the deck for a sign-in link
 *   { type: "signin-code", code }       hand it the code the page showed
 *   { type: "signin-cancel", quiet }    let go of the deck's sign-in
 *   { type: "signin-done", account }    the page closed on a sign-in that took
 *   { type: "history" }                 read the deck's machine history (t)
 *   { type: "home", account, set }      make it Auto-switch's home, or stop
 *   { type: "hold", account, out }      hold it out of rotation, or put it back
 *   { type: "alias", account, alias }   rename it ("" takes the alias away)
 *   { type: "move", account, slot }
 *   { type: "remove", account }
 *
 * The refusals a switch can be told before it is asked for — the account in
 * use, a deck that is running and not answering — are answered here, in the
 * words `ccdeck switch` uses; a login known to be dead opens the sign-in page
 * for it instead. While that page is up every key is its own.
 */
export function tuiKey(state, str, key = {}, { now = 0, g } = {}) {
  const name = key.name ?? "";
  if (key.ctrl && name === "c") return { state, effect: { type: "quit" } };
  if (key.ctrl && name === "l") return { state, effect: { type: "redraw" } };
  if (state.signin) return signinKey(state, str, key, { now, g });
  if (state.codexSignin) return codexSigninKey(state, str, key, { now, g });
  // Help is a page over the view: any key puts the view back, and the key is
  // spent doing it — q there closes the page, it does not quit.
  if (state.help) return { state: { ...state, help: false }, effect: null };
  if (state.menu) return menuKey(state, str, key, { now, g });
  if (str === "q" || name === "escape") return { state, effect: { type: "quit" } };
  if (str === "?") return { state: { ...state, help: true }, effect: null };

  const rows = accountsOf(state);
  const at = atOf(state);
  const s = { ...state, notice: null };
  const go = (i) => ({ state: withAt(s, i), effect: null });
  const last = Math.max(0, rows.length - 1);
  if (name === "up" || str === "k") return go(rows.length ? (at - 1 + rows.length) % rows.length : 0);
  if (name === "down" || str === "j" || (name === "tab" && !key.shift)) return go(rows.length ? (at + 1) % rows.length : 0);
  if (name === "home" || str === "g") return go(0);
  if (name === "end" || str === "G") return go(last);
  if (name === "pageup") return go(Math.max(0, at - 5));
  if (name === "pagedown") return go(Math.min(last, at + 5));
  if (/^[1-9]$/.test(str ?? "")) {
    const i = rows.findIndex(a => a.num === Number(str));
    return i === -1 ? { state: s, effect: null } : go(i);
  }
  // Claude's accounts or Codex's: c turns the list over, the arrows pick a side.
  if (str === "c" || name === "left" || name === "right") return sideKey(s, str === "c" ? null : name === "right" ? "codex" : "claude", { now, g });
  if (name === "return" || name === "enter" || str === "s") {
    return onCodex(state) ? codexSwitchKey(s, rows[at], { now, g }) : switchKey(s, rows[at], { now, g });
  }
  if (str === "b") {
    if (!rows.length) return { state: s, effect: null };
    return onCodex(state) ? codexBestKey(s, rows, { now, g }) : { state: s, effect: { type: "best" } };
  }
  if (str === "a") return autoKey(s, { now, g });
  if (str === "+") return onCodex(state) ? codexAddKey(s, { now, g }) : addKey(s, { now, g });
  // The account's own actions: the menu, or one of them straight from the list.
  const row = rows[at];
  if (row && (str === "m" || str === ".")) return menuOpen(s, row, "menu", { now, g });
  if (row && ACTION_KEYS[str] && !key.ctrl && !key.meta) return menuAct(s, row, ACTION_KEYS[str], { now, g });
  if (row && name === "delete") return menuAct(s, row, "remove", { now, g });
  if (row?.codex && str === "i") return menuAct(s, row, "signin", { now, g });
  if (str === "r") return { state: s, effect: { type: "refresh" } };
  if (str === "t") {
    if (!state.deck) return { state: s, effect: null };
    const view = state.machineView === "hours" ? "live" : "hours";
    return { state: { ...s, machineView: view }, effect: view === "hours" ? { type: "history" } : null };
  }
  if (str === "d") {
    if (state.deck) return { state: { ...s, notice: note("info", `the deck is already running on ${state.deck.port}`, now) }, effect: null };
    if (state.starting) return { state: s, effect: null };
    return { state: s, effect: { type: "start" } };
  }
  return { state, effect: null };
}

function switchKey(state, row, { now, g }) {
  if (!row) return { state, effect: null };
  const told = (tone, text) => ({ state: { ...state, notice: note(tone, text, now) }, effect: null });
  if (state.busy) return told("info", `${state.busy.text} ${g.dash} one thing at a time`);
  // A login known to be dead: switching to it signs every running session out,
  // so enter offers the one remedy instead, where the panel offers it — the
  // sign-in, for this account, which replaces its login in place. In use or
  // not. A disabled slot is a person's own "keep out of rotation" and switches.
  if (!switchable(row) && !row.disabled) {
    if (state.deck && row.email) return { state: { ...state, signin: openSignin(row.email) }, effect: null };
    return told("err", `${accountName(row)} needs a fresh sign-in ${g.dash} d starts the deck, which signs it in again`);
  }
  if (row.active) return told("ok", `already on ${accountName(row)}`);
  // A deck that is alive and did not answer holds the store's lock in its own
  // process: switching beside it is the race #1039 closed.
  if (!state.deck && state.silent.length) {
    return told("err", `the deck on ${state.silent.map(d => d.port).join(", ")} is running but did not answer ${g.dash} not switching behind its back`);
  }
  return { state, effect: { type: "switch", account: row } };
}

function autoKey(state, { now, g }) {
  const told = (tone, text) => ({ state: { ...state, notice: note(tone, text, now) }, effect: null });
  const codex = onCodex(state);
  const what = codex ? "Codex Auto-switch" : "Auto-switch";
  const auto = codex ? state.codexAuto : state.auto;
  if (!state.deck) return told("info", `${what} runs inside the deck ${g.dash} d starts one`);
  if (state.busy) return told("info", `${state.busy.text} ${g.dash} one thing at a time`);
  if (!auto) return told("info", `the deck has not said whether ${what} is on yet`);
  return { state, effect: { type: "auto", enabled: auto.enabled !== true, codex } };
}

// ── the Codex side ──────────────────────────────────────────────────────────

/** The list turned to `side`, or over when `side` is null. The arrows reach
 *  the Codex side once the deck has a Codex account; c, asked for by name,
 *  once the deck answers for Codex at all — to add the first one. */
function sideKey(state, side, { now, g }) {
  const to = side ?? (onCodex(state) ? "claude" : "codex");
  if (to === state.side) return { state, effect: null };
  if (to === "codex" && !(side ? hasCodex(state) : state.deck && state.codex)) {
    if (side) return { state, effect: null };
    const why = state.deck ? `this deck does not serve Codex accounts ${g.dash} an update of ccdeck brings them` : `the Codex accounts are the deck's ${g.dash} d starts one`;
    return { state: { ...state, notice: note("info", why, now) }, effect: null };
  }
  const next = { ...state, side: to, top: 0 };
  // The first look at the Codex side lands on the account Codex runs on.
  if (to === "codex" && state.codexAt == null) next.codexAt = Math.max(0, codexRows(state).findIndex(a => a.active));
  return { state: next, effect: null };
}

/** Enter on a Codex account: make it the default, or sign in an account that
 *  has no login to switch to. */
function codexSwitchKey(state, row, { now, g }) {
  if (!row) return { state, effect: null };
  const told = (tone, text) => ({ state: { ...state, notice: note(tone, text, now) }, effect: null });
  if (state.busy) return told("info", `${state.busy.text} ${g.dash} one thing at a time`);
  if (!state.deck) return told("info", `Codex accounts switch through the deck ${g.dash} d starts one`);
  if (row.issue?.blocks) {
    if (row.issue.fix) return codexSigninOpen(state, row);
    return told("err", `${accountName(row)}: ${row.issue.word} ${g.dash} ${row.issue.hint}`);
  }
  if (row.active) return told("ok", `Codex already runs on ${accountName(row)}`);
  return { state, effect: { type: "switch", account: row } };
}

/** b on the Codex side: the account with the most room left, the deck's own
 *  "next" for Codex Auto-switch — selected, for enter to switch. */
function codexBestKey(state, rows, { now, g }) {
  const can = rows.filter(r => !r.issue?.blocks && !r.disabled && r.headroom != null);
  if (!can.length) return { state: { ...state, notice: note("err", `no Codex account has a reading of its room ${g.dash} every one is held out, signed out or unread`, now) }, effect: null };
  const best = can.reduce((a, b) => (b.headroom > a.headroom || (b.headroom === a.headroom && b.active) ? b : a));
  const at = rows.indexOf(best);
  if (best.active) return { state: { ...state, codexAt: at, notice: note("ok", `Codex already runs on the most room: ${accountName(best)}`, now) }, effect: null };
  return { state: { ...state, codexAt: at, notice: note("info", `enter switches Codex to ${accountName(best)} ${g.dash} the most room`, now) }, effect: null };
}

function codexAddKey(state, { now, g }) {
  const told = (tone, text) => ({ state: { ...state, notice: note(tone, text, now) }, effect: null });
  if (!state.deck) return told("info", `Codex accounts are added through the deck ${g.dash} d starts one`);
  if (state.busy) return told("info", `${state.busy.text} ${g.dash} one thing at a time`);
  return codexSigninOpen(state, null);
}

/** The Codex sign-in page, for `row` in place or for a new account. */
function codexSigninOpen(state, row) {
  return { state: { ...state, menu: null, codexSignin: { id: row?.id ?? null, name: row ? accountName(row) : null, adding: !row, started: false, login: null } }, effect: null };
}

/** The keys while the Codex sign-in page is up. Nothing is typed here: the
 *  code goes into the browser's page. */
function codexSigninKey(state, str, key, { now, g }) {
  const si = state.codexSignin;
  const name = key.name ?? "";
  const enter = name === "return" || name === "enter";
  const back = name === "escape" || str === "q";
  const stay = { state, effect: null };
  const close = (effect = null) => ({ state: { ...state, codexSignin: null }, effect });
  const login = si.login?.state;
  if (!si.started || login === "failed" || login === "expired" || login === "cancelled") {
    if (enter) return { state: { ...state, codexSignin: { ...si, started: true, login: null } }, effect: { type: "codex-signin-start" } };
    return back ? close() : stay;
  }
  if (login === "done") return enter || back ? close({ type: "codex-signin-done" }) : stay;
  // Leaving while it runs lets the deck's codex login go: no process stays behind.
  if (back) return close(si.id ? { type: "codex-signin-cancel", id: si.id } : null);
  return stay;
}

function addKey(state, { now, g }) {
  const told = (tone, text) => ({ state: { ...state, notice: note(tone, text, now) }, effect: null });
  if (!state.deck) return told("info", `accounts are added through the deck ${g.dash} d starts one`);
  if (state.busy) return told("info", `${state.busy.text} ${g.dash} one thing at a time`);
  // claude-swap keeps the accounts: missing, refused or still being installed,
  // a sign-in would end at its last step with nowhere to put the account.
  if (state.roster && !state.roster.ok && state.roster.reason !== "no_accounts") {
    return told("err", String([].concat(state.trouble ?? "could not read the accounts")[0]));
  }
  return { state: { ...state, signin: openSignin() }, effect: null };
}

// ── an account's actions ────────────────────────────────────────────────────
//
// The deck's ⋯ menu on an account row (AccountMenuPopover.tsx), item for item
// and by the same rules: hold out is offered on every account but the one in
// use, putting one back whenever it is out; home whenever the account has an
// address or already is home; remove asks first. Share and Projects stay in
// the deck: one hands over a login as text, the other is a chart. Each item
// has a key that works from the list too, so the menu is where they are
// learnt, not the only way to them.

/** The keys that reach an item straight from the list. */
const ACTION_KEYS = Object.freeze({ n: "rename", v: "move", o: "hold", h: "home", x: "remove" });

/** What claude-swap takes as an alias (cswap-admin.mjs ALIAS_OK). */
const ALIAS_OK = /^(?!-)[A-Za-z0-9 ._-]{1,64}$/;

/** The menu's items for `row`, in the deck's order — the Codex panel's, for
 *  a Codex account. */
export function menuItems(state, row) {
  if (row.codex) return codexMenuItems(row);
  const home = homeSlot(state) === row.num;
  const dead = !switchable(row) && !row.disabled;
  return [
    !row.active || dead ? { id: "switch", key: "enter", label: dead ? "Sign in again" : "Switch to this account" } : null,
    { id: "rename", key: "n", label: "Rename…" },
    { id: "move", key: "v", label: "Move to slot…" },
    !row.active || row.disabled ? { id: "hold", key: "o", label: row.disabled ? "Put back in rotation" : "Hold out of rotation" } : null,
    home || row.email ? { id: "home", key: "h", label: home ? "Remove home" : "Set as home" } : null,
    { id: "remove", key: "x", label: "Remove…", danger: true },
  ].filter(Boolean);
}

function menuOpen(state, row, view, { now, g }) {
  if (!state.deck) {
    return { state: { ...state, notice: note("info", `the account's actions go through the deck ${g.dash} d starts one`, now) }, effect: null };
  }
  if (state.busy) return { state: { ...state, notice: note("info", `${state.busy.text} ${g.dash} one thing at a time`, now) }, effect: null };
  const draft = view === "rename" ? oneLine(row.alias) : "";
  return { state: { ...state, menu: { num: row.num, id: row.codex ? row.id : null, view, at: 0, draft, error: null } }, effect: null };
}

/** An item chosen, from the menu or from the list. */
function menuAct(state, row, id, { now, g }) {
  if (row.codex) {
    if (id === "switch") return codexSwitchKey({ ...state, menu: null }, row, { now, g });
    // Codex has no slots and no home: the keys say so rather than nothing.
    if (id === "move") return { state: { ...state, notice: note("info", `Codex accounts have no slots ${g.dash} the list is the deck's order`, now) }, effect: null };
    if (id === "home") return { state: { ...state, notice: note("info", `Codex Auto-switch has no home account`, now) }, effect: null };
    if (id === "remove" && !row.managed) {
      return { state: { ...state, notice: note("info", `${accountName(row)} is Codex's own login ${g.dash} only accounts added in the deck can be removed`, now) }, effect: null };
    }
  } else if (id === "switch") return switchKey({ ...state, menu: null }, row, { now, g });
  if (!state.deck || state.busy) return menuOpen(state, row, "menu", { now, g });
  if (id === "signin" && row.codex) return codexSigninOpen(state, row);
  if (id === "rename" || id === "move" || id === "remove") {
    const open = menuOpen(state, row, id, { now, g });
    // Back from a form lands on the item it came from.
    const at = menuItems(state, row).findIndex(i => i.id === id);
    return { ...open, state: { ...open.state, menu: { ...open.state.menu, at: Math.max(0, at) } } };
  }
  if (id === "hold") {
    if (row.active && !row.disabled) {
      return { state: { ...state, notice: note("info", `${accountName(row)} is in use ${g.dash} hold another account out, or switch first`, now) }, effect: null };
    }
    return { state, effect: { type: "hold", account: row, out: !row.disabled } };
  }
  if (id === "home") {
    const home = homeSlot(state) === row.num;
    if (!home && !row.email) return { state, effect: null };
    return { state, effect: { type: "home", account: row, set: !home } };
  }
  return { state, effect: null };
}

function menuKey(state, str, key, { now, g }) {
  const name = key.name ?? "";
  const m = state.menu;
  const row = menuRow(state, m);
  // The account went — removed, or moved by somebody else — and the menu with it.
  if (!row) return { state: { ...state, menu: null }, effect: null };
  // While the deck works on what was asked, the menu waits for its answer.
  if (state.busy) return { state, effect: null };
  const set = (patch) => ({ state: { ...state, menu: { ...m, ...patch } }, effect: null });
  const enter = name === "return" || name === "enter";
  const typed = typeof str === "string" && str.length > 0 && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str);

  if (m.view === "menu") {
    const items = menuItems(state, row);
    if (name === "escape" || str === "q" || str === "m" || str === ".") return { state: { ...state, menu: null }, effect: null };
    if (name === "up" || str === "k") return set({ at: (m.at - 1 + items.length) % items.length, error: null });
    if (name === "down" || str === "j" || name === "tab") return set({ at: (m.at + 1) % items.length, error: null });
    if (enter) return menuAct({ ...state, menu: { ...m, error: null } }, row, items[m.at]?.id ?? "", { now, g });
    const hot = name === "delete" ? items.find(i => i.id === "remove") : items.find(i => i.key === str);
    if (hot) {
      const at = items.indexOf(hot);
      return menuAct({ ...state, menu: { ...m, at, error: null } }, row, hot.id, { now, g });
    }
    return { state, effect: null };
  }

  const back = () => set({ view: "menu", draft: "", error: null });
  if (m.view === "remove") {
    if (str === "y" || str === "Y") return { state, effect: { type: "remove", account: row } };
    return back();
  }

  // The two fields: an alias, a slot.
  if (name === "escape") return back();
  if (name === "backspace") return set({ draft: [...m.draft].slice(0, -1).join(""), error: null });
  if (key.ctrl && name === "u") return set({ draft: "", error: null });
  if (m.view === "rename") {
    if (enter) {
      const alias = m.draft.trim();
      const trouble = row.codex ? codexNameTrouble(alias)
        : alias && !ALIAS_OK.test(alias) ? "letters, digits, spaces and . _ - only, up to 64, not starting with -" : null;
      if (trouble) return set({ error: trouble });
      if (alias === oneLine(row.alias)) return { state: { ...state, menu: null }, effect: null };
      return { state, effect: { type: "alias", account: row, alias } };
    }
    if (typed) return set({ draft: (m.draft + str).slice(0, row.codex ? 80 : 64), error: null });
    return { state, effect: null };
  }
  if (m.view === "move") {
    if (enter) {
      const slot = Number(m.draft);
      if (!Number.isInteger(slot) || slot < 1 || slot > 999) return set({ error: "a slot is a number from 1 to 999" });
      if (slot === row.num) return { state: { ...state, menu: null, notice: note("ok", `${accountName(row)} is already in slot ${slot}`, now) }, effect: null };
      return { state, effect: { type: "move", account: row, slot } };
    }
    if (typed && /^\d+$/.test(str)) return set({ draft: (m.draft + str).slice(0, 3), error: null });
    return { state, effect: null };
  }
  return { state, effect: null };
}


// ── the frame ───────────────────────────────────────────────────────────────

/** From this many columns the detail and the waiting sessions sit side by side. */
export const WIDE_COLUMNS = 120;

/**
 * The screen: `{ lines, top }`, `lines` exactly `rows` long and none of them
 * reaching the last column, `top` the first account row shown — kept by the
 * app and handed back, so the list scrolls only when the selection leaves it.
 *
 *     ccdeck  Claude accounts                          ● live · deck 4317
 *   ╭─ Accounts ───────────────────────────────────────────────────────╮
 *   │ › ● 1 ⌂ work  alice@corp.example  5h ███▍       20%   7d ██▊ …   │
 *   ╰─ 1–6 of 9 ──────────── Auto-switch on · at 90% · next: most room ─╯
 *   ╭─ #1 alice@corp.example (work) ───────────── in use · read 1m ago ─╮
 *   │ 5h  ████████▍                       20%   resets in 1h           │
 *   ╰──────────────────────────────────────────────────────────────────╯
 *   ╭─ Waiting on you · 2 ──────────────────────────────── 1 working ─╮
 *   │ ⚠  12m  docs  Codex                                              │
 *   │         Which branch?                                            │
 *   ╰──────────────────────────────────────────────────────────────────╯
 *     ✓  switched to #1 alice@corp.example
 *    enter  switch  b  best  a  auto-switch  r  refresh  ?  keys  q  quit
 *
 * From WIDE_COLUMNS the detail and the waiting sessions sit side by side under
 * the list. On a short screen what gives way first is what is said elsewhere
 * too: waiting sessions beyond the first, then the detail, then the question
 * under the one left, then account rows (the list scrolls, its border saying
 * where), and the waiting panel last of all. The last panel takes the rows
 * left over, so the frame ends at the foot of the screen whatever its height.
 *
 * `profile` is the colour tier (term.mjs colorProfile): the backgrounds — the
 * title bar, the lit row, the keys — reach as far as it does, and under
 * "none" there is not one escape on the screen. `links` says the terminal
 * takes OSC 8 links (term.mjs supportsHyperlinks).
 *
 * While the sign-in page is up the panels give way to it, and the frame may
 * carry a `run` (tui-screen.mjs): the sign-in link, edge to edge, its rows in
 * `lines` as the pieces the terminal will wrap it into.
 */
export function tuiFrame(state, { columns = 80, rows = 24, tone, g, unicode = true, now = 0, profile, links = false } = {}) {
  // The last column stays empty, the way statusLine leaves it (term.mjs): a
  // terminal that does not honour the wrap-off mode would wrap a full row.
  // The run is the one exception, and wraps on purpose.
  const width = columns - 1;
  const plain = unicode ? (l) => l : asciiOnly;
  const fill = (lines, run = null) => {
    const out = lines.slice(0, rows).map((l, i) => (run && i >= run.row && i < run.row + run.rows ? l : fitPainted(plain(l), width, g.ellipsis)));
    while (out.length < rows) out.push("");
    return out;
  };
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    const times = unicode ? "×" : "x";
    return { lines: fill([`${tone.muted}too small ${g.dash} ${MIN_COLUMNS}${times}${MIN_ROWS} at least${tone.reset}`]), top: state.top, run: null };
  }
  const look = { tone, g, unicode, now, links, skin: skinOf(profile ?? (tone.reset ? "ansi16" : "none")) };
  if (state.signin || state.codexSignin) {
    const page = state.signin ? signinLines(state, rows - 3, width, columns, look) : codexSigninLines(state, rows - 3, width, columns, look);
    const run = page.run ? { ...page.run, row: page.run.row + 1 } : null;
    const lines = [titleBar(state, width, look), ...page.lines, noticeLine(state, look), footerLine(state, width, look)];
    return { lines: fill(lines, run), top: state.top, run };
  }
  const body = bodyLines(state, rows - 3, width, look);
  const lines = [titleBar(state, width, look), ...body.lines, noticeLine(state, look), footerLine(state, width, look)];
  const over = state.help ? withHelp(lines, width, look) : state.menu ? withMenu(lines, state, width, look) : lines;
  return { lines: fill(over), top: body.top, run: null };
}

// ── the look ────────────────────────────────────────────────────────────────

// Rider Black's own (src/web/themes), the deck's default theme, so the
// terminal and the page are one product: the chrome, the selection, the text
// on them. Every background carries its own text colour, since the terminal's
// may be a dark one on a light theme.
const LIGHT = [223, 225, 229];
const CHROME = [43, 45, 48];
const SELECTION = [46, 67, 110];
const KEYCAP = [57, 59, 64];
const TRACK = [78, 81, 88];
const FADED = [92, 95, 102];

/**
 * The backgrounds, as far as the profile reaches, and the two greys drawn on
 * the terminal's own: the meters' track and the screen under the keys. 16
 * colours keep two backgrounds — the lit row and the keys — in the terminal's
 * own blue and in reverse; "none" keeps none, and the pointer alone says
 * which row is selected.
 */
function skinOf(profile) {
  const deep = profile === "truecolor" || profile === "ansi256";
  const paint = (layer, rgb) => (deep ? fg(rgb, profile, "").replace("\x1b[38;", `\x1b[${layer};`) : "");
  const on = (rgb) => (deep ? `${paint(48, rgb)}${paint(38, LIGHT)}` : "");
  const sixteen = profile === "ansi16";
  return {
    raised: on(CHROME),
    select: deep ? on(SELECTION) : sixteen ? "\x1b[44;97m" : "",
    cap: deep ? on(KEYCAP) : sixteen ? "\x1b[7m" : "",
    track: deep ? paint(38, TRACK) : sixteen ? "\x1b[2m" : "",
    faded: deep ? paint(38, FADED) : sixteen ? "\x1b[2m" : "",
  };
}

/** `s` on a background, put back after every reset inside it. */
const onBg = (s, bg) => (bg ? `${bg}${s.replaceAll("\x1b[0m", `\x1b[0m${bg}`)}\x1b[0m` : s);
const padEnd = (s, n) => s + " ".repeat(Math.max(0, n - textWidth(s)));
const padStart = (s, n) => " ".repeat(Math.max(0, n - textWidth(s))) + s;
/** A painted line exactly `n` columns wide: cut, or padded. */
function cells(s, n, ellipsis) {
  const fitted = fitPainted(s, n, ellipsis);
  return fitted + " ".repeat(Math.max(0, n - textWidth(fitted)));
}
const pad = (n) => Array.from({ length: Math.max(0, n) }, () => "");

const BOX = {
  unicode: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};

/**
 * A panel `width` by `height`, borders included: its title and `note` on the
 * top border, `footLeft` and `footRight` on the bottom one, `lines` inside and
 * the `selected` one lit across the whole row. A note or a foot may be a list,
 * longest first: the border takes the first that fits.
 */
function panel(width, height, { title = "", note = "", footLeft = "", footRight = "", lines = [], selected = -1 }, look) {
  const { tone, g, unicode, skin } = look;
  const b = unicode ? BOX.unicode : BOX.ascii;
  const inner = width - 4;
  const side = `${tone.muted}${b.v}${tone.reset}`;
  const body = [];
  for (let i = 0; i < height - 2; i++) {
    const cell = cells(lines[i] ?? "", inner, g.ellipsis);
    body.push(i === selected && skin.select ? `${side}${onBg(` ${cell} `, skin.select)}${side}` : `${side} ${cell} ${side}`);
  }
  return [rule(width, b.tl, b.tr, title, note, look), ...body, rule(width, b.bl, b.br, footLeft, footRight, look)];
}

/** A border: a corner, the left words, the rule, the right words, a corner. */
function rule(width, l, r, left, right, { tone, g, unicode }) {
  const h = unicode ? BOX.unicode.h : BOX.ascii.h;
  const room = width - 4;
  const lefts = [].concat(left);
  left = lefts.find(t => !t || textWidth(t) + 3 <= room) ?? fitPainted(lefts.at(-1), Math.max(0, room - 3), g.ellipsis);
  const lw = left ? textWidth(left) + 2 : 0;
  const said = [].concat(right).find(t => !t || lw + textWidth(t) + 3 <= room) ?? "";
  const rw = said ? textWidth(said) + 2 : 0;
  const line = (n) => `${tone.muted}${h.repeat(Math.max(0, n))}${tone.reset}`;
  return `${tone.muted}${l}${h}${tone.reset}${left ? ` ${left} ` : ""}${line(room - lw - rw)}${said ? ` ${said} ` : ""}`
    + `${tone.muted}${h}${r}${tone.reset}`;
}

/**
 * A meter `width` cells long: a heavy line for what is used, to the half
 * cell, over a light one for the rest. Thin, so a column of them reads as a
 * table rather than as blocks, and drawn in text colour alone, so it sits as
 * well on a light terminal as on a dark one — and the two weights tell used
 * from free with no colour at all. ASCII is the commands' own `#` and `.`.
 */
function gauge(pct, width, { tone, unicode, skin }) {
  const colour = pctTone(pct, tone);
  if (!unicode) return `${colour}${meter(pct, { cells: width, unicode })}${tone.reset}`;
  const p = Math.min(100, Math.max(0, Number(pct) || 0));
  const halves = Math.round((p / 100) * width * 2);
  const full = Math.floor(halves / 2);
  const half = halves % 2;
  return `${colour}${"━".repeat(full)}${half ? "╸" : ""}${tone.reset}${skin.track}${"─".repeat(width - full - half)}${tone.reset}`;
}

// ── the rows around the panels ──────────────────────────────────────────────

/** A reading this recent says the screen is live. The sessions are read every
 *  three seconds, so a deck that answers never lets it lapse. */
const LIVE_MS = 10_000;

function titleBar(state, width, { tone, g, unicode, now, skin }) {
  // Claude | Codex, the side shown lit, once the deck has a Codex side: a
  // tab where the colours draw one, brackets where they do not.
  const tab = (label, lit) => (lit
    ? skin.select ? onBg(`${tone.bold} ${label} `, skin.select) : `${tone.bold}[${label}]${tone.reset}`
    : `${tone.muted} ${label} ${tone.reset}`);
  const sides = hasCodex(state) || onCodex(state);
  const what = sides ? `${tab("Claude", !onCodex(state))}${tab("Codex", onCodex(state))}` : `${tone.bold}Claude accounts${tone.reset}`;
  const left = `  ${tone.accent}${tone.bold}ccdeck${tone.reset}  ${what}`;
  let right = "";
  if (state.deck) {
    const ago = state.readAt == null ? null : now - state.readAt;
    const where = `deck ${state.deck.port}`;
    right = ago == null ? `${tone.muted}${where}${tone.reset}`
      : ago < LIVE_MS ? `${tone.ok}${unicode ? "●" : "*"}${tone.reset} ${tone.muted}live ${g.bullet} ${where}${tone.reset}`
      : `${tone.warn}${unicode ? "○" : "o"}${tone.reset} ${tone.muted}read ${sinceLabel(ago)} ago ${g.bullet} ${where}${tone.reset}`;
  } else if (state.starting) right = `${tone.muted}starting the deck${g.ellipsis}${tone.reset}`;
  else if (state.silent.length) right = `${tone.warn}deck ${state.silent.map(d => d.port).join(", ")} not answering${tone.reset}`;
  else if (state.source === "local") right = `${tone.muted}no deck ${g.bullet} claude-swap's store${tone.reset}`;
  const gap = width - textWidth(left) - textWidth(right) - 2;
  const line = right && gap >= 2 ? `${left}${" ".repeat(gap)}${right}  ` : left;
  return skin.raised ? onBg(cells(line, width, g.ellipsis), skin.raised) : line;
}

const NOTICE_MARK = { ok: ["ok", "ok"], err: ["err", "fail"], warn: ["warn", "warn"], info: ["accent", "arrow"] };

function noticeLine(state, { tone, g, unicode, now }) {
  if (state.busy) {
    const frames = spinnerFrames(unicode);
    const spin = frames[Math.floor((now - state.busy.since) / 100) % frames.length];
    return `  ${tone.accent}${spin}${tone.reset}  ${tone.muted}${state.busy.text}${g.ellipsis}${tone.reset}`;
  }
  const n = state.notice;
  if (!n || (n.until != null && now > n.until)) return "";
  const [toneName, glyph] = NOTICE_MARK[n.tone] ?? NOTICE_MARK.info;
  return `  ${tone[toneName]}${g[glyph]}${tone.reset}  ${n.tone === "err" ? tone.err : ""}${oneLine(n.text)}${tone.reset}`;
}

/** The keys, as many as fit, the ones that leave and explain kept to the last.
 *  Each key is a cap where the terminal can draw one. */
function footerLine(state, width, { tone, unicode, skin }) {
  const keys = state.signin ? signinKeys(state.signin) : state.codexSignin ? codexSigninKeys(state.codexSignin) : [
    [unicode ? "↑↓" : "up/down", "move"],
    ["enter", "switch"],
    ["m", "actions"],
    ...(hasCodex(state) || onCodex(state) ? [["c", onCodex(state) ? "Claude" : "Codex"]] : []),
    ["b", "best"],
    state.deck ? ["a", "auto-switch"] : ["d", "start the deck"],
    ["+", "add"],
    ["r", "refresh"],
    ["?", "keys"],
    ["q", "quit"],
  ];
  const cap = (k) => (skin.cap ? `${skin.cap} ${k} ${tone.reset}` : `${tone.bold}${k}${tone.reset}`);
  const draw = (list) => `${skin.cap ? " " : "  "}${list.map(([k, what]) => `${cap(k)} ${tone.muted}${what}${tone.reset}`).join("  ")}`;
  const list = keys.slice();
  // r goes first, then the moves, then b: the screen says what they do, and ?
  // and q are how to find out and how to leave.
  for (const drop of ["r", unicode ? "↑↓" : "up/down", "b", "+", "a", "d", "m", "c", "enter"]) {
    if (textWidth(draw(list)) <= width) break;
    const i = list.findIndex(([k]) => k === drop);
    if (i !== -1) list.splice(i, 1);
  }
  return draw(list);
}

// ── the panels ──────────────────────────────────────────────────────────────

function bodyLines(state, room, width, look) {
  const { tone, g, unicode } = look;
  const rows = accountsOf(state, look.now);
  const home = homeSlot(state);
  const at = atOf(state);
  const selected = rows[at] ?? null;
  const inner = width - 4;

  let accounts;
  if (onCodex(state)) {
    accounts = !state.deck ? [`${tone.muted}the Codex accounts are the deck's ${g.dash} d starts one${tone.reset}`]
      : !state.codex ? [`${tone.muted}reading the Codex accounts${g.ellipsis}${tone.reset}`]
      : !rows.length ? [`${tone.muted}no Codex accounts yet ${g.dash} + signs one in${tone.reset}`]
      : accountRows(rows, { home: null, at, width: inner }, look);
  } else if (!state.roster) accounts = [`${tone.muted}reading the accounts${g.ellipsis}${tone.reset}`];
  else if (!state.roster.ok && state.roster.reason === "no_accounts" && state.deck) {
    accounts = [`${tone.muted}no Claude accounts yet ${g.dash} + signs one in${tone.reset}`];
  } else if (!state.roster.ok) {
    // Wrapped, not cut: these are what to do next, a command among them.
    accounts = [].concat(state.trouble ?? "could not read the accounts")
      .flatMap((l, i) => wrap(String(l), inner).map(part => `${i ? tone.muted : tone.warn}${part}${tone.reset}`));
  } else if (!rows.length) accounts = [`${tone.muted}no Claude accounts yet${tone.reset}`];
  else accounts = accountRows(rows, { home, at, width: inner }, look);
  const listed = rows.length > 0 && (onCodex(state) || Boolean(state.roster?.ok));
  const auto = autoSummary(state, look);
  const waiting = waitingOf(state);

  // The list, scrolled so the selection is on it; when it does not fit whole
  // its bottom border says which rows are showing.
  const accountsPanel = (shownRows, height) => {
    let top = 0;
    let shown = accounts;
    let where = "";
    if (shownRows < accounts.length) {
      top = listed ? Math.min(Math.max(0, state.top, at - shownRows + 1), at, accounts.length - shownRows) : 0;
      shown = accounts.slice(top, top + shownRows);
      if (listed) where = `${tone.muted}${top + 1}${unicode ? "–" : "-"}${top + shown.length} of ${accounts.length}${tone.reset}`;
    }
    const lines = panel(width, height, {
      title: `${tone.bold}Accounts${tone.reset}`, footLeft: where, footRight: auto, lines: shown, selected: listed ? at - top : -1,
    }, look);
    return { lines, top };
  };

  // The waiting sessions have a panel only while somebody waits: the rest of
  // the time the room is the machine's, and the count of the sessions at work
  // is on its foot.
  const someoneWaits = waiting.list.length > 0;
  const working = waiting.read && !someoneWaits ? waiting.working : 0;
  const machineFor = (panelW, height) => panel(panelW, height, machinePanel(state.machine, {
    width: panelW - 4, height: height - 2, look, working, deck: Boolean(state.deck), starting: state.starting,
    view: state.machineView, history: state.history,
  }), look);
  // What the charts ask for before the panels above them give way; before the
  // first reading the panel has one line to say so, and asks for no more.
  const chartsWant = state.machine?.count > 0 ? 6 : 1;

  const stacked = () => {
    const detail = selected ? detailPanel(selected, home, inner, look) : null;
    let accountRoom = accounts.length;
    let showDetail = Boolean(detail);
    let max = waiting.list.length;
    let asks = true;
    let showWaiting = someoneWaits || !state.deck;
    let machineMin = chartsWant;
    let showMachine = Boolean(state.deck);
    const sessions = () => sessionsPanel(state, waiting, { max, asks, width: inner }, look);
    const need = () => 2 + accountRoom + (showDetail ? 2 + detail.lines.length : 0)
      + (showWaiting ? 2 + sessions().lines.length : 0) + (showMachine ? 2 + machineMin : 0);
    const giveWay = [
      () => max > 1 && (max--, true),
      () => showDetail && !(showDetail = false),
      () => asks && someoneWaits && !(asks = false),
      () => showMachine && machineMin > 3 && (machineMin--, true),
      () => accountRoom > 3 && (accountRoom--, true),
      () => showMachine && machineMin > 1 && (machineMin--, true),
      // Somebody waiting on you is the one thing here that is somebody's
      // work stopped: the charts go first.
      () => showMachine && someoneWaits && !(showMachine = false),
      () => showWaiting && showMachine && !(showWaiting = false),
      () => showMachine && !(showMachine = false),
      () => showWaiting && !(showWaiting = false),
      () => accountRoom > 1 && (accountRoom--, true),
    ];
    while (need() > room && giveWay.some(step => step()));
    // What the detail gave up may hold a waiting session it cost.
    while (showWaiting && max < waiting.list.length && (max++, need() > room ? (max--, false) : true));
    // The last panel takes the rows left over.
    const spare = Math.max(0, room - need());
    const list = accountsPanel(accountRoom, 2 + accountRoom + (showDetail || showWaiting || showMachine ? 0 : spare));
    const out = [...list.lines];
    if (showDetail) out.push(...panel(width, 2 + detail.lines.length + (showWaiting || showMachine ? 0 : spare), detail, look));
    if (showWaiting) {
      const s = sessions();
      out.push(...panel(width, 2 + s.lines.length + (showMachine ? 0 : spare), s, look));
    }
    if (showMachine) out.push(...machineFor(width, 2 + machineMin + spare));
    return { lines: out, top: list.top };
  };

  // From WIDE_COLUMNS, while somebody waits: the detail and the waiting side by
  // side under the list, and the machine under both.
  const sideBySide = () => {
    const leftW = Math.floor((width - 1) / 2);
    const rightW = width - 1 - leftW;
    const detail = detailPanel(selected, home, leftW - 4, look);
    let accountRoom = accounts.length;
    let max = waiting.list.length;
    let asks = true;
    let machineMin = chartsWant;
    let showMachine = Boolean(state.deck);
    const sessions = () => sessionsPanel(state, waiting, { max, asks, width: rightW - 4 }, look);
    const pair = () => 2 + Math.max(detail.lines.length, sessions().lines.length);
    const need = () => 2 + accountRoom + pair() + (showMachine ? 2 + machineMin : 0);
    const giveWay = [
      () => max > 1 && (max--, true),
      () => showMachine && machineMin > 3 && (machineMin--, true),
      () => accountRoom > 3 && (accountRoom--, true),
      () => asks && !(asks = false),
      () => showMachine && machineMin > 1 && (machineMin--, true),
    ];
    while (need() > room && giveWay.some(step => step()));
    if (need() > room) return null;
    const list = accountsPanel(accountRoom, 2 + accountRoom);
    const height = showMachine ? pair() : room - list.lines.length;
    const left = panel(leftW, height, detail, look);
    const right = panel(rightW, height, sessions(), look);
    const out = [...list.lines, ...left.map((l, i) => `${l} ${right[i]}`)];
    if (showMachine) out.push(...machineFor(width, room - out.length));
    return { lines: out, top: list.top };
  };

  const laid = (width >= WIDE_COLUMNS - 1 && selected && someoneWaits && sideBySide()) || stacked();
  return { lines: [...laid.lines, ...pad(room - laid.lines.length)].slice(0, room), top: laid.top };
}

const LANE_IDS = ["five_hour", "seven_day"];

/** The held-out mark: ASCII's, and Unicode's pause-like double bar. */
const HELD_MARK = ["=", "‖"];

/** A lane's columns: its label, the meter and the percentage, and the reset —
 *  all of it (A), without the reset (B), or the percentage alone (C). */
const laneWidth = (kind, bar, labelW) => (kind === "A" ? labelW + bar + 17 : kind === "B" ? labelW + bar + 6 : labelW + 5);

/**
 * The roster, one account per row: the pointer, the account in use, the slot,
 * the home mark, the alias, the email and its two lanes.
 *
 * The lanes take the room the names leave them: a meter and the reset each on
 * a wide screen, the meter alone on a middling one, the percentages on a
 * narrow one — and only then the alias goes. The email keeps twenty columns,
 * or all of itself when it is shorter; on a wide screen what it does not need
 * goes to the meters.
 */
function accountRows(rows, { home, at, width }, look) {
  const { tone, g, unicode } = look;
  const aliasOf = (a) => oneLine(a.alias);
  const emailOf = (a) => oneLine(a.email) || "(no email)";
  const numW = Math.max(...rows.map(a => String(a.num).length));
  const showHome = home != null && rows.some(a => a.num === home);
  const showHeld = rows.some(a => a.disabled);
  const labelW = Math.max(2, ...rows.flatMap(a => (a.lanes ?? []).filter(l => LANE_IDS.includes(l.id)).map(l => textWidth(oneLine(l.label)))));
  const longest = Math.max(...rows.map(a => textWidth(emailOf(a))));
  const aliasW = Math.min(14, Math.max(0, ...rows.map(a => textWidth(aliasOf(a)))));
  const lead = (alias) => 2 + 2 + numW + 1 + (showHome ? 2 : 0) + (showHeld ? 2 : 0) + (alias ? aliasW + 2 : 0);
  const lanesW = ({ kind, bar }) => 2 * laneWidth(kind, bar, labelW) + 3;
  const want = Math.min(longest, 20);
  const tries = [["A", 10], ["A", 8], ["A", 6], ["B", 10], ["B", 8], ["B", 6], ["B", 4], ["C", 0]];
  let pick = null;
  for (const alias of aliasW ? [true, false] : [false]) {
    const fit = tries.find(([kind, bar]) => width - lead(alias) - 2 - lanesW({ kind, bar }) >= want);
    if (fit) { pick = { alias, kind: fit[0], bar: fit[1] }; break; }
  }
  pick ??= { alias: false, kind: "C", bar: 0 };
  const emailW = Math.max(6, Math.min(longest, width - lead(pick.alias) - 2 - lanesW(pick)));
  if (pick.kind !== "C") {
    const spare = width - lead(pick.alias) - emailW - 2 - lanesW(pick);
    pick.bar = Math.min(20, pick.bar + Math.max(0, Math.floor(spare / 2)));
  }

  return rows.map((a, i) => {
    const pointer = i === at ? `${tone.accent}${tone.bold}${unicode ? "›" : ">"}${tone.reset}` : " ";
    const mark = a.active ? `${tone.ok}${g.pulse}${tone.reset}` : " ";
    const num = `${a.active ? tone.bold : ""}${padStart(String(a.num), numW)}${tone.reset}`;
    const house = !showHome ? "" : a.num === home ? `${tone.accent}${unicode ? "⌂" : "H"}${tone.reset} ` : "  ";
    // Held out of rotation: a mark of its own, the usage still beside it —
    // it is still an account to switch to, and the room it has still counts.
    const held = !showHeld ? "" : a.disabled ? `${tone.warn}${HELD_MARK[unicode ? 1 : 0]}${tone.reset} ` : "  ";
    const alias = pick.alias ? `${tone.accent}${padEnd(clip(aliasOf(a), aliasW, g.ellipsis), aliasW)}${tone.reset}  ` : "";
    const email = `${a.disabled ? tone.muted : ""}${padEnd(clip(emailOf(a), emailW, g.ellipsis), emailW)}${tone.reset}`;
    const trouble = troubleOf(a);
    const status = trouble ? `${tone[trouble.tone]}${trouble.word}${tone.reset}` : laneCells(a, pick, labelW, look);
    return `${pointer} ${mark} ${num} ${house}${held}${alias}${email}  ${status}`;
  });
}

function laneCells(a, { kind, bar }, labelW, look) {
  const { tone, g, now } = look;
  const lanes = LANE_IDS.map(id => (a.lanes ?? []).find(l => l.id === id) ?? null);
  if (!lanes.some(Boolean)) return `${tone.muted}${a.fetchedAt == null ? "not read yet" : "no usage reading"}${tone.reset}`;
  return lanes.map(l => {
    if (!l) return " ".repeat(laneWidth(kind, bar, labelW));
    const head = `${tone.muted}${padEnd(oneLine(l.label), labelW)}${tone.reset} `;
    const pct = `${pctTone(l.pct, tone)}${padStart(`${Math.round(l.pct)}%`, 4)}${tone.reset}`;
    if (kind === "C") return `${head}${pct}`;
    if (kind === "B") return `${head}${gauge(l.pct, bar, look)} ${pct}`;
    const until = untilReset(l.resetAt, now);
    return `${head}${gauge(l.pct, bar, look)} ${pct}  ${tone.muted}${padEnd(until ? `${g.restart} ${until}` : "", 9)}${tone.reset}`;
  }).join("   ");
}

/** What the trouble on an account means for a switch to it. */
const TROUBLE_SAYS = {
  "sign-in needed": "its login has expired; enter signs it in again, keeping its slot, alias and history",
  "not collecting usage": "nothing has been read for it in half a day, so these are its last numbers",
};

/** What is wrong with a row, for the list and the detail: a Codex account's
 *  issue, or what a Claude account's trouble is called. */
const troubleOf = (a) => (a.codex ? (a.issue ? { word: a.issue.word, tone: a.issue.tone } : null) : accountTrouble({ ...a, disabled: false }));

/** The deck's hint, run on after a dash: its first letter small. */
const sentenceLower = (s) => (s ? s[0].toLowerCase() + s.slice(1) : "");

/** A Codex plan as its name reads: Plus, Pro, Team. */
const planWord = (plan) => oneLine(plan).replace(/^./, c => c.toUpperCase());

/** What holding an account out means, the deck's own word for it. */
const HELD_SAYS = "held out of rotation — Auto-switch passes over it; enter still switches to it, o puts it back";

/** The selected account at length: what it is, what is wrong, every lane. */
function detailPanel(a, home, width, look) {
  const { tone, g, now } = look;
  const sep = ` ${tone.muted}${g.bullet}${tone.reset} `;
  const tags = [
    a.active ? `${tone.ok}in use${tone.reset}` : "",
    a.num === home ? `${tone.accent}home${tone.reset}` : "",
    a.disabled ? `${tone.warn}held out${tone.reset}` : "",
    a.plan ? `${tone.muted}${planWord(a.plan)}${tone.reset}` : "",
  ].filter(Boolean);
  const read = a.fetchedAt != null ? `${a.stale ? tone.warn : tone.muted}read ${sinceLabel(now - a.fetchedAt)} ago${tone.reset}` : "";
  const note = [[...tags, read].filter(Boolean).join(sep), tags.join(sep)];
  const title = `${tone.bold}${accountName(a)}${tone.reset}`;
  const trouble = troubleOf(a);
  const said = [
    ...(trouble ? wrap(`${trouble.word} ${g.dash} ${a.codex ? sentenceLower(a.issue.hint) : TROUBLE_SAYS[trouble.word] ?? ""}`, width).map(l => `${tone[trouble.tone]}${l}${tone.reset}`) : []),
    ...(a.disabled ? wrap(HELD_SAYS.replace("—", g.dash), width).map(l => `${tone.muted}${l}${tone.reset}`) : []),
  ];
  const lanes = a.lanes ?? [];
  if (!lanes.length) {
    return { title, note, lines: [...said, `${tone.muted}${a.fetchedAt == null ? "not read yet" : "no usage reading"}${tone.reset}`] };
  }
  const labelW = Math.max(2, ...lanes.map(l => textWidth(oneLine(l.label))));
  const untils = lanes.map(l => untilReset(l.resetAt, now));
  const untilW = Math.max(0, ...untils.map(u => u.length));
  // The reset in words where it fits, as a mark where it does not, and not at
  // all on a screen that would have to cut the meter for it.
  const fixed = labelW + 2 + 5;
  const words = untilW ? 3 + "resets in ".length + untilW : 0;
  const mark = untilW ? 2 + 2 + untilW : 0;
  const tail = width - fixed - words >= 12 ? words : width - fixed - mark >= 8 ? mark : 0;
  const bar = Math.max(4, Math.min(40, width - fixed - tail));
  return {
    title,
    note,
    lines: [...said, ...lanes.map((l, i) => {
      const u = untils[i];
      const reset = !tail || !u ? "" : tail === words ? `   ${tone.muted}resets in ${u}${tone.reset}` : `  ${tone.muted}${g.restart} ${u}${tone.reset}`;
      return `${tone.muted}${padEnd(oneLine(l.label), labelW)}${tone.reset}  ${gauge(l.pct, bar, look)}`
        + `${pctTone(l.pct, tone)}${padStart(`${Math.round(l.pct)}%`, 5)}${tone.reset}${reset}`;
    })],
  };
}

const NEXT_WORDS = { room: "most room", weekly: "soonest weekly reset" };

/** Auto-switch in the list's bottom border, longest first. */
function autoSummary(state, { tone, g }) {
  const auto = !state.deck ? null : onCodex(state) ? state.codexAuto : state.auto;
  if (!auto || auto.ok === false) return "";
  const sep = ` ${g.bullet} `;
  const external = auto.external ? `${sep}${tone.warn}your own cswap auto is running${tone.reset}` : "";
  if (auto.enabled !== true) return [`${tone.muted}Auto-switch off${tone.reset}${external}`, `${tone.muted}Auto-switch off${tone.reset}`, `${tone.muted}auto off${tone.reset}`];
  const threshold = Number(auto.settings?.["autoswitch.threshold"]?.value);
  const parts = [Number.isFinite(threshold) ? `at ${Math.round(threshold)}%` : "", `next: ${NEXT_WORDS[auto.choice?.next] ?? NEXT_WORDS.room}`].filter(Boolean);
  const on = `${tone.muted}Auto-switch${tone.reset} ${tone.ok}on${tone.reset}`;
  return [
    `${on}${tone.muted}${sep}${parts.join(sep)}${tone.reset}${external}`,
    `${on}${tone.muted}${sep}${parts.join(sep)}${tone.reset}`,
    `${on}${parts[0] && parts.length > 1 ? `${tone.muted}${sep}${parts[0]}${tone.reset}` : ""}`,
    on,
    `${tone.muted}auto${tone.reset} ${tone.ok}on${tone.reset}`,
  ];
}

function waitingOf(state) {
  if (!state.deck || !Array.isArray(state.sessions)) return { read: false, list: [], working: 0, skew: 0 };
  // The one waiting longest first: it is the one most likely to have stopped
  // someone's work.
  const list = state.sessions.filter(s => s.state === "waiting")
    .sort((x, y) => (x.since ?? x.lastEventAt ?? 0) - (y.since ?? y.lastEventAt ?? 0));
  const working = state.sessions.filter(s => s.state === "working").length;
  return { read: true, list, working, skew: state.skew ?? 0 };
}

/** The sessions waiting on you, the first `max` of them, the question under
 *  each while `asks`; or what stands in for them with no deck. */
function sessionsPanel(state, waiting, { max, asks, width }, look) {
  const { tone, g, now } = look;
  const plain = (toneCode, text) => wrap(text, width).map(l => `${toneCode}${l}${tone.reset}`);
  const sessionsTitle = `${tone.bold}Sessions${tone.reset}`;
  if (!state.deck) {
    const lines = state.starting ? plain(tone.muted, `starting the deck${g.ellipsis}`)
      : state.silent.length ? plain(tone.warn, `the deck on ${state.silent.map(d => d.port).join(", ")} is running but did not answer`)
      : state.source === "local" ? plain(tone.muted, `no deck is running ${g.dash} d starts one in the background`)
      : plain(tone.muted, `looking for the deck${g.ellipsis}`);
    return { title: sessionsTitle, lines };
  }
  if (!waiting.read) return { title: sessionsTitle, lines: plain(tone.muted, `reading the sessions${g.ellipsis}`) };
  const working = waiting.working ? `${tone.muted}${waiting.working} working${tone.reset}` : "";
  if (!waiting.list.length) return { title: sessionsTitle, note: working, lines: plain(tone.muted, "nobody is waiting on you") };
  const shown = waiting.list.slice(0, max);
  const more = waiting.list.length - shown.length;
  return {
    title: `${tone.warn}${tone.bold}Waiting on you${tone.reset} ${tone.muted}${g.bullet} ${waiting.list.length}${tone.reset}`,
    note: working,
    footLeft: more > 0 ? [`${tone.muted}${more} more ${g.dash} ccdeck sessions${tone.reset}`, `${tone.muted}${more} more${tone.reset}`] : "",
    lines: waitingRows(shown, { asks, width, now: now + waiting.skew }, look),
  };
}

/** One row a session — the mark, how long it has waited, its name, the agent —
 *  and its question under the name, in its own words. */
function waitingRows(list, { asks, width, now }, { tone, g }) {
  const label = (s) => oneLine(s.name) || oneLine(s.project) || oneLine(s.id).slice(0, 8);
  const ages = list.map(s => sinceLabel(now - (s.since ?? s.lastEventAt ?? now)));
  const ageW = Math.max(...ages.map(a => a.length));
  const lead = textWidth(g.warn) + 2 + ageW + 2;
  const agentOf = (s) => (s.provider === "codex" ? "Codex" : "Claude");
  // The agent column gives way first — the model, then the agent — so the
  // name, which is how a person tells two sessions apart, keeps its room.
  const tails = [
    (s) => `${agentOf(s)}${shortModel(s.model) ? ` ${g.bullet} ${shortModel(s.model)}` : ""}`,
    (s) => agentOf(s),
    () => "",
  ];
  const longest = Math.max(...list.map(s => textWidth(label(s))));
  const tailOf = tails.find(t => width - lead - 2 - Math.max(...list.map(s => textWidth(t(s)))) >= Math.min(longest, 12)) ?? tails[2];
  const tailW = Math.max(...list.map(s => textWidth(tailOf(s))));
  const labelW = Math.max(1, Math.min(longest, width - lead - (tailW ? tailW + 2 : 0)));
  const out = [];
  list.forEach((s, i) => {
    const tail = tailOf(s);
    const named = padEnd(clip(label(s), labelW, g.ellipsis), labelW);
    out.push(`${tone.warn}${g.warn}${tone.reset}  ${tone.muted}${padStart(ages[i], ageW)}${tone.reset}  ${tone.bold}${named}${tone.reset}`
      + `${tail ? `  ${tone.muted}${tail}${tone.reset}` : ""}`);
    if (!asks) return;
    const what = oneLine(s.waiting?.message) || (s.waiting?.kind === "asked" ? "asked a question" : "needs your permission");
    // The tool the prompt is most likely about, unless Claude Code's own
    // sentence already names it — "permission to use Bash (Bash)" says
    // nothing twice over.
    const tool = oneLine(s.waiting?.tool);
    const toolText = tool && !what.includes(tool) ? ` (${tool})` : "";
    const room = Math.max(8, width - lead - textWidth(toolText));
    out.push(`${" ".repeat(lead)}${clip(what, room, g.ellipsis)}${toolText ? `${tone.muted}${toolText}${tone.reset}` : ""}`);
  });
  return out;
}

// ── adding an account ───────────────────────────────────────────────────────
//
// The deck's own sign-in (cswap-admin.mjs startLogin), the one the Accounts
// panel's Add dialog drives (AddAccountDialog.tsx, signin-stages.ts):
// `claude auth login` on this machine prints a link, the person approves it in
// a browser, and either the CLI hears back by itself — a browser on this
// machine reaches its loopback port — or the page shows a code, which is typed
// or pasted here. Over SSH it is the code. The deck does the rest: who signed
// in, `cswap add`, and the account in use put back in front.

/** The sign-in page before anything is asked: a new account, or `email`'s
 *  expired login signed in again in place. `login` is the deck's
 *  loginState() once it has one. */
export function openSignin(email = null) {
  return { email, started: false, login: null, code: "", sending: false, lastLive: null };
}

/** The stages, in order (signin-stages.ts), and where `registering`'s steps
 *  sit among them. */
export const SIGNIN_STAGES = Object.freeze(["link", "approve", "confirm", "save"]);
const STEP_STAGE = Object.freeze({ confirm: "confirm", save: "save", restore: "save" });

/**
 * Where a started sign-in is, from the deck's own state: `{ live }` while it
 * runs, `{ failed }` once it stopped, `{ done: true }`. A flow the deck no
 * longer has (`idle`) ended at the stage last seen (`vanished`).
 */
export function signinStage(si) {
  const login = si?.login;
  switch (login?.state) {
    case "done": return { done: true };
    case "failed": return { failed: STEP_STAGE[login.step] ?? (login.url ? "approve" : "link") };
    case "idle": return { failed: si.lastLive ?? "link", vanished: true };
    case "registering": return { live: STEP_STAGE[login.step] ?? "confirm" };
    case "awaiting_code": return { live: "approve" };
    default: return { live: "link" };
  }
}

/** The deck's answer in place of the last, keeping the stage it was at, so a
 *  flow that vanishes can still say where. */
export function withLogin(state, login) {
  const si = state.signin;
  if (!si?.started) return state;
  const next = { ...si, login };
  return { ...state, signin: { ...next, lastLive: signinStage(next).live ?? si.lastLive } };
}

/** Whether the deck is still at it: what the app asks about, and what leaving
 *  has to cancel. */
export function signinRunning(si) {
  return Boolean(si?.started) && Boolean(signinStage(si).live);
}

/** How often the deck is asked where the sign-in is: a person reading a
 *  consent page, or three short commands (signin-stages.ts loginPollMs). */
export function signinPollMs(si) {
  return si?.login?.state === "registering" ? 400 : 1_500;
}

/** The longest code taken: the CLI's is well under it, a paste of a page is not. */
const CODE_MAX = 1_024;

function signinKey(state, str, key, { now, g }) {
  const si = state.signin;
  const name = key.name ?? "";
  const enter = name === "return" || name === "enter";
  const back = name === "escape" || str === "q";
  const stay = { state, effect: null };
  const close = (effect = null) => ({ state: { ...state, signin: null }, effect });
  if (!si.started) {
    if (enter) return { state, effect: { type: "signin-start" } };
    return back ? close() : stay;
  }
  const at = signinStage(si);
  if (at.done) return enter || back ? close({ type: "signin-done", account: si.login?.account ?? null }) : stay;
  if (at.failed) {
    if (enter) return { state, effect: { type: "signin-start" } };
    // The deck may still hold the flow that failed. Letting go of it is what
    // the panel's dialog does on every way out but a success (login-flow.ts) —
    // unless the deck never started ours (`local`), when the only sign-in it
    // holds is somebody else's.
    if (!back) return stay;
    return close(si.login?.local ? null : { type: "signin-cancel", quiet: true });
  }
  if (name === "escape") {
    // Past the code the deck is writing the account, and the dialog offers no
    // cancel there either: stopping half-way is how a store loses a record.
    if (at.live === "confirm" || at.live === "save") {
      return { state: { ...state, notice: note("info", `saving the account ${g.dash} a moment`, now) }, effect: null };
    }
    return close({ type: "signin-cancel" });
  }
  // The code's field: q and every other letter are its characters here.
  if (at.live !== "approve") return stay;
  const edit = (code) => ({ state: { ...state, signin: { ...si, code } }, effect: null });
  if (enter) {
    const code = si.code.trim();
    if (!code || si.sending) return stay;
    return { state: { ...state, signin: { ...si, sending: true } }, effect: { type: "signin-code", code } };
  }
  if (name === "backspace") return edit([...si.code].slice(0, -1).join(""));
  if (key.ctrl && name === "u") return edit("");
  // A code is printable ASCII with no spaces; anything else is a key that
  // means nothing here rather than a character of it.
  if (str && !key.ctrl && !key.meta && /^[\x21-\x7e]+$/.test(str)) return edit((si.code + str).slice(0, CODE_MAX));
  return stay;
}

/** The page's keys, for the footer. */
function signinKeys(si) {
  if (!si.started) return [["enter", "get the sign-in link"], ["esc", "back"]];
  const at = signinStage(si);
  if (at.done) return [["enter", "done"]];
  if (at.failed) return [["enter", "try again"], ["esc", "back"]];
  if (at.live === "approve") return [["enter", "send the code"], ["esc", "cancel"]];
  if (at.live === "link") return [["esc", "cancel"]];
  return [];
}

/** Each stage's words: still to come, under way, done (signin-stages.ts). */
const STAGE_WORDS = Object.freeze({
  link: ["Get a sign-in link", "Asking the claude CLI for a sign-in link", "Sign-in link ready"],
  approve: ["Approve in your browser", "Waiting for you to approve in the browser", "Approved in the browser"],
  confirm: ["Confirm who signed in", "Confirming who signed in", "Sign-in confirmed"],
  save: ["Save the credentials", "Saving the credentials", "Credentials saved"],
});
const STAGE_FAILED = Object.freeze({
  link: "No sign-in link came",
  approve: "The sign-in did not finish in the browser",
  confirm: "The sign-in could not be confirmed",
  save: "claude-swap could not save the account",
});
/** login-flow.ts LOGIN_VANISHED, for a sign-in the deck no longer has. */
const SIGNIN_VANISHED = "the sign-in ended before it finished — the deck restarted, or it was cancelled elsewhere";

/** A link the page may draw edge to edge: https, and nothing in it a
 *  terminal could read as anything but a character. */
const safeLink = (url) => (typeof url === "string" && /^https:\/\/[\x21-\x7e]+$/.test(url) ? url : null);

/** A reason as a sentence: a capital unless it opens on a lower-case name. */
function sentence(text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const head = /^(?:claude|claude-swap|cswap|ccdeck)\b/.test(t) ? t : t[0].toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(head) ? head : `${head}.`;
}

/** login-flow.ts restoreWarning: the account in use did not go back. */
function restoreWarning(login, g) {
  if (login?.restored !== false) return null;
  const a = login.activeAccount;
  const who = oneLine(a?.email) || (a?.num != null ? `account ${a.num}` : null);
  return who
    ? `This machine is now signed in as ${who} ${g.dash} the account you were using could not be put back. Switch back from the list.`
    : `The account you were using could not be put back ${g.dash} check which account is in use in the list.`;
}

/**
 * The page, `room` rows: the stages in a panel and under it what the person
 * does next — on the approve stage the link, edge to edge, and the code's
 * field. What gives way on a short screen is the explaining, then the panel;
 * the link and the field go last.
 */
function signinLines(state, room, width, columns, look) {
  const { tone, g, unicode, now, links } = look;
  const si = state.signin;
  const inner = width - 4;
  // Everything the deck wrote — an address, the CLI's own last words — on one
  // line, with nothing in it a terminal could take for an instruction.
  const email = oneLine(si.email);
  const error = oneLine(si.login?.error);
  const title = `${tone.bold}${email ? "Sign in again" : "Add a Claude account"}${tone.reset}`;
  const say = (text, t = tone.muted) => wrap(text, width - 2).map(l => `  ${t}${l}${tone.reset}`);
  const out = (lines, run = null) => ({ lines: [...lines, ...pad(room - lines.length)].slice(0, room), run });

  if (!si.started) {
    const what = email
      ? `claude-swap replaces the expired login in place ${g.dash} the account keeps its slot, its alias and its history ${g.dash} and the account you use now stays active.`
      : "claude-swap records the account, and the account you use now stays active.";
    const lines = [
      `${tone.bold}${email ? `Sign in again as ${email}` : "Sign in to Anthropic"}${tone.reset}`,
      "",
      ...wrap("The claude CLI on this machine makes a sign-in link to open in any browser. If that browser runs on this machine, the sign-in finishes by itself; anywhere else the page shows a code to paste here.", inner),
      "",
      ...wrap(what, inner),
    ].map((l, i) => (i ? `${tone.muted}${l}${tone.reset}` : l));
    return out(panel(width, Math.min(room, lines.length + 2), { title, lines }, look));
  }

  const at = signinStage(si);
  const frames = spinnerFrames(unicode);
  const spin = frames[Math.floor(now / 100) % frames.length];
  const stages = SIGNIN_STAGES.map((id, i) => {
    const pos = at.done ? SIGNIN_STAGES.length : SIGNIN_STAGES.indexOf(at.live ?? at.failed);
    const [later, under, did] = STAGE_WORDS[id];
    if (i < pos) return `${tone.ok}${g.ok}${tone.reset}  ${tone.muted}${did}${tone.reset}`;
    if (i > pos) return `${tone.muted}${unicode ? "·" : "."}  ${later}${tone.reset}`;
    if (at.failed) return `${tone.err}${g.fail}  ${at.vanished ? "Sign-in ended" : STAGE_FAILED[id]}${tone.reset}`;
    return `${tone.accent}${spin}${tone.reset}  ${under}`;
  });
  const left = at.live === "approve" && typeof si.login?.expiresAt === "number"
    ? Math.ceil((si.login.expiresAt - (now + (state.skew ?? 0))) / 60_000) : null;
  const clock = left >= 1 && left <= 5 ? `${tone.muted}${left} min left${tone.reset}` : "";
  const box = panel(width, stages.length + 2, { title, note: clock, lines: stages }, look);

  if (at.done) {
    const acc = si.login?.account ?? {};
    const warn = restoreWarning(si.login, g);
    const headline = acc.added === false ? "Credentials refreshed" : acc.num != null ? `Account ${acc.num} added` : "Account added";
    const who = oneLine(acc.email) || "the account";
    const lines = [
      ...box, "",
      `  ${tone.ok}${g.ok}${tone.reset}  ${tone.bold}${headline}${tone.reset}`,
      ...say(acc.added === false
        ? `${who} was already in the rotation, so its stored login was replaced with this one.`
        : warn ? `${who} is in the rotation.` : `${who} is in the rotation. The account you were using is still active.`),
      ...(warn ? say(warn, tone.warn) : []),
    ];
    return out(lines);
  }
  if (at.failed) {
    return out([...box, "", ...say(sentence(at.vanished ? SIGNIN_VANISHED : error || "the deck gave no reason"))]);
  }
  if (at.live !== "approve") {
    const doing = {
      link: "Asking the claude CLI on this machine for a sign-in link.",
      confirm: "Asking the claude CLI which account just signed in.",
      save: si.login?.step === "restore" ? "Switching this machine back to the account you were using." : "claude-swap is recording the account.",
    }[at.live];
    return out([...box, "", ...say(doing)]);
  }

  // The link, and the field for the code the page shows.
  const url = safeLink(si.login?.url);
  const caret = unicode ? "▏" : "_";
  const shown = si.code.length > width - 8 ? `${g.ellipsis}${si.code.slice(-(width - 9))}` : si.code;
  const field = si.sending
    ? `  ${tone.accent}${unicode ? "›" : ">"}${tone.reset} ${shown}  ${tone.muted}sending the code${g.ellipsis}${tone.reset}`
    : `  ${tone.accent}${unicode ? "›" : ">"}${tone.reset} ${shown}${tone.accent}${caret}${tone.reset}`;
  const refused = !si.sending && error
    ? wrap(error, width - 5).map((l, i) => `  ${tone.err}${i ? "   " : `${g.fail}  `}${l}${tone.reset}`) : [];
  const pieces = [];
  if (url) for (let i = 0; i < url.length; i += columns) pieces.push(url.slice(i, i + columns));
  const blocks = {
    box: [...box, ""],
    open: say("Open this link in any browser and approve the sign-in:", ""),
    link: url ? pieces : say(`the deck's sign-in link could not be shown ${g.dash} sign in from its Accounts panel`, tone.warn),
    gap: [""],
    paste: say("If that browser runs on this machine, this finishes by itself. Anywhere else the page shows a code: paste it here and press enter."),
    field: [field, ...refused],
    kept: say("The code goes only to the claude CLI on this machine, and is not kept."),
  };
  const order = ["box", "open", "link", "gap", "paste", "field", "kept"];
  const shownBlocks = new Set(order);
  const height = () => order.filter(b => shownBlocks.has(b)).reduce((n, b) => n + blocks[b].length, 0);
  for (const drop of ["kept", "gap", "paste", "box", "open"]) {
    if (height() <= room) break;
    shownBlocks.delete(drop);
  }
  // A link that does not fit whole is no link at all: say so instead.
  if (height() > room) blocks.link = say(`make the window taller to see the sign-in link ${g.dash} it needs ${pieces.length} rows`, tone.warn);
  const lines = [];
  let run = null;
  for (const b of order) {
    if (!shownBlocks.has(b)) continue;
    if (b === "link" && url && blocks.link === pieces) {
      run = { row: lines.length, rows: pieces.length, full: url.length % columns === 0, text: `${tone.accent}${link(url, url, links)}${tone.reset}` };
    }
    lines.push(...blocks[b]);
  }
  return out(lines, run && run.row + run.rows <= room ? run : null);
}

// ── the Codex sign-in ───────────────────────────────────────────────────────

/** The footer's keys while the Codex sign-in page is up. */
function codexSigninKeys(si) {
  const login = si.login?.state;
  if (!si.started) return [["enter", "get the code"], ["esc", "back"]];
  if (login === "done") return [["enter", "done"]];
  if (login === "failed" || login === "expired" || login === "cancelled") return [["enter", "try again"], ["esc", "back"]];
  return [["esc", "cancel"]];
}

/**
 * The Codex sign-in, a page of its own: what it does before it starts, then
 * the link — edge to edge, so the terminal makes it one link — and the code
 * to type on the page it opens, until codex says the sign-in is done.
 */
function codexSigninLines(state, room, width, columns, look) {
  const { tone, g, unicode, now, links } = look;
  const si = state.codexSignin;
  const inner = width - 4;
  const title = `${tone.bold}${si.adding ? "Add a Codex account" : `Sign in: ${oneLine(si.name)}`}${tone.reset}`;
  const quiet = (l) => `${tone.muted}${l}${tone.reset}`;
  const say = (text, t = tone.muted) => wrap(text, width - 2).map(l => `  ${t}${l}${tone.reset}`);
  const out = (lines, run = null) => ({ lines: [...lines, ...pad(room - lines.length)].slice(0, room), run });
  const box = (lines, note = "") => panel(width, Math.min(room, lines.length + 2), { title, note, lines }, look);
  const login = si.login ?? {};

  if (!si.started) {
    return out(box([
      ...wrap(`codex on this machine makes a sign-in link and a one-time code. Open the link in any browser ${g.dash} a phone works ${g.dash} and type the code there. It finishes by itself.`, inner),
      "",
      ...wrap(si.adding
        ? "The deck adds a new account for it. Codex keeps running on the account it runs on now."
        : "Signing in replaces this account's login in place: it keeps its name, settings and history.", inner),
    ].map(quiet)));
  }
  const frames = spinnerFrames(unicode);
  const spin = frames[Math.floor(now / 100) % frames.length];
  if (login.state === "done") {
    const who = oneLine(si.account);
    return out(box([
      `${tone.ok}${g.ok}${tone.reset}  ${tone.bold}Signed in${tone.reset}${who ? quiet(` as ${who}`) : ""}`,
      ...wrap(si.adding ? "The account is in the list. Codex keeps running on the account it ran on." : "Its login is replaced; the account keeps its name, settings and history.", inner - 3).map(l => quiet(`   ${l}`)),
    ]));
  }
  if (login.state === "failed" || login.state === "expired" || login.state === "cancelled") {
    const why = CODEX_LOGIN_FAILED[login.reason] ?? (login.state === "cancelled" ? "the sign-in was cancelled" : oneLine(login.reason) || "the deck gave no reason");
    return out(box(wrap(sentence(why), inner - 3).map((l, i) => `${tone.err}${i ? "   " : `${g.fail}  `}${l}${tone.reset}`)));
  }
  const url = safeLink(login.url);
  const code = oneLine(login.code);
  if (login.state !== "waiting" || !code) {
    return out(box([`${tone.accent}${spin}${tone.reset}  ${quiet(`asking codex on this machine for a sign-in code${g.ellipsis}`)}`]));
  }

  const left = typeof login.expiresAt === "number" ? Math.ceil((login.expiresAt - (now + (state.skew ?? 0))) / 60_000) : null;
  const clock = left >= 1 ? quiet(`${left} min left`) : "";
  const pieces = [];
  if (url) for (let i = 0; i < url.length; i += columns) pieces.push(url.slice(i, i + columns));
  const blocks = {
    box: [...box([`${tone.accent}${spin}${tone.reset}  waiting for the code to be entered`], clock), ""],
    open: say("Open this link in any browser:", ""),
    link: url ? pieces : say(`the deck's sign-in link could not be shown ${g.dash} sign in from its Accounts panel`, tone.warn),
    gap: [""],
    enter: say("and type this code on its page:", ""),
    code: [`    ${tone.accent}${tone.bold}${code}${tone.reset}`],
    after: ["", ...say("It finishes by itself once the page takes the code. Nothing is typed here.")],
  };
  const order = ["box", "open", "link", "gap", "enter", "code", "after"];
  const shownBlocks = new Set(order);
  const height = () => order.filter(b => shownBlocks.has(b)).reduce((n, b) => n + blocks[b].length, 0);
  for (const drop of ["after", "gap", "box"]) {
    if (height() <= room) break;
    shownBlocks.delete(drop);
  }
  if (height() > room) blocks.link = say(`make the window taller to see the sign-in link ${g.dash} it needs ${pieces.length} rows`, tone.warn);
  const lines = [];
  let run = null;
  for (const b of order) {
    if (!shownBlocks.has(b)) continue;
    if (b === "link" && url && blocks.link === pieces) {
      run = { row: lines.length, rows: pieces.length, full: url.length % columns === 0, text: `${tone.accent}${link(url, url, links)}${tone.reset}` };
    }
    lines.push(...blocks[b]);
  }
  return out(lines, run && run.row + run.rows <= room ? run : null);
}

// ── help ────────────────────────────────────────────────────────────────────

/** The keys, in a box over the screen, the screen under it faded. */
function withHelp(base, width, look) {
  const { tone, g, unicode, skin } = look;
  const keys = [
    [unicode ? "↑ ↓  j k" : "up down  j k", "move"],
    ["1-9", "the account in that slot"],
    ["enter  s", "switch to it, or sign it in again"],
    ["m", "its actions, as in the deck's account menu"],
    ["h  o", `set or clear home  ${g.bullet}  hold out, or put back`],
    ["n  v  x", `rename  ${g.bullet}  move to another slot  ${g.bullet}  remove`],
    ["b", "select the account Auto-switch would pick"],
    ["a", "turn Auto-switch on or off"],
    ["+", "add an account, signed in from any browser"],
    ["r", "read the usage again"],
    [unicode ? "c  ← →" : "c", "the Claude or the Codex accounts"],
    ["t", "the machine: live, or the last hours"],
    ["d", "start the deck, when none is running"],
    ["ctrl+l", "draw the screen again"],
    ["q  esc", "quit"],
  ];
  const marks = [
    [g.pulse, "in use"],
    [unicode ? "⌂" : "H", "Auto-switch's home"],
    [HELD_MARK[unicode ? 1 : 0], "held out of rotation"],
  ];
  const boxW = Math.min(width - 2, 66);
  const inner = boxW - 4;
  const keyW = Math.max(...keys.map(([k]) => textWidth(k))) + 3;
  const entry = ([k, what]) => wrap(what, Math.max(8, inner - keyW))
    .map((part, i) => `${tone.bold}${padEnd(i ? "" : k, keyW)}${tone.reset}${tone.muted}${part}${tone.reset}`);
  // The marks read as one legend line while it fits, one per line when it does not.
  const legend = marks.map(([k, what]) => `${k}  ${what}`).join("    ");
  const lines = [
    ...keys.flatMap(entry),
    "",
    ...(textWidth(legend) <= inner
      ? [marks.map(([k, what]) => `${tone.bold}${k}${tone.reset}  ${tone.muted}${what}${tone.reset}`).join("    ")]
      : marks.flatMap(entry)),
    "",
    ...wrap("A switch moves the live Claude login. Every running Claude session uses the new account from its next message.", inner)
      .map(l => `${tone.muted}${l}${tone.reset}`),
  ];
  const height = Math.min(base.length - 2, lines.length + 2);
  const box = panel(boxW, height, { title: `${tone.bold}Keys${tone.reset}`, footRight: `${tone.muted}any key closes${tone.reset}`, lines }, look);
  return overlay(base, box, boxW, width, look);
}

/** `box`, `boxW` wide, in the middle of the screen, the screen under it faded. */
function overlay(base, box, boxW, width, { tone, skin }) {
  const x = Math.floor((width - boxW) / 2);
  const y = Math.max(1, Math.floor((base.length - box.length) / 2));
  const faded = (s) => (s && skin.faded ? `${skin.faded}${s}${tone.reset}` : s);
  return base.map((line, i) => {
    const plain = stripAnsi(line);
    if (i < y || i >= y + box.length) return faded(plain);
    return `${faded(sliceCells(plain, 0, x))}${onBg(box[i - y], skin.raised)}${faded(sliceCells(plain, x + boxW, width))}`;
  });
}

// ── an account's menu, drawn ────────────────────────────────────────────────

/** The menu, or the one form an item turned it into, in a box over the screen. */
function withMenu(base, state, width, look) {
  const { tone, g, unicode } = look;
  const m = state.menu;
  const row = menuRow(state, m);
  if (!row) return base;
  const boxW = Math.min(width - 2, 60);
  const inner = boxW - 4;
  const say = (text, code = tone.muted) => wrap(text, inner).map(l => `${code}${l}${tone.reset}`);
  const refused = m.error ? wrap(m.error, inner - 3).map((l, i) => `${tone.err}${i ? "   " : `${g.fail}  `}${l}${tone.reset}`) : [];
  const caret = `${tone.accent}${unicode ? "▏" : "_"}${tone.reset}`;
  const field = (text) => `${tone.accent}${unicode ? "›" : ">"}${tone.reset} ${text}${caret}`;
  const name = accountName(row);
  let spec;
  if (m.view === "menu") {
    const items = menuItems(state, row);
    const keyW = Math.max(...items.map(i => textWidth(i.key)));
    const lines = [];
    let selected = -1;
    items.forEach((item, i) => {
      if (item.danger) lines.push(`${tone.muted}${(unicode ? "─" : "-").repeat(inner)}${tone.reset}`);
      if (i === m.at) selected = lines.length;
      const pointer = i === m.at ? `${tone.accent}${tone.bold}${unicode ? "›" : ">"}${tone.reset}` : " ";
      const room = inner - 2 - keyW - 2;
      const shown = padEnd(clip(item.label, room, g.ellipsis), room);
      lines.push(`${pointer} ${item.danger ? tone.err : ""}${shown}${tone.reset}  ${tone.muted}${padStart(item.key, keyW)}${tone.reset}`);
    });
    spec = {
      title: `${tone.bold}${name}${tone.reset}`,
      footRight: [`${tone.muted}enter chooses ${g.bullet} esc closes${tone.reset}`, `${tone.muted}esc closes${tone.reset}`],
      lines: [...lines, ...refused], selected,
    };
  } else if (m.view === "rename") {
    spec = {
      title: `${tone.bold}Rename ${name}${tone.reset}`,
      footRight: [`${tone.muted}enter saves ${g.bullet} esc back${tone.reset}`, `${tone.muted}esc back${tone.reset}`],
      lines: [...say(row.codex ? "A short name to show instead of the email. Empty takes it away." : "A short name the list shows beside the address. Empty takes it away."), "", field(m.draft), ...refused],
    };
  } else if (m.view === "move") {
    const slot = Number(m.draft);
    const holder = m.draft ? accountsOf(state).find(a => a.num === slot) : null;
    const hint = !m.draft ? `the slot numbers are the list's ${g.dash} 1 to 9 select them there`
      : holder && holder.num === row.num ? `it is already in slot ${slot}`
      : holder ? `slot ${slot} holds ${accountName(holder)} ${g.dash} the two trade places`
      : `slot ${slot} is free`;
    spec = {
      title: `${tone.bold}Move ${name}${tone.reset}`,
      footRight: [`${tone.muted}enter moves ${g.bullet} esc back${tone.reset}`, `${tone.muted}esc back${tone.reset}`],
      lines: [...say("To slot:", ""), field(m.draft), ...say(hint), ...refused],
    };
  } else {
    spec = {
      title: `${tone.err}${tone.bold}Remove ${name}?${tone.reset}`,
      footRight: `${tone.muted}any other key keeps it${tone.reset}`,
      lines: [
        ...(row.codex
          ? say("The deck takes this account out. Its sign-in and history are kept aside in the deck's data folder, not deleted.", "")
          : say("claude-swap deletes this account's stored login. This cannot be undone.", "")),
        ...(row.active && !row.codex ? say("It is the account in use: Claude Code stays signed in to it until the next switch.") : []),
        "",
        `${tone.bold}y${tone.reset} ${tone.muted}removes it${tone.reset}`,
        ...refused,
      ],
    };
  }
  const height = Math.min(base.length - 2, spec.lines.length + 2);
  return overlay(base, panel(boxW, height, spec, look), boxW, width, look);
}

function wrap(text, width) {
  const out = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && textWidth(`${line} ${word}`) > width) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}
