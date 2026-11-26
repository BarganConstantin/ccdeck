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
  checkFolder,
  codexUpdated,
  folderRefusal,
  launchTerminal,
  openTerminal,
  stopElsewhere,
  stopElsewhereCheck,
  terminalStatus,
  panelUnavailable,
  PANEL_RECOVERING,
  STILL_RUNNING,
  type FolderAnswer,
  type FolderRefusal,
  type LaunchOptions,
  type PaneColours,
  type ApiFailure,
  type SessionRef,
  type StopElsewhereReason,
  type TerminalProvider,
  type TerminalTarget,
  type TmuxProgress,
  type TmuxStatus,
} from "./terminal-api";
import { connectTerminal, hexColour, pasteTooLarge, type ConnectOptions, type SizeOwner, type TerminalConnection, type TmuxVersion, type ViewKind } from "./terminal-protocol";
import { MINIMUM_CONTRAST_RATIO } from "./terminal-palette";
import { fileDropText, isFileDrop } from "./terminal-file-drop";
import { codexTerminalSurfaces } from "./codex-terminal-surfaces";
import type { Cell } from "./stage-geometry";
import { terminalKeyInput, terminalKeyOutcome, type TerminalKey } from "./terminal-keys";
import { stepTerminalText, textSizeChord } from "./terminal-text-size";
import { openLink } from "./terminal-links";
import { copyText } from "./copy-text";
import { leaveRepliesToTmux } from "./terminal-replies";
import { isApplePlatform, platformName } from "./platform";
import { screenShows, type AskStep } from "./ask-keys";
import { prefersReducedMotion } from "./viewport-motion";
import { t as tr } from "./i18n";
import { isEventOnly } from "../server/provider-ids.mjs";
import { providerLabel } from "./provider-copy";
import type { Provider } from "./types";
import { CLEAN_END_MIN_LIVE_MS, endedCleanly, showsFrame, type FolderGonePhase, type KeysOwner, type StagePhase } from "./components/terminal/stage-model";

/** The stage's font size. 13.3px is where the deck's mono stack advances a
 *  whole 8px on DejaVu Sans Mono and on Menlo, so cells come out exactly 8
 *  wide there instead of floor-squeezed from 7.8; elsewhere the measured cell
 *  (Cell, below) is what the geometry uses, so a different advance costs
 *  nothing but a different column count. It is the pane's 100%: the reader
 *  zooms the pane's own text from there (terminal-text-size.ts). */
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
 *  terminal-bridge.mjs), so the window never empties for want of an ack. */
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
/** How often the stage looks again at a session running in a terminal outside
 *  the deck, while its card is up and the page is shown (#97): soon enough
 *  that quitting it there turns the card into Reopen here before the reader
 *  reaches for a button, and an open is one loopback read. */
export const ELSEWHERE_POLL_MS = 4_000;
/** The same look while Resume here after exit is armed: the reader has said
 *  they are about to exit Claude there, so the conversation follows within a
 *  second or two of it, and the look goes on with the page hidden, since the
 *  reader is in that other terminal. Still one loopback read each. */
export const EXIT_WATCH_POLL_MS = 1_500;
/** Stop there and resume here: how long after the deck sent the stop the card
 *  says Claude has not stopped yet, if it still runs there. Claude Code ends
 *  on the signal within a second or two at most; the wait goes on after this,
 *  and the reader can still cancel it or exit Claude there. */
export const STOP_SLOW_MS = 15_000;

// ---------------------------------------------------------------------------
// What the stage is asked to show.

/** The session on stage, a new one being started, or nothing. */
export type StageSubject =
  | { kind: "empty" }
  | { kind: "session"; ref: SessionRef; launch?: string }
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
  /** For a session with no tmux: the query kinds the deck says xterm answers
   *  itself (terminal-replies.ts). A tmux version, null included, clears it. */
  viewAnswers(kinds: readonly ViewKind[]): void;
  focus(): void;
  blur(): void;
  /** Whether the terminal's own input holds the focus. */
  hasFocus(): boolean;
  /** Whether the program turned application cursor keys on (DECCKM, what vim
   *  and less ask for): then an arrow is ESC O A, not ESC [ A. */
  applicationCursorKeys(): boolean;
  /** What a typed key does to a view scrolled back: it comes to the bottom,
   *  unless the terminal's own scrollOnUserInput is off. */
  scrollForInput(): void;
  /** The live screen's text, one line per row: what the program shows now. */
  screen?(): string;
  /** The text's size in CSS pixels: the pane's own zoom. The cell follows. */
  setFontSize(px: number): void;
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
  onFileDropUnavailable?(): void;
}

export interface TerminalInit {
  cols: number;
  rows: number;
  theme: ITheme;
  fontFamily: string;
  /** The text's size in CSS pixels; STAGE_FONT_SIZE when not said. */
  fontSize?: number;
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
 * Forget a key the pane saw go down but will never see come up.
 *
 * xterm takes text that comes with no key — an emoji panel, dictation, an
 * on-screen keyboard — only while no key of its own is down: it marks one on
 * keydown and clears the mark on the keyup in its textarea, never on blur
 * (CoreBrowserTerminal `_keyDownSeen`, `_keyPressHandled`, `_inputEvent`). A
 * key let go elsewhere leaves the mark: the deck's Ctrl+Shift+X gives the keys
 * to the board on the press, Alt+Tab lets go in another window. The first such
 * text after the pane has the keys again was then lost. Cleared as the pane
 * loses them; xterm 6 has no public switch for this, and a version without
 * these flags is left as it is. Exported for its test.
 */
export function forgetKeyInFlight(term: unknown): void {
  const core = (term as { _core?: { _keyDownSeen?: unknown; _keyPressHandled?: unknown } } | null)?._core;
  if (!core) return;
  if (typeof core._keyDownSeen === "boolean") core._keyDownSeen = false;
  if (typeof core._keyPressHandled === "boolean") core._keyPressHandled = false;
}

/** The byte Ctrl+V sends in a terminal: Claude Code and Codex read an image
 *  from the clipboard on it. */
export const CTRL_V = "\x16";

/** An up or down arrow as a program in application cursor-key mode wants it
 *  (ESC O A / ESC O B); any other bytes are returned as they are. */
export function applicationArrow(bytes: string): string {
  return bytes === "\x1b[A" || bytes === "\x1b[B" ? `\x1bO${bytes[2]}` : bytes;
}

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
 * the deck reports per connection (`tmuxVersion`); xterm answers the rest. A
 * session with no tmux is told instead which questions xterm answers
 * (`viewAnswers`).
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
    fontSize: init.fontSize ?? STAGE_FONT_SIZE,
    lineHeight: STAGE_LINE_HEIGHT,
    theme: init.theme,
    // `unicode` is behind the proposed-API gate in xterm 6.
    allowProposedApi: true,
    customGlyphs: true,
    // It blinks, as a native terminal's does, so the eye finds where typing
    // goes; not for a reader who asked the OS for less motion. Read once, as
    // the pane opens; xterm blinks only while the pane has the keys.
    cursorBlink: !prefersReducedMotion(),
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
  // With no application mouse tracking, an alternate screen has no local
  // scrollback. xterm otherwise fabricates Up/Down key presses for its wheel,
  // which changes Codex's input history. A wheel must never become typing.
  // Applications that request mouse reports keep receiving their own wheel.
  term.attachCustomWheelEventHandler(event => {
    if (programHasMouse() || term.buffer.active.type !== "alternate") return true;
    event.preventDefault();
    event.stopPropagation();
    return false;
  });
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
  const onDragOver = (event: DragEvent) => {
    if (!isFileDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent) => {
    if (!isFileDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const text = event.dataTransfer && fileDropText(event.dataTransfer);
    if (!text) { events.onFileDropUnavailable?.(); return; }
    term.focus();
    term.scrollToBottom();
    events.onPaste(text);
  };
  host.addEventListener("dragover", onDragOver, true);
  host.addEventListener("drop", onDrop, true);
  const textarea = term.textarea;
  const onFocus = () => events.onFocusChange(true);
  const onBlur = () => {
    forgetKeyInFlight(term);
    events.onFocusChange(false);
  };
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
    viewAnswers: kinds => replies.setViewAnswers(kinds),
    focus: () => term.focus(),
    blur: () => term.blur(),
    hasFocus: () => term.textarea != null && document.activeElement === term.textarea,
    applicationCursorKeys: () => term.modes.applicationCursorKeysMode,
    scrollForInput: () => { if (term.options.scrollOnUserInput !== false) term.scrollToBottom(); },
    // The live screen, whatever the view is scrolled back to: its rows from
    // the buffer's base, which is where the program draws.
    screen: () => {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < term.rows; y++) lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "");
      return lines.join("\n");
    },
    setFontSize: px => { if (term.options.fontSize !== px) term.options.fontSize = px; },
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
      host.removeEventListener("dragover", onDragOver, true);
      host.removeEventListener("drop", onDrop, true);
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
  /** Whether a Codex that exited 0 had just updated itself. An API without
   *  it (a suite's) never asks, and every ending is taken as it comes. */
  codexUpdated?: typeof codexUpdated;
  /** Whether an agent can start in a folder: asked before a Reopen here, a
   *  Start again or a new session in the pane's folder, and by Check again
   *  on the folder-gone card. An API without it (a suite's) never asks, and
   *  the press goes straight to the deck, which asks the same itself. */
  checkFolder?: typeof checkFolder;
  /** Stop there and resume here: the check, which finds the process holding
   *  the session where it runs and signals nothing, and the stop. An API
   *  without them (a suite's) offers no stop: the check answers unsupported. */
  stopElsewhereCheck?: typeof stopElsewhereCheck;
  stopElsewhere?: typeof stopElsewhere;
}

export interface SessionDeps {
  api: SessionApi;
  connect: (options: ConnectOptions) => TerminalConnection;
  mount: MountTerminal;
  now: () => number;
}

export const DEFAULT_DEPS: SessionDeps = {
  api: { status: terminalStatus, open: openTerminal, adopt: adoptTerminal, launch: launchTerminal, codexUpdated, checkFolder, stopElsewhereCheck, stopElsewhere },
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
  /** The launch on show, started again under a new key: what Check again
   *  does once the folder is back, for a launch whose agent ended at once
   *  saying its folder could not be read (agentFolderFailure). Left out, Check
   *  again puts the ended pane back, whose own Start again stays a press. */
  onLaunchAgain?(): void;
}

/** Where the deck's sessions run: tmux, or on Windows the session host,
 *  which has no tmux to ask about and is named in the stage's sentences. */
export interface SessionPlace {
  windows?: boolean;
}

/** A paste too big for one message: refused, and said, rather than lost. */
export const PASTE_TOO_LARGE_MSG = "board.session.pasteTooLarge";

/** Local transport acceptance, not an acknowledgement from the agent.
 *  A partial send pasted the text but could not safely submit it; never retry it. */
export type PromptSendResult = "sent" | "unavailable" | "too-large" | "partial" | "empty";

/** Stop there and resume here's check, as the card reads it: the deck found
 *  the process and holds its token (`gone` when the session had ended there
 *  already, and the wait that resumes it is armed), or why it will not stop it. */
export type StopCheckResult = { ok: true; gone?: true } | { ok: false; reason: StopElsewhereReason };

/** An answer from Chat: every key went; the screen showed something else and
 *  nothing went; some keys went before it stopped; or no connection to send on. */
export type AskSendResult = "sent" | "changed" | "partial" | "unavailable";
/** How long a step waits for the screen to show its question, and how often it looks. */
export const ASK_SCREEN_WAIT_MS = 3000;
export const ASK_SCREEN_POLL_MS = 80;
/** The pause before each key after the first, as a person's keys come apart.
 *  The prompt reads a key and redraws before the next arrives: two keys read
 *  in one go ("13", or a digit with the words after it) are not two presses
 *  to it, and words pasted before "Type something" opens would miss the box. */
export const ASK_KEY_GAP_MS = 120;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface TerminalSessionController {
  mount(host: HTMLElement, init: Omit<TerminalInit, "cols" | "rows">): void;
  show(subject: StageSubject): void;
  resize(cols: number, rows: number, hold: boolean): void;
  setTheme(theme: ITheme): void;
  /** The pane's text size in CSS pixels (terminal-text-size.ts). */
  setFontSize(px: number): void;
  adopt(): void;
  retry(): void;
  /** `run`, a press that starts an agent in `cwd` from this pane (Start
   *  again, a new session here), once the deck says the folder is one to
   *  start in; else the folder-gone phase, whose Check again runs it once the
   *  folder is back. One at a time. `who` is what that phase names. */
  startIfFolder(cwd: string, who: FolderWho, run: () => void): void;
  /** Cancel on the folder-gone phase over a kept frame: that pane again, as
   *  it was before the press the folder stopped. Nothing is asked or started. */
  cancelFolder(): void;
  focus(): void;
  /** Keys typed before the pane could take them (type-ahead.ts). */
  type(text: string): void;
  /** Resume here after exit: for a Claude session running in a terminal
   *  outside the deck, keep this card up (`awaitingExit`), look at that exact
   *  session closely, and reopen it here by itself once nothing holds it any
   *  more. Only from that card, and only once: a second call does nothing. */
  resumeAfterExit(): void;
  /** Cancel on that card: stop waiting, and leave the session and the card
   *  as they were before. Nothing is asked or started. */
  stopWaitingForExit(): void;
  /** Stop there and resume here, its first step: where Resume here after
   *  exit could be armed, ask the deck which process holds the session there.
   *  Signals nothing; the token it answers stays here for the second step. A
   *  refusal is put on the phase (`stopIssue`) for the card to say. One at a
   *  time: a second call while one is asked answers the same. */
  checkStopElsewhere(): Promise<StopCheckResult>;
  /** Its second step, once the reader confirmed: Resume here after exit
   *  armed (`awaitingExit`, `stopping`), then the stop sent with the token.
   *  The wait resumes the conversation here once Claude has ended there; a
   *  stop the deck refused disarms it and says why (`stopIssue`). Still
   *  running STOP_SLOW_MS after the stop was sent, the phase says so
   *  (`slowStop`) and the wait goes on. Once per check: a second call does
   *  nothing. */
  confirmStopElsewhere(): void;
  /** Cancel on the confirmation: the token is let go, nothing is sent. The
   *  wait's own Cancel, once armed, is stopWaitingForExit. */
  cancelStopElsewhere(): void;
  /** Paste and submit only to the caller's subjectKey, without moving focus. */
  sendPrompt(text: string, expectedSubject: string): PromptSendResult;
  /** Answer Claude Code's question prompt, a step at a time: each step's keys
   *  go only once the live screen shows what it expects (ask-keys.ts). */
  sendAsk(steps: readonly AskStep[], expectedSubject: string): Promise<AskSendResult>;
  /** The live screen's text, for the caller's subjectKey only; null while that
   *  session is not live in the pane (screen-prompt.ts reads it). */
  readScreen(expectedSubject: string): string | null;
  /** One key from the phone's key row, as the bytes the terminal would have sent
   *  for it: through the same input the keyboard types into. */
  press(bytes: string, held?: boolean): void;
  /** Whether the terminal holds the focus right now. */
  holdsFocus(): boolean;
  release(): void;
  dispose(): void;
  snapshot(): SessionSnapshot;
}

const isFailure = (v: { ok: boolean }): v is ApiFailure => v.ok === false && !("target" in v);
/** A failure that a deck on its way back up would also give: no answer at
 *  all, or a gateway in front of it that has none yet. */
const transient = (f: ApiFailure) => f.status === null || f.status === 502 || f.status === 503 || f.status === 504;
/** The engine's refusal of a moment (restarting, busy, slow): waited out,
 *  asking again, wherever asking again cannot start anything. */
const recovering = (f: ApiFailure) => transient(f) && (PANEL_RECOVERING as readonly string[]).includes(f.code ?? "");

/** What the folder-gone phase names besides the folder: the agent a new
 *  session elsewhere would start, and the conversation that stays with the
 *  folder, when there is one. */
export interface FolderWho {
  agent: TerminalProvider;
  sessionId?: string;
}

/** The agent the deck would start for `provider`, or null: Claude and Codex
 *  are the agents it starts. */
const startable = (provider?: Provider): TerminalProvider | null =>
  (provider === "claude" || provider === "codex" ? provider : null);

/** The folder-gone phase for `cwd` (StagePhase), without its frame: the
 *  caller knows where the press came from (goneAt). */
const folderGone = (code: FolderRefusal, cwd: string, who: FolderWho): FolderGonePhase =>
  ({ kind: "folder-gone", cwd, code, agent: who.agent, ...(who.sessionId ? { sessionId: who.sessionId } : {}) });

/** The deck's word on a folder as a refusal, or null to go ahead: there, or a
 *  deck that could not say (offline, a deck without the question, a relative
 *  path), when the launch or the adopt asks the same on the deck's side. */
const folderProblem = (answer: FolderAnswer): FolderRefusal | null =>
  answer.ok ? null
    : answer.code === "missing" || answer.code === "not-folder" ? "folder-missing"
      : answer.code === "denied" ? "folder-denied"
        : answer.code === "unreachable" ? "folder-unreachable" : null;

/** The system's codes for a folder, as the deck's refusals say them. The
 *  unreachable ones are the deck's own list (terminal-folder.mjs UNREACHABLE):
 *  a drive or a network folder that is there, disconnected right now. */
const ERRNO_REFUSALS: Readonly<Record<string, FolderRefusal>> = {
  ENOTCONN: "folder-unreachable", EIO: "folder-unreachable", ESTALE: "folder-unreachable",
  EHOSTDOWN: "folder-unreachable", ETIMEDOUT: "folder-unreachable",
  ENOENT: "folder-missing", ENOTDIR: "folder-missing",
  EACCES: "folder-denied", EPERM: "folder-denied",
};
/** The same, by the system's sentence for each, where an agent prints that
 *  in place of the code (Rust's "… (os error 107)"). */
const STRERROR_REFUSALS: ReadonlyArray<readonly [RegExp, FolderRefusal]> = [
  [/transport endpoint is not connected/i, "folder-unreachable"],
  [/stale (?:nfs )?file handle/i, "folder-unreachable"],
  [/host is down/i, "folder-unreachable"],
  [/input\/output error/i, "folder-unreachable"],
  [/no such file or directory/i, "folder-missing"],
  [/permission denied|operation not permitted/i, "folder-denied"],
];
/** Claude Code's words when it cannot read the folder it was started in:
 *  "Can't read the current directory (ENOTCONN). Start Claude Code from a
 *  different directory." Spaces optional, so a line the pane wrapped reads
 *  the same once its rows are put back together. */
const CANT_READ_CWD = /can['’]?t\s*read\s*the\s*current\s*directory(?:\s*\(\s*(E[A-Z0-9]+)\s*\))?/i;
/** A line about the agent's own folder, in the words programs use for it
 *  (Node's own is "uv_cwd"). */
const CWD_LINE = /\b(?:current|working)\s+directory\b|\bcwd\b|\buv_cwd\b/i;
/** A system code as programs print one — "ENOTCONN:", "(ENOTCONN)",
 *  'ENOTCONN' — and not a word inside a folder's name ("EIO-project"). */
const ERRNO_SAID = /\b(E[A-Z][A-Z0-9]+)\b(?=\s*[:)'",])/g;

/**
 * The screen's rows put back into the lines the program printed, for a pane
 * `cols` wide: a row that fills the width wrapped, and its line goes on in
 * the next row. A row is read without its trailing blanks, so one that
 * wrapped at a space is a column short, and gets that space back. Without a
 * width, each row is a line, as it is read.
 */
function screenLines(screen: string, cols?: number): string[] {
  const rows = screen.split("\n");
  if (!cols || cols < 2) return rows;
  const lines: string[] = [];
  let line = "";
  for (const row of rows) {
    if (row.length >= cols) line += row;
    else if (row.length === cols - 1) line += `${row} `;
    else { lines.push(line + row); line = ""; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Why the folder an agent was started in could not be used, as the agent's
 * last screen says it, or null when it says nothing of the kind. Read only
 * from an agent this pane started that ended at once, never from a session
 * at work. Claude Code's own sentence counts whatever its code (one this list
 * does not know is a folder it could not read: not reachable); any other line
 * must name the current or working directory and the system's code or
 * sentence for it — the shell that starts the agent says "error retrieving
 * current directory: getcwd: … No such file or directory", in one line wider
 * than many panes, which `cols` (the pane's width) puts back together.
 */
export function agentFolderFailure(screen: string, cols?: number): FolderRefusal | null {
  if (!screen) return null;
  const said = CANT_READ_CWD.exec(screen.replace(/\n/g, ""));
  if (said) return (said[1] && ERRNO_REFUSALS[said[1].toUpperCase()]) || "folder-unreachable";
  for (const line of screenLines(screen, cols)) {
    if (!CWD_LINE.test(line)) continue;
    for (const [, code] of line.matchAll(ERRNO_SAID)) {
      const refusal = ERRNO_REFUSALS[code];
      if (refusal) return refusal;
    }
    for (const [words, refusal] of STRERROR_REFUSALS) if (words.test(line)) return refusal;
  }
  return null;
}

/** What this pane did to start the agent a connection shows, when it did: a
 *  Reopen here (`from`: the phase it was pressed on; `checked`: Check again
 *  had just found the folder there), or a launch. */
type Started = { kind: "reopen"; from: StagePhase; checked: boolean } | { kind: "launch" };

/** A failure as the card draws it. A refusal that is a state of this machine
 *  keeps its code, so the card checks again in place. A Claude or a Codex
 *  session refused because its CLI is not installed is said so, and the card
 *  offers to install it (ClaudeInstall.tsx). A launch or an adopt refused for
 *  its folder (`at`: the folder it named, and the conversation for an adopt)
 *  is the folder-gone phase, never asked again by itself. */
const failed = (f: ApiFailure, agent?: Provider, at?: { cwd: string; sessionId?: string }): StagePhase => {
  const starts = startable(agent);
  if (folderRefusal(f.code) && at && starts) return folderGone(f.code, f.cwd || at.cwd, { agent: starts, sessionId: at.sessionId });
  return panelUnavailable(f.code) ? { kind: "error", message: f.error, code: f.code, busy: false }
    : f.code === "agent-missing" && (agent === "claude" || agent === "codex") ? { kind: "error", message: f.error, missing: agent }
      : { kind: "error", message: f.error };
};

/**
 * The card for an opencode or Copilot session. Each runs in a terminal of its
 * own that the deck neither started nor can reach, and the engine knows no
 * such provider: a Copilot id is a UUID, and asked as a Claude session's, a
 * "Reopen here" would start Claude Code on another CLI's conversation. So
 * nothing is asked of the engine, nothing is offered to reopen, and the card
 * says what the board does follow. Not running elsewhere, so nothing watches.
 */
export const eventsOnlyPhase = (provider: Provider): StagePhase => ({
  kind: "not-attachable",
  target: { kind: "unsupported", label: tr(EVENTS_ONLY_MSG, { agent: providerLabel(provider) }), adoptable: false },
  stillRunning: false,
  busy: false,
});

/** Whether two answers about the deck's tmux download say the same thing, so
 *  a poll that learned nothing new draws nothing. */
const sameProgress = (a?: TmuxProgress, b?: TmuxProgress) =>
  a?.stage === b?.stage
  && (a?.stage !== "downloading" || b?.stage !== "downloading" || (a.received === b.received && a.total === b.total));

// Keys for the sentences the panel shows, read with `tr` where the line is made.
const STOPPED_MSG = "board.stage.panelStopped";
export const NO_RETURN_MSG = "board.session.noReturn";
export const ENGINE_NO_RETURN_MSG = "board.session.engineNoReturn";
/** The same two on Windows, where the panel's sessions run in its session host. */
export const NO_RETURN_WINDOWS_MSG = "board.session.noReturnWindows";
export const ENGINE_NO_RETURN_WINDOWS_MSG = "board.session.engineNoReturnWindows";
const NOT_REOPENABLE_MSG = "board.session.notReopenable";
export const EVENTS_ONLY_MSG = "board.stage.eventsOnly";
const TMUX_SETUP_SLOW_MSG = "board.session.tmuxSetupSlow";

/**
 * The stage's terminal and its one connection, as a state machine.
 *
 * Every asynchronous step carries the generation it started in; a step that
 * comes back after the subject changed, or after the controller was disposed,
 * finds a newer generation and does nothing.
 */
export function createTerminalSession(deps: SessionDeps, callbacks: SessionCallbacks, place: SessionPlace = {}): TerminalSessionController {
  const windows = place.windows === true;
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
  // The text was zoomed: the cell is measured again once xterm has drawn at
  // the new size, whatever the snapshot already holds.
  let remeasure = false;
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
  // Whether the last answer while reconnecting was the engine's, not silence:
  // the deck is up, and it is the engine that has not come back.
  let engineLost = false;
  // When the deck last said it was restarting; null for any other loss.
  let restartSaid: number | null = null;
  let attempts = 0;

  let snap: SessionSnapshot = { subject: "empty", phase: { kind: "empty" }, keysOwner: "board", streaming: false, cell: null };

  // THE FOLDER-GONE PHASE (stage-model.ts). What its Check again runs once
  // the folder is back — the press the missing folder stopped — and the phase
  // that press was made from, put back first. Only ever run by Check again.
  let goneThen: (() => void) | null = null;
  let goneFrom: StagePhase | null = null;
  /** The generation a startIfFolder is asking the deck in: one at a time. */
  let askingAt: number | null = null;
  /** Resume here after exit is armed for the subject on show: it lasts while
   *  the stage shows that session's card, and ends with anything else. */
  let exitWatch = false;
  // STOP THERE AND RESUME HERE (stop-elsewhere.mjs on the deck). The token
  // the check answered, for the generation it was asked in; the check being
  // asked; a stop being asked; whether the wait was armed by a stop, so the
  // card says Claude is being stopped rather than waited for; whether it
  // still runs STOP_SLOW_MS after the stop was sent; and why the last check
  // or stop did not happen, said until the next press. All of it goes with
  // the card, a Cancel, another subject or the controller.
  let stopToken: { token: string; at: number } | null = null;
  let stopChecking: Promise<StopCheckResult> | null = null;
  let stopAsking = false;
  let stopArmed = false;
  let stopSlow = false;
  let stopIssue: StopElsewhereReason | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  /** Moved on whenever the stop's state is let go: an answer to an older
   *  question finds a newer run, and does nothing. */
  let stopRun = 0;
  const endStop = () => {
    stopRun += 1;
    stopToken = null;
    stopChecking = null;
    stopAsking = false;
    stopArmed = false;
    stopSlow = false;
    if (stopTimer !== null) clearTimeout(stopTimer);
    stopTimer = null;
  };

  const emit = (next: Partial<SessionSnapshot>) => {
    if (disposed) return;
    if (next.phase) next = { ...next, phase: exitWatched(next.phase) };
    snap = { ...snap, ...next, subject: subjectKey(subject) };
    callbacks.onChange(snap);
  };
  const setPhase = (phase: StagePhase) => emit({ phase });

  /** The folder is not one to start in: say so, naming it, and keep `then`
   *  for Check again. `from` is the phase the press was made from: an ended
   *  pane keeps its last frame, and the choices go to its end bar. */
  const goneAt = (phase: FolderGonePhase, from: StagePhase, then: () => void) => {
    goneThen = then;
    goneFrom = from;
    setPhase(showsFrame(from) ? { ...phase, frame: true } : phase);
  };

  /** Check again on the folder-gone phase: the folder asked about once more,
   *  and the press it stopped run once it is back — once. Still gone, the
   *  phase says so and waits for the next press. */
  const checkAgain = (phase: FolderGonePhase) => {
    if (phase.busy) return;
    const then = goneThen;
    const from = goneFrom;
    const back = () => {
      goneThen = null;
      goneFrom = null;
      if (from) setPhase(from);
      if (then) then();
      else begin(false);
    };
    const check = deps.api.checkFolder;
    if (!check) { back(); return; }
    gen += 1;
    const my = gen;
    setPhase({ ...phase, busy: true });
    void check(phase.cwd).then(answer => {
      if (my !== gen || disposed) return;
      const code = folderProblem(answer);
      if (code) {
        // The folder itself is the reason now, whatever was said before.
        const { there: _there, ...gone } = phase;
        setPhase({ ...gone, code, busy: false, checked: true });
        return;
      }
      back();
    });
  };

  /** The agent this pane started ended at once saying its folder could not
   *  be read (agentFolderFailure, `cols`: the pane's width): the folder-gone
   *  phase, over the frame the press was made on. Check again starts the same
   *  thing again once the folder is back — the same conversation by its id,
   *  or the launch again — and only then: never by itself, so an agent that
   *  ends the same way is started once a press. A Check again that led here
   *  says so. False when the screen says nothing of the kind or there is no
   *  folder to name: the ending as before.
   *
   *  THE DECK SAYS WHY. The agent says only that it could not read the folder
   *  it was handed; the deck is asked about the folder itself, and its answer
   *  is the one named — gone, not this account's, not reachable. A folder the
   *  deck finds there (`there`) was not what failed: the agent was started
   *  somewhere it could not read (a terminal still running in a folder that
   *  was removed), and the words never call the folder gone. A deck that
   *  cannot say leaves the agent's own word. */
  const folderSaid = (screen: string, started: Started, unseen: boolean, cols?: number): boolean => {
    const code = agentFolderFailure(screen, cols);
    if (!code) return false;
    let gone: { phase: FolderGonePhase; from: StagePhase; then: () => void };
    if (started.kind === "reopen") {
      const ref = refOf();
      const agent = startable(ref?.provider);
      if (!ref || !agent || !ref.cwd) return false;
      const phase = folderGone(code, ref.cwd, { agent, sessionId: ref.sessionId });
      gone = { phase: started.checked ? { ...phase, checked: true } : phase, from: started.from, then: () => reopen(true) };
    } else {
      if (subject.kind !== "launch") return false;
      // A launch has no conversation to keep: its ended pane is what Cancel
      // goes back to, and Check again starts it again under a new key.
      const ended: StagePhase = unseen ? { kind: "ended", atOpen: true } : { kind: "ended" };
      gone = { phase: folderGone(code, subject.cwd, { agent: subject.agent }), from: ended, then: () => callbacks.onLaunchAgain?.() };
    }
    const check = deps.api.checkFolder;
    if (!check) { goneAt(gone.phase, gone.from, gone.then); return true; }
    const my = gen;
    void check(gone.phase.cwd).then(answer => {
      if (my !== gen || disposed) return;
      const problem = folderProblem(answer);
      const phase: FolderGonePhase = problem ? { ...gone.phase, code: problem } : answer.ok ? { ...gone.phase, there: true } : gone.phase;
      goneAt(phase, gone.from, gone.then);
    });
    return true;
  };

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

  /** `started`: the ticket is for an agent this pane just started — a Reopen
   *  here's (adopt) or a launch's. A reopened agent ending before it was live
   *  CLEAN_END_MIN_LIVE_MS is the resume failing — a conversation the agent
   *  could not find or load — not the session ending, and the pane says so
   *  (`unresumed`) rather than offering the same Reopen here again. Either
   *  one ending that soon may have said its folder could not be read
   *  (folderSaid): the folder-gone phase then. */
  const connect = (ticket: string, my: number, started?: Started) => {
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
    // When this connection first drew the pane live: an ending that comes
    // too soon after it is not the agent's own (endedCleanly).
    let liveAt: number | null = null;
    // Whether this connection drew a frame of its own (a reset and its seed):
    // only then is the screen this agent's, and not the frame it replaced.
    let seeded = false;
    const parsedBytes = (n: number, now = false) => {
      if (my !== gen || !open) return;
      parsed += n;
      if (now || parsed - acked >= ACK_EVERY_BYTES) {
        acked = parsed;
        c.sendAck(parsed);
      }
    };
    const surfaces = codexTerminalSurfaces();
    const codex = subject.kind === "launch" ? subject.agent === "codex" : refOf()?.provider === "codex";
    const displayBytes = (bytes: Uint8Array) => codex ? surfaces.write(bytes) : bytes;
    const c: TerminalConnection = deps.connect({
      ticket,
      onHello: hello => {
        if (my !== gen) return;
        sizeOwner = hello.sizeOwner;
        readOnly = hello.readOnly;
      },
      onReset: ({ cols, rows, seed }) => {
        if (my !== gen) return;
        seeded = true;
        surfaces.reset();
        const displayed = displayBytes(seed);
        withTerminal(t => {
          t.write("", () => {
            if (my !== gen) return;
            t.reset();
            if (t.cols !== cols || t.rows !== rows) t.resize(cols, rows);
          });
          t.write(displayed, () => {
            if (my !== gen || !open) return;
            // At once after a seed, whatever its size: it is how the deck
            // learns this panel acknowledges at all.
            parsedBytes(seed.byteLength, true);
            attempts = 0;
            reconnectStarted = null;
            engineLost = false;
            restartSaid = null;
            if (liveAt === null) liveAt = deps.now();
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
        const displayed = displayBytes(bytes);
        withTerminal(t => t.write(displayed, () => parsedBytes(bytes.byteLength)));
      },
      onTmux: version => {
        if (my !== gen) return;
        withTerminal(t => t.write("", () => { if (my === gen) t.tmuxVersion(version); }));
      },
      // A session with no tmux says, in the version's place, which questions
      // xterm answers itself; applied where it falls in the bytes, as the
      // version is, and cleared with it on the next connection.
      onReplies: kinds => {
        if (my !== gen) return;
        withTerminal(t => t.write("", () => { if (my === gen) t.viewAnswers(kinds); }));
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
      onExit: ({ reason, message, atOpen, exitStatus, exitSignal }) => {
        if (my !== gen) return;
        open = false;
        conn = null;
        if (snap.streaming) emit({ streaming: false });
        if (reason === "server-shutdown") { restartSaid = deps.now(); reconnect(my); }
        // Ended before anyone was looking: the deck says so for a dead pane
        // opened for its last frame, and an ending that lands before the seed
        // was ever revealed is the same thing seen from here.
        // One this pane watched is the agent ending itself when it exited
        // cleanly (endedCleanly): the stage closes the pane then.
        else if (reason === "ended") {
          const unseen = atOpen || snap.phase.kind !== "live";
          const liveFor = deps.now() - (liveAt ?? deps.now());
          const atOnce = unseen || liveFor < CLEAN_END_MIN_LIVE_MS;
          const endAsBefore = () => {
            if (started?.kind === "reopen" && atOnce) { setPhase({ kind: "ended", unresumed: true }); return; }
            const ended: StagePhase = unseen ? { kind: "ended", atOpen: true }
              : endedCleanly({ exitStatus, exitSignal }, liveFor) ? { kind: "ended", clean: true }
                : { kind: "ended" };
            // A Codex that exits 0 may be one that just updated itself: its own
            // "Update now" installs the new version and asks to be restarted.
            // The deck tells it from /exit by the codex on disk (codex-update.mjs),
            // and the stage starts the new one in its place (`updated`). While it
            // asks, the pane is plainly ended, never clean, so the stage does not
            // close it first. A crash, a kill or an ending it never watched is
            // not asked about; an answer that comes after the stage moved on, or
            // none at all, leaves the ending as it would have been.
            const ask = deps.api.codexUpdated;
            if (codex && ask && !unseen && exitSignal === undefined && (exitStatus === undefined || exitStatus === 0)) {
              const asking: StagePhase = { kind: "ended" };
              setPhase(asking);
              const settle = (updated: boolean) => {
                if (my !== gen || disposed || snap.phase !== asking) return;
                setPhase(updated ? { kind: "ended", updated: true } : ended);
              };
              ask(liveFor).then(settle, () => settle(false));
            } else setPhase(ended);
          };
          // AN AGENT THIS PANE STARTED THAT ENDED AT ONCE may have said why:
          // its folder could not be read — a drive or a network folder
          // disconnected after the deck looked (Claude Code: "Can't read the
          // current directory (ENOTCONN)"). Its last screen is read once every
          // byte before the ending is drawn, and such an ending is the
          // folder-gone phase, never "could not resume" with a new session
          // offered in the same folder. A terminal that cannot be read ends
          // as before.
          const shown = term;
          if (started && atOnce && seeded && shown?.screen) {
            shown.write("", () => {
              if (my !== gen || disposed) return;
              if (!folderSaid(shown.screen?.() ?? "", started, unseen, shown.cols)) endAsBefore();
            });
          } else endAsBefore();
        }
        else if (reason === "detached") setPhase({ kind: "detached" });
        else setPhase({ kind: "error", message: message || tr(STOPPED_MSG) });
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

  /** A refusal that might be tmux missing: ask, and draw that fact if so.
   *  Windows has no tmux to be missing: the refusal is said as it is. */
  const tmuxOr = async (my: number, otherwise: StagePhase) => {
    if (windows) { setPhase(otherwise); return; }
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
    if (deps.now() - since > TMUX_SETUP_GIVE_UP_MS) { setPhase({ kind: "error", message: tr(TMUX_SETUP_SLOW_MSG) }); return; }
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
          setPhase(failed(status));
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

  /** A card's `held` (StagePhase), for an agent this pane can start anew. */
  const heldBy = (provider: SessionRef["provider"]) => provider === "claude" || provider === "codex" ? { held: provider } : {};

  /** `held`: a Reopen here of this pane's led here (StagePhase, `held`). */
  const openFlow = async (ref: SessionRef, my: number, reconnecting: boolean, held = false) => {
    // Every open goes through here — the first, Check again, a reconnect.
    if (isEventOnly(ref.provider)) { setPhase(eventsOnlyPhase(ref.provider)); return; }
    // At the pane's size and in its colours, as an adopt: an open the engine
    // answers by starting a client (a managed Codex) starts it in both.
    const answer = await deps.api.open(ref, {}, { ...want }, paneColours());
    if (my !== gen) return;
    await landOpen(answer, my, reconnecting, held ? ref.provider : undefined);
  };

  /** The card for a session that runs in a terminal outside the deck, and a
   *  quiet look every few seconds at whether it still does (#97): quit there,
   *  it turns into Reopen here without a press. The look is the same read the
   *  open is — it starts, stops and sends nothing — and it skips a hidden page,
   *  so a tab left in the background does not ask on its own. */
  const runningElsewhere = (phase: Extract<StagePhase, { kind: "not-attachable" }>, my: number) => {
    setPhase(phase);
    watchElsewhere(my);
  };

  const watchElsewhere = (my: number, delay = exitWatch ? EXIT_WATCH_POLL_MS : ELSEWHERE_POLL_MS) => {
    clearTimer(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (my !== gen || disposed) return;
      const now = snap.phase;
      if (now.kind !== "not-attachable" || !now.stillRunning) return;
      const ref = refOf();
      // Armed, it looks with the page hidden too: the reader is in the other
      // terminal, exiting Claude, and the conversation is to be here after.
      const hidden = !exitWatch && typeof document !== "undefined" && document.visibilityState === "hidden";
      if (!ref || hidden || now.busy) { watchElsewhere(my); return; }
      void deps.api.open(ref, {}, { ...want }, paneColours()).then(answer => {
        if (my !== gen || disposed) return;
        const still = snap.phase;
        if (still.kind !== "not-attachable" || !still.stillRunning || still.busy) return;
        // Still running there, or the deck blinked: the card stays as it is.
        if (isFailure(answer) || (!answer.ok && answer.target.kind === "C")) { watchElsewhere(my); return; }
        // Armed, and nothing holds the conversation any more: reopened here,
        // as Reopen here would. An ended deck pane of its own is no stop on
        // the way (the adopt clears it). Held anywhere the deck can show — a
        // pane another tab reopened it in — it is shown there instead.
        if (exitWatch && answer.target.kind === "gone" && answer.target.adoptable === true) { resumeHere(answer.target); return; }
        void landOpen(answer, my, false);
      });
    }, delay);
  };

  /** Arming and its end, on every phase the stage shows (emit): the card
   *  says it waits while armed, and anything but the card ends the wait. A
   *  wait a stop armed says so too, and Claude not stopped yet; a check or a
   *  stop that did not happen says why while nothing is armed. */
  const exitWatched = (phase: StagePhase): StagePhase => {
    if (phase.kind !== "not-attachable") { exitWatch = false; endStop(); stopIssue = null; return phase; }
    const awaitingExit = exitWatch || undefined;
    const stopping = (exitWatch && stopArmed) || undefined;
    const slowStop = (exitWatch && stopArmed && stopSlow) || undefined;
    const issue = (!exitWatch && stopIssue) || undefined;
    if (phase.awaitingExit === awaitingExit && phase.stopping === stopping && phase.slowStop === slowStop && phase.stopIssue === issue) return phase;
    const { awaitingExit: _was, stopping: _stopping, slowStop: _slow, stopIssue: _issue, ...rest } = phase;
    return {
      ...rest,
      ...(awaitingExit ? { awaitingExit } : {}),
      ...(stopping ? { stopping } : {}),
      ...(slowStop ? { slowStop } : {}),
      ...(issue ? { stopIssue: issue } : {}),
    };
  };

  /** The armed session has stopped where it ran: this card's Reopen here,
   *  pressed for the reader. Its folder is asked about first and the adopt
   *  is the deck's, which refuses while anything still holds the session. */
  const resumeHere = (target: TerminalTarget) => {
    setPhase({ kind: "not-attachable", target, stillRunning: false, busy: false });
    reopen();
  };

  const landOpen = async (answer: Awaited<ReturnType<SessionDeps["api"]["open"]>>, my: number, reconnecting: boolean, held?: SessionRef["provider"]) => {
    if (answer.ok) { connect(answer.ticket, my); return; }
    if (isFailure(answer)) {
      // Opening starts nothing, so a moment's refusal is waited out even on
      // a first open, its card kept up while the engine comes back.
      if ((reconnecting && transient(answer)) || recovering(answer)) { reconnect(my, answer); return; }
      setPhase(failed(answer, refOf()?.provider));
      return;
    }
    if (answer.target.kind === "unsupported") {
      await tmuxOr(my, { kind: "error", message: answer.target.reason === "uncertain" ? tr("board.stage.identityUncertain") : answer.target.label });
      return;
    }
    // An ended session whose folder is not there to reopen it in — a git
    // worktree removed, a project moved or renamed before it was opened —
    // is the folder-gone phase a Reopen here would have met: the folder
    // named, Choose folder… and Check again, never the bare card.
    if (answer.target.kind === "gone" && answer.target.adoptable === false && await goneOnOpen(my)) return;
    const stillRunning = answer.target.kind === "C";
    // Still held after this pane asked to reopen it: the card says so, and
    // offers a new session beside Not now. Freed, it is the plain card again.
    const phase = { kind: "not-attachable", target: answer.target, stillRunning, busy: false, ...(stillRunning && held ? heldBy(held) : {}) } as const;
    if (phase.stillRunning) runningElsewhere(phase, my);
    else setPhase(phase);
  };

  /** The deck answered that an ended session cannot be reopened for want of
   *  its folder: asked about the folder (missing, or not this account's), and
   *  the folder-gone phase for it. Check again, once the folder is back, opens
   *  the session again — its card offers Reopen here, which stays a press.
   *  False when the folder is there after all, or the session has none, or
   *  its agent is not one the deck starts: the card the deck described. */
  const goneOnOpen = async (my: number): Promise<boolean> => {
    const ref = refOf();
    const agent = startable(ref?.provider);
    if (!ref || !agent || !ref.cwd) return false;
    const from = snap.phase;
    const check = deps.api.checkFolder;
    const answer = check ? await check(ref.cwd) : null;
    if (my !== gen || disposed) return true;
    // The deck has just said the folder is not one to reopen in; a question
    // it could not answer (offline, a deck without it) does not undo that.
    const code = !answer ? "folder-missing" : folderProblem(answer) ?? (answer.ok ? null : "folder-missing");
    if (!code) return false;
    goneAt(folderGone(code, ref.cwd, { agent, sessionId: ref.sessionId }), from, () => begin(false));
    return true;
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
      // A 409 of the engine's own is its state, not tmux's: said as it is,
      // without asking about tmux. Never asked again by itself, whatever the
      // status — a launch is started only by a press, and its key keeps a
      // second press to the one agent.
      const said = failed(answer, agent, { cwd });
      // Its folder is not one to start in: named, with Check again launching
      // it once the folder is back. The deck refused before starting
      // anything, so the same key starts it then.
      if (said.kind === "folder-gone") { goneAt(said, snap.phase, () => begin(false)); return; }
      if (answer.status === 409 && !answer.code) await tmuxOr(my, { kind: "error", message: answer.error });
      else setPhase(said);
      return;
    }
    launched = true;
    if (answer.sessionId) launchedRef = { sessionId: answer.sessionId, provider: agent, cwd };
    callbacks.onLaunched?.({ agent, cwd, sessionId: answer.sessionId, name: answer.name });
    connect(answer.ticket, my, { kind: "launch" });
  };

  /** Start over for the current subject: a fresh generation, nothing of the
   *  last attempt left running. */
  const begin = (reconnecting = false) => {
    gen += 1;
    const my = gen;
    dropConnection();
    goneThen = null;
    goneFrom = null;
    exitWatch = false;
    endStop();
    stopIssue = null;
    if (subject.kind === "empty") { setPhase({ kind: "empty" }); return; }
    if (toLaunch() && subject.kind === "launch") {
      setPhase({ kind: "starting", agent: subject.agent, cwd: subject.cwd });
      void launchFlow(subject.agent, subject.cwd, subject.key, my, subject.options);
      return;
    }
    const ref = refOf();
    if (!ref) { setPhase({ kind: "error", message: tr(NOT_REOPENABLE_MSG) }); return; }
    // Its card at once, with no "attaching" before it: there is nothing to attach to.
    if (isEventOnly(ref.provider)) { setPhase(eventsOnlyPhase(ref.provider)); return; }
    setPhase({ kind: "attaching", reconnect: reconnecting });
    void openFlow(ref, my, reconnecting);
  };

  /** The deck, or its engine, went away under a live pane, or refused a
   *  first open for a moment. Keep the frame, or the card, and ask again.
   *  `lost`: the answer that sent it here, when there was one. */
  const reconnect = (my: number, lost?: ApiFailure) => {
    if (my !== gen || disposed) return;
    const now = deps.now();
    if (lost) engineLost = !!lost.code;
    reconnectStarted ??= now;
    if (now - reconnectStarted > RECONNECT_GIVE_UP_MS) {
      reconnectStarted = null;
      attempts = 0;
      const message = tr(engineLost ? (windows ? ENGINE_NO_RETURN_WINDOWS_MSG : ENGINE_NO_RETURN_MSG) : (windows ? NO_RETURN_WINDOWS_MSG : NO_RETURN_MSG));
      setPhase({ kind: "error", message });
      engineLost = false;
      return;
    }
    // A pane that was up keeps its frame. Anything else — a first open, a
    // card checking again — keeps a card: "reconnecting" over an empty box
    // would be neither true nor anything to look at.
    const next: StagePhase = showsFrame(snap.phase) ? { kind: "attaching", reconnect: true } : { kind: "attaching", reconnect: false };
    if (snap.phase.kind !== "attaching" || snap.phase.reconnect !== next.reconnect) setPhase(next);
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
      if (!ref) { setPhase({ kind: "error", message: tr(NOT_REOPENABLE_MSG) }); return; }
      void openFlow(ref, next, true);
    }, delay);
  };

  // -- size ------------------------------------------------------------------

  function applySize() {
    clearTimer(sizeTimer);
    sizeTimer = null;
    if (!conn) { fitKeptFrame(); return; }
    if (sizeOwner === "pane") return;
    if (term && snap.phase.kind === "live" && (term.cols !== want.cols || term.rows !== want.rows)) {
      term.resize(want.cols, want.rows);
    }
    conn.sendSize(want.cols, want.rows);
  }

  /** A frame kept on show with nothing attached (an ended pane's last screen)
   *  takes the rows it is given: fewer while the folder-gone line sits above
   *  it, all of them again once the line goes, so no row of it is cut at the
   *  pane's bottom. xterm keeps what no longer fits in its scrollback and
   *  brings it back when the rows return. Its columns stay as drawn, so
   *  nothing is rewrapped, and there is no session to tell. */
  function fitKeptFrame() {
    if (!term || sizeOwner === "pane" || !showsFrame(snap.phase)) return;
    if (term.rows !== want.rows) term.resize(term.cols, want.rows);
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
      if (!conn.sendPaste(text) && pasteTooLarge(text)) callbacks.onNotice?.(tr(PASTE_TOO_LARGE_MSG));
    },
    onFileDropUnavailable: () => callbacks.onNotice?.(tr("board.drop.pathsUnavailable")),
    // terminal-keys.ts decides; this only carries the decision out. The
    // release chord is kept from the session and acted on by the deck's own
    // listener, so it is not answered here as well: one owner, one release.
    onKey: e => {
      const outcome = terminalKeyOutcome(e);
      if (outcome === "pass") return true;
      // The pane's own zoom, on the keydown: kept from xterm and from the
      // browser, whose zoom would take the whole page with it.
      if (outcome === "zoom") {
        const direction = e.type === "keydown" ? textSizeChord(e) : null;
        if (direction) stepTerminalText(direction);
        return false;
      }
      const input = e.type === "keydown" && snap.phase.kind === "live" ? terminalKeyInput(e, outcome) : null;
      if (input) { typed(); conn?.sendInput(input); }
      return false;
    },
    onFocusChange: focused => {
      const owner: KeysOwner = focused ? "pane" : "board";
      if (owner !== snap.keysOwner) emit({ keysOwner: owner });
    },
    onRender: () => {
      if (snap.cell && !remeasure) return;
      remeasure = false;
      measure();
    },
  };

  /** Reopen here: the session again, in this pane, resumed by its id in its
   *  own folder (the deck's adopt). Refused while one is already asked for.
   *  The folder is asked about first (`checked`: Check again just did): a
   *  conversation is resumed in its own folder or not at all, and a folder
   *  that went away is the folder-gone phase, not an adopt the engine might
   *  start somewhere else. */
  const reopen = (checked = false) => {
    const ref = refOf();
    const phase = snap.phase;
    // Never for opencode or Copilot (eventsOnlyPhase): its card offers no
    // Reopen here, and no key or menu may reach one either.
    if (!ref || disposed || isEventOnly(ref.provider)) return;
    // A refused Reopen here's Try again reopens again (retry, below).
    const again = phase.kind === "error" && phase.reopen === true;
    if (phase.kind !== "not-attachable" && phase.kind !== "ended" && phase.kind !== "detached" && !again) return;
    // The button stays enabled while it works (#620: a press never
    // disables its own control), so a second press is refused here.
    if ((phase.kind === "not-attachable" || phase.kind === "ended" || phase.kind === "error") && phase.busy) return;
    gen += 1;
    const my = gen;
    dropConnection();
    // An ended pane keeps its last frame while it reopens, and its button
    // says so (Reopening…); a card keeps its sentence, busy, the same way.
    if (phase.kind === "not-attachable" || phase.kind === "error") setPhase({ ...phase, busy: true });
    else if (phase.kind === "ended") setPhase({ kind: "ended", ...(phase.atOpen ? { atOpen: true } : {}), busy: true });
    else setPhase({ kind: "attaching", reconnect: true });
    // Check again is a read. Only a target confirmed as ended may offer
    // Reopen here; repeatedly adopting a live external session just fails.
    if (phase.kind === "not-attachable" && phase.stillRunning) {
      void openFlow(ref, my, false, !!phase.held);
      return;
    }
    const agent = startable(ref.provider);
    const who: FolderWho | null = agent ? { agent, sessionId: ref.sessionId } : null;
    const adopt = () => void deps.api.adopt(ref, {}, { ...want }, paneColours()).then(answer => {
      if (my !== gen) return;
      if (answer.ok) { connect(answer.ticket, my, { kind: "reopen", from: phase, checked }); return; }
      // Still held, after a press here: the card says where (`held`).
      if (answer.error === STILL_RUNNING && phase.kind === "not-attachable") {
        runningElsewhere({ ...phase, stillRunning: true, busy: false, ...heldBy(ref.provider) }, my);
        return;
      }
      // Running already — reopened from another tab, or by hand in a
      // terminal: shown where it runs, never started a second time. Where
      // it cannot be shown, its card is `held`.
      if (answer.error === STILL_RUNNING) { void openFlow(ref, my, false, true); return; }
      const said = failed(answer, ref.provider, { cwd: ref.cwd, sessionId: ref.sessionId });
      // The deck found its folder gone after all: named, as below.
      if (said.kind === "folder-gone") { goneAt(said, phase, () => reopen(true)); return; }
      // The deck's own sentence, with Try again reopening again and a new
      // session in the same folder beside it (StageBody). A refusal that is
      // a state of this machine keeps its own card.
      setPhase(said.kind === "error" && !said.code && !said.missing ? { ...said, reopen: true } : said);
    });
    const check = checked ? undefined : deps.api.checkFolder;
    if (!check || !who) { adopt(); return; }
    void check(ref.cwd).then(answer => {
      if (my !== gen || disposed) return;
      const code = folderProblem(answer);
      if (!code) { adopt(); return; }
      // Never resumed anywhere else, and never asked again by itself: Check
      // again reopens it here once the folder is back.
      goneAt(folderGone(code, ref.cwd, who), phase, () => reopen(true));
    });
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
        if (!disposed) setPhase({ kind: "error", message: tr("board.session.loadFailed") });
      });
    },

    show(next) {
      if (disposed) return;
      // The session a launch just started, arriving on the board: the stage
      // is already attached to it, so this is a rename, not a switch. Known
      // by the id the launch was answered with, or, for a Codex, which is
      // answered none, by the stage saying which launch it came from.
      if (next.kind === "session" && subject.kind === "launch"
        && ((launchedRef && next.ref.sessionId === launchedRef.sessionId) || (launched && next.launch === subject.key))) {
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
      engineLost = false;
      begin();
    },

    resize(cols, rows, holdResize) {
      if (!(cols > 0 && rows > 0)) return;
      want = { cols: Math.floor(cols), rows: Math.floor(rows) };
      hold = holdResize;
      clearTimer(sizeTimer);
      sizeTimer = null;
      if (hold) return;
      // Nothing attached, nothing to send: a kept frame is fitted at once,
      // in the same paint as the line that moved it.
      if (!conn) { fitKeptFrame(); return; }
      sizeTimer = setTimeout(applySize, RESIZE_SETTLE_MS);
    },

    setFontSize(px) {
      if (disposed) return;
      withTerminal(t => {
        t.setFontSize(px);
        remeasure = true;
        measure();
      });
    },

    setTheme(theme) {
      if (term) term.setTheme(theme);
      else pendingTheme = theme;
      colours = theme;
      conn?.sendColours(theme.foreground, theme.background);
    },

    adopt() { reopen(); },

    resumeAfterExit() {
      const phase = snap.phase;
      const ref = refOf();
      // Claude only: an idle Codex outside the deck holds nothing the deck can
      // see, so "nothing holds it" would not mean it stopped. Never on
      // Windows, whose sessions the deck cannot watch this way.
      if (disposed || exitWatch || windows || ref?.provider !== "claude") return;
      if (phase.kind !== "not-attachable" || !phase.stillRunning || phase.busy || phase.target.adoptable !== true) return;
      // A stop asked about and not confirmed is let go, and why the last one
      // did not happen is no longer the card's line.
      endStop();
      stopIssue = null;
      exitWatch = true;
      setPhase(phase);
      // A first look at once: it may have been quit since the last one.
      watchElsewhere(gen, 0);
    },

    stopWaitingForExit() {
      if (disposed || !exitWatch) return;
      exitWatch = false;
      // A stop under way is let go too: its answer, and the line that says
      // Claude has not stopped yet, are no one's now.
      endStop();
      const phase = snap.phase;
      if (phase.kind !== "not-attachable") return;
      setPhase(phase);
      if (phase.stillRunning && !phase.busy) watchElsewhere(gen);
    },

    checkStopElsewhere() {
      const phase = snap.phase;
      const ref = refOf();
      const ask = deps.api.stopElsewhereCheck;
      const no: StopCheckResult = { ok: false, reason: "unsupported" };
      // Where Resume here after exit could be armed, and only there: the
      // stop's way back here is that wait.
      if (disposed || exitWatch || windows || ref?.provider !== "claude" || !ask) return Promise.resolve(no);
      if (phase.kind !== "not-attachable" || !phase.stillRunning || phase.busy || phase.target.adoptable !== true) return Promise.resolve(no);
      if (stopChecking) return stopChecking;
      stopToken = null;
      if (stopIssue) { stopIssue = null; setPhase(phase); }
      const run = stopRun;
      const my = gen;
      const asked: Promise<StopCheckResult> = ask(ref)
        .catch(() => ({ ok: false, reason: "network" }) as const)
        .then((answer): StopCheckResult => {
          if (stopChecking === asked) stopChecking = null;
          // Let go meanwhile (a Cancel, another subject), or the card moved
          // on: the answer is no one's, and nothing is said.
          const now = snap.phase;
          if (run !== stopRun || my !== gen || disposed || exitWatch) return { ok: false, reason: "changed" };
          if (now.kind !== "not-attachable" || !now.stillRunning || now.busy) return { ok: false, reason: "changed" };
          if (answer.ok && "gone" in answer) {
            // It ended there already: nothing to stop, and the wait finds it
            // gone at its first look and reopens it here, as asked.
            exitWatch = true;
            setPhase(now);
            watchElsewhere(gen, 0);
            return { ok: true, gone: true };
          }
          if (answer.ok) { stopToken = { token: answer.token, at: gen }; return { ok: true }; }
          stopIssue = answer.reason;
          setPhase(now);
          return { ok: false, reason: answer.reason };
        });
      stopChecking = asked;
      return asked;
    },

    confirmStopElsewhere() {
      const phase = snap.phase;
      const ref = refOf();
      const send = deps.api.stopElsewhere;
      const held = stopToken;
      // Once per check, and never a second stop while one is asked.
      if (disposed || exitWatch || stopAsking || windows || !held || held.at !== gen || ref?.provider !== "claude" || !send) return;
      if (phase.kind !== "not-attachable" || !phase.stillRunning || phase.busy || phase.target.adoptable !== true) return;
      stopToken = null;
      stopIssue = null;
      stopRun += 1;
      const run = stopRun;
      const my = gen;
      // Armed first, as Resume here after exit arms: once Claude has ended
      // there, the wait reopens the conversation here by itself.
      exitWatch = true;
      stopArmed = true;
      stopSlow = false;
      stopAsking = true;
      setPhase(phase);
      watchElsewhere(gen);
      void send(ref, held.token)
        .catch(() => ({ ok: false, reason: "network" }) as const)
        .then(answer => {
          if (run !== stopRun) return;
          stopAsking = false;
          if (my !== gen || disposed) return;
          // Ended already: the wait looks at once, and resumes it.
          if (answer.ok && "gone" in answer) { watchElsewhere(gen, 0); return; }
          if (answer.ok) {
            stopTimer = setTimeout(() => {
              stopTimer = null;
              const now = snap.phase;
              if (run !== stopRun || disposed || !exitWatch || !stopArmed) return;
              if (now.kind !== "not-attachable" || !now.stillRunning) return;
              stopSlow = true;
              setPhase(now);
            }, STOP_SLOW_MS);
            return;
          }
          // Nothing was stopped: the wait ends with it, the card says why,
          // and Resume here after exit is still on offer.
          exitWatch = false;
          stopArmed = false;
          stopIssue = answer.reason;
          const now = snap.phase;
          if (now.kind !== "not-attachable") return;
          setPhase(now);
          if (now.stillRunning && !now.busy) watchElsewhere(gen);
        });
    },

    cancelStopElsewhere() {
      // The armed wait's Cancel is stopWaitingForExit, which ends it.
      if (disposed || exitWatch) return;
      endStop();
    },

    retry() {
      if (disposed) return;
      const phase = snap.phase;
      // A refused Reopen here is tried again as what it was.
      if (phase.kind === "error" && phase.reopen) { reopen(); return; }
      // A folder that was gone: asked about again, and the press it stopped
      // run only once it is back.
      if (phase.kind === "folder-gone") { checkAgain(phase); return; }
      const checks = phase.kind === "tmux-missing" || (phase.kind === "error" && !!phase.code);
      if (checks && phase.busy) return;
      attempts = 0;
      reconnectStarted = null;
      engineLost = false;
      if (!checks) {
        // A failed launch is asked again; anything else is reopened.
        begin(false);
        return;
      }
      // "Check again" keeps the fact on screen while it asks, rather than
      // flashing "attaching…" over the install line, or over the engine's
      // state, for the length of a request that will most likely say the
      // same thing.
      gen += 1;
      const my = gen;
      dropConnection();
      setPhase({ ...phase, busy: true });
      askAgain(my);
    },

    cancelFolder() {
      if (disposed) return;
      const from = goneFrom;
      // Only over a kept frame: a card's way out is Not now, which closes it.
      if (snap.phase.kind !== "folder-gone" || !from || !showsFrame(from)) return;
      goneThen = null;
      goneFrom = null;
      // A Check again still asking answers nothing now.
      gen += 1;
      setPhase(from);
    },

    startIfFolder(cwd, who, run) {
      if (disposed) return;
      const check = deps.api.checkFolder;
      if (!check) { run(); return; }
      // A second press while the deck is asked starts nothing.
      if (askingAt === gen) return;
      const my = gen;
      askingAt = my;
      const from = snap.phase;
      void check(cwd).then(answer => {
        if (askingAt === my) askingAt = null;
        if (my !== gen || disposed) return;
        const code = folderProblem(answer);
        if (!code) { run(); return; }
        goneAt(folderGone(code, cwd, who), from, run);
      });
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
    sendPrompt(text, expectedSubject) {
      const current = conn;
      const my = gen;
      const writable = () => !disposed && gen === my && conn === current
        && subjectKey(subject) === expectedSubject && snap.subject === expectedSubject
        && snap.phase.kind === "live"
        && !snap.phase.readOnly && !readOnly;
      if (!current || !writable()) return "unavailable";
      if (!text.trim()) return "empty";
      if (pasteTooLarge(text)) return "too-large";
      let pasted = false;
      try {
        typed();
        if (!writable()) return "unavailable";
        if (!current.sendPaste(text)) return "unavailable";
        pasted = true;
        // A synchronous transport callback may have switched or lost the
        // target. Enter must never reach a replacement connection or session.
        if (!writable()) return "partial";
        return current.sendInput("\r") ? "sent" : "partial";
      } catch {
        return pasted ? "partial" : "unavailable";
      }
    },
    async sendAsk(steps, expectedSubject) {
      const current = conn;
      const my = gen;
      const writable = () => !disposed && gen === my && conn === current
        && subjectKey(subject) === expectedSubject && snap.subject === expectedSubject
        && snap.phase.kind === "live"
        && !snap.phase.readOnly && !readOnly;
      const shows = (expect: readonly string[]) => {
        const screen = term?.screen?.();
        return typeof screen === "string" && screenShows(screen, expect);
      };
      if (!current || !writable() || !term?.screen || !steps.length) return "unavailable";
      let sent = false;
      try {
        for (const step of steps) {
          // The program redraws after each key: the screen is asked again
          // until it shows what this step answers, or the wait runs out.
          if (sent) await sleep(ASK_KEY_GAP_MS);
          const until = deps.now() + ASK_SCREEN_WAIT_MS;
          while (writable() && !shows(step.expect) && deps.now() < until) await sleep(ASK_SCREEN_POLL_MS);
          if (!writable()) return sent ? "partial" : "unavailable";
          if (!shows(step.expect)) return sent ? "partial" : "changed";
          for (const [i, key] of step.keys.entries()) {
            if (i > 0) {
              await sleep(ASK_KEY_GAP_MS);
              if (!writable()) return "partial";
            }
            typed();
            // An arrow goes as the terminal would send it when typed: ESC O B
            // for a program that asked for application cursor keys.
            const ok = "paste" in key ? current.sendPaste(key.paste)
              : current.sendInput(term?.applicationCursorKeys() ? applicationArrow(key.input) : key.input);
            if (!ok) return sent ? "partial" : "unavailable";
            sent = true;
            if (!writable()) return "partial";
          }
        }
        return "sent";
      } catch {
        return sent ? "partial" : "unavailable";
      }
    },
    readScreen(expectedSubject) {
      // Only the caller's session, live: a screen read while another session is
      // switching in, or before the pane holds one, is no screen at all.
      if (disposed || !conn || subjectKey(subject) !== expectedSubject || snap.subject !== expectedSubject) return null;
      if (snap.phase.kind !== "live") return null;
      const screen = term?.screen?.();
      return typeof screen === "string" ? screen : null;
    },
    press(bytes, heldBefore) {
      // The terminal's own key: an arrow follows the cursor-key mode, a view
      // scrolled back comes to the bottom as it does for a typed key, and a
      // terminal that held the focus before the press holds it after. "Before"
      // is when the press began (the key row records it at pointerdown): by the
      // click the focus may already have left the terminal.
      const held = heldBefore ?? term?.hasFocus() === true;
      events.onInput(term?.applicationCursorKeys() ? applicationArrow(bytes) : bytes);
      term?.scrollForInput();
      if (held) term?.focus();
    },
    holdsFocus() { return term?.hasFocus() === true; },
    release() { term?.blur(); },

    dispose() {
      if (disposed) return;
      gen += 1;
      dropConnection();
      endStop();
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
  /** The pane's text size in CSS pixels; STAGE_FONT_SIZE when not said. */
  fontSize?: number;
  onCell?: (cell: Cell) => void;
  onLaunched?: (launched: LaunchedSession) => void;
  onNotice?: (sentence: string) => void;
  /** The launch on show, started again (SessionCallbacks.onLaunchAgain). */
  onLaunchAgain?: () => void;
  /** The deck's sessions run in the Windows session host. Read once, as the
   *  stage's terminal is made: the deck said it before the stage could open. */
  windows?: boolean;
  /** The suite's seam. The stage passes nothing. */
  deps?: Partial<SessionDeps>;
}

export interface TerminalSessionView extends SessionSnapshot {
  /** The element xterm is opened in. Rendered by the stage for its whole
   *  life, whatever it is showing, so the one terminal survives every state. */
  hostRef: MutableRefObject<HTMLDivElement | null>;
  adopt(): void;
  retry(): void;
  startIfFolder(cwd: string, who: FolderWho, run: () => void): void;
  cancelFolder(): void;
  focus(): void;
  type(text: string): void;
  resumeAfterExit(): void;
  stopWaitingForExit(): void;
  checkStopElsewhere(): Promise<StopCheckResult>;
  confirmStopElsewhere(): void;
  cancelStopElsewhere(): void;
  sendPrompt(text: string, expectedSubject: string): PromptSendResult;
  sendAsk(steps: readonly AskStep[], expectedSubject: string): Promise<AskSendResult>;
  readScreen(expectedSubject: string): string | null;
  press(bytes: string, held?: boolean): void;
  holdsFocus(): boolean;
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
      onLaunchAgain: () => latest.current.onLaunchAgain?.(),
    }, { windows: o.windows === true });
    controller.current = ctl;
    ctl.resize(o.cols, o.rows, !!o.holdResize);
    ctl.setTheme(o.theme);
    if (hostRef.current) ctl.mount(hostRef.current, { theme: o.theme, fontFamily: o.fontFamily, fontSize: o.fontSize });
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
  // The first size goes in with the mount; a later one zooms the pane in place.
  const mountedSize = useRef(options.fontSize);
  useEffect(() => {
    if (options.fontSize === mountedSize.current) return;
    mountedSize.current = options.fontSize;
    controller.current?.setFontSize(options.fontSize ?? STAGE_FONT_SIZE);
  }, [options.fontSize]);

  const adopt = useCallback(() => controller.current?.adopt(), []);
  const retry = useCallback(() => controller.current?.retry(), []);
  const startIfFolder = useCallback((cwd: string, who: FolderWho, run: () => void) => controller.current?.startIfFolder(cwd, who, run), []);
  const cancelFolder = useCallback(() => controller.current?.cancelFolder(), []);
  const focus = useCallback(() => controller.current?.focus(), []);
  const type = useCallback((text: string) => controller.current?.type(text), []);
  const resumeAfterExit = useCallback(() => controller.current?.resumeAfterExit(), []);
  const stopWaitingForExit = useCallback(() => controller.current?.stopWaitingForExit(), []);
  const checkStopElsewhere = useCallback((): Promise<StopCheckResult> =>
    controller.current?.checkStopElsewhere() ?? Promise.resolve({ ok: false, reason: "unsupported" }), []);
  const confirmStopElsewhere = useCallback(() => controller.current?.confirmStopElsewhere(), []);
  const cancelStopElsewhere = useCallback(() => controller.current?.cancelStopElsewhere(), []);
  const sendPrompt = useCallback((text: string, expectedSubject: string): PromptSendResult => {
    const ctl = controller.current;
    // A new subject can render before the effect has switched the controller.
    if (!ctl || expectedSubject !== subjectKey(latest.current.subject)) return "unavailable";
    return ctl.sendPrompt(text, expectedSubject);
  }, []);
  const sendAsk = useCallback(async (steps: readonly AskStep[], expectedSubject: string): Promise<AskSendResult> => {
    const ctl = controller.current;
    if (!ctl || expectedSubject !== subjectKey(latest.current.subject)) return "unavailable";
    return ctl.sendAsk(steps, expectedSubject);
  }, []);
  const readScreen = useCallback((expectedSubject: string): string | null => {
    const ctl = controller.current;
    if (!ctl || expectedSubject !== subjectKey(latest.current.subject)) return null;
    return ctl.readScreen(expectedSubject);
  }, []);
  const press = useCallback((bytes: string, held?: boolean) => controller.current?.press(bytes, held), []);
  const holdsFocus = useCallback(() => controller.current?.holdsFocus() === true, []);
  const release = useCallback(() => controller.current?.release(), []);

  return {
    ...snapshot, hostRef, adopt, retry, startIfFolder, cancelFolder, focus, type, resumeAfterExit, stopWaitingForExit,
    checkStopElsewhere, confirmStopElsewhere, cancelStopElsewhere, sendPrompt, sendAsk, readScreen, press, holdsFocus, release,
  };
}
