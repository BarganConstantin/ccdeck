// The stage's one terminal, and the session it is showing.
//
// ONE XTERM FOR THE STAGE'S LIFETIME. A switch between sessions is the same
// Terminal reset and seeded again (v3: "one instance; a switch is reset plus
// seed, never a second terminal"). A second instance per session would be a
// second WebGL context per click — browsers cap those at sixteen and drop the
// oldest without asking — and a remount would flash an empty box between two
// frames that both have content.
//
// WRITE BEFORE REVEAL. The deck answers a socket with `reset {cols, rows}` and
// one binary frame, the seed: the bytes that make a cleared terminal show what
// tmux shows. The stage reveals the pane only from the seed's parse callback,
// so the first frame anybody sees is the session as it is, never a terminal
// booting. Until then the body shows a state card (the last line the board
// knew, or "Starting Claude Code in …").
//
// ORDER IS XTERM'S QUEUE. The reset, the resize and the seed go through
// `write`: `write("", cb)` runs `cb` once everything already queued has been
// parsed, and nothing queued after it is parsed before `cb` returns. So the
// reset and the resize happen exactly between the old session's last bytes
// and the new seed, and the output that follows the seed can be written
// straight away — no buffer of our own beyond the moment before xterm loads.
//
// A DECK RESTART IS NOT AN ENDING (scenario S3). The deck tells every socket
// `exit server-shutdown` as it stops; a socket that simply drops is the same
// story told less politely. Either way the session is still running in tmux,
// so the stage keeps the frozen frame up, says "reconnecting…", and asks the
// restarted deck for a fresh ticket — backing off, and giving up with a
// sentence after two minutes rather than polling a dead port forever.
//
// THE TERMINAL IS LOADED HERE, LAZILY. This file is reached only from the
// stage's own lazy chunk, and even there xterm and its addons are dynamic
// imports: the stage chrome can draw its state card while the library is
// still on its way. Everything else imports only types from @xterm.
//
// The controller (createTerminalSession) knows nothing about React, so the
// suite drives it with a fake socket, a fake terminal and a fake API; the
// hook at the bottom is the thin part that ties it to a component's life.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ITheme } from "@xterm/xterm";
import {
  adoptTerminal,
  launchTerminal,
  openTerminal,
  terminalStatus,
  STILL_RUNNING,
  type LaunchOptions,
  type PaneColours,
  type ApiFailure,
  type SessionRef,
  type TerminalProvider,
  type TmuxProgress,
  type TmuxStatus,
} from "./terminal-api";
import { connectTerminal, hexColour, pasteTooLarge, type ConnectOptions, type SizeOwner, type TerminalConnection, type TmuxVersion } from "./terminal-protocol";
import { MINIMUM_CONTRAST_RATIO } from "./terminal-palette";
import type { Cell } from "./stage-geometry";
import { terminalKeyInput, terminalKeyOutcome, type TerminalKey } from "./terminal-keys";
import { openLink } from "./terminal-links";
import { copyText } from "./copy-text";
import { leaveRepliesToTmux } from "./terminal-replies";
import { isApplePlatform, platformName } from "./platform";
import type { KeysOwner, StagePhase } from "./components/terminal/stage-model";

/** The stage's font size. 13.3px is where the deck's mono stack advances a
 *  whole 8px on DejaVu Sans Mono and on Menlo, so cells come out exactly 8
 *  wide there instead of floor-squeezed from 7.8; elsewhere the measured cell
 *  (Cell, below) is what the geometry uses, so a different advance costs
 *  nothing but a different column count. */
export const STAGE_FONT_SIZE = 13.3;
export const STAGE_LINE_HEIGHT = 1.2;
/** The token the terminal's font is read from: the deck's mono stack, read
 *  through the palette snapshot like the colours, never written out again. */
export const TERMINAL_FONT_TOKEN = "--font-mono";

/** How long the divider must rest before the pane is resized — the SIGWINCH
 *  goes once, when the width has settled, never per frame of a drag. */
export const RESIZE_SETTLE_MS = 120;
/** How long after the last output the spine's light keeps travelling. */
export const STREAM_QUIET_MS = 1200;
/** Output this soon after the reader's own input is its echo, not streaming. */
export const ECHO_WINDOW_MS = 250;
/** How often the panel tells the deck how much its terminal has parsed, in
 *  bytes: an eighth of the deck's window (ACK_WINDOW_BYTES in
 *  terminal-socket.mjs), so the window never empties for want of an ack. */
export const ACK_EVERY_BYTES = 64 * 1024;
/** The waits between attempts to reach a restarting deck. */
export const RECONNECT_DELAYS_MS = [400, 800, 1600, 3200, 5000] as const;
/** When the stage stops asking a deck that has not come back. */
export const RECONNECT_GIVE_UP_MS = 120_000;
/** After the deck said it is restarting (`server-shutdown`), how often the
 *  panel asks to come back, and for how long, before the backoff above. A
 *  restart is a deck on its way back in a second or two — an upgrade, the
 *  stale-module notice — and every step of the backoff it lands in is time
 *  the pane sits frozen with the deck already up: measured, a 2 s restart came
 *  back live 0.6 s after the deck did, and one landing in the 3.2 s step would
 *  wait 1.6 s. A refused connection costs nothing on loopback. */
export const RESTART_POLL_MS = 250;
export const RESTART_FAST_MS = 15_000;
/** How often the stage asks again while the deck fetches its own tmux: often
 *  enough that its bar moves with the download, which is a second or two on
 *  a good connection. A status is a loopback read of a value in memory. */
export const TMUX_SETUP_POLL_MS = 400;
/** When it stops waiting for that: a build is about a megabyte, so this is a
 *  connection that is not working rather than a slow one. */
export const TMUX_SETUP_GIVE_UP_MS = 180_000;

// ---------------------------------------------------------------------------
// What the stage is asked to show.

/** The session on stage, a new one being started, or nothing. */
export type StageSubject =
  | { kind: "empty" }
  | { kind: "session"; ref: SessionRef }
  | { kind: "launch"; agent: TerminalProvider; cwd: string; key: string; options?: LaunchOptions };

/** One string per subject, so a re-render that hands the same subject again
 *  is not a switch. */
export function subjectKey(subject: StageSubject): string {
  switch (subject.kind) {
    case "empty": return "empty";
    case "session": return `session:${subject.ref.sessionId}`;
    case "launch": return `launch:${subject.key}`;
  }
}

/** What a launch hands back, for the integrator to find the new session by. */
export interface LaunchedSession {
  agent: TerminalProvider;
  cwd: string;
  /** "" for Codex, which names its session only once it starts writing. */
  sessionId: string;
  /** The deck-owned tmux session it runs in. */
  name: string;
}

// ---------------------------------------------------------------------------
// The terminal, as the controller sees it.

/** The handful of things the controller does with a terminal. The real one is
 *  xterm behind mountXterm; the suite's is a recording fake. */
export interface StageTerminal {
  readonly cols: number;
  readonly rows: number;
  /** Queue bytes; `done` runs once they (and everything before) are parsed. */
  write(data: Uint8Array | string, done?: () => void): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  setTheme(theme: ITheme): void;
  /** The tmux server the pane lives in, which decides the questions xterm
   *  leaves to it (terminal-replies.ts); null while a connection has not said. */
  tmuxVersion(version: TmuxVersion | null): void;
  focus(): void;
  blur(): void;
  /** The cell it drew with, in CSS pixels, once it has drawn. */
  cell(): Cell | null;
  dispose(): void;
}

/** What the terminal reports back. */
export interface StageTerminalEvents {
  /** Typed input, as xterm's onData gives it. */
  onInput(data: string): void;
  /** Raw bytes as a binary string (xterm's onBinary: some mouse reports). */
  onBinary(data: string): void;
  /** A paste, taken before xterm could type it, so it goes up whole. */
  onPaste(text: string): void;
  /** Every key event, first. False keeps it from the pane. */
  onKey(e: TerminalKey): boolean;
  onFocusChange(focused: boolean): void;
  onRender(): void;
}

export interface TerminalInit {
  cols: number;
  rows: number;
  theme: ITheme;
  fontFamily: string;
}

export type MountTerminal = (host: HTMLElement, init: TerminalInit, events: StageTerminalEvents) => Promise<StageTerminal>;

/** Whether the reader runs a forced-colours theme (Windows contrast themes).
 *  The WebGL renderer paints pixels the browser cannot recolour; the DOM
 *  renderer paints elements it can, so that is the one used then. */
function forcedColors(): boolean {
  return typeof matchMedia === "function" && matchMedia("(forced-colors: active)").matches;
}

/**
 * Let xterm draw the cursor before its first focus.
 *
 * xterm keeps the cursor undrawn until the terminal is first focused or typed
 * into (its `isCursorInitialized`), which suits a shell starting in a fresh
 * terminal and not a stage that shows a pane that has been running all along
 * — usually with the keys on the board, so nobody focuses it. A shell prompt
 * with no cursor reads as frozen, and v3 draws the inactive outline there.
 * The seed still says whether tmux shows a cursor at all (`\e[?25h/l`), so a
 * TUI that hides its own keeps it hidden. xterm 6 has no public switch for
 * this; the one internal flag is set when it is there, and a version without
 * it only loses the early cursor again. Exported for its test.
 */
export function showCursorFromTheStart(term: unknown): void {
  const core = (term as { _core?: { coreService?: { isCursorInitialized?: unknown } } } | null)?._core;
  const service = core?.coreService;
  if (service && typeof service.isCursorInitialized === "boolean") service.isCursorInitialized = true;
}

/** The byte Ctrl+V sends in a terminal: Claude Code and Codex read an image
 *  from the clipboard on it. */
export const CTRL_V = "\x16";

/** How soon after a middle press a paste counts as that press's: the browser
 *  fires it within the same click. */
export const MIDDLE_PASTE_MS = 1000;

/** Whether a paste carries an image (a screenshot, a copied picture). */
export function pasteHoldsImage(data: Pick<DataTransfer, "items"> | null | undefined): boolean {
  const items = data?.items;
  if (!items) return false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item && item.kind === "file" && item.type.startsWith("image/")) return true;
  }
  return false;
}

/** Copy what is selected in the pane, if anything, through the deck's one
 *  clipboard helper. Its fallback selects a textarea of its own, so the keys
 *  are put back in the pane if that took them. */
function copySelection(term: { hasSelection(): boolean; getSelection(): string; focus(): void; textarea?: HTMLTextAreaElement }): void {
  if (!term.hasSelection()) return;
  const typing = !!term.textarea && document.activeElement === term.textarea;
  void copyText(term.getSelection()).then(() => {
    if (typing && document.activeElement !== term.textarea) term.focus();
  });
}

/**
 * xterm itself, loaded on first use: grapheme-cluster widths, WebGL with the
 * DOM renderer as the fallback when it cannot start or loses its context, the
 * options v3 settled on, and the few places the pane is not a page:
 *
 * WIDTHS ARE TMUX'S AND CLAUDE CODE'S. The seed is tmux's grid and Claude Code
 * lays its prompt out by grapheme cluster, so 👍🏽, 🇲🇩, 👨‍👩‍👧 and ⚠️ are two
 * cells each to both — measured on tmux 3.8 with `cursor_x` after each. The
 * Unicode 11 table gave 4, 2, 6 and 1, which pushed the rest of the line
 * right and broke Claude Code's box; the graphemes addon gives exactly tmux's.
 *
 * TMUX ANSWERS THE PANE'S QUESTIONS (terminal-replies.ts) — those that tmux
 * answers: xterm sees them in the raw output and would answer a second time
 * into the program's input. What a given tmux answers is its version's, which
 * the deck reports per connection (`tmuxVersion`); xterm answers the rest.
 *
 * LINKS NEED CTRL (Cmd on a Mac), and never a browser dialog
 * (terminal-links.ts), for OSC 8 links and plain URLs alike.
 */
export const mountXterm: MountTerminal = async (host, init, events) => {
  const [{ Terminal }, { UnicodeGraphemesAddon }, { WebLinksAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-unicode-graphemes"),
    import("@xterm/addon-web-links"),
    // Its stylesheet, with it rather than with the stage: see xterm-sheet.ts.
    import("./xterm-sheet"),
  ]);
  const apple = isApplePlatform(platformName());
  // Read when a link is pressed, so a program that turns the mouse on later
  // keeps its clicks (terminal-links.ts).
  let programHasMouse = () => false;
  const follow = (e: MouseEvent, uri: string) => openLink(e, uri, { apple, programHasMouse: programHasMouse() });
  const term = new Terminal({
    cols: init.cols,
    rows: init.rows,
    fontFamily: init.fontFamily,
    fontSize: STAGE_FONT_SIZE,
    lineHeight: STAGE_LINE_HEIGHT,
    theme: init.theme,
    // `unicode` is behind the proposed-API gate in xterm 6.
    allowProposedApi: true,
    customGlyphs: true,
    // Nothing on the stage blinks: a blinking cursor beside a still header
    // reads as an alarm, and under reduced motion it would be one anyway.
    cursorBlink: false,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    minimumContrastRatio: MINIMUM_CONTRAST_RATIO,
    // What native terminals keep, and what the deck's tmux keeps for the
    // pane (terminal-sessions.mjs). A reattach brings back the last
    // SEED_HISTORY lines of it, so a switch stays quick; what streamed while
    // the pane was on screen stays here to scroll back through.
    scrollback: 10_000,
    smoothScrollDuration: 0,
    // Off: streaming agent output into a live region is #372's anti-pattern.
    // The stage announces what changed, once, through the deck's own regions.
    screenReaderMode: false,
    // OSC 8 links, without xterm's confirm() and only with Ctrl/Cmd held.
    linkHandler: { activate: follow, allowNonHttpProtocols: false },
    // Option-drag selects on a Mac while the program has the mouse, as Shift
    // does elsewhere; without it a Mac has no way to select there at all.
    macOptionClickForcesSelection: true,
  });
  // Activates "15-graphemes" itself.
  term.loadAddon(new UnicodeGraphemesAddon());
  term.loadAddon(new WebLinksAddon(follow));
  programHasMouse = () => term.modes.mouseTrackingMode !== "none";
  const replies = leaveRepliesToTmux(term.parser);
  term.open(host);
  // A form field with neither id nor name is flagged by the browser's issues
  // panel on every open; the pane's input is named for what it is.
  term.textarea?.setAttribute("name", "terminal-input");
  showCursorFromTheStart(term);

  if (!forcedColors()) {
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      const gl = new WebglAddon();
      // Disposing the addon hands rendering back to xterm's DOM renderer.
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch {
      // No WebGL2 here (a headless browser, a blocked GPU): the DOM renderer
      // is already drawing, which is the fallback.
    }
  }

  term.attachCustomKeyEventHandler(e => {
    const pass = events.onKey(e);
    // A key kept from the pane is kept from the textarea and the browser too:
    // Shift+Enter would type a newline into it and fire a keypress xterm reads
    // as Enter, the release chord has a browser meaning (Firefox flips a
    // field's text direction), and Ctrl+Shift+C opens Chrome's element picker.
    // It is not stopped, though: the release chord goes on to the deck's window
    // listener, which is the one that acts on it (terminal-keys.ts and
    // use-deck-shortcuts.ts).
    if (!pass && e.type === "keydown") {
      e.preventDefault();
      if (terminalKeyOutcome(e, apple) === "copy") copySelection(term);
    }
    return pass;
  });
  const disposables = [
    term.onData(d => events.onInput(d)),
    term.onBinary(d => events.onBinary(d)),
    term.onRender(() => events.onRender()),
  ];
  // Capture on the host, which holds xterm's element and its textarea, so the
  // paste is taken before either of xterm's own paste listeners sees it.
  // A middle click pastes the primary selection on Linux. While the program
  // has the mouse that click is the program's — xterm reports it — and a
  // native terminal pastes nothing with it; Shift+middle pastes there, and
  // here, because xterm does not report a Shift click.
  let middleAt = -Infinity;
  const onMouseDown = (e: MouseEvent) => { if (e.button === 1 && !e.shiftKey) middleAt = performance.now(); };
  host.addEventListener("mousedown", onMouseDown, true);
  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    e.preventDefault();
    e.stopPropagation();
    const fromMiddle = performance.now() - middleAt < MIDDLE_PASTE_MS;
    middleAt = -Infinity;
    if (fromMiddle && programHasMouse()) return;
    if (!text) {
      // A screenshot, and no text: do what a terminal does with Ctrl+V and
      // hand the program the key itself, so Claude Code (or Codex) reads the
      // image off the clipboard as it does in any terminal. The browser took
      // the key for its own paste and would otherwise drop the image without
      // a word. The pane's socket is loopback only, so the clipboard this
      // page sees is the machine's own, the one the program reads.
      if (pasteHoldsImage(e.clipboardData)) {
        term.scrollToBottom();
        events.onInput(CTRL_V);
      }
      return;
    }
    // Back to where the paste lands, as typing already brings the view.
    term.scrollToBottom();
    events.onPaste(text);
  };
  host.addEventListener("paste", onPaste, true);
  const textarea = term.textarea;
  const onFocus = () => events.onFocusChange(true);
  const onBlur = () => events.onFocusChange(false);
  textarea?.addEventListener("focus", onFocus);
  textarea?.addEventListener("blur", onBlur);

  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    write: (data, done) => term.write(data, done),
    reset: () => term.reset(),
    resize: (cols, rows) => term.resize(cols, rows),
    setTheme: theme => { term.options.theme = theme; },
    tmuxVersion: version => replies.setTmux(version),
    focus: () => term.focus(),
    blur: () => term.blur(),
    // The screen element is exactly cols × rows cells: xterm sizes it to the
    // renderer's canvas. Measured rather than read off xterm's private render
    // service, which has no public accessor in xterm 6.
    cell: () => {
      const screen = term.element?.querySelector(".xterm-screen");
      if (!screen || !term.cols || !term.rows) return null;
      const box = screen.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      return { w: box.width / term.cols, h: box.height / term.rows };
    },
    dispose: () => {
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("mousedown", onMouseDown, true);
      textarea?.removeEventListener("focus", onFocus);
      textarea?.removeEventListener("blur", onBlur);
      for (const d of disposables) d.dispose();
      replies.dispose();
      term.dispose();
    },
  };
};

// ---------------------------------------------------------------------------
// The controller.

export interface SessionApi {
  status: typeof terminalStatus;
  open: typeof openTerminal;
  adopt: typeof adoptTerminal;
  launch: typeof launchTerminal;
}

export interface SessionDeps {
  api: SessionApi;
  connect: (options: ConnectOptions) => TerminalConnection;
  mount: MountTerminal;
  now: () => number;
}

export const DEFAULT_DEPS: SessionDeps = {
  api: { status: terminalStatus, open: openTerminal, adopt: adoptTerminal, launch: launchTerminal },
  connect: connectTerminal,
  mount: mountXterm,
  now: () => Date.now(),
};

/** Everything the stage draws from, in one value. */
export interface SessionSnapshot {
  /** The subject this describes (subjectKey). For a render or two after the
   *  stage moves, the snapshot is still the last subject's, and a pane that
   *  took keys then is not the one the stage now shows. */
  subject: string;
  phase: StagePhase;
  keysOwner: KeysOwner;
  /** Output arrived in the last STREAM_QUIET_MS — the spine's light. */
  streaming: boolean;
  /** The cell xterm drew with, once it has drawn. */
  cell: Cell | null;
  /** The pane's own size where the pane keeps it — case B, the user's own
   *  tmux — so the stage can make room for it. Null where the stage sizes
   *  the pane. */
  paneSize?: { cols: number; rows: number } | null;
}

export interface SessionCallbacks {
  onChange(snapshot: SessionSnapshot): void;
  onCell?(cell: Cell): void;
  onLaunched?(launched: LaunchedSession): void;
  /** Something the reader did that the pane would not take, said once. */
  onNotice?(sentence: string): void;
}

/** A paste too big for one message: refused, and said, rather than lost. */
export const PASTE_TOO_LARGE = "That paste is over 1 MB, too big to send to the session. Nothing was typed.";

export interface TerminalSessionController {
  mount(host: HTMLElement, init: Omit<TerminalInit, "cols" | "rows">): void;
  show(subject: StageSubject): void;
  resize(cols: number, rows: number, hold: boolean): void;
  setTheme(theme: ITheme): void;
  adopt(): void;
  retry(): void;
  focus(): void;
  /** Keys typed before the pane could take them (type-ahead.ts). */
  type(text: string): void;
  release(): void;
  dispose(): void;
  snapshot(): SessionSnapshot;
}

const isFailure = (v: { ok: boolean }): v is ApiFailure => v.ok === false && !("target" in v);
/** A failure that a deck on its way back up would also give: no answer at
 *  all, or a gateway in front of it that has none yet. */
const transient = (f: ApiFailure) => f.status === null || f.status === 502 || f.status === 503 || f.status === 504;

/** Whether two answers about the deck's tmux download say the same thing, so
 *  a poll that learned nothing new draws nothing. */
const sameProgress = (a?: TmuxProgress, b?: TmuxProgress) =>
  a?.stage === b?.stage
  && (a?.stage !== "downloading" || b?.stage !== "downloading" || (a.received === b.received && a.total === b.total));

const STOPPED = "The terminal stopped. The session may still be running.";
const NO_RETURN = "The deck did not come back. The session is still running in tmux; try again once the deck is up.";
const NOT_REOPENABLE = "This session started without a name the deck can find it by yet. Open it from the board.";
const TMUX_SETUP_SLOW = "The deck is still setting up tmux. Try again in a minute.";

/**
 * The stage's terminal and its one connection, as a state machine.
 *
 * Every asynchronous step carries the generation it started in; a step that
 * comes back after the subject changed, or after the controller was disposed,
 * finds a newer generation and does nothing.
 */
export function createTerminalSession(deps: SessionDeps, callbacks: SessionCallbacks): TerminalSessionController {
  let gen = 0;
  let disposed = false;
  let subject: StageSubject = { kind: "empty" };
  /** The ref to reach a launched session by, once the deck has named it. */
  let launchedRef: SessionRef | null = null;
  /** The launch was answered: its agent is running, whether or not the deck
   *  could name it (a Codex launch answers no session id). Asked again, it
   *  would start a second agent in the same folder; NOT_REOPENABLE says to
   *  open it from the board instead. */
  let launched = false;

  let term: StageTerminal | null = null;
  let mounting = false;
  let pendingTheme: ITheme | null = null;
  /** The theme the pane is drawn in now, whose foreground and background the
   *  deck passes on to tmux (terminal-protocol's `colours`). */
  let colours: ITheme | null = null;
  /** Those colours as a session is started in them, or nothing yet. */
  const paneColours = (): PaneColours | undefined => {
    const fg = hexColour(colours?.foreground);
    const bg = hexColour(colours?.background);
    return fg && bg ? { fg, bg } : undefined;
  };
  /** Terminal work asked for before xterm had loaded, replayed in order. */
  let held: Array<(t: StageTerminal) => void> = [];

  let conn: TerminalConnection | null = null;
  let sizeOwner: SizeOwner = "dock";
  let readOnly = false;

  let want = { cols: 80, rows: 24 };
  let hold = false;
  let sizeTimer: ReturnType<typeof setTimeout> | null = null;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectStarted: number | null = null;
  // When the deck last said it was restarting; null for any other loss.
  let restartSaid: number | null = null;
  let attempts = 0;

  let snap: SessionSnapshot = { subject: "empty", phase: { kind: "empty" }, keysOwner: "board", streaming: false, cell: null };

  const emit = (next: Partial<SessionSnapshot>) => {
    if (disposed) return;
    snap = { ...snap, ...next, subject: subjectKey(subject) };
    callbacks.onChange(snap);
  };
  const setPhase = (phase: StagePhase) => emit({ phase });

  const withTerminal = (fn: (t: StageTerminal) => void) => {
    if (term) fn(term);
    else held.push(fn);
  };

  const measure = () => {
    const c = term?.cell();
    if (!c || (snap.cell && snap.cell.w === c.w && snap.cell.h === c.h)) return;
    emit({ cell: c });
    callbacks.onCell?.(c);
  };

  const clearTimer = (t: ReturnType<typeof setTimeout> | null) => { if (t !== null) clearTimeout(t); };

  const dropConnection = () => {
    conn?.close();
    conn = null;
    clearTimer(retryTimer);
    retryTimer = null;
    if (snap.streaming) emit({ streaming: false });
    clearTimer(streamTimer);
    streamTimer = null;
  };

  /** The ref the current subject is reached by, or null when there is none. */
  const refOf = (): SessionRef | null =>
    subject.kind === "session" ? subject.ref : subject.kind === "launch" ? launchedRef : null;
  /** The subject is a launch that has not started an agent yet. */
  const toLaunch = () => subject.kind === "launch" && !launchedRef && !launched;

  // -- the socket ------------------------------------------------------------

  // What the reader sent last, for telling the program's own output from the
  // echo of what was typed (onData below).
  let typedAt = -Infinity;
  const typed = () => { typedAt = deps.now(); };

  const markStreaming = () => {
    if (!snap.streaming) emit({ streaming: true });
    clearTimer(streamTimer);
    streamTimer = setTimeout(() => { streamTimer = null; emit({ streaming: false }); }, STREAM_QUIET_MS);
  };

  const connect = (ticket: string, my: number) => {
    sizeOwner = "dock";
    readOnly = false;
    if (snap.paneSize) emit({ paneSize: null });
    // A new connection may be to another tmux (the user's own, in case B), and
    // until it says which, every question that depends on it is left to tmux.
    // In the write queue, like every change of what the bytes mean: what the
    // last connection wrote is still parsed under its own tmux.
    withTerminal(t => t.write("", () => t.tmuxVersion(null)));
    // Whether this connection is still the one speaking. A seed is revealed
    // from xterm's parse callback, which can come after the socket has already
    // said `exit` — a session that ended the moment it was attached, or a
    // terminal still loading when it did — and the ending must not then be
    // painted over with "live".
    let open = true;
    // What this connection's terminal has parsed of the deck's binary bytes,
    // and what was last said of it (`ack`): the deck keeps no more than a
    // window of output in flight beyond it. Counted per connection, from the
    // parse callbacks, which a superseded connection's writes do not reach.
    let parsed = 0;
    let acked = 0;
    const parsedBytes = (n: number, now = false) => {
      if (my !== gen || !open) return;
      parsed += n;
      if (now || parsed - acked >= ACK_EVERY_BYTES) {
        acked = parsed;
        c.sendAck(parsed);
      }
    };
    const c: TerminalConnection = deps.connect({
      ticket,
      onHello: hello => {
        if (my !== gen) return;
        sizeOwner = hello.sizeOwner;
        readOnly = hello.readOnly;
      },
      onReset: ({ cols, rows, seed }) => {
        if (my !== gen) return;
        withTerminal(t => {
          t.write("", () => {
            if (my !== gen) return;
            t.reset();
            if (t.cols !== cols || t.rows !== rows) t.resize(cols, rows);
          });
          t.write(seed, () => {
            if (my !== gen || !open) return;
            // At once after a seed, whatever its size: it is how the deck
            // learns this panel acknowledges at all.
            parsedBytes(seed.byteLength, true);
            attempts = 0;
            reconnectStarted = null;
            restartSaid = null;
            emit({ phase: { kind: "live", sizeOwner, readOnly }, paneSize: sizeOwner === "pane" ? { cols: t.cols, rows: t.rows } : null });
            measure();
            // The stage moved while this was being seeded (a reconnect after
            // a resize): say the size it has now.
            if (sizeOwner === "dock" && (t.cols !== want.cols || t.rows !== want.rows)) applySize();
          });
        });
      },
      onData: bytes => {
        if (my !== gen) return;
        // The echo of a key is output too, but it is not the agent at work:
        // counted, it lit the spine for as long as anyone typed, and that
        // endless light kept the page producing frames and every echo a frame
        // late (25 ms a key against 2.3 measured). Output that follows input
        // this closely is the input's own.
        if (deps.now() - typedAt >= ECHO_WINDOW_MS) markStreaming();
        withTerminal(t => t.write(bytes, () => parsedBytes(bytes.byteLength)));
      },
      onTmux: version => {
        if (my !== gen) return;
        withTerminal(t => t.write("", () => { if (my === gen) t.tmuxVersion(version); }));
      },
      onSize: ({ cols, rows }) => {
        // The pane's real size, when it is not the one this panel asked for:
        // in case B it lives in someone's own tmux and keeps its own size, and
        // on a deck pane another view of the same session (a second tab,
        // `tmux attach` by hand) sized it last. The deck takes a shared pane
        // back for this panel when it is typed in, and says so the same way.
        if (my !== gen) return;
        withTerminal(t => t.write("", () => {
          if (my !== gen) return;
          t.resize(cols, rows);
          if (sizeOwner === "pane") emit({ paneSize: { cols, rows } });
        }));
      },
      onExit: ({ reason, message, atOpen }) => {
        if (my !== gen) return;
        open = false;
        conn = null;
        if (snap.streaming) emit({ streaming: false });
        if (reason === "server-shutdown") { restartSaid = deps.now(); reconnect(my); }
        // Ended before anyone was looking: the deck says so for a dead pane
        // opened for its last frame, and an ending that lands before the seed
        // was ever revealed is the same thing seen from here.
        else if (reason === "ended") setPhase(atOpen || snap.phase.kind !== "live" ? { kind: "ended", atOpen: true } : { kind: "ended" });
        else if (reason === "detached") setPhase({ kind: "detached" });
        else setPhase({ kind: "error", message: message || STOPPED });
      },
      onError: failure => {
        if (my !== gen) return;
        open = false;
        conn = null;
        if (failure.kind === "lost" || snap.phase.kind === "attaching" && snap.phase.reconnect) reconnect(my);
        else setPhase({ kind: "error", message: failure.message });
      },
    });
    conn = c;
    // The first size is what starts the stream; it is queued until the socket
    // opens, so it can be sent straight away. The colours with it, so a
    // program asking its terminal's colours in its first frame is answered.
    conn.sendSize(want.cols, want.rows);
    if (colours) conn.sendColours(colours.foreground, colours.background);
  };

  // -- asking the deck -------------------------------------------------------

  /** A refusal that might be tmux missing: ask, and draw that fact if so. */
  const tmuxOr = async (my: number, otherwise: StagePhase) => {
    const status = await deps.api.status();
    if (my !== gen) return;
    if (status.ok && !status.tmux.ok) tmuxNotReady(my, status.tmux, deps.now());
    else setPhase(otherwise);
  };

  /** tmux is not usable yet. Missing, it is a fact with its install line;
   *  while the deck fetches its own, the stage says so and asks again until
   *  it lands, then asks once more for what was refused. */
  const tmuxNotReady = (my: number, tmux: TmuxStatus, since: number) => {
    if (tmux.reason !== "installing") {
      setPhase({
        kind: "tmux-missing",
        reason: tmux.reason ?? "missing",
        ...(tmux.install ? { install: tmux.install } : {}),
        ...(tmux.download ? { download: tmux.download } : {}),
        busy: false,
      });
      return;
    }
    if (deps.now() - since > TMUX_SETUP_GIVE_UP_MS) { setPhase({ kind: "error", message: TMUX_SETUP_SLOW }); return; }
    if (snap.phase.kind !== "tmux-installing" || !sameProgress(snap.phase.progress, tmux.progress)) {
      setPhase({ kind: "tmux-installing", ...(tmux.progress ? { progress: tmux.progress } : {}) });
    }
    clearTimer(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (my !== gen || disposed) return;
      void deps.api.status().then((status) => {
        if (my !== gen) return;
        if (status.ok && status.tmux.ok) {
          setPhase(toLaunch() && subject.kind === "launch"
            ? { kind: "starting", agent: subject.agent, cwd: subject.cwd }
            : { kind: "attaching", reconnect: false });
          askAgain(my);
        } else if (status.ok) {
          tmuxNotReady(my, status.tmux, since);
        } else if (transient(status)) {
          // The deck blinked; the download it started goes on without it,
          // and the bar stays where it was.
          const shown = snap.phase.kind === "tmux-installing" ? snap.phase.progress : undefined;
          tmuxNotReady(my, { ok: false, reason: "installing", ...(shown ? { progress: shown } : {}) }, since);
        } else {
          setPhase({ kind: "error", message: status.error });
        }
      });
    }, TMUX_SETUP_POLL_MS);
  };

  /** Ask again for what tmux's absence refused: the launch, or the open. */
  const askAgain = (my: number) => {
    const ref = refOf();
    if (toLaunch() && subject.kind === "launch") void launchFlow(subject.agent, subject.cwd, subject.key, my, subject.options);
    else if (ref) void openFlow(ref, my, false);
    else setPhase({ kind: "empty" });
  };

  const openFlow = async (ref: SessionRef, my: number, reconnecting: boolean) => {
    const answer = await deps.api.open(ref);
    if (my !== gen) return;
    if (answer.ok) { connect(answer.ticket, my); return; }
    if (isFailure(answer)) {
      if (reconnecting && transient(answer)) { reconnect(my); return; }
      setPhase({ kind: "error", message: answer.error });
      return;
    }
    if (answer.target.kind === "unsupported") {
      await tmuxOr(my, { kind: "error", message: answer.target.label });
      return;
    }
    setPhase({ kind: "not-attachable", target: answer.target, stillRunning: false, busy: false });
  };

  const launchFlow = async (agent: TerminalProvider, cwd: string, key: string, my: number, options?: LaunchOptions) => {
    // At the size the pane will be shown at, so the agent's first screen is
    // drawn once (terminal-routes.mjs, the launch route).
    // And in the panel's colours, so a program asking its terminal's
    // background at its first frame is told the deck's (terminal-sessions.mjs).
    const tint = paneColours();
    // By its key, so Try again after an answer that never came (the deck
    // restarting under it) reaches the agent it started, not a second one.
    const answer = await deps.api.launch({ agent, cwd, key, size: { ...want }, ...(options ? { launch: options } : {}), ...(tint ? { colours: tint } : {}) });
    if (my !== gen) return;
    if (!answer.ok) {
      if (answer.status === 409) await tmuxOr(my, { kind: "error", message: answer.error });
      else setPhase({ kind: "error", message: answer.error });
      return;
    }
    launched = true;
    if (answer.sessionId) launchedRef = { sessionId: answer.sessionId, provider: agent, cwd };
    callbacks.onLaunched?.({ agent, cwd, sessionId: answer.sessionId, name: answer.name });
    connect(answer.ticket, my);
  };

  /** Start over for the current subject: a fresh generation, nothing of the
   *  last attempt left running. */
  const begin = (reconnecting = false) => {
    gen += 1;
    const my = gen;
    dropConnection();
    if (subject.kind === "empty") { setPhase({ kind: "empty" }); return; }
    if (toLaunch() && subject.kind === "launch") {
      setPhase({ kind: "starting", agent: subject.agent, cwd: subject.cwd });
      void launchFlow(subject.agent, subject.cwd, subject.key, my, subject.options);
      return;
    }
    const ref = refOf();
    if (!ref) { setPhase({ kind: "error", message: NOT_REOPENABLE }); return; }
    setPhase({ kind: "attaching", reconnect: reconnecting });
    void openFlow(ref, my, reconnecting);
  };

  /** The deck went away under a live pane. Keep the frame, and ask again. */
  const reconnect = (my: number) => {
    if (my !== gen || disposed) return;
    const now = deps.now();
    reconnectStarted ??= now;
    if (now - reconnectStarted > RECONNECT_GIVE_UP_MS) {
      reconnectStarted = null;
      attempts = 0;
      setPhase({ kind: "error", message: NO_RETURN });
      return;
    }
    setPhase({ kind: "attaching", reconnect: true });
    const fast = restartSaid !== null && now - restartSaid < RESTART_FAST_MS;
    const delay = fast ? RESTART_POLL_MS : RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)];
    attempts += 1;
    clearTimer(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (my !== gen || disposed) return;
      gen += 1;
      const next = gen;
      const ref = refOf();
      if (!ref) { setPhase({ kind: "error", message: NOT_REOPENABLE }); return; }
      void openFlow(ref, next, true);
    }, delay);
  };

  // -- size ------------------------------------------------------------------

  function applySize() {
    clearTimer(sizeTimer);
    sizeTimer = null;
    if (!conn || sizeOwner === "pane") return;
    if (term && snap.phase.kind === "live" && (term.cols !== want.cols || term.rows !== want.rows)) {
      term.resize(want.cols, want.rows);
    }
    conn.sendSize(want.cols, want.rows);
  }

  // -- the terminal's own events ---------------------------------------------

  const events: StageTerminalEvents = {
    onInput: data => { if (snap.phase.kind === "live") { typed(); conn?.sendInput(data); } },
    onBinary: data => {
      if (snap.phase.kind !== "live") return;
      typed();
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      conn?.sendInput(bytes);
    },
    onPaste: text => {
      if (snap.phase.kind !== "live" || !conn) return;
      typed();
      if (!conn.sendPaste(text) && pasteTooLarge(text)) callbacks.onNotice?.(PASTE_TOO_LARGE);
    },
    // terminal-keys.ts decides; this only carries the decision out. The
    // release chord is kept from the session and acted on by the deck's own
    // listener, so it is not answered here as well: one owner, one release.
    onKey: e => {
      const outcome = terminalKeyOutcome(e);
      if (outcome === "pass") return true;
      const input = e.type === "keydown" && snap.phase.kind === "live" ? terminalKeyInput(e, outcome) : null;
      if (input) { typed(); conn?.sendInput(input); }
      return false;
    },
    onFocusChange: focused => {
      const owner: KeysOwner = focused ? "pane" : "board";
      if (owner !== snap.keysOwner) emit({ keysOwner: owner });
    },
    onRender: () => { if (!snap.cell) measure(); },
  };

  return {
    mount(host, init) {
      if (term || mounting || disposed) return;
      mounting = true;
      const theme = pendingTheme ?? init.theme;
      if (!colours) colours = theme;
      deps.mount(host, { ...init, theme, cols: want.cols, rows: want.rows }, events).then(t => {
        mounting = false;
        if (disposed) { t.dispose(); return; }
        term = t;
        if (pendingTheme) t.setTheme(pendingTheme);
        pendingTheme = null;
        const queued = held;
        held = [];
        for (const fn of queued) fn(t);
        measure();
      }, () => {
        mounting = false;
        if (!disposed) setPhase({ kind: "error", message: "The terminal could not be loaded. Reload the page to try again." });
      });
    },

    show(next) {
      if (disposed) return;
      // The session a launch just started, arriving on the board: the stage
      // is already attached to it, so this is a rename, not a switch.
      if (next.kind === "session" && subject.kind === "launch" && launchedRef
        && next.ref.sessionId === launchedRef.sessionId) {
        subject = next;
        launchedRef = null;
        launched = false;
        emit({});
        return;
      }
      if (subjectKey(next) === subjectKey(subject)) return;
      subject = next;
      launchedRef = null;
      launched = false;
      held = [];
      attempts = 0;
      reconnectStarted = null;
      begin();
    },

    resize(cols, rows, holdResize) {
      if (!(cols > 0 && rows > 0)) return;
      want = { cols: Math.floor(cols), rows: Math.floor(rows) };
      hold = holdResize;
      clearTimer(sizeTimer);
      sizeTimer = null;
      if (hold) return;
      sizeTimer = setTimeout(applySize, RESIZE_SETTLE_MS);
    },

    setTheme(theme) {
      if (term) term.setTheme(theme);
      else pendingTheme = theme;
      colours = theme;
      conn?.sendColours(theme.foreground, theme.background);
    },

    adopt() {
      const ref = refOf();
      const phase = snap.phase;
      if (!ref || disposed) return;
      if (phase.kind !== "not-attachable" && phase.kind !== "ended" && phase.kind !== "detached") return;
      // The button stays enabled while it works (#620: a press never
      // disables its own control), so a second press is refused here.
      if (phase.kind === "not-attachable" && phase.busy) return;
      gen += 1;
      const my = gen;
      dropConnection();
      if (phase.kind === "not-attachable") setPhase({ ...phase, busy: true });
      else setPhase({ kind: "attaching", reconnect: true });
      void deps.api.adopt(ref, {}, { ...want }, paneColours()).then(answer => {
        if (my !== gen) return;
        if (answer.ok) { connect(answer.ticket, my); return; }
        if (answer.error === STILL_RUNNING && phase.kind === "not-attachable") {
          setPhase({ ...phase, stillRunning: true, busy: false });
          return;
        }
        setPhase({ kind: "error", message: answer.error });
      });
    },

    retry() {
      if (disposed) return;
      const phase = snap.phase;
      if (phase.kind === "tmux-missing" && phase.busy) return;
      attempts = 0;
      reconnectStarted = null;
      if (phase.kind !== "tmux-missing") {
        // A failed launch is asked again; anything else is reopened.
        begin(false);
        return;
      }
      // "Check again" keeps the fact on screen while it asks, rather than
      // flashing "attaching…" over the install line for the length of a
      // request that will most likely say the same thing.
      gen += 1;
      const my = gen;
      dropConnection();
      setPhase({ ...phase, busy: true });
      askAgain(my);
    },

    focus() { term?.focus(); },
    // One key per message, as the pane sends a typist's: each reaches tmux as
    // a send-keys of its own. A program that reads several in one go reads
    // what a fast typist's keys would have given it. An ESC is never held on
    // its own — Esc ends the hold, and a chord that sends a lone ESC spoils it
    // (type-ahead.ts) — so one here is the first
    // half of a key sent as two bytes, Shift+Enter or an Option chord, and
    // goes in one message with its second, as the pane sends it: apart, a
    // program could read a lone Esc and then the Enter as a submit.
    type(text) {
      const keys = [...text];
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === "\x1b" && i + 1 < keys.length) events.onInput(keys[i] + keys[++i]);
        else events.onInput(keys[i]);
      }
    },
    release() { term?.blur(); },

    dispose() {
      if (disposed) return;
      gen += 1;
      dropConnection();
      clearTimer(sizeTimer);
      disposed = true;
      held = [];
      term?.dispose();
      term = null;
    },

    snapshot: () => snap,
  };
}

// ---------------------------------------------------------------------------
// The hook.

export interface UseTerminalSessionOptions {
  subject: StageSubject;
  cols: number;
  rows: number;
  /** True while the divider is held: the pane is resized once it settles. */
  holdResize?: boolean;
  theme: ITheme;
  fontFamily: string;
  onCell?: (cell: Cell) => void;
  onLaunched?: (launched: LaunchedSession) => void;
  onNotice?: (sentence: string) => void;
  /** The suite's seam. The stage passes nothing. */
  deps?: Partial<SessionDeps>;
}

export interface TerminalSessionView extends SessionSnapshot {
  /** The element xterm is opened in. Rendered by the stage for its whole
   *  life, whatever it is showing, so the one terminal survives every state. */
  hostRef: MutableRefObject<HTMLDivElement | null>;
  adopt(): void;
  retry(): void;
  focus(): void;
  type(text: string): void;
  release(): void;
}

const EMPTY_SNAPSHOT: SessionSnapshot = { subject: "empty", phase: { kind: "empty" }, keysOwner: "board", streaming: false, cell: null };

/** The stage's terminal session, for as long as the component lives. */
export function useTerminalSession(options: UseTerminalSessionOptions): TerminalSessionView {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<TerminalSessionController | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(EMPTY_SNAPSHOT);

  // Made and mounted in an effect, not during render, so a render that never
  // commits starts nothing, and an unmount takes the terminal and the socket
  // with it — the tmux session keeps running, which is the point.
  useEffect(() => {
    const o = latest.current;
    const ctl = createTerminalSession({ ...DEFAULT_DEPS, ...o.deps }, {
      onChange: setSnapshot,
      onCell: cell => latest.current.onCell?.(cell),
      onLaunched: launched => latest.current.onLaunched?.(launched),
      onNotice: sentence => latest.current.onNotice?.(sentence),
    });
    controller.current = ctl;
    ctl.resize(o.cols, o.rows, !!o.holdResize);
    ctl.setTheme(o.theme);
    if (hostRef.current) ctl.mount(hostRef.current, { theme: o.theme, fontFamily: o.fontFamily });
    ctl.show(o.subject);
    return () => {
      ctl.dispose();
      controller.current = null;
    };
  }, []);

  const key = subjectKey(options.subject);
  useEffect(() => { controller.current?.show(latest.current.subject); }, [key]);
  useEffect(() => { controller.current?.resize(options.cols, options.rows, !!options.holdResize); },
    [options.cols, options.rows, options.holdResize]);
  useEffect(() => { controller.current?.setTheme(options.theme); }, [options.theme]);

  const adopt = useCallback(() => controller.current?.adopt(), []);
  const retry = useCallback(() => controller.current?.retry(), []);
  const focus = useCallback(() => controller.current?.focus(), []);
  const type = useCallback((text: string) => controller.current?.type(text), []);
  const release = useCallback(() => controller.current?.release(), []);

  return { ...snapshot, hostRef, adopt, retry, focus, type, release };
}
