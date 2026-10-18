// Who owns a keystroke once the terminal stage is open: the session in the
// pane, or the board around it.
//
// The stage puts a live agent TUI on the page, and a TUI wants every key —
// Escape interrupts Claude Code, Ctrl+C stops a turn, a bare `1` answers a
// permission prompt. The deck wants keys too: j and k walk the board, w goes to
// the session waiting on you. So the keyboard has exactly one owner at a time,
// and this file is the rule that says which, in the shape every key rule on
// this deck takes (shortcuts.ts, canvas-keys.ts, modal-dismiss.ts): plain data
// in, a decision out, no DOM, so a node test can call what ships.
//
// THREE DECISIONS, each pinned in terminal-keys.test.ts:
//
//  1. Inside the pane every key is the session's — Escape first among them —
//     except one chord, the RELEASE CHORD, which hands the keys back to the
//     board. use-deck-shortcuts.ts asks `inTerminalPanel` before anything else
//     and returns on it.
//  2. Inside xterm a few keys are rewritten on their way to the session: the
//     release chord never reaches it; Shift+Enter becomes ESC CR, the newline
//     Claude Code reads (a terminal sends plain CR for Shift+Enter, so without
//     this the prompt would be submitted); Ctrl+Shift+C copies the selection
//     instead of opening the browser's DevTools; and on a Mac, Option with the
//     letters of Claude Code's Meta bindings sends ESC + the letter, as a
//     terminal with "Option as Meta" would. See `terminalKeyOutcome`.
//  3. With the stage open and the keys on the board, j/k walk the sessions the
//     navigator shows (the stage follows once the key rests), Enter and i put
//     the keys in the pane, n and w take the next ask. See `stageKeyIntent`.
//
// ── WHY THE RELEASE CHORD IS CTRL+SHIFT+X ─────────────────────────────────────
//
// The chord had to be researched rather than picked, because a wrong one
// either steals a key the agent needs or never arrives at the page at all.
// The evidence, as of 2026-10-08:
//
// WHAT THE PANE COULD EVER SEND. The pane is xterm.js 6.0.0, and its encoder
// (node_modules/@xterm/xterm/src/common/input/Keyboard.ts, the `default:` case)
// turns Ctrl+letter into a C0 byte only when Shift is NOT held, and has no
// branch at all for Ctrl+Shift+letter, so that chord produces no bytes. Nor does
// xterm.js 6 speak the Kitty keyboard protocol or modifyOtherKeys, the only
// ways a TUI can tell Ctrl+Shift+X from Ctrl+X. So a Ctrl+Shift+letter chord
// costs the agent nothing in this pane: it could never have reached it. That
// rules OUT every chord the pane does deliver: Ctrl+] (GS) is Claude Code's
// app:openArtifact and Codex's chat.skip_question, Ctrl+\ is SIGQUIT in a
// shell, Ctrl+X is Claude Code's chord prefix and Codex's voice mute, Alt+
// letters are Claude Code's meta+p/o/t/w and Codex's alt-r/b/f/d, and F2/F3/F4/
// F8 are Codex's.
//
// CLAUDE CODE (2.1.294, the default table compiled into the binary, and
// code.claude.com/docs/en/keybindings): its Ctrl+Shift bindings are
// ctrl+shift+b (app:toggleBrief), ctrl+shift+c (selection:copy, fullscreen
// only), and ctrl+shift+- / ctrl+shift+_ (chat:undo, which xterm sends as
// Ctrl+_). Nothing on X with Shift.
//
// CODEX (0.155, codex-rs/tui/src/keymap.rs, built_in_defaults): Ctrl+Shift
// appears only on Backspace and Delete (delete a word) and on `a`
// (approval.open_fullscreen). Nothing on X with Shift.
//
// TMUX: nothing to avoid. The deck is a control-mode client, which reads no
// keys from any terminal, and it delivers input with `send-keys -H` (see
// src/server/tmux-control.mjs), which writes the bytes to the pane without
// passing through a key table — so tmux's prefix and its bindings never see a
// keystroke from the deck, and Ctrl+B reaches Claude Code at the first press.
//
// THE BROWSERS. A page never sees the shortcuts a browser reserves: Chrome's
// are Ctrl+N, Ctrl+Shift+N, Ctrl+T, Ctrl+Shift+T, Ctrl+W, Ctrl+Shift+W,
// Ctrl+Tab and Ctrl+Shift+Q; Firefox marks `reserved="true"` on Ctrl+N, Ctrl+T,
// Ctrl+W, Ctrl+Shift+W, Ctrl+Shift+P and its quit key
// (browser/base/content/browser-sets.inc.xhtml). Ctrl+Shift+X is on neither
// list. Every other shortcut reaches the page first, and `preventDefault`
// cancels it, which is all the one that exists needs: Firefox's
// key_switchTextDirection is accel+shift+X with no `reserved`, and on a Mac
// Firefox's Ctrl+X (its AI sidebar) is not reserved either. Edge's published
// list takes Ctrl+Shift+E, L and U and not X; Chrome's takes A B C D G I J M
// N O Q R T V W and not X; Safari's shortcuts are all Cmd. Even Firefox's
// DevTools keys (Ctrl+Shift+E, I, J, K, C, M) are XUL keys without `reserved`
// (devtools/startup/DevToolsStartup.sys.mjs, createKey), so they too are the
// page's to cancel.
//
// WHAT RULES A LETTER OUT is a layer below the browser. IBus before 1.5.25
// (Ubuntu 20.04, Fedora 34 and older) opens its emoji picker on Ctrl+Shift+E,
// and GTK and IBus take Ctrl+Shift+U for Unicode entry: the input method
// swallows both before any page sees a keydown, which is why E — the
// prototype's placeholder — and U are out.
//
// THE DESKTOP APP (desktop/, Electron 42) sets no application menu, so it runs
// Electron's default one: Ctrl+Shift+I, Ctrl+Shift+R, Ctrl+Shift+Z (redo, on
// Linux) and the plain Ctrl chords, and no Ctrl+Shift+X.
//
// THE SAME CHORD ON EVERY PLATFORM, Control rather than Cmd on a Mac: a Mac
// browser leaves Control chords alone where it fills the Cmd ones, and one
// spelling is one thing to learn. The keys bar prints it the way the keyboard
// in front of the reader labels it (⌃⇧X or Ctrl+Shift+X).
//
// MATCHED THE WAY CLAUDE CODE MATCHES ITS OWN CTRL CHORDS (the "Non-US keyboard
// layouts" section of its keybindings page): by the letter the key types under
// a Latin layout, so AZERTY's X is X, and by the US-layout position (`code`
// KeyX) under a non-Latin one, where the key types Ч. Alt must be up, because
// on Windows AltGr arrives as Ctrl+Alt and AltGr+Shift+X types a character on
// some layouts.
import { isApplePlatform, platformName } from "./platform";
import { ownsKeystroke, type FocusTarget } from "./shortcuts";

/** The keystroke fields the chord rules read. Structural, so a test can pass a
 *  plain object; a real KeyboardEvent has every one of them. */
export interface ChordKey {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** The release chord, spelled out once. Everything below reads it from here,
 *  so a change of chord is a change to this object and its label. */
export const RELEASE_CHORD = Object.freeze({ key: "x", code: "KeyX", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false });

/** Is this keystroke the chord that gives the keys back to the board? Any
 *  event type: the keyup and keypress of the chord must stay out of xterm too. */
export function isReleaseChord(e: ChordKey): boolean {
  if (e.ctrlKey !== RELEASE_CHORD.ctrlKey || e.shiftKey !== RELEASE_CHORD.shiftKey) return false;
  if (e.altKey !== RELEASE_CHORD.altKey || e.metaKey !== RELEASE_CHORD.metaKey) return false;
  const key = String(e.key ?? "");
  if (/^[a-z]$/i.test(key)) return key.toLowerCase() === RELEASE_CHORD.key;
  // Not a Latin letter: a Cyrillic, Greek or other layout. The key's position
  // is the only thing that still says X.
  return e.code === RELEASE_CHORD.code;
}

/** The chord as the keys in front of the reader label it, for the keys bar
 *  and the ⌨ control's tooltip. Control on a Mac too — see the header. */
export function releaseChordLabel(platform: string): string {
  return isApplePlatform(platform) ? "⌃⇧X" : "Ctrl+Shift+X";
}

/** The chord in words, for a screen reader — "⌃⇧X" is read as symbols, or not
 *  at all. The same on every platform, as the chord is. */
export const RELEASE_CHORD_SPOKEN = "Control Shift X";

// ── 1. the pane ─────────────────────────────────────────────────────────────

/** The attribute that marks the pane: every element under it hands every key
 *  to the session. On the element that holds the terminal, not on the stage's
 *  header or keys bar — those are where focus goes when the keys go back to the
 *  board, and from there j, k and n must work. */
export const TERMINAL_PANEL_SELECTOR = "[data-terminal-panel]";

/** Whether a keystroke's target sits inside the pane. Structural: the window
 *  and the document reach a listener with no `closest` at all, and neither is
 *  in a pane. */
export function inTerminalPanel(target: { closest?: (selector: string) => unknown } | null | undefined): boolean {
  return typeof target?.closest === "function" && target.closest(TERMINAL_PANEL_SELECTOR) != null;
}

// ── 2. inside xterm ─────────────────────────────────────────────────────────

/** What Shift+Enter sends: ESC CR, the sequence Claude Code reads as a newline
 *  in the prompt rather than a submit (its multiline input docs, "Option+Enter",
 *  which is the same bytes). */
export const SHIFT_ENTER_INPUT = "\x1b\r";

/** The keystroke fields xterm's custom key handler is handed. */
export interface TerminalKey extends ChordKey {
  type: string;
  isComposing?: boolean;
  keyCode?: number;
}

/** What becomes of a keystroke inside xterm: `release`, `newline`, `copy`,
 *  `meta` and `send` are kept from xterm (`newline`, `meta` and `send` send
 *  something of their own), everything else — Escape always — goes to it. */
export type TerminalKeyOutcome = "release" | "newline" | "copy" | "meta" | "send" | "pass";

/**
 * CONTROL WITH A SYMBOL, as xterm, GNOME Terminal and Ghostty send it. xterm.js
 * sends nothing for Ctrl+/ or Ctrl+2…8, so Claude Code's undo — Ctrl+_, which
 * every native terminal also sends for Ctrl+/ — needed Shift as well here.
 * Matched by the character the key types, so a layout's own / is the one that
 * counts. (In a browser tab Ctrl+1…8 switch tabs before the page sees them;
 * the desktop app passes them.)
 */
export const CONTROL_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  "/": "\x1f", "2": "\x00", "3": "\x1b", "4": "\x1c", "5": "\x1d", "6": "\x1e", "7": "\x1f", "8": "\x7f", "^": "\x1e",
});

/** The byte a Control chord with a symbol sends, or null. */
export function controlSymbolInput(e: ChordKey): string | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  return Object.prototype.hasOwnProperty.call(CONTROL_SYMBOLS, e.key) ? CONTROL_SYMBOLS[e.key] : null;
}

/**
 * LINE EDITING ON A MAC, as Ghostty, iTerm2's natural text editing and VS
 * Code's terminal do it: Cmd+Left and Cmd+Right go to the start and end of the
 * line (^A, ^E), Cmd+Backspace deletes back to the start (^U), and Option+Left
 * and Option+Right move by word (ESC b, ESC f) — the keys a Mac user's hands
 * already know, which xterm.js sent nothing (Cmd) or a CSI the shell does not
 * bind (Option) for. Claude Code's prompt, bash and zsh all read these.
 */
export function macEditInput(e: ChordKey): string | null {
  if (e.ctrlKey || e.shiftKey) return null;
  if (e.metaKey && !e.altKey) {
    if (e.key === "ArrowLeft") return "\x01";
    if (e.key === "ArrowRight") return "\x05";
    if (e.key === "Backspace") return "\x15";
  }
  if (e.altKey && !e.metaKey) {
    if (e.key === "ArrowLeft") return "\x1bb";
    if (e.key === "ArrowRight") return "\x1bf";
  }
  return null;
}

/**
 * COPY IS CTRL+SHIFT+C, as in GNOME Terminal, Konsole and VS Code's terminal:
 * Ctrl+C is the session's (it stops a turn), and Chrome opens its element
 * picker on Ctrl+Shift+C unless the page takes the key. xterm.js sends no byte
 * for a Ctrl+Shift letter (see THE RELEASE CHORD above), so the chord costs the
 * session nothing — Claude Code's own ctrl+shift+c, its fullscreen copy, could
 * never have arrived through this pane. With nothing selected it does nothing,
 * and still never reaches the browser. Cmd+C on a Mac is left to xterm, which
 * copies through the browser's own copy event. Ctrl+Shift+V needs nothing: it
 * is the browser's plain-text paste, which arrives as a paste event and goes
 * up whole like any other paste.
 */
export function isCopyChord(e: ChordKey): boolean {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return false;
  const key = String(e.key ?? "");
  return /^[a-z]$/i.test(key) ? key.toLowerCase() === "c" : e.code === "KeyC";
}

/**
 * OPTION ON A MAC. Claude Code binds Meta+P (model picker), Meta+O (fast mode),
 * Meta+T (thinking), and Alt+B / Alt+F / Alt+D / Alt+Y (word motion and paste
 * history), and on a Mac those arrive only from a terminal set to send Option
 * as Meta (code.claude.com/docs/en/terminal-config). xterm.js's own switch for
 * that, macOptionIsMeta, would take Option away from every layout that types
 * with it — ö, ł, @ — so it stays off, and only these letters are rewritten.
 * Each is matched by the glyph Option types on it under the US layout as well
 * as by its position: a Polish layout's Option+O types "ó", which is a letter
 * the reader wants, so it goes through untouched. Option+Enter needs nothing,
 * since xterm already sends ESC CR for it.
 */
export const MAC_META_KEYS: Readonly<Record<string, { code: string; glyph: string }>> = Object.freeze({
  p: { code: "KeyP", glyph: "π" },
  o: { code: "KeyO", glyph: "ø" },
  t: { code: "KeyT", glyph: "†" },
  b: { code: "KeyB", glyph: "∫" },
  f: { code: "KeyF", glyph: "ƒ" },
  d: { code: "KeyD", glyph: "∂" },
  y: { code: "KeyY", glyph: "¥" },
});

/** The letter a Mac Option chord stands for, or null. */
export function macMetaLetter(e: ChordKey): string | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  for (const [letter, k] of Object.entries(MAC_META_KEYS)) {
    if (e.code === k.code && e.key === k.glyph) return letter;
  }
  return null;
}

/**
 * The keystroke's fate. `apple` is whether the keyboard is a Mac's; it decides
 * only the Option chords, read from the browser when not given.
 */
export function terminalKeyOutcome(e: TerminalKey, apple = isApplePlatform(platformName())): TerminalKeyOutcome {
  // Escape is the session's, whatever is held with it: it interrupts Claude
  // Code mid-turn, closes its dialogs and declines a permission prompt, and a
  // pane that kept it would leave a running agent with no brake.
  if (e.key === "Escape") return "pass";
  if (isReleaseChord(e)) return "release";
  // An input method composing CJK text owns Enter: it commits the
  // composition. keyCode 229 is what a browser reports while one is active,
  // including on the keydown that ends it, where isComposing can already read
  // false.
  if (e.isComposing || e.keyCode === 229) return "pass";
  if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return "newline";
  if (isCopyChord(e)) return "copy";
  if (controlSymbolInput(e)) return "send";
  if (apple && macEditInput(e)) return "send";
  if (apple && macMetaLetter(e)) return "meta";
  return "pass";
}

/** What a kept keystroke sends to the session on its keydown, if anything. */
export function terminalKeyInput(e: TerminalKey, outcome: TerminalKeyOutcome, apple = isApplePlatform(platformName())): string | null {
  if (outcome === "newline") return SHIFT_ENTER_INPUT;
  if (outcome === "send") return controlSymbolInput(e) ?? (apple ? macEditInput(e) : null);
  if (outcome === "meta") {
    const letter = macMetaLetter(e);
    return letter ? `\x1b${letter}` : null;
  }
  return null;
}

/**
 * The function to give xterm's `attachCustomKeyEventHandler`. It returns
 * whether xterm may process the event, as that API wants.
 *
 * THE RELEASE IS NOT DONE HERE. Returning false makes xterm 6 leave the event
 * alone before it cancels anything (CoreBrowserTerminal `_keyDown`: the custom
 * handler is asked first and a false return ends the method), so the keydown
 * goes on bubbling to the deck's window listener — and that listener, which
 * owns every key in the pane, is the one that releases (use-deck-shortcuts.ts).
 * One owner means the chord cannot release twice, and it works the same from
 * anywhere in the pane, not only from xterm's textarea. What this does is keep
 * the chord out of the session and stop the browser's own meaning for it:
 * Firefox flips a text field's direction on Ctrl+Shift+X unless the page
 * prevents it.
 *
 * SHIFT+ENTER IS SENT ONCE. xterm would otherwise send CR on the keydown —
 * submitting the prompt — and a keydown xterm skips is followed by a keypress
 * it does NOT skip, which would send the CR anyway. So the keydown sends ESC
 * CR and is prevented (a prevented keydown has no keypress), and a keypress or
 * keyup of the same chord is refused as well, for a browser that sends one.
 */
export function terminalKeyHandler({ sendInput, apple }: { sendInput: (data: string) => void; apple?: boolean }): (e: KeyboardEvent) => boolean {
  return (e: KeyboardEvent) => {
    const outcome = terminalKeyOutcome(e, apple);
    if (outcome === "pass") return true;
    if (e.type === "keydown") {
      e.preventDefault();
      const input = terminalKeyInput(e, outcome, apple);
      if (input) sendInput(input);
    }
    return false;
  };
}

// ── 3. the board, while the stage is open ───────────────────────────────────

/** How long j or k must rest before the stage follows the board's focus. A held
 *  j passes a session every ~33ms; attaching to each would open a socket per
 *  session and replay every seed it passed. 160ms is the prototype's figure:
 *  longer than a key repeat, shorter than a deliberate look. */
export const STAGE_FLIP_REST_MS = 160;

/** What a board key does while the stage is open. */
export type StageKeyIntent =
  | { kind: "step"; direction: 1 | -1 }
  | { kind: "focus-pane" }
  | { kind: "next-ask" };

/**
 * The board's meaning for a keystroke while the stage is open, or null when
 * the stage has no claim on it and the deck's ordinary rules decide — which,
 * for every key not listed here, is exactly what they decided before the stage
 * existed.
 *
 * j/k step through the sessions and keep repeating, the way they do on the
 * canvas. Enter and i hand the keys to the pane; n and w take the next ask, w
 * because it already meant "the session waiting on you" (#825). Every letter
 * in both cases, as the deck binds them.
 *
 * TWO GATES, and they are the deck's own. Nothing over a dialog: a stray j
 * behind a modal must not move the stage under it. And nothing a focused
 * control answers itself — a field being typed in, a select's type-ahead, a
 * button's Enter. A BUTTON'S LETTERS ARE THE EXCEPTION, by the argument #851
 * made for a button the pointer pressed: a button has no use for a letter, and
 * here the reason matters more, because handing the keys back to the board puts
 * focus on a button (the ⌨ control, or the session's own tile) by program, and
 * the keys bar then promises that j works.
 */
export function stageKeyIntent(
  { key, repeat, target, modalOpen }: { key: string; repeat: boolean; target: FocusTarget | null | undefined; modalOpen: boolean },
): StageKeyIntent | null {
  if (modalOpen) return null;
  if (key === "Enter") {
    if (repeat || ownsKeystroke(target, key)) return null;
    return { kind: "focus-pane" };
  }
  if (!/^[jkinw]$/i.test(key)) return null;
  const letter = key.toLowerCase();
  // A letter on a button is the board's; on anything that types or picks, it
  // is that control's. Asked as the pointer-pressed button #851 already frees.
  if (ownsKeystroke(target ? { ...target, pointerFocused: true } : target, key)) return null;
  if (letter === "j" || letter === "k") return { kind: "step", direction: letter === "j" ? 1 : -1 };
  if (repeat) return null;
  return letter === "i" ? { kind: "focus-pane" } : { kind: "next-ask" };
}

/**
 * The session j (+1) or k (-1) lands on, in the navigator's reading order.
 * Wraps at both ends, like the canvas's j. From a session the navigator does
 * not show — or from none — j starts at the first and k at the last.
 */
export function stepSession(order: readonly string[], from: string | null | undefined, direction: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = from == null ? -1 : order.indexOf(from);
  if (at < 0) return direction === 1 ? order[0] : order[order.length - 1];
  return order[(at + direction + order.length) % order.length];
}
