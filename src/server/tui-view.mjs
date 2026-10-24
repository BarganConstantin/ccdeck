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
import { fg, sinceLabel, spinnerFrames, stripAnsi } from "./term.mjs";

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
    skew: 0,            // the deck's clock minus this one, for the sessions' ages
    at: 0,              // the selected account, by index
    top: 0,             // the first account row on screen
    help: false,
    notice: null,       // { tone, text, until }
    busy: null,         // { text, since } while a switch or a start is under way
    starting: false,
  };
}

/** A notice. `until` null keeps it until the next key. */
export function note(tone, text, now) {
  return { tone, text, until: tone === "err" || tone === "warn" ? null : now + NOTICE_MS };
}

const accountsOf = (state) => (state.roster?.ok && Array.isArray(state.roster.accounts) ? state.roster.accounts : []);

/** Auto-switch's home account, by slot, or null. */
export function homeSlot(state) {
  const home = state.auto?.choice?.home;
  if (!home || typeof home.email !== "string") return null;
  const key = accountKey(home.email, home.orgUuid);
  return accountsOf(state).find(a => accountKey(a.email, a.orgUuid) === key)?.num ?? null;
}

/** The selection moved onto the account in slot `num`, if there is one. */
export function selectSlot(state, num) {
  const i = accountsOf(state).findIndex(a => a.num === num);
  return i === -1 ? state : { ...state, at: i };
}

/**
 * A fresh roster in place of the old one, the selection kept on the account it
 * was on — the list's order is the rotation's and can change under it — or,
 * on the first read, put on the account in use.
 */
export function withRoster(state, roster, trouble = null) {
  const before = accountsOf(state)[state.at]?.num;
  const next = { ...state, roster, trouble };
  const rows = accountsOf(next);
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
 *
 * The refusals a switch can be told before it is asked for — the account in
 * use, a login known to be dead, a deck that is running and not answering —
 * are answered here, in the words `ccdeck switch` uses.
 */
export function tuiKey(state, str, key = {}, { now = 0, g } = {}) {
  const name = key.name ?? "";
  if (key.ctrl && name === "c") return { state, effect: { type: "quit" } };
  if (key.ctrl && name === "l") return { state, effect: { type: "redraw" } };
  // Help is a page over the view: any key puts the view back, and the key is
  // spent doing it — q there closes the page, it does not quit.
  if (state.help) return { state: { ...state, help: false }, effect: null };
  if (str === "q" || name === "escape") return { state, effect: { type: "quit" } };
  if (str === "?") return { state: { ...state, help: true }, effect: null };

  const rows = accountsOf(state);
  const s = { ...state, notice: null };
  const go = (at) => ({ state: { ...s, at }, effect: null });
  const last = Math.max(0, rows.length - 1);
  if (name === "up" || str === "k") return go(rows.length ? (state.at - 1 + rows.length) % rows.length : 0);
  if (name === "down" || str === "j" || (name === "tab" && !key.shift)) return go(rows.length ? (state.at + 1) % rows.length : 0);
  if (name === "home" || str === "g") return go(0);
  if (name === "end" || str === "G") return go(last);
  if (name === "pageup") return go(Math.max(0, state.at - 5));
  if (name === "pagedown") return go(Math.min(last, state.at + 5));
  if (/^[1-9]$/.test(str ?? "")) {
    const i = rows.findIndex(a => a.num === Number(str));
    return i === -1 ? { state: s, effect: null } : go(i);
  }
  if (name === "return" || name === "enter" || str === "s") return switchKey(s, rows[state.at], { now, g });
  if (str === "b") {
    if (!rows.length) return { state: s, effect: null };
    return { state: s, effect: { type: "best" } };
  }
  if (str === "a") return autoKey(s, { now, g });
  if (str === "r") return { state: s, effect: { type: "refresh" } };
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
  if (row.active) return told("ok", `already on ${accountName(row)}`);
  // A login known to be dead: switching to it signs every running session out.
  // A disabled slot is a person's own "keep out of rotation" and switches.
  if (!switchable(row) && !row.disabled) {
    return told("err", `${accountName(row)} needs a fresh sign-in ${g.dash} switching to it would sign every running session out`);
  }
  // A deck that is alive and did not answer holds the store's lock in its own
  // process: switching beside it is the race #1039 closed.
  if (!state.deck && state.silent.length) {
    return told("err", `the deck on ${state.silent.map(d => d.port).join(", ")} is running but did not answer ${g.dash} not switching behind its back`);
  }
  return { state, effect: { type: "switch", account: row } };
}

function autoKey(state, { now, g }) {
  const told = (tone, text) => ({ state: { ...state, notice: note(tone, text, now) }, effect: null });
  if (!state.deck) return told("info", `Auto-switch runs inside the deck ${g.dash} d starts one`);
  if (state.busy) return told("info", `${state.busy.text} ${g.dash} one thing at a time`);
  if (!state.auto) return told("info", `the deck has not said whether Auto-switch is on yet`);
  return { state, effect: { type: "auto", enabled: state.auto.enabled !== true } };
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
 * "none" there is not one escape on the screen.
 */
export function tuiFrame(state, { columns = 80, rows = 24, tone, g, unicode = true, now = 0, profile } = {}) {
  // The last column stays empty, the way statusLine leaves it (term.mjs): a
  // terminal that does not honour the wrap-off mode would wrap a full row.
  const width = columns - 1;
  const fill = (lines) => {
    const out = lines.slice(0, rows).map(l => fitPainted(l, width, g.ellipsis));
    while (out.length < rows) out.push("");
    return out;
  };
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    const times = unicode ? "×" : "x";
    return { lines: fill([`${tone.muted}too small ${g.dash} ${MIN_COLUMNS}${times}${MIN_ROWS} at least${tone.reset}`]), top: state.top };
  }
  const look = { tone, g, unicode, now, skin: skinOf(profile ?? (tone.reset ? "ansi16" : "none")) };
  const body = bodyLines(state, rows - 3, width, look);
  const lines = [titleBar(state, width, look), ...body.lines, noticeLine(state, look), footerLine(state, width, look)];
  return { lines: fill(state.help ? withHelp(lines, width, look) : lines), top: body.top };
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
  const left = `  ${tone.accent}${tone.bold}ccdeck${tone.reset}  ${tone.bold}Claude accounts${tone.reset}`;
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
  return `  ${tone[toneName]}${g[glyph]}${tone.reset}  ${n.tone === "err" ? tone.err : ""}${n.text}${tone.reset}`;
}

/** The keys, as many as fit, the ones that leave and explain kept to the last.
 *  Each key is a cap where the terminal can draw one. */
function footerLine(state, width, { tone, unicode, skin }) {
  const keys = [
    [unicode ? "↑↓" : "up/down", "move"],
    ["enter", "switch"],
    ["b", "best"],
    state.deck ? ["a", "auto-switch"] : ["d", "start the deck"],
    ["r", "refresh"],
    ["?", "keys"],
    ["q", "quit"],
  ];
  const cap = (k) => (skin.cap ? `${skin.cap} ${k} ${tone.reset}` : `${tone.bold}${k}${tone.reset}`);
  const draw = (list) => `${skin.cap ? " " : "  "}${list.map(([k, what]) => `${cap(k)} ${tone.muted}${what}${tone.reset}`).join("  ")}`;
  const list = keys.slice();
  // r goes first, then b, then the moves: the screen says what they do, and ?
  // and q are how to find out and how to leave.
  for (const drop of ["r", "b", unicode ? "↑↓" : "up/down", "a", "d", "enter"]) {
    if (textWidth(draw(list)) <= width) break;
    const i = list.findIndex(([k]) => k === drop);
    if (i !== -1) list.splice(i, 1);
  }
  return draw(list);
}

// ── the panels ──────────────────────────────────────────────────────────────

function bodyLines(state, room, width, look) {
  const { tone, g, unicode } = look;
  const rows = accountsOf(state);
  const home = homeSlot(state);
  const selected = rows[state.at] ?? null;
  const inner = width - 4;

  let accounts;
  if (!state.roster) accounts = [`${tone.muted}reading the accounts${g.ellipsis}${tone.reset}`];
  else if (!state.roster.ok) {
    // Wrapped, not cut: these are what to do next, a command among them.
    accounts = [].concat(state.trouble ?? "could not read the accounts")
      .flatMap((l, i) => wrap(String(l), inner).map(part => `${i ? tone.muted : tone.warn}${part}${tone.reset}`));
  } else if (!rows.length) accounts = [`${tone.muted}no Claude accounts yet${tone.reset}`];
  else accounts = accountRows(rows, { home, at: state.at, width: inner }, look);
  const listed = rows.length > 0 && Boolean(state.roster?.ok);
  const auto = autoSummary(state, look);
  const waiting = waitingOf(state);

  // The list, scrolled so the selection is on it; when it does not fit whole
  // its bottom border says which rows are showing.
  const accountsPanel = (shownRows, height) => {
    let top = 0;
    let shown = accounts;
    let where = "";
    if (shownRows < accounts.length) {
      top = listed ? Math.min(Math.max(0, state.top, state.at - shownRows + 1), state.at, accounts.length - shownRows) : 0;
      shown = accounts.slice(top, top + shownRows);
      if (listed) where = `${tone.muted}${top + 1}${unicode ? "–" : "-"}${top + shown.length} of ${accounts.length}${tone.reset}`;
    }
    const lines = panel(width, height, {
      title: `${tone.bold}Accounts${tone.reset}`, footLeft: where, footRight: auto, lines: shown, selected: listed ? state.at - top : -1,
    }, look);
    return { lines, top };
  };

  const stacked = () => {
    const detail = selected ? detailPanel(selected, home, inner, look) : null;
    let accountRoom = accounts.length;
    let showDetail = Boolean(detail);
    let max = waiting.list.length;
    let asks = true;
    let showWaiting = true;
    const sessions = () => sessionsPanel(state, waiting, { max, asks, width: inner }, look);
    const need = () => 2 + accountRoom + (showDetail ? 2 + detail.lines.length : 0) + (showWaiting ? 2 + sessions().lines.length : 0);
    const giveWay = [
      () => max > 1 && (max--, true),
      () => showDetail && !(showDetail = false),
      () => asks && waiting.list.length > 0 && !(asks = false),
      () => accountRoom > 3 && (accountRoom--, true),
      () => showWaiting && !(showWaiting = false),
      () => accountRoom > 1 && (accountRoom--, true),
    ];
    while (need() > room && giveWay.some(step => step()));
    // What the detail gave up may hold a waiting session it cost.
    while (showWaiting && max < waiting.list.length && (max++, need() > room ? (max--, false) : true));
    // The last panel takes the rows left over.
    const spare = Math.max(0, room - need());
    const list = accountsPanel(accountRoom, 2 + accountRoom + (showDetail || showWaiting ? 0 : spare));
    const out = [...list.lines];
    if (showDetail) out.push(...panel(width, 2 + detail.lines.length + (showWaiting ? 0 : spare), detail, look));
    if (showWaiting) {
      const s = sessions();
      out.push(...panel(width, 2 + s.lines.length + spare, s, look));
    }
    return { lines: out, top: list.top };
  };

  const sideBySide = () => {
    const leftW = Math.floor((width - 1) / 2);
    const rightW = width - 1 - leftW;
    const detail = detailPanel(selected, home, leftW - 4, look);
    let accountRoom = accounts.length;
    let max = waiting.list.length;
    let asks = true;
    const sessions = () => sessionsPanel(state, waiting, { max, asks, width: rightW - 4 }, look);
    const need = () => 2 + accountRoom + 2 + Math.max(detail.lines.length, sessions().lines.length);
    const giveWay = [
      () => max > 1 && (max--, true),
      () => accountRoom > 3 && (accountRoom--, true),
      () => asks && waiting.list.length > 0 && !(asks = false),
    ];
    while (need() > room && giveWay.some(step => step()));
    if (need() > room) return null;
    const list = accountsPanel(accountRoom, 2 + accountRoom);
    const height = room - list.lines.length;
    const left = panel(leftW, height, detail, look);
    const right = panel(rightW, height, sessions(), look);
    return { lines: [...list.lines, ...left.map((l, i) => `${l} ${right[i]}`)], top: list.top };
  };

  const laid = (width >= WIDE_COLUMNS - 1 && selected && sideBySide()) || stacked();
  return { lines: [...laid.lines, ...pad(room - laid.lines.length)].slice(0, room), top: laid.top };
}

const LANE_IDS = ["five_hour", "seven_day"];

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
  const labelW = Math.max(2, ...rows.flatMap(a => (a.lanes ?? []).filter(l => LANE_IDS.includes(l.id)).map(l => textWidth(oneLine(l.label)))));
  const longest = Math.max(...rows.map(a => textWidth(emailOf(a))));
  const aliasW = Math.min(14, Math.max(0, ...rows.map(a => textWidth(aliasOf(a)))));
  const lead = (alias) => 2 + 2 + numW + 1 + (showHome ? 2 : 0) + (alias ? aliasW + 2 : 0);
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
    const alias = pick.alias ? `${tone.accent}${padEnd(clip(aliasOf(a), aliasW, g.ellipsis), aliasW)}${tone.reset}  ` : "";
    const email = `${a.disabled ? tone.muted : ""}${padEnd(clip(emailOf(a), emailW, g.ellipsis), emailW)}${tone.reset}`;
    const trouble = accountTrouble(a);
    const status = trouble ? `${tone[trouble.tone]}${trouble.word}${tone.reset}` : laneCells(a, pick, labelW, look);
    return `${pointer} ${mark} ${num} ${house}${alias}${email}  ${status}`;
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
  "sign-in needed": "its login has expired, and switching to it would sign every running session out",
  disabled: "kept out of Auto-switch's rotation; enter still switches to it",
  "not collecting usage": "nothing has been read for it in half a day, so these are its last numbers",
};

/** The selected account at length: what it is, what is wrong, every lane. */
function detailPanel(a, home, width, look) {
  const { tone, g, now } = look;
  const sep = ` ${tone.muted}${g.bullet}${tone.reset} `;
  const tags = [
    a.active ? `${tone.ok}in use${tone.reset}` : "",
    a.num === home ? `${tone.accent}home${tone.reset}` : "",
  ].filter(Boolean);
  const read = a.fetchedAt != null ? `${a.stale ? tone.warn : tone.muted}read ${sinceLabel(now - a.fetchedAt)} ago${tone.reset}` : "";
  const note = [[...tags, read].filter(Boolean).join(sep), tags.join(sep)];
  const title = `${tone.bold}${accountName(a)}${tone.reset}`;
  const trouble = accountTrouble(a);
  const said = trouble
    ? wrap(`${trouble.word} ${g.dash} ${TROUBLE_SAYS[trouble.word] ?? ""}`, width).map(l => `${tone[trouble.tone]}${l}${tone.reset}`)
    : [];
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
  const auto = state.deck ? state.auto : null;
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

// ── help ────────────────────────────────────────────────────────────────────

/** The keys, in a box over the screen, the screen under it faded. */
function withHelp(base, width, look) {
  const { tone, g, unicode, skin } = look;
  const keys = [
    [unicode ? "↑ ↓  j k" : "up down  j k", "move"],
    ["1-9", "the account in that slot"],
    ["enter  s", "switch to the selected account"],
    ["b", "select the account Auto-switch would pick"],
    ["a", "turn Auto-switch on or off"],
    ["r", "read the usage again"],
    ["d", "start the deck, when none is running"],
    ["ctrl+l", "draw the screen again"],
    ["q  esc", "quit"],
  ];
  const marks = [
    [g.pulse, "the account in use"],
    [unicode ? "⌂" : "H", "Auto-switch's home account"],
  ];
  const boxW = Math.min(width - 2, 66);
  const inner = boxW - 4;
  const keyW = Math.max(...keys.map(([k]) => textWidth(k))) + 3;
  const entry = ([k, what]) => wrap(what, Math.max(8, inner - keyW))
    .map((part, i) => `${tone.bold}${padEnd(i ? "" : k, keyW)}${tone.reset}${tone.muted}${part}${tone.reset}`);
  const lines = [
    ...keys.flatMap(entry),
    "",
    ...marks.flatMap(entry),
    "",
    ...wrap("A switch moves the live Claude login. Every running Claude session uses the new account from its next message.", inner)
      .map(l => `${tone.muted}${l}${tone.reset}`),
  ];
  const height = Math.min(base.length - 2, lines.length + 2);
  const box = panel(boxW, height, { title: `${tone.bold}Keys${tone.reset}`, footRight: `${tone.muted}any key closes${tone.reset}`, lines }, look);
  const x = Math.floor((width - boxW) / 2);
  const y = Math.max(1, Math.floor((base.length - height) / 2));
  const faded = (s) => (s && skin.faded ? `${skin.faded}${s}${tone.reset}` : s);
  return base.map((line, i) => {
    const plain = stripAnsi(line);
    if (i < y || i >= y + height) return faded(plain);
    return `${faded(sliceCells(plain, 0, x))}${onBg(box[i - y], skin.raised)}${faded(sliceCells(plain, x + boxW, width))}`;
  });
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
