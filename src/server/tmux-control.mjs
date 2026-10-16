// One tmux control-mode connection: the wire under the terminal panel.
//
// WHY CONTROL MODE AND NOT A PTY. A browser terminal is normally a pty the
// server owns, and a pty from Node means node-pty, a native module. package.json
// has no `dependencies` key at all — `npx ccdeck` is one tarball with nothing to
// compile — and a terminal is not worth spending that on. `tmux -C` is a child
// with three pipes: tmux owns the pty, keeps the session alive when the deck
// goes away, and reports what the pane writes as `%output` lines that carry the
// bytes exactly.
//
// MEASURED BEFORE IT WAS BUILT. The phase-0 spike fed the raw `%output` stream
// into xterm.js and compared it, after every repaint, with tmux's own screen as
// `capture-pane` reads it back: text row by row, attributes cell by cell, and
// the cursor. Claude Code and Codex were identical in 11 of 11 scenarios each,
// and a synthetic TUI that tees what it writes showed the 519,400 bytes that
// arrived as `%output` to be a byte-identical suffix of what it wrote. What this
// module adds to that spike is everything a connection needs around the stream.
//
// THE RULES IT KEEPS, each one learned from the spike or from tmux's source:
//
//   Bytes, never strings. `%output` escapes every byte below 0x20 and the
//   backslash as \ooo and sends every other byte as itself, UTF-8 included. A
//   line is therefore split on 0x0a, which can never be data, and decoded as a
//   Buffer: a multi-byte character cut by a chunk boundary is reassembled by the
//   line, not by a string decoder.
//
//   The seed boundary. A browser terminal that opens late starts from
//   `capture-pane`, then applies `%output`. tmux writes pane output and command
//   replies on ONE ordered stream, so output that arrives before the capture's
//   reply is already in the capture and must be dropped, and everything after it
//   is new. The spike attached mid-burst with that rule and stayed an exact
//   suffix of the wire (628,114 of 752,988 bytes).
//
//   Modes set before the attach never pass through `%output`. Claude Code runs
//   on the alternate screen with any-event mouse on; an emulator that was not
//   told so sends no mouse events. The seed restates every mode tmux has a
//   format for; bracketed paste, focus events and extended keys have none in
//   3.6, which is why paste goes through tmux rather than through the emulator.
//
//   Flow control. With `pause-after`, tmux stops sending a pane's output to a
//   client that has fallen behind and says `%pause`; the screen it skipped is
//   gone from the stream, so the only honest recovery is to continue the pane
//   and capture it again — the 'reseed' event.
//
// Nothing here spawns tmux SERVERS or shells: the one child is `tmux -C attach`
// on a socket the caller names, registered with exec-children.mjs so the deck's
// shutdown reaps it. Closing the client detaches it and leaves the tmux session
// running, which is the point of having one.
import { EventEmitter } from "node:events";
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { killTree, watchChild } from "./exec-children.mjs";
// The one spelling of a tmux invocation (binary, -u, socket, then arguments),
// of an argument tmux could split, and of the environment a tmux client gets.
import { parseTmuxVersion, tmuxArg, tmuxCommand, tmuxEnv } from "./tmux.mjs";

/**
 * The most bytes one `send-keys -H` carries. Each byte is three characters on
 * the command line, so a 512-byte chunk is a 1.5 KB line: small enough that a
 * pasted-in-by-typing burst never becomes one enormous command, large enough
 * that ordinary typing is always one command per keystroke batch.
 */
export const INPUT_CHUNK = 512;

/**
 * The most characters one `set-buffer` carries. A paste is staged in pieces
 * appended with `set-buffer -a`, so a large clipboard is many ordinary command
 * lines rather than one line of unbounded length.
 */
export const PASTE_CHUNK = 16 * 1024;

/**
 * How long a client may fall behind, in seconds, before tmux pauses a pane for
 * it. Two seconds is long enough that a busy event loop never trips it and short
 * enough that a stalled browser tab stops costing tmux memory.
 */
export const PAUSE_AFTER = 2;

// The subscription that reports a pane dying. It is subscribed for EVERY pane
// in the session (`%*`) and filtered here, because tmux 3.6 does not report a
// change of `#{pane_dead}` to a subscription on the single pane (`%5`) — the
// first value arrives and the death never does — while the `%*` form reports
// it within a second. Measured, and tmux-control-tmux.test.ts holds it there:
// a program exits under remain-on-exit and 'exit' must say 'ended'.
const DEAD_SUBSCRIPTION = "ccdeck-dead";

// A line longer than this without a newline is not tmux talking. It caps what a
// broken peer can make this process buffer.
const MAX_LINE = 64 << 20;

// How long close() waits for tmux to detach on its own before killing it.
const CLOSE_GRACE_MS = 2000;

const isOct = (c) => c >= 48 && c <= 55;

/**
 * Decode the value of one `%output` line into the bytes the pane wrote.
 *
 * tmux escapes a byte below 0x20, and the backslash itself, as a backslash and
 * three octal digits; every other byte, UTF-8 included, arrives as itself. So
 * this works on bytes and never on a string: a string decoder would mangle
 * the escapes' neighbours, and the pane may legitimately write bytes that are
 * not UTF-8 at all. A backslash that is not followed by three octal digits
 * cannot come from tmux and is kept as it is rather than guessed at.
 *
 * Takes and returns a Buffer. The common line has no escapes at all, and then
 * the input is returned as it is, without a copy.
 */
export function unescapeOutput(buf) {
  if (buf.indexOf(0x5c) < 0) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x5c && i + 3 < buf.length && isOct(buf[i + 1]) && isOct(buf[i + 2]) && isOct(buf[i + 3])) {
      out[n++] = (((buf[i + 1] - 48) << 6) | ((buf[i + 2] - 48) << 3) | (buf[i + 3] - 48)) & 0xff;
      i += 3;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

// The text after "<word> " in a notification, as latin1 so a byte is a char.
const rest = (buf, from) => buf.subarray(from).toString("latin1");

/**
 * Classify one line tmux wrote in control mode, without its newline.
 *
 * Pure, and deliberately unaware of context: a line INSIDE a %begin/%end block
 * is command output and may itself start with "%" (`display-message -p
 * '#{pane_id}'` prints "%5"), so the caller decides whether a line is a reply
 * before asking what it is. Shapes:
 *
 *   { type: "output", pane, data, age? }  — %output, or %extended-output (the
 *                                            form tmux uses once pause-after is
 *                                            set; age is in milliseconds)
 *   { type: "begin" | "end" | "error", time, number, flags, guard }
 *   { type: "pause" | "continue", pane }
 *   { type: "exit", reason }               — reason is "" when tmux gave none
 *   { type: "layout-change", window, layout, visibleLayout, flags }
 *   { type: "window-close" | "unlinked-window-close", window }
 *   { type: "session-changed", session, name }
 *   { type: "subscription-changed", name, session, window, index, pane, value }
 *   { type: "notification", name, args }   — every other %word
 *   { type: "line", text }                 — anything not starting with "%"
 *
 * Accepts a Buffer or, for tests, a string (encoded as UTF-8).
 */
export function parseControlLine(line) {
  const buf = typeof line === "string" ? Buffer.from(line, "utf8") : line;
  if (buf[0] !== 0x25) return { type: "line", text: buf.toString("utf8") };
  const sp = buf.indexOf(0x20);
  const word = buf.subarray(1, sp < 0 ? buf.length : sp).toString("latin1");
  const args = sp < 0 ? "" : rest(buf, sp + 1);
  switch (word) {
    case "output": {
      const sp2 = buf.indexOf(0x20, sp + 1);
      if (sp2 < 0) return { type: "output", pane: args, data: Buffer.alloc(0) };
      return { type: "output", pane: buf.subarray(sp + 1, sp2).toString("latin1"), data: unescapeOutput(buf.subarray(sp2 + 1)) };
    }
    case "extended-output": {
      // "%extended-output %5 12 ... : value" — the arguments between the age and
      // a lone ":" are reserved for future use, and none of them contains a
      // space, so the first " : " is the separator.
      const sep = buf.indexOf(" : ", sp + 1, "latin1");
      const head = (sep < 0 ? args : rest(buf, sp + 1).slice(0, sep - sp - 1)).split(" ");
      const data = sep < 0 ? Buffer.alloc(0) : unescapeOutput(buf.subarray(sep + 3));
      return { type: "output", pane: head[0], age: Number(head[1]) || 0, data };
    }
    case "begin":
    case "end":
    case "error": {
      const [time, number, flags] = args.split(" ");
      return { type: word, time, number, flags, guard: args };
    }
    case "pause":
    case "continue":
      return { type: word, pane: args.split(" ")[0] };
    case "exit":
      return { type: "exit", reason: args };
    case "layout-change": {
      const [window, layout, visibleLayout, flags = ""] = args.split(" ");
      return { type: word, window, layout, visibleLayout, flags };
    }
    case "window-close":
    case "unlinked-window-close":
      return { type: word, window: args.split(" ")[0] };
    case "session-changed": {
      const i = args.indexOf(" ");
      return { type: word, session: i < 0 ? args : args.slice(0, i), name: i < 0 ? "" : args.slice(i + 1) };
    }
    case "subscription-changed": {
      const sep = args.indexOf(" : ");
      const head = (sep < 0 ? args : args.slice(0, sep)).split(" ");
      const value = sep < 0 ? "" : Buffer.from(args.slice(sep + 3), "latin1").toString("utf8");
      return { type: word, name: head[0], session: head[1], window: head[2], index: head[3], pane: head[4], value };
    }
    default:
      return { type: "notification", name: word, args };
  }
}

/**
 * Quote one argument for tmux's command parser, so it arrives as exactly this
 * string whatever it contains.
 *
 * Control mode reads one command per LINE, so a newline in an argument cannot
 * be sent as itself — it would end the command, and tmux also strips the
 * indentation after a literal newline inside quotes. Inside double quotes the
 * parser understands backslash escapes (\n, \r, \t, \ooo, and backslash before
 * anything else meaning that character), and it EXPANDS three things: `$NAME`
 * from the server's environment, `~` to a home directory at the start of a
 * word — even a quoted one — and the escapes themselves. So the backslash,
 * the double quote, `$` and `~` are escaped, the C0 controls and DEL become
 * octal, and every other character, UTF-8 included, passes as itself. `;`, `#`,
 * `{` and spaces are inert inside quotes.
 *
 * A NUL cannot be carried — tmux's arguments are C strings — and throws rather
 * than being dropped without a word; paste() strips it first, on purpose.
 */
export function quoteTmuxArg(value) {
  const s = String(value);
  if (s.includes("\0")) throw new TypeError("a tmux argument cannot carry a NUL character");
  let out = "\"";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\" || ch === "\"" || ch === "$" || ch === "~") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\${c.toString(8).padStart(3, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * The `send-keys` commands that deliver these bytes to the pane unchanged.
 *
 * `-H` takes each key as a hex byte and tmux writes it to the pane as a
 * literal, so the bytes xterm.js produced for a keystroke — in whatever
 * encoding the pane asked xterm for — reach the program exactly. One command
 * per INPUT_CHUNK bytes.
 */
export function sendKeysCommands(pane, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const out = [];
  for (let i = 0; i < buf.length; i += INPUT_CHUNK) {
    const hex = [];
    for (const b of buf.subarray(i, i + INPUT_CHUNK)) hex.push(b.toString(16).padStart(2, "0"));
    out.push(`send-keys -t ${pane} -H ${hex.join(" ")}`);
  }
  return out;
}

/**
 * The commands that paste `text` into the pane the way a terminal would.
 *
 * Staged in a paste buffer and delivered with `paste-buffer -p`, which wraps
 * it in bracketed-paste markers only if the program in the pane asked for
 * them. tmux 3.6 exposes no format for that mode, so the browser cannot know
 * it, and tmux is the one party that does. paste-buffer also turns each LF into
 * CR, as a terminal paste does; a CRLF is folded to LF first, as xterm.js does,
 * so Windows line ends do not paste as two Enters. NUL is dropped: no terminal
 * pastes one, and tmux could not carry it. `-d` deletes the buffer once used,
 * so a paste does not linger in the user's `choose-buffer` list.
 */
export function pasteCommands(pane, text, buffer) {
  const body = String(text).replace(/\r\n/g, "\n").replace(/\0/g, "");
  if (!body) return [];
  const out = [];
  for (let i = 0; i < body.length;) {
    let end = Math.min(body.length, i + PASTE_CHUNK);
    // Never split a surrogate pair: half an emoji in each buffer append would
    // reach tmux as two replacement characters.
    if (end < body.length && /[\ud800-\udbff]/.test(body[end - 1])) end--;
    out.push(`set-buffer ${i ? "-a " : ""}-b ${buffer} -- ${quoteTmuxArg(body.slice(i, end))}`);
    i = end;
  }
  out.push(`paste-buffer -p -d -b ${buffer} -t ${pane}`);
  return out;
}

/**
 * Every pane in a tmux layout string, with its size.
 *
 * A layout is "checksum,WxH,X,Y" followed by ",ID" for a pane, or by
 * "{...}" / "[...]" around the cells of a split. Only a pane cell has four
 * numbers in a row, so the panes are exactly the WxH,X,Y,ID runs. Returns
 * `[{ pane: "%ID", cols, rows }]`.
 */
export function layoutPanes(layout) {
  const out = [];
  for (const m of String(layout).matchAll(/(\d+)x(\d+),\d+,\d+,(\d+)/g)) {
    out.push({ pane: `%${m[3]}`, cols: Number(m[1]), rows: Number(m[2]) });
  }
  return out;
}

// The format the seed asks tmux for. Named fields, because an older tmux
// expands a variable it does not know to nothing, and a positional list would
// then shift every value after it.
const SEED_FIELDS = [
  "alternate_on", "cursor_x", "cursor_y", "pane_width", "pane_height", "cursor_flag",
  "keypad_cursor_flag", "keypad_flag", "mouse_standard_flag", "mouse_button_flag", "mouse_all_flag",
  "mouse_sgr_flag", "mouse_utf8_flag", "insert_flag", "origin_flag", "wrap_flag",
  "scroll_region_upper", "scroll_region_lower", "cursor_shape", "cursor_blinking",
];
const SEED_FORMAT = SEED_FIELDS.map(f => `${f}=#{${f}}`).join(" ");

/** The seed's display-message answer (key=value pairs) as numbers and flags. */
export function parseSeedInfo(line) {
  const raw = {};
  for (const pair of String(line ?? "").split(" ")) {
    const eq = pair.indexOf("=");
    if (eq > 0) raw[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const num = (k, d = 0) => (raw[k] === undefined || raw[k] === "" ? d : Number(raw[k]) || 0);
  const on = (k) => raw[k] === "1";
  const rows = num("pane_height", 24);
  return {
    alternate: on("alternate_on"),
    cursorX: num("cursor_x"),
    cursorY: num("cursor_y"),
    cols: num("pane_width", 80),
    rows,
    cursorVisible: raw.cursor_flag !== "0",
    keypadCursor: on("keypad_cursor_flag"),
    keypad: on("keypad_flag"),
    mouseStandard: on("mouse_standard_flag"),
    mouseButton: on("mouse_button_flag"),
    mouseAll: on("mouse_all_flag"),
    mouseSgr: on("mouse_sgr_flag"),
    mouseUtf8: on("mouse_utf8_flag"),
    insert: on("insert_flag"),
    origin: on("origin_flag"),
    wrap: raw.wrap_flag !== "0",
    scrollTop: num("scroll_region_upper", 0),
    scrollBottom: num("scroll_region_lower", rows - 1),
    cursorShape: raw.cursor_shape || "",
    cursorBlinking: on("cursor_blinking"),
  };
}

/**
 * The background a run of `capture-pane -e` text leaves in force, as the SGR
 * sequence that sets it, or "" for the default.
 *
 * Needed because capture-pane carries attributes ACROSS line ends — it states
 * an attribute when it changes, not on every line — and a newline that
 * scrolls a terminal fills the new bottom row with the current background
 * (xterm.js erases with it, as a VT does). Writing history into the emulator
 * scrolls, so a coloured line end would paint the next row's empty cells. The
 * seed switches to the default background for the newline itself and then
 * restates this one, which leaves the carried attributes exactly as they were.
 */
export function trailingBackground(text, bg = "") {
  for (const m of String(text).matchAll(/\x1b\[([0-9;:]*)m/g)) {
    const ps = m[1] === "" ? ["0"] : m[1].split(";");
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const n = Number(p.split(":")[0] || "0");
      if (n === 0 || n === 49) bg = "";
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) bg = `\x1b[${n}m`;
      else if (n === 38 || n === 48 || n === 58) {
        // Colon form keeps the whole colour in one parameter; the semicolon form
        // spends the next two (5;n) or four (2;r;g;b).
        if (p.includes(":")) { if (n === 48) bg = `\x1b[${p}m`; continue; }
        const take = ps[i + 1] === "5" ? 2 : ps[i + 1] === "2" ? 4 : 0;
        if (n === 48) bg = take ? `\x1b[${ps.slice(i, i + 1 + take).join(";")}m` : bg;
        i += take;
      }
    }
  }
  return bg;
}

// Lines written one under another from the top, so that what does not fit
// scrolls into the emulator's scrollback, with the background guard above.
function stackLines(lines) {
  let s = "";
  let bg = "";
  lines.forEach((line, i) => {
    s += line;
    if (i === lines.length - 1) return;
    bg = trailingBackground(line, bg);
    s += bg ? `\x1b[49m\r\n${bg}` : "\r\n";
  });
  return s;
}

const plainText = (line) => line.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "").trimEnd();

/**
 * The bytes that make a freshly reset emulator show what tmux shows.
 *
 * `info` is parseSeedInfo's answer, `lines` is `capture-pane -p -e -N -S -<n>`
 * (history, then the visible rows) and `saved` is `capture-pane -a -q`, the
 * normal screen tmux keeps aside while a program is on the alternate one.
 *
 * NORMAL SCREEN: history and visible rows are written top to bottom, so the
 * history scrolls into scrollback and the last `rows` lines are the screen.
 *
 * ALTERNATE SCREEN: the normal buffer is built first — the history, then the
 * screen tmux saved — and only then `?1049h` and the alternate rows, each
 * placed by row. The DESIGN asked only for the visible alternate rows; the
 * saved screen costs one more capture in the same atomic batch and means that
 * when the TUI exits, the emulator shows the shell tmux shows instead of a
 * blank page. tmux does not expose the cursor it saved at `?1049h`, so the one
 * this seed saves is a guess with a reason: a shell launched the TUI from the
 * line after its last output, which is where the cursor sat.
 *
 * Then the state no `%output` will ever restate: scroll region, origin, insert
 * and wrap modes, cursor-key and keypad modes, mouse reporting, cursor
 * position, visibility and shape. Order matters: setting the scroll region or
 * origin mode homes the cursor, so the cursor goes last.
 */
export function buildSeed({ info, lines = [], saved = [] }) {
  const rows = Math.max(1, info.rows);
  const cols = Math.max(1, info.cols);
  const history = lines.length > rows ? lines.slice(0, lines.length - rows) : [];
  const visible = lines.slice(history.length);
  while (visible.length < rows) visible.push("");

  let s = "\x1bc";
  if (!info.alternate) {
    s += stackLines([...history, ...visible]);
  } else {
    const normal = saved.slice(0, rows);
    s += stackLines([...history, ...normal]);
    let last = -1;
    normal.forEach((line, y) => { if (plainText(line)) last = y; });
    s += `\x1b[0m\x1b[${Math.min(last + 1, rows - 1) + 1};1H\x1b[?1049h`;
    visible.forEach((line, y) => { s += `\x1b[${y + 1};1H${line}`; });
  }
  s += "\x1b[0m";
  const top = Math.max(0, Math.min(info.scrollTop, rows - 1));
  const bottom = Math.max(top, Math.min(info.scrollBottom, rows - 1));
  if (top !== 0 || bottom !== rows - 1) s += `\x1b[${top + 1};${bottom + 1}r`;
  if (info.origin) s += "\x1b[?6h";
  if (info.insert) s += "\x1b[4h";
  if (!info.wrap) s += "\x1b[?7l";
  if (info.keypadCursor) s += "\x1b[?1h";
  if (info.keypad) s += "\x1b=";
  if (info.mouseStandard) s += "\x1b[?1000h";
  if (info.mouseButton) s += "\x1b[?1002h";
  if (info.mouseAll) s += "\x1b[?1003h";
  if (info.mouseUtf8) s += "\x1b[?1005h";
  if (info.mouseSgr) s += "\x1b[?1006h";
  const x = Math.max(0, Math.min(info.cursorX, cols - 1));
  const y = Math.max(0, Math.min(info.cursorY, rows - 1));
  const row = info.origin ? Math.max(0, y - top) : y;
  s += `\x1b[${row + 1};${x + 1}H`;
  s += info.cursorVisible ? "\x1b[?25h" : "\x1b[?25l";
  const shape = { block: 1, underline: 3, bar: 5 }[info.cursorShape];
  if (shape) s += `\x1b[${info.cursorBlinking ? shape : shape + 1} q`;
  return Buffer.from(s, "utf8");
}

/**
 * The socket a control client may use: `{ name }` or `{ path }`, and nothing
 * else. tmuxCommand reads a missing socket as the user's default server, which
 * is right for the one lookup that wants it (terminal-target on macOS) and
 * never right here: case A is the deck's own socket and case B names the
 * user's socket path, so an unnamed socket is a bug, refused rather than
 * defaulted.
 */
function requireSocket(socket) {
  const named = typeof socket?.name === "string" && socket.name !== "";
  const pathed = typeof socket?.path === "string" && socket.path !== "";
  if (!named && !pathed) throw new TypeError("openControl needs a socket: { name } or { path }");
  return socket;
}

const toBuffer = (bytes) =>
  Buffer.isBuffer(bytes) ? bytes
    : typeof bytes === "string" ? Buffer.from(bytes, "utf8")
      : bytes instanceof ArrayBuffer ? Buffer.from(bytes)
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const failed = (why) => ({ ok: false, lines: [why] });

/** The first tmux whose control clients can tell it their colours. */
export const COLOURS_TMUX = Object.freeze([3, 5]);

/** A colour the panel may hand tmux: six lowercase hex digits after a #. */
const HEX_COLOUR = /^#[0-9a-f]{6}$/;

/**
 * The OSC 10 (foreground) or 11 (background) reply a terminal would give for
 * `hex`, as `refresh-client -r` takes it: 16 bits a channel, each byte
 * doubled ("#1e1e2e" → rgb:1e1e/1e1e/2e2e), ended by ST. Pure.
 */
export function oscColourReport(which, hex) {
  const h = String(hex).slice(1);
  const channel = (i) => h.slice(i, i + 2).repeat(2);
  return `\x1b]${which};rgb:${channel(0)}/${channel(2)}/${channel(4)}\x1b\\`;
}

/** Several replies as one: ok when every command was, lines concatenated. */
async function allOf(promises) {
  const replies = await Promise.all(promises);
  return { ok: replies.every(r => r.ok), lines: replies.flatMap(r => r.lines) };
}

/**
 * A live control-mode connection to one pane. Construct with openControl().
 *
 * Events, all emitted synchronously from the line that caused them so that
 * their order is the stream's order:
 *   'output' (Buffer)          bytes the chosen pane wrote after the latest
 *                              seed() resolved; never before the first one
 *   'reseed' ()                the stream lost bytes (a %pause); call seed()
 *                              again and reset the emulator with it
 *   'size' ({ cols, rows })    the pane changed size, at the point in the
 *                              stream where tmux changed it
 *   'exit' ({ reason, message? })  exactly once, whatever ended it:
 *       'ended'    the pane died, or its window/session/server went away
 *       'detached' tmux detached this client (another client ran attach -d,
 *                  or the pane moved out of this session); the pane lives on
 *       'closed'   close() was called
 *       'error'    tmux could not be run or failed in a way it did not explain
 *     After a pane death the client stays attached, so a seed() can still read
 *     the last frame; call close() when done with it.
 *
 * Never emits 'error', so an absent listener cannot crash the deck, and none of
 * the command methods reject: a failure is a `{ ok: false, lines }` answer.
 * seed() is the exception, because it has no partial answer to give.
 */
class ControlClient extends EventEmitter {
  #tmux;
  #socket;
  #env;
  #target;
  #ignoreSize;
  /** The server's [major, minor] once asked (colours), or null. */
  #serverVersion = null;
  #readOnly;
  #pauseAfter;
  #spawn;
  #execFile;
  #child = null;
  #childClosed = false;
  #pre = [];            // command text written before the child exists
  #waiters = [];        // one per command sent, in order
  #partial = [];
  #partialBytes = 0;
  #block = null;
  #attached = false;
  #isReady = false;
  #readyResolve;
  #readyReject;
  #beforeReady = [];
  #pane = "";
  #window = "";
  #session = "";
  #size = null;
  #streaming = false;
  #folding = null;      // output past a seed's boundary, held until seed() resolves
  #seedSeq = 0;
  #pauseEpoch = 0;
  #exitEmitted = false;
  #torn = false;
  #closing = false;
  #exitClassifying = false;
  #stderr = "";
  #closedPromise;
  #closedResolve;
  #killTimer = null;
  #pasteBuffer = `ccdeck-paste-${randomBytes(4).toString("hex")}`;

  /** Resolves `{ pane, window, session, cols, rows, dead }` once attached. */
  ready;

  constructor({ tmux, socket, target, pane, ignoreSize = false, readOnly = false,
    pauseAfter = PAUSE_AFTER, spawn = nodeSpawn, execFile = nodeExecFile, env = process.env }) {
    super();
    this.#tmux = typeof tmux === "string" ? tmux : tmux?.path;
    if (!this.#tmux) throw new TypeError("openControl needs the tmux binary");
    this.#socket = requireSocket(socket);
    // Spelled once now, so a socket tmuxCommand refuses (a name with a path
    // separator in it) is refused here, where the caller can see it, and not
    // later inside #start where it would only reach 'exit'.
    this.#argv([]);
    if (!target && !pane) throw new TypeError("openControl needs a target session or pane");
    this.#target = String(target || pane);
    // A pane id as the target is also the pane to stream, unless told otherwise.
    this.#pane = pane ? String(pane) : this.#target.startsWith("%") ? this.#target : "";
    this.#ignoreSize = !!ignoreSize;
    this.#readOnly = !!readOnly;
    this.#pauseAfter = Math.max(0, Math.floor(Number(pauseAfter) || 0));
    this.#spawn = spawn;
    this.#execFile = execFile;
    // tmux.mjs's client environment: the deck's own, without TMUX and
    // TMUX_PANE — a client that thinks it is nested may refuse to attach — and
    // without the deck's and a parent agent's variables, which a tmux client
    // never reads and which a user's `update-environment` could otherwise copy
    // into their own session when case B attaches to it.
    this.#env = tmuxEnv(env);
    this.ready = new Promise((resolve, reject) => { this.#readyResolve = resolve; this.#readyReject = reject; });
    // A caller that only listens for 'exit' never awaits `ready`; its rejection
    // must not become an unhandled rejection that takes the deck down.
    this.ready.catch(() => {});
    this.#closedPromise = new Promise(r => { this.#closedResolve = r; });

    // The first thing on the wire after attach: which pane, how big, and a
    // subscription to its death. Queued now so they precede anything a caller
    // sends, and answered in this order.
    const fmt = quoteTmuxArg("#{session_id} #{window_id} #{pane_id} #{pane_width} #{pane_height} #{pane_dead}");
    this.#send([`display-message -p${this.#pane ? ` -t ${this.#pane}` : ""} ${fmt}`], (reply) => this.#onPaneInfo(reply));
    this.#send([`refresh-client -B ${quoteTmuxArg(`${DEAD_SUBSCRIPTION}:%*:#{pane_dead}`)}`]);
    // #start is async (a pane target is looked up first); nothing in it should
    // throw, and if something does, it is this connection's error, not the deck's.
    this.#start().catch((err) => this.#fail("error", err?.message || String(err)));
  }

  /** The pane this client streams, e.g. "%5" ("" until ready). */
  get pane() { return this.#pane; }
  /** The pane's last known size, `{ cols, rows }`, or null before ready. */
  get size() { return this.#size ? { ...this.#size } : null; }
  /** The control client's pid, for liveChildPids and diagnostics. */
  get pid() { return this.#child?.pid; }
  /** True once the connection is over (exit emitted and tmux gone). */
  get closed() { return this.#torn; }

  // The arguments after the binary for one tmux invocation on this client's
  // socket, as tmux.mjs spells every invocation: `-u` (the deck may run under
  // LANG=C — launchd, systemd — and tmux decides from the locale whether a
  // client speaks UTF-8), the socket, then `args`.
  #argv(args) {
    return tmuxCommand(this.#tmux, this.#socket, args).slice(1);
  }

  async #start() {
    let attachTo = this.#target;
    if (attachTo.startsWith("%")) {
      // ATTACHING BY PANE MOVES THE USER. `attach-session -t %5` selects that
      // pane's window as the session's current window — measured on tmux 3.6
      // with two windows — so in the user's own tmux (case B) the panel would
      // yank their terminal to another window. Attaching to the pane's SESSION
      // leaves their current window alone; output for every window of the
      // session reaches a control client anyway.
      const found = await new Promise((resolve) => {
        try {
          this.#execFile(this.#tmux, this.#argv(["display-message", "-p", "-t", attachTo, "#{session_id}"]),
            { timeout: 3000, env: this.#env, windowsHide: true },
            (err, stdout) => resolve(err ? null : String(stdout).trim()));
        } catch { resolve(null); }
      });
      if (this.#closing) return this.#teardown("closed");
      if (!found) return this.#fail("ended", `tmux has no pane ${attachTo}`);
      attachTo = found;
    } else if (!/^[$@=]/.test(attachTo)) {
      // "=name" is an exact match. A bare name would also match by prefix.
      attachTo = `=${attachTo}`;
    }
    if (this.#closing) return this.#teardown("closed");

    const flags = [];
    if (this.#pauseAfter) flags.push(`pause-after=${this.#pauseAfter}`);
    // At attach, not by a later refresh-client: between the two, a client that
    // does not ignore size could already have resized the user's window.
    if (this.#ignoreSize) flags.push("ignore-size");
    // -E: an attaching client copies every variable named in the session's
    // update-environment from its own environment into the session's, and
    // removes the ones it lacks. The deck's environment is a login item's or a
    // service's, not the user's shell, so without -E opening the user's own
    // session here would strip its SSH_AUTH_SOCK and DISPLAY for every window
    // they open afterwards — long after the panel has closed.
    // tmux's command line ends a command at any argument that ENDS in ";", so a
    // session named "notes;" is passed as "notes\;" (tmuxArg), tmux's escape
    // for it.
    const argv = this.#argv(["-C", "attach-session", "-E", ...(flags.length ? ["-f", flags.join(",")] : []), "-t", tmuxArg(attachTo)]);
    let child;
    try {
      child = this.#spawn(this.#tmux, argv, { stdio: ["pipe", "pipe", "pipe"], env: this.#env, windowsHide: true });
    } catch (err) {
      return this.#fail("error", err?.message || String(err));
    }
    this.#child = watchChild(child);
    child.on("error", (err) => this.#fail("error", err?.message || String(err)));
    child.on("close", (code) => this.#onChildClose(code));
    child.stdin?.on("error", () => { /* EPIPE once tmux has gone; 'close' says the rest */ });
    child.stdout?.on("data", (d) => this.#onData(d));
    child.stderr?.on("data", (d) => { this.#stderr = (this.#stderr + d.toString("utf8")).slice(-2000); });
    if (this.#pre.length) {
      child.stdin.write(this.#pre.join(""));
      this.#pre = [];
    }
  }

  #onData(chunk) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) break;
      let line = chunk.subarray(start, nl);
      if (this.#partial.length) {
        this.#partial.push(line);
        line = Buffer.concat(this.#partial);
        this.#partial = [];
        this.#partialBytes = 0;
      }
      start = nl + 1;
      this.#line(line);
    }
    if (start < chunk.length) {
      this.#partial.push(chunk.subarray(start));
      this.#partialBytes += chunk.length - start;
      if (this.#partialBytes > MAX_LINE) {
        this.#partial = [];
        this.#partialBytes = 0;
        this.#fail("error", "tmux sent a line longer than any it writes");
        this.#kill();
      }
    }
  }

  #line(raw) {
    if (this.#block) {
      // Inside a reply, only this block's OWN guard ends it — same time, number
      // and flags. Command output is not escaped, so a pane showing the text
      // "%end 1 2 1" must not be able to close a capture early.
      if (raw[0] === 0x25) {
        const text = raw.toString("latin1");
        const g = this.#block.guard;
        if (text === `%end ${g}` || text === `%error ${g}`) {
          const block = this.#block;
          this.#block = null;
          this.#settle(block, text.startsWith("%end "));
          return;
        }
      }
      this.#block.lines.push(raw.toString("utf8"));
      return;
    }
    const msg = parseControlLine(raw);
    switch (msg.type) {
      case "begin":
        this.#block = { guard: msg.guard, flags: msg.flags, lines: [] };
        return;
      case "output":
        if (msg.pane !== this.#pane || !msg.data.length || this.#exitEmitted) return;
        if (this.#streaming) this.emit("output", msg.data);
        else if (this.#folding) this.#folding.chunks.push(msg.data);
        return;
      case "pause":
        if (msg.pane === this.#pane) this.#onPause();
        return;
      case "layout-change":
        if (msg.window === this.#window) this.#onLayout(msg.layout);
        return;
      case "window-close":
      case "unlinked-window-close":
        if (msg.window === this.#window) this.#verifyPane("detached");
        return;
      case "session-changed":
        // Our client moved to another session: the user's own config may say
        // detach-on-destroy off, which switches clients instead of detaching.
        if (this.#isReady && msg.session !== this.#session) this.#verifyPane("detached", true);
        return;
      case "subscription-changed":
        if (msg.name === DEAD_SUBSCRIPTION && msg.pane === this.#pane && msg.value === "1") this.#emitExit("ended");
        return;
      case "exit":
        this.#onExitLine(msg.reason);
        return;
      default:
    }
  }

  // A complete %begin…%end block. The first one is attach-session's own
  // reply; after that, tmux marks a command read from THIS client's stdin with
  // flags 1 and anything else — a hook's command, say — with 0.
  #settle(block, ok) {
    if (!this.#attached) {
      this.#attached = true;
      if (!ok) {
        const why = block.lines.join(" ").trim() || "tmux refused to attach";
        this.#fail(/can't find|no such|no sessions|not found/i.test(why) ? "ended" : "error", why);
      }
      return;
    }
    if (block.flags === "0") return;
    const w = this.#waiters.shift();
    if (!w) return;
    const reply = { ok, lines: block.lines };
    w.onReply?.(reply);
    w.resolve(reply);
  }

  /**
   * Queue command lines as ONE write, so tmux reads them together and runs them
   * back to back with no pane output between them. `onLast` runs synchronously
   * at the last reply, before the next line of the stream is read — which is
   * what lets a seed say exactly where its capture ends.
   */
  #send(lines, onLast) {
    const promises = lines.map((_, i) => new Promise((resolve) => {
      this.#waiters.push({ resolve, onReply: i === lines.length - 1 ? onLast : undefined });
    }));
    const text = lines.map(l => `${l}\n`).join("");
    if (this.#torn) {
      // Nothing will answer; settle what was just queued.
      for (const w of this.#waiters.splice(0)) w.resolve(failed("the control client has exited"));
    } else if (this.#child) {
      this.#child.stdin.write(text);
    } else {
      this.#pre.push(text);
    }
    return promises;
  }

  #onPaneInfo(reply) {
    if (!reply.ok) {
      const why = reply.lines.join(" ").trim() || "tmux could not find the pane";
      this.#fail("ended", why);
      return;
    }
    const [session, window, pane, w, h, dead] = (reply.lines[0] ?? "").split(" ");
    this.#session = session;
    this.#window = window;
    this.#pane = pane;
    this.#size = { cols: Number(w) || 0, rows: Number(h) || 0 };
    this.#isReady = true;
    this.#readyResolve({ pane, window, session, ...this.#size, dead: dead === "1" });
    // Run what callers queued while waiting, in their order, right here: a call
    // made after this point would otherwise overtake them.
    const queued = this.#beforeReady.splice(0);
    for (const run of queued) run();
  }

  // Run `fn` once the pane is known — immediately if it already is. Never
  // rejects: a client that never got ready answers `{ ok: false }`.
  #whenReady(fn) {
    if (this.#isReady) return Promise.resolve(fn());
    if (this.#torn) return Promise.resolve(failed("the control client has exited"));
    return new Promise((resolve) => { this.#beforeReady.push(() => resolve(fn())); });
  }

  #onPause() {
    // The bytes tmux skipped are gone from the stream for good, so nothing the
    // stream says until a new capture can be trusted: stop forwarding now, ask
    // tmux to continue, and have the owner seed again. The continue is written
    // before 'reseed' is emitted, so a seed() made in the handler is queued
    // after it and captures a screen that the continued stream follows.
    this.#pauseEpoch++;
    this.#streaming = false;
    this.#folding = null;
    this.#send([`refresh-client -A ${quoteTmuxArg(`${this.#pane}:continue`)}`]);
    this.emit("reseed");
  }

  #onLayout(layout) {
    const mine = layoutPanes(layout).find(p => p.pane === this.#pane);
    if (!mine) {
      // Not in its window's layout any more: killed, or moved by break-pane.
      this.#verifyPane("detached");
      return;
    }
    this.#setSize(mine.cols, mine.rows);
  }

  #setSize(cols, rows) {
    if (this.#size && this.#size.cols === cols && this.#size.rows === rows) return;
    this.#size = { cols, rows };
    // Between a seed's capture and its delivery there is no event a consumer
    // could place correctly — the seed it has not received yet is at the old
    // size — so the seed is marked stale and replaced, size and all.
    if (this.#folding) { this.#folding.stale = true; return; }
    if (!this.#exitEmitted) this.emit("size", { cols, rows });
  }

  // Ask tmux about the pane after a notification that it may be gone. Gone or
  // dead is 'ended'; alive but somewhere this client no longer sees is `ifAlive`
  // — in another session, or anywhere at all once this client itself has been
  // switched to another session (`left`), since only the attached session's
  // panes send it output.
  #verifyPane(ifAlive, left = false) {
    if (!this.#pane || this.#exitEmitted) return;
    const [p] = this.#send([`display-message -p -t ${this.#pane} ${quoteTmuxArg("#{pane_dead} #{pane_width} #{pane_height} #{window_id} #{session_id}")}`]);
    p.then((r) => {
      if (this.#torn) return;
      if (!r.ok) return this.#emitExit("ended");
      const [dead, w, h, window, session] = (r.lines[0] ?? "").split(" ");
      if (dead === "1") return this.#emitExit("ended");
      if (left || session !== this.#session) return this.#emitExit(ifAlive);
      this.#window = window;
      this.#setSize(Number(w) || 0, Number(h) || 0);
    });
  }

  #onExitLine(reason) {
    if (this.#closing || this.#exitEmitted) return;
    // tmux's %exit says why only sometimes, and a detach and a destroyed
    // session both arrive as a bare "%exit". Whether the session and the pane
    // are still there tells them apart, and this client can no longer ask, so
    // a one-shot tmux does. The SESSION is asked first, and has to be: right
    // after kill-session the pane can still answer as alive for a moment —
    // tmux keeps a destroyed window referenced until the notifications about
    // it have run — while the session is gone at once. Measured.
    this.#exitClassifying = true;
    const why = reason || "";
    const done = (r) => { this.#emitExit(r, why || undefined); this.#teardown(r); };
    if (!this.#pane || !this.#session) return done("ended");
    try {
      // A lone ";" argument separates tmux commands; no shell is involved.
      this.#execFile(this.#tmux, this.#argv(["has-session", "-t", this.#session, ";",
        "display-message", "-p", "-t", this.#pane, "#{pane_dead}"]),
      { timeout: 3000, env: this.#env, windowsHide: true },
      (err, stdout) => done(err || String(stdout).trim() !== "0" ? "ended" : "detached"));
    } catch {
      done("ended");
    }
  }

  #onChildClose(code) {
    clearTimeout(this.#killTimer);
    this.#childClosed = true;
    if (this.#closing) {
      this.#teardown("closed");
    } else if (!this.#exitClassifying) {
      // When %exit came first, its answer is on the way and decides the reason.
      const why = this.#stderr.trim().split("\n").pop() || `tmux exited with code ${code}`;
      this.#fail(/no server running|can't find|no sessions/i.test(why) ? "ended" : "error", why);
    }
    if (this.#torn) this.#closedResolve();
  }

  #emitExit(reason, message) {
    if (this.#exitEmitted) return;
    this.#exitEmitted = true;
    this.#streaming = false;
    this.#folding = null;
    this.emit("exit", message ? { reason, message } : { reason });
  }

  #fail(reason, message) {
    this.#emitExit(reason, message);
    this.#teardown(reason, message);
  }

  // The connection is over: settle every waiter and the ready promise.
  #teardown(reason, message) {
    if (this.#torn) return;
    this.#torn = true;
    if (!this.#exitEmitted) this.#emitExit(reason, message);
    const why = message || `the control client has ${reason === "closed" ? "closed" : "exited"}`;
    for (const w of this.#waiters.splice(0)) w.resolve(failed(why));
    if (!this.#isReady) this.#readyReject(new Error(why));
    for (const run of this.#beforeReady.splice(0)) run();
    // A connection can be over while tmux is still attached — the pane could not
    // be found, or tmux said something it never says. Detach it the same way
    // close() does; `closed` resolves when it has really gone.
    // A child with no pid never started (ENOENT), and may never say 'close'.
    if (!this.#child || this.#childClosed || !this.#child.pid) this.#closedResolve();
    else this.#stopChild();
  }

  // End of input is how a control client is told to detach; one that has not
  // gone within the grace period is killed.
  #stopChild() {
    try { this.#child.stdin.end(); } catch { /* already closed */ }
    clearTimeout(this.#killTimer);
    this.#killTimer = setTimeout(() => this.#kill(), CLOSE_GRACE_MS);
    this.#killTimer.unref?.();
  }

  #kill() {
    if (this.#child && this.#child.exitCode === null && this.#child.signalCode === null) killTree(this.#child, "SIGTERM");
  }

  /**
   * Send one tmux command line and get its reply, `{ ok, lines }`. Commands are
   * answered in the order sent. A line break would make it two commands and an
   * empty line would detach the client, so both are refused.
   */
  cmd(line) {
    const text = String(line);
    if (!text.trim() || /[\r\n]/.test(text)) return Promise.resolve(failed("one non-empty command line at a time"));
    return this.#send([text])[0];
  }

  /**
   * Capture what tmux shows for the pane, as the bytes to write into a RESET
   * emulator: `{ bytes, cols, rows, cursor: [x, y], alternate }`.
   *
   * The questions go out as one write so tmux answers them back to back with no
   * output in between, and the seed boundary is the last answer: pane output
   * that arrived before it is already in the capture and is dropped.
   *
   * OUTPUT JUST PAST THE BOUNDARY IS IN THE SEED, NOT IN 'output'. The rest of
   * the chunk that carried the last answer is read synchronously, before this
   * promise can resolve, so any pane output in it would reach an 'output'
   * listener BEFORE the caller had the seed to write — and a consumer that
   * resets its emulator with the seed would wipe those bytes. They are
   * appended to `bytes` instead, and 'output' starts with what arrives after.
   * The caller must therefore write the seed before it awaits anything else:
   * `const s = await c.seed(); send(s.bytes)` is exactly right.
   *
   * If several seeds overlap, only the newest opens the stream; a %pause
   * while one is in flight keeps it shut, since 'reseed' has asked for
   * another; and a size change in that last window emits 'reseed' too, because
   * a seed at the old size followed by output at the new one cannot be
   * written correctly by anyone.
   *
   * Rejects when tmux cannot capture the pane (it has gone).
   */
  async seed({ history = 2000 } = {}) {
    await this.ready;
    const id = ++this.#seedSeq;
    const epoch = this.#pauseEpoch;
    this.#streaming = false;
    this.#folding = null;
    const p = this.#pane;
    const h = Math.max(0, Math.floor(Number(history) || 0));
    const [infoP, capP, savedP] = this.#send([
      `display-message -p -t ${p} ${quoteTmuxArg(SEED_FORMAT)}`,
      `capture-pane -p -e -N${h ? ` -S -${h}` : ""} -t ${p}`,
      `capture-pane -p -e -N -a -q -t ${p}`,
    ], (reply) => {
      if (reply.ok && id === this.#seedSeq && epoch === this.#pauseEpoch && !this.#exitEmitted) {
        this.#folding = { id, chunks: [], stale: false };
      }
    });
    const [infoR, capR, savedR] = await Promise.all([infoP, capP, savedP]);
    const fold = this.#folding?.id === id ? this.#folding : null;
    if (fold) this.#folding = null;
    if (!infoR.ok || !capR.ok) throw new Error((infoR.ok ? capR : infoR).lines.join(" ").trim() || "tmux could not capture the pane");
    const info = parseSeedInfo(infoR.lines[0]);
    let bytes = buildSeed({ info, lines: capR.lines, saved: savedR.ok ? savedR.lines : [] });
    if (fold && !fold.stale) {
      if (fold.chunks.length) bytes = Buffer.concat([bytes, ...fold.chunks]);
      this.#size = { cols: info.cols, rows: info.rows };
      this.#streaming = !this.#exitEmitted;
    } else if (fold) {
      this.emit("reseed");
    }
    return { bytes, cols: info.cols, rows: info.rows, cursor: [info.cursorX, info.cursorY], alternate: info.alternate };
  }

  /**
   * Make this client's size `cols` x `rows`, and the window's (case A).
   * Resolves at tmux's reply — the point in the stream from which output is
   * drawn at the new size. A no-op answering ok when the client was opened
   * with ignoreSize (case B), where the pane's size belongs to the user's own
   * terminal and arrives as 'size'.
   *
   * With more than one client on the window — a second tab, `tmux attach` by
   * hand — tmux's default window-size, latest, sizes it for the latest client
   * alone, and a control client's send-keys never makes it the latest: only
   * attaching or select-window do. So once attached, a resize is also a
   * select-window of the pane's own window from this client, which makes it
   * the latest and the window its size. That is how the view that last typed
   * or resized is the one the pane is drawn for (terminal-socket's bridge).
   */
  resize(cols, rows) {
    if (this.#ignoreSize) return Promise.resolve({ ok: true, lines: [] });
    const c = Math.floor(Number(cols));
    const r = Math.floor(Number(rows));
    if (!(c >= 1 && c <= 10000 && r >= 1 && r <= 10000)) return Promise.resolve(failed("a size is two positive whole numbers"));
    const commands = [`refresh-client -C ${c}x${r}`];
    // Before attach the window is not known yet, and needs no claim: tmux
    // makes the client that attaches the latest.
    if (this.#window) commands.push(`select-window -t ${this.#window}`);
    return allOf(this.#send(commands));
  }

  /**
   * Type raw bytes (a Buffer, Uint8Array or string) into the pane — exactly
   * what xterm.js's onData produced, chunked into `send-keys -H` commands.
   * Refused on a read-only client.
   */
  input(bytes) {
    if (this.#readOnly) return Promise.resolve(failed("read-only"));
    const buf = toBuffer(bytes ?? "");
    if (!buf.length) return Promise.resolve({ ok: true, lines: [] });
    return this.#whenReady(() => allOf(this.#send(sendKeysCommands(this.#pane, buf))));
  }

  /**
   * Paste text into the pane through a paste buffer, so tmux brackets it if
   * and only if the program asked for bracketed paste. The buffer name is this
   * client's own: two panels pasting at once into one server would otherwise
   * paste each other's text. Refused on a read-only client.
   */
  paste(text) {
    if (this.#readOnly) return Promise.resolve(failed("read-only"));
    return this.#whenReady(() => {
      const cmds = pasteCommands(this.#pane, text ?? "", this.#pasteBuffer);
      return cmds.length ? allOf(this.#send(cmds)) : { ok: true, lines: [] };
    });
  }

  /**
   * Tell tmux the colours this client draws the pane with — the panel's own
   * foreground and background, six-digit hex — so a program in the pane that
   * asks for them (OSC 10/11; Claude Code's auto theme does) is answered with
   * the deck's theme instead of the black tmux answers when no client has
   * said. tmux keeps them per pane and flags a theme change when the
   * background moves, which reaches programs that subscribed to it (mode
   * 2031, tmux 3.6+).
   *
   * Refused on a read-only client and on an ignoreSize one: that pane is in
   * the user's own tmux, where these colours would change what the user's own
   * terminal programs are told. A no-op answering `{ ok: false }` below tmux
   * 3.5, which has no `refresh-client -r` — asked of the server itself, once,
   * since it is the server's version that decides and it may be older than
   * the binary that started this client.
   */
  colours(fg, bg) {
    if (this.#readOnly) return Promise.resolve(failed("read-only"));
    if (this.#ignoreSize) return Promise.resolve(failed("the pane's colours belong to the user's own terminal"));
    if (!HEX_COLOUR.test(String(fg)) || !HEX_COLOUR.test(String(bg))) return Promise.resolve(failed("a colour is #rrggbb"));
    return this.#whenReady(async () => {
      this.#serverVersion ??= this.cmd('display-message -p "#{version}"')
        .then(r => (r.ok ? parseTmuxVersion(`tmux ${r.lines[0] ?? ""}`) : null));
      const v = await this.#serverVersion;
      const [major, minor] = COLOURS_TMUX;
      if (!v || v[0] < major || (v[0] === major && v[1] < minor)) return failed("this tmux cannot be told colours");
      return allOf(this.#send([
        `refresh-client -r ${quoteTmuxArg(`${this.#pane}:${oscColourReport(10, fg)}`)}`,
        `refresh-client -r ${quoteTmuxArg(`${this.#pane}:${oscColourReport(11, bg)}`)}`,
      ]));
    });
  }

  /**
   * Detach and stop the control client. The tmux session keeps running — that
   * is what makes closing the panel safe. Resolves once tmux has gone; a tmux
   * that has not left within two seconds of losing its stdin is killed.
   */
  close() {
    if (this.#torn) return this.#closedPromise;
    this.#closing = true;
    // With no child yet, #start is still resolving the pane's session; it sees
    // the flag and stops there.
    if (this.#child) this.#stopChild();
    return this.#closedPromise;
  }
}

/**
 * Attach a control client to a tmux session and stream one of its panes.
 *
 *   tmux        the tmux binary: a path, or findTmux()'s answer ({ path })
 *   socket      { name } for `-L name` or { path } for `-S path` — required
 *   target      session name, "$id", or a pane id "%N" (then its session is
 *               looked up first, so the user's current window is not moved)
 *   pane        the pane to stream; defaults to the target's active pane
 *   ignoreSize  attach with `ignore-size` (case B: the user's terminal owns the
 *               size; resize() becomes a no-op and 'size' reports the pane's)
 *   readOnly    input() and paste() are refused
 *   pauseAfter  seconds behind before tmux pauses the pane (0 = never)
 *   spawn, execFile, env   seams for tests; real defaults
 *
 * Returns the ControlClient synchronously; await `.ready` before relying on
 * `.pane`.
 */
export function openControl(options) {
  return new ControlClient(options);
}
