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
  type ApiFailure,
  type SessionRef,
  type TerminalProvider,
  type TmuxStatus,
} from "./terminal-api";
import { connectTerminal, pasteTooLarge, type ConnectOptions, type SizeOwner, type TerminalConnection } from "./terminal-protocol";
import { MINIMUM_CONTRAST_RATIO } from "./terminal-palette";
import type { Cell } from "./stage-geometry";
import { SHIFT_ENTER_INPUT, terminalKeyOutcome, type TerminalKey } from "./terminal-keys";
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
/** The waits between attempts to reach a restarting deck. */
export const RECONNECT_DELAYS_MS = [400, 800, 1600, 3200, 5000] as const;
/** When the stage stops asking a deck that has not come back. */
export const RECONNECT_GIVE_UP_MS = 120_000;
/** How often the stage asks again while the deck fetches its own tmux. */
export const TMUX_SETUP_POLL_MS = 1500;
/** When it stops waiting for that: a build is about a megabyte, so this is a
 *  connection that is not working rather than a slow one. */
export const TMUX_SETUP_GIVE_UP_MS = 180_000;

// ---------------------------------------------------------------------------
// What the stage is asked to show.

/** The session on stage, a new one being started, or nothing. */
export type StageSubject =
  | { kind: "empty" }
  | { kind: "session"; ref: SessionRef }
  | { kind: "launch"; agent: TerminalProvider; cwd: string; key: string };

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

/**
 * xterm itself, loaded on first use: Unicode 11 widths (emoji and CJK take
 * the cells Claude Code thinks they take), WebGL with the DOM renderer as the
 * fallback when it cannot start or loses its context, and the options v3
 * settled on.
 */
export const mountXterm: MountTerminal = async (host, init, events) => {
  const [{ Terminal }, { Unicode11Addon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-unicode11"),
    // Its stylesheet, with it rather than with the stage: see xterm-sheet.ts.
    import("./xterm-sheet"),
  ]);
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
    scrollback: 2000,
    smoothScrollDuration: 0,
    // Off: streaming agent output into a live region is #372's anti-pattern.
    // The stage announces what changed, once, through the deck's own regions.
    screenReaderMode: false,
  });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(host);
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
    // as Enter, and the release chord has a browser meaning (Firefox flips a
    // field's text direction). It is not stopped, though: the release chord
    // goes on to the deck's window listener, which is the one that acts on it
    // (terminal-keys.ts and use-deck-shortcuts.ts).
    if (!pass && e.type === "keydown") e.preventDefault();
    return pass;
  });
  const disposables = [
    term.onData(d => events.onInput(d)),
    term.onBinary(d => events.onBinary(d)),
    term.onRender(() => events.onRender()),
  ];
  // Capture on the host, which holds xterm's element and its textarea, so the
  // paste is taken before either of xterm's own paste listeners sees it.
  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    e.preventDefault();
    e.stopPropagation();
    if (text) events.onPaste(text);
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
      textarea?.removeEventListener("focus", onFocus);
      textarea?.removeEventListener("blur", onBlur);
      for (const d of disposables) d.dispose();
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
  phase: StagePhase;
  keysOwner: KeysOwner;
  /** Output arrived in the last STREAM_QUIET_MS — the spine's light. */
  streaming: boolean;
  /** The cell xterm drew with, once it has drawn. */
  cell: Cell | null;
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
  release(): void;
  dispose(): void;
  snapshot(): SessionSnapshot;
}

const isFailure = (v: { ok: boolean }): v is ApiFailure => v.ok === false && !("target" in v);
/** A failure that a deck on its way back up would also give: no answer at
 *  all, or a gateway in front of it that has none yet. */
const transient = (f: ApiFailure) => f.status === null || f.status === 502 || f.status === 503 || f.status === 504;

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

  let term: StageTerminal | null = null;
  let mounting = false;
  let pendingTheme: ITheme | null = null;
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
  let attempts = 0;

  let snap: SessionSnapshot = { phase: { kind: "empty" }, keysOwner: "board", streaming: false, cell: null };

  const emit = (next: Partial<SessionSnapshot>) => {
    if (disposed) return;
    snap = { ...snap, ...next };
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

  // -- the socket ------------------------------------------------------------

  const markStreaming = () => {
    if (!snap.streaming) emit({ streaming: true });
    clearTimer(streamTimer);
    streamTimer = setTimeout(() => { streamTimer = null; emit({ streaming: false }); }, STREAM_QUIET_MS);
  };

  const connect = (ticket: string, my: number) => {
    sizeOwner = "dock";
    readOnly = false;
    // Whether this connection is still the one speaking. A seed is revealed
    // from xterm's parse callback, which can come after the socket has already
    // said `exit` — a session that ended the moment it was attached, or a
    // terminal still loading when it did — and the ending must not then be
    // painted over with "live".
    let open = true;
    conn = deps.connect({
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
            attempts = 0;
            reconnectStarted = null;
            setPhase({ kind: "live", sizeOwner, readOnly });
            measure();
            // The stage moved while this was being seeded (a reconnect after
            // a resize): say the size it has now.
            if (sizeOwner === "dock" && (t.cols !== want.cols || t.rows !== want.rows)) applySize();
          });
        });
      },
      onData: bytes => {
        if (my !== gen) return;
        markStreaming();
        withTerminal(t => t.write(bytes));
      },
      onSize: ({ cols, rows }) => {
        // Case B: the pane lives in someone's own tmux and keeps its size.
        if (my !== gen) return;
        withTerminal(t => t.write("", () => { if (my === gen) t.resize(cols, rows); }));
      },
      onExit: ({ reason, message, atOpen }) => {
        if (my !== gen) return;
        open = false;
        conn = null;
        if (snap.streaming) emit({ streaming: false });
        if (reason === "server-shutdown") reconnect(my);
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
    // The first size is what starts the stream; it is queued until the socket
    // opens, so it can be sent straight away.
    conn.sendSize(want.cols, want.rows);
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
    if (snap.phase.kind !== "tmux-installing") setPhase({ kind: "tmux-installing" });
    clearTimer(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (my !== gen || disposed) return;
      void deps.api.status().then((status) => {
        if (my !== gen) return;
        if (status.ok && status.tmux.ok) {
          setPhase(subject.kind === "launch" && !launchedRef
            ? { kind: "starting", agent: subject.agent, cwd: subject.cwd }
            : { kind: "attaching", reconnect: false });
          askAgain(my);
        } else if (status.ok) {
          tmuxNotReady(my, status.tmux, since);
        } else if (transient(status)) {
          // The deck blinked; the download it started goes on without it.
          tmuxNotReady(my, { ok: false, reason: "installing" }, since);
        } else {
          setPhase({ kind: "error", message: status.error });
        }
      });
    }, TMUX_SETUP_POLL_MS);
  };

  /** Ask again for what tmux's absence refused: the launch, or the open. */
  const askAgain = (my: number) => {
    const ref = refOf();
    if (subject.kind === "launch" && !launchedRef) void launchFlow(subject.agent, subject.cwd, my);
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

  const launchFlow = async (agent: TerminalProvider, cwd: string, my: number) => {
    const answer = await deps.api.launch({ agent, cwd });
    if (my !== gen) return;
    if (!answer.ok) {
      if (answer.status === 409) await tmuxOr(my, { kind: "error", message: answer.error });
      else setPhase({ kind: "error", message: answer.error });
      return;
    }
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
    if (subject.kind === "launch" && !launchedRef) {
      setPhase({ kind: "starting", agent: subject.agent, cwd: subject.cwd });
      void launchFlow(subject.agent, subject.cwd, my);
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
    const delay = RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)];
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
    onInput: data => { if (snap.phase.kind === "live") conn?.sendInput(data); },
    onBinary: data => {
      if (snap.phase.kind !== "live") return;
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      conn?.sendInput(bytes);
    },
    onPaste: text => {
      if (snap.phase.kind !== "live" || !conn) return;
      if (!conn.sendPaste(text) && pasteTooLarge(text)) callbacks.onNotice?.(PASTE_TOO_LARGE);
    },
    // terminal-keys.ts decides; this only carries the decision out. The
    // release chord is kept from the session and acted on by the deck's own
    // listener, so it is not answered here as well: one owner, one release.
    onKey: e => {
      const outcome = terminalKeyOutcome(e);
      if (outcome === "pass") return true;
      if (outcome === "newline" && e.type === "keydown" && snap.phase.kind === "live") conn?.sendInput(SHIFT_ENTER_INPUT);
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
        return;
      }
      if (subjectKey(next) === subjectKey(subject)) return;
      subject = next;
      launchedRef = null;
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
      void deps.api.adopt(ref).then(answer => {
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
  release(): void;
}

const EMPTY_SNAPSHOT: SessionSnapshot = { phase: { kind: "empty" }, keysOwner: "board", streaming: false, cell: null };

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
  const release = useCallback(() => controller.current?.release(), []);

  return { ...snapshot, hostRef, adopt, retry, focus, release };
}
