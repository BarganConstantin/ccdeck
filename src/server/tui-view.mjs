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
// The rows are the commands' own (cli-lines.mjs), so the screen reads like
// `ccdeck accounts` and `ccdeck sessions` do — the same marks, the same
// colours, the same ASCII tier on a console that cannot draw a block.
import { accountName, switchable } from "./account-pick.mjs";
import { accountLines, clip, fitPainted, laneLines, sessionLines, textWidth } from "./cli-lines.mjs";
import { accountKey } from "./lan-copies.mjs";
import { sinceLabel, spinnerFrames } from "./term.mjs";

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

/**
 * The screen: `{ lines, top }`, `lines` exactly `rows` long and none of them
 * wider than `columns`, `top` the first account row shown — kept by the app
 * and handed back, so the list scrolls only when the selection leaves it.
 *
 *   header      ccdeck  Claude accounts                     deck 4317
 *   accounts    the roster's rows, the selected one pointed at
 *   detail      the selected account's every lane, a meter each
 *   auto        Auto-switch on · switches at 90% · next: most room · home #2
 *   waiting     the sessions waiting on you, their question under each
 *   notice      what the last key did
 *   footer      the keys
 *
 * When the screen is short, what gives way first is what is said elsewhere
 * too: waiting sessions beyond the first, then the detail, then the last
 * waiting session (its count stays), then the Auto-switch line, then account
 * rows (the list scrolls), and the waiting section last of all.
 */
export function tuiFrame(state, { columns = 80, rows = 24, tone, g, unicode = true, now = 0 } = {}) {
  // The last column stays empty, the way statusLine leaves it (term.mjs): a
  // terminal that does not honour the wrap-off mode would wrap a full row.
  const fill = (lines) => {
    const out = lines.slice(0, rows).map(l => fitPainted(l, columns - 1, g.ellipsis));
    while (out.length < rows) out.push("");
    return out;
  };
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    const times = unicode ? "×" : "x";
    return { lines: fill([`${tone.muted}too small ${g.dash} ${MIN_COLUMNS}${times}${MIN_ROWS} at least${tone.reset}`]), top: state.top };
  }
  // Laid out to that width, so the cut below is a guard and not the layout.
  const look = { tone, g, unicode, columns: columns - 1, now };
  const head = headerLine(state, look);
  const notice = noticeLine(state, look);
  const keys = state.help ? `  ${tone.muted}any key goes back${tone.reset}` : footerLine(state, look);
  const room = rows - 4;
  if (state.help) {
    const help = helpLines(look).slice(0, room);
    return { lines: fill([head, "", ...help, ...pad(room - help.length), notice, keys]), top: state.top };
  }

  const body = bodyLines(state, room, look);
  return { lines: fill([head, "", ...body.lines, ...pad(room - body.lines.length), notice, keys]), top: body.top };
}

const pad = (n) => Array.from({ length: Math.max(0, n) }, () => "");

function headerLine(state, { tone, g, columns }) {
  const left = `  ${tone.accent}${tone.bold}ccdeck${tone.reset}  ${tone.bold}Claude accounts${tone.reset}`;
  const right = state.deck
    ? `${tone.muted}deck ${state.deck.port}${tone.reset}`
    : state.starting
      ? `${tone.muted}starting the deck${g.ellipsis}${tone.reset}`
      : state.silent.length
        ? `${tone.warn}deck ${state.silent.map(d => d.port).join(", ")} not answering${tone.reset}`
        : state.source === "local"
          ? `${tone.muted}no deck ${g.bullet} claude-swap's store${tone.reset}`
          : "";
  const gap = columns - textWidth(left) - textWidth(right) - 1;
  return right && gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : left;
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

/** The keys, as many as fit, the ones that leave and explain kept to the last. */
function footerLine(state, { tone, unicode, columns }) {
  const keys = [
    [unicode ? "↑↓" : "up/down", "move"],
    ["enter", "switch"],
    ["b", "best"],
    state.deck ? ["a", "auto-switch"] : ["d", "start the deck"],
    ["r", "refresh"],
    ["?", "keys"],
    ["q", "quit"],
  ];
  const draw = (list) => `  ${list.map(([k, what]) => `${tone.bold}${k}${tone.reset} ${tone.muted}${what}${tone.reset}`).join("  ")}`;
  const list = keys.slice();
  // r goes first, then b, then the moves: the screen says what they do, and ?
  // and q are how to find out and how to leave.
  for (const drop of ["r", "b", unicode ? "↑↓" : "up/down", "a", "d", "enter"]) {
    if (textWidth(draw(list)) <= columns) break;
    const i = list.findIndex(([k]) => k === drop);
    if (i !== -1) list.splice(i, 1);
  }
  return draw(list);
}

function helpLines({ tone, unicode, columns }) {
  const rows = [
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
  const w = Math.max(...rows.map(([k]) => k.length)) + 3;
  return [
    `  ${tone.bold}Keys${tone.reset}`,
    "",
    ...rows.map(([k, what]) => `  ${tone.bold}${k}${tone.reset}${" ".repeat(w - k.length)}${tone.muted}${what}${tone.reset}`),
    "",
    ...wrap("A switch moves the live Claude login. Every running Claude session uses the new account from its next message.", columns - 4)
      .map(l => `  ${tone.muted}${l}${tone.reset}`),
  ];
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

function bodyLines(state, room, look) {
  const { tone, g } = look;
  const rows = accountsOf(state);
  const home = homeSlot(state);

  let accounts;
  if (!state.roster) accounts = [`  ${tone.muted}reading the accounts${g.ellipsis}${tone.reset}`];
  else if (!state.roster.ok) {
    // Wrapped, not cut: these are what to do next, a command among them.
    accounts = [].concat(state.trouble ?? "could not read the accounts")
      .flatMap((l, i) => wrap(String(l), look.columns - 2).map(part => `  ${i ? tone.muted : tone.warn}${part}${tone.reset}`));
  } else {
    const pointer = look.unicode ? "›" : ">";
    accounts = accountLines(rows, { ...look, home })
      .map((line, i) => (i === state.at && rows.length ? `${tone.accent}${tone.bold}${pointer}${tone.reset}${line.slice(1)}` : line));
  }

  const detail = rows[state.at] ? detailLines(rows[state.at], home, look) : [];
  const auto = autoLines(state, home, look);
  const waiting = state.deck ? waitingSessions(state) : null;

  let maxWaiting = waiting ? Math.min(waiting.waiting.length, 4) : 0;
  let showDetail = detail.length > 0;
  let showAuto = auto.length > 0;
  let showWaiting = Boolean(waiting);
  let accountRoom = accounts.length;
  const waitLines = () => (showWaiting ? waitingLines(waiting, maxWaiting, look) : []);
  const block = (lines) => (lines.length ? lines.length + 1 : 0);
  const need = () => accountRoom + (showDetail ? block(detail) : 0) + (showAuto ? block(auto) : 0) + block(waitLines());
  const giveWay = [
    () => maxWaiting > 1 && (maxWaiting--, true),
    () => showDetail && !(showDetail = false),
    () => maxWaiting > 0 && (maxWaiting--, true),
    () => showAuto && !(showAuto = false),
    () => accountRoom > 3 && (accountRoom--, true),
    () => showWaiting && !(showWaiting = false),
    () => accountRoom > 1 && (accountRoom--, true),
  ];
  while (need() > room && giveWay.some(step => step()));

  // The list, scrolled so the selection is on it. When it does not fit whole,
  // its last row says how much is off screen and where.
  let top = state.top;
  let shown = accounts;
  if (accountRoom < accounts.length) {
    const visible = accountRoom >= 3 ? accountRoom - 1 : accountRoom;
    top = Math.min(Math.max(0, top, state.at - visible + 1), state.at, accounts.length - visible);
    shown = accounts.slice(top, top + visible);
    if (visible < accountRoom) {
      const above = top;
      const below = accounts.length - top - visible;
      const parts = [above ? `${above} above` : "", below ? `${below} below` : ""].filter(Boolean).join(` ${g.bullet} `);
      shown = [...shown, `    ${tone.muted}${parts}${tone.reset}`];
    }
  } else top = 0;

  const out = [...shown];
  if (showDetail) out.push("", ...detail);
  if (showAuto) out.push("", ...auto);
  const wl = waitLines();
  if (wl.length) out.push("", ...wl);
  return { lines: out.slice(0, room), top };
}

/** The selected account at length: its name, what it is, and every lane. */
function detailLines(a, home, { tone, g, unicode, columns, now }) {
  const tags = [
    a.active ? `${tone.ok}in use${tone.reset}` : "",
    a.num === home ? `${tone.accent}home${tone.reset}` : "",
    a.fetchedAt != null ? `${tone.muted}read ${sinceLabel(now - a.fetchedAt)} ago${tone.reset}` : "",
  ].filter(Boolean).join(`  `);
  const tagW = tags ? textWidth(tags) + 2 : 0;
  const name = clip(accountName(a), Math.max(12, columns - 4 - tagW), g.ellipsis);
  return [
    `  ${tone.bold}${name}${tone.reset}${tags ? `  ${tags}` : ""}`,
    ...laneLines(a, { tone, unicode, columns, now, indent: "    " }),
  ];
}

const NEXT_WORDS = { room: "most room", weekly: "soonest weekly reset" };

/** One line for Auto-switch, or the reason it is not there. */
function autoLines(state, home, { tone, g }) {
  if (!state.deck) {
    if (state.source !== "local" || state.starting) return [];
    return [`  ${tone.muted}no deck is running ${g.dash} d starts one in the background${tone.reset}`];
  }
  const auto = state.auto;
  if (!auto || auto.ok === false) return [];
  const on = auto.enabled === true;
  const threshold = Number(auto.settings?.["autoswitch.threshold"]?.value);
  const parts = [
    on && Number.isFinite(threshold) ? `switches at ${Math.round(threshold)}%` : "",
    `next: ${NEXT_WORDS[auto.choice?.next] ?? NEXT_WORDS.room}`,
    home != null ? `home #${home}` : "",
  ].filter(Boolean);
  const external = auto.external ? ` ${g.bullet} ${tone.warn}your own cswap auto is running${tone.reset}` : "";
  return [`  ${tone.bold}Auto-switch${tone.reset} ${on ? `${tone.ok}on` : `${tone.muted}off`}${tone.reset}`
    + `  ${tone.muted}${parts.join(` ${g.bullet} `)}${tone.reset}${external}`];
}

function waitingSessions(state) {
  if (!Array.isArray(state.sessions)) return { read: false, waiting: [], working: 0 };
  // The one waiting longest first: it is the one most likely to have stopped
  // someone's work.
  const waiting = state.sessions.filter(s => s.state === "waiting")
    .sort((x, y) => (x.since ?? x.lastEventAt ?? 0) - (y.since ?? y.lastEventAt ?? 0));
  const working = state.sessions.filter(s => s.state === "working").length;
  return { read: true, waiting, working, skew: state.skew ?? 0 };
}

function waitingLines(w, max, { tone, g, columns, now }) {
  if (!w.read) return [`  ${tone.muted}reading the sessions${g.ellipsis}${tone.reset}`];
  const working = w.working ? `${w.working} working` : "";
  if (!w.waiting.length) {
    return [`  ${tone.muted}nobody is waiting on you${working ? ` ${g.bullet} ${working}` : ""}${tone.reset}`];
  }
  const count = `${w.waiting.length} session${w.waiting.length === 1 ? "" : "s"}`;
  const out = [`  ${tone.warn}${tone.bold}Waiting on you${tone.reset}  ${tone.muted}${[count, working].filter(Boolean).join(` ${g.bullet} `)}${tone.reset}`];
  if (max > 0) out.push(...sessionLines(w.waiting.slice(0, max), { tone, g, columns, now: now + w.skew }));
  const more = w.waiting.length - max;
  if (more > 0 && max > 0) out.push(`    ${tone.muted}${more} more ${g.dash} \`ccdeck sessions\` lists them${tone.reset}`);
  return out;
}
