// Who owns a keystroke once the terminal stage is open — terminal-keys.ts.
//
// Three rules, each of which fails in a way nobody sees until it costs
// something: a pane that keeps Escape leaves a running agent with no brake, a
// Shift+Enter that reaches the session as CR submits a half-written prompt,
// and a release chord the browser swallows (or the agent needs) traps the
// keyboard in the pane. So the chord's evidence is pinned here too — the parts
// of it that live in this repository's own dependencies, read from source —
// and an xterm upgrade that changes either fact fails a case that says which.
//
// Plain node: the rules take plain objects, and the xterm facts are source text.
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  CONTROL_SYMBOLS, controlSymbolInput, inTerminalPanel, isCopyChord, isReleaseChord, MAC_META_KEYS, macEditInput, macMetaLetter,
  RELEASE_CHORD, RELEASE_CHORD_SPOKEN, releaseChordLabel,
  SHIFT_ENTER_INPUT, STAGE_FLIP_REST_MS, stageKeyIntent, stepSession, TERMINAL_PANEL_SELECTOR, terminalKeyHandler, terminalKeyInput,
  terminalKeyOutcome, type TerminalKey,
} from "../terminal-keys";
import { isSettingsChord } from "../settings";
import { CAUGHT_KEYS_ATTR, isBrowserChord } from "../shortcuts";

const XTERM = fileURLToPath(new URL("../../../node_modules/@xterm/xterm/", import.meta.url));

/** A keystroke with nothing held, and whatever the case overrides. */
const key = (k: string, o: Partial<TerminalKey> = {}): TerminalKey => ({
  type: "keydown", key: k, code: undefined, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o,
});
const chord = (o: Partial<TerminalKey> = {}) => key("X", { code: "KeyX", ctrlKey: true, shiftKey: true, ...o });

/** Every combination of the four modifiers. */
const MODIFIERS = Array.from({ length: 16 }, (_, n) => ({
  ctrlKey: !!(n & 1), shiftKey: !!(n & 2), altKey: !!(n & 4), metaKey: !!(n & 8),
}));

describe("the release chord is Ctrl+Shift+X, and only that", () => {
  it("is Ctrl+Shift+X whichever case the browser reports the letter in", () => {
    expect(isReleaseChord(chord())).toBe(true);
    expect(isReleaseChord(chord({ key: "x" })), "Caps Lock, or a browser that reports the base letter").toBe(true);
  });

  it("takes no other set of modifiers on X — AltGr arrives as Ctrl+Alt on Windows", () => {
    for (const m of MODIFIERS) {
      const want = m.ctrlKey && m.shiftKey && !m.altKey && !m.metaKey;
      expect(isReleaseChord(key("X", { code: "KeyX", ...m })), JSON.stringify(m)).toBe(want);
    }
  });

  it("is no other letter with the same modifiers", () => {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWYZ") {
      expect(isReleaseChord(chord({ key: letter, code: `Key${letter}` })), letter).toBe(false);
    }
  });

  it("goes by the letter typed under a Latin layout, as Claude Code does — Dvorak's X is X wherever it sits", () => {
    expect(isReleaseChord(chord({ key: "X", code: "KeyB" }))).toBe(true);
    // And the key in X's position typing another Latin letter is that letter.
    expect(isReleaseChord(chord({ key: "Q", code: "KeyX" }))).toBe(false);
  });

  it("goes by the key's position under a non-Latin layout, where X types something else", () => {
    expect(isReleaseChord(chord({ key: "Ч", code: "KeyX" })), "Russian ЙЦУКЕН: the X key types Ч").toBe(true);
    expect(isReleaseChord(chord({ key: "С", code: "KeyC" }))).toBe(false);
    expect(isReleaseChord(chord({ key: "Ч", code: undefined })), "no position to go by").toBe(false);
  });

  it("is spelled the way the keyboard in front of the reader labels it", () => {
    expect(releaseChordLabel("MacIntel")).toBe("⌃⇧X");
    expect(releaseChordLabel("macOS")).toBe("⌃⇧X");
    for (const platform of ["Linux x86_64", "Win32", "Windows", ""]) {
      expect(releaseChordLabel(platform), platform).toBe("Ctrl+Shift+X");
    }
    // Both spellings name the chord the rule answers.
    expect(RELEASE_CHORD.key.toUpperCase()).toBe("X");
    // And a screen reader is told it in words, not read the symbols.
    expect(RELEASE_CHORD_SPOKEN).toBe("Control Shift X");
    expect(RELEASE_CHORD).toMatchObject({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false });
  });

  it("is not a chord the deck answers anywhere else — and is one the board leaves to the browser", () => {
    expect(isSettingsChord(chord())).toBe(false);
    expect(isBrowserChord(chord()), "outside the pane the deck's handler must step aside for it").toBe(true);
  });

  it("is none of the Ctrl+Shift chords Claude Code 2.1.294 or Codex 0.155 bind by default", () => {
    // Claude Code: app:toggleBrief, selection:copy, chat:undo (twice). Codex:
    // approval.open_fullscreen, and a word deleted either way. Copied from the
    // two keymaps on 2026-10-08 — see the header of terminal-keys.ts.
    const taken = [
      key("B", { code: "KeyB" }), key("C", { code: "KeyC" }), key("_", { code: "Minus" }), key("-", { code: "Minus" }),
      key("A", { code: "KeyA" }), key("Backspace"), key("Delete"),
    ];
    for (const k of taken) expect(isReleaseChord({ ...k, ctrlKey: true, shiftKey: true }), k.key).toBe(false);
  });
});

describe("what the chord's evidence rests on, in the xterm.js this deck bundles", () => {
  it("sends no bytes for Ctrl+Shift+letter, so taking the chord costs the session nothing", () => {
    const keyboard = readFileSync(join(XTERM, "src/common/input/Keyboard.ts"), "utf8");
    // The one branch that turns Ctrl+letter into a C0 byte refuses Shift.
    expect(keyboard).toMatch(/if \(ev\.ctrlKey && !ev\.shiftKey && !ev\.altKey && !ev\.metaKey\) \{\s*if \(ev\.keyCode >= 65 && ev\.keyCode <= 90\)/);
    // And the only other Ctrl branch answers `_` and `@`, never a letter.
    const rest = keyboard.slice(keyboard.indexOf("} else if (ev.key && ev.ctrlKey) {"));
    expect(rest, "the trailing Ctrl branch moved").not.toBe(keyboard);
    expect(rest.slice(0, 300)).toMatch(/ev\.key === '_'[\s\S]*ev\.key === '@'/);
    expect(rest.slice(0, 300)).not.toMatch(/keyCode >= 65/);
  });

  it("speaks no keyboard protocol that would let a TUI tell Ctrl+Shift+X from Ctrl+X", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(XTERM, "src"));
    expect(files.length, "found no xterm sources to read").toBeGreaterThan(50);
    const speaks = files.filter(f => /kitty|modifyOtherKeys/i.test(readFileSync(f, "utf8")));
    expect(speaks, "xterm learned an extended keyboard protocol: re-check the release chord").toEqual([]);
  });

  it("lets a keydown the custom handler refuses go on to the deck's listener uncancelled", () => {
    const core = readFileSync(join(XTERM, "src/browser/CoreBrowserTerminal.ts"), "utf8");
    const keyDown = core.slice(core.indexOf("protected _keyDown(event: KeyboardEvent)"));
    // The handler is asked first, and a false answer returns before any
    // cancel(): the release reaches use-deck-shortcuts.ts through that gap.
    expect(keyDown).toMatch(/^protected _keyDown\(event: KeyboardEvent\): boolean \| undefined \{\s*this\._keyDownHandled = false;\s*this\._keyDownSeen = true;\s*if \(this\._customKeyEventHandler && this\._customKeyEventHandler\(event\) === false\) \{\s*return false;\s*\}/);
  });
});

describe("the pane is where the attribute says", () => {
  it("answers through closest, which an element inside the pane has", () => {
    const seen: string[] = [];
    const inside = { closest: (sel: string) => { seen.push(sel); return {}; } };
    expect(inTerminalPanel(inside)).toBe(true);
    expect(seen).toEqual([TERMINAL_PANEL_SELECTOR]);
    expect(TERMINAL_PANEL_SELECTOR).toBe("[data-terminal-panel]");
  });

  it("is not the board, the window or the document — which have no ancestor in the pane, or no closest at all", () => {
    expect(inTerminalPanel({ closest: () => null })).toBe(false);
    expect(inTerminalPanel({})).toBe(false);
    expect(inTerminalPanel(null)).toBe(false);
    expect(inTerminalPanel(undefined)).toBe(false);
  });
});

describe("inside xterm, two keys are rewritten and Escape never is", () => {
  /** A keystroke as xterm hands it to the custom handler, with its spies. */
  const event = (k: TerminalKey) => ({ ...k, preventDefault: vi.fn(), stopPropagation: vi.fn() });

  it("hands Escape to the session with any modifiers held, untouched", () => {
    for (const m of MODIFIERS) {
      for (const type of ["keydown", "keypress", "keyup"]) {
        const sendInput = vi.fn();
        const e = event(key("Escape", { type, code: "Escape", ...m }));
        expect(terminalKeyOutcome(e), JSON.stringify(m)).toBe("pass");
        expect(terminalKeyHandler({ sendInput })(e as unknown as KeyboardEvent), "xterm must process Escape").toBe(true);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(sendInput).not.toHaveBeenCalled();
      }
    }
  });

  it("keeps the release chord from the session, and its keydown from the browser, without releasing here", () => {
    const sendInput = vi.fn();
    const handle = terminalKeyHandler({ sendInput });
    const down = event(chord());
    expect(handle(down as unknown as KeyboardEvent), "xterm must not process the chord").toBe(false);
    // Firefox flips a text field's direction on this chord unless prevented.
    expect(down.preventDefault).toHaveBeenCalledTimes(1);
    // The release is the window listener's: propagation is left alone.
    expect(down.stopPropagation).not.toHaveBeenCalled();
    for (const type of ["keypress", "keyup"]) {
      expect(handle(event(chord({ type })) as unknown as KeyboardEvent), type).toBe(false);
    }
    expect(sendInput, "the chord sends nothing").not.toHaveBeenCalled();
  });

  it("sends ESC CR for Shift+Enter, once, and refuses the keypress that would send CR after it", () => {
    const sendInput = vi.fn();
    const handle = terminalKeyHandler({ sendInput });
    const down = event(key("Enter", { shiftKey: true, code: "Enter" }));
    expect(handle(down as unknown as KeyboardEvent)).toBe(false);
    expect(down.preventDefault, "a prevented keydown has no keypress").toHaveBeenCalled();
    expect(handle(event(key("Enter", { type: "keypress", shiftKey: true })) as unknown as KeyboardEvent)).toBe(false);
    expect(handle(event(key("Enter", { type: "keyup", shiftKey: true })) as unknown as KeyboardEvent)).toBe(false);
    expect(sendInput.mock.calls).toEqual([[SHIFT_ENTER_INPUT]]);
    expect(SHIFT_ENTER_INPUT).toBe("\x1b\r");
  });

  it("leaves Enter, and Enter with anything but Shift alone, to xterm", () => {
    for (const m of MODIFIERS.filter(m => !(m.shiftKey && !m.ctrlKey && !m.altKey && !m.metaKey))) {
      expect(terminalKeyOutcome(key("Enter", m)), JSON.stringify(m)).toBe("pass");
    }
  });

  it("leaves Shift+Enter to an input method that is composing, which commits with it", () => {
    expect(terminalKeyOutcome(key("Enter", { shiftKey: true, isComposing: true }))).toBe("pass");
    expect(terminalKeyOutcome(key("Enter", { shiftKey: true, keyCode: 229 }))).toBe("pass");
  });

  it("leaves everything else to the session — Ctrl+C, a bare 1, Ctrl+X, Ctrl+]", () => {
    for (const k of [key("c", { ctrlKey: true }), key("1"), key("x", { ctrlKey: true }), key("]", { ctrlKey: true }), key("Tab", { shiftKey: true })]) {
      expect(terminalKeyOutcome(k), k.key).toBe("pass");
    }
  });
});

describe("copy, and Option on a Mac", () => {
  const event = (k: TerminalKey) => ({ ...k, preventDefault: vi.fn(), stopPropagation: vi.fn() });

  it("copies on Ctrl+Shift+C, by letter or by position, and keeps it from the browser's element picker", () => {
    expect(isCopyChord(key("C", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isCopyChord(key("С", { code: "KeyC", ctrlKey: true, shiftKey: true })), "a Cyrillic layout's C key").toBe(true);
    for (const m of MODIFIERS.filter(m => !(m.ctrlKey && m.shiftKey && !m.altKey && !m.metaKey))) {
      expect(isCopyChord(key("c", { code: "KeyC", ...m })), JSON.stringify(m)).toBe(false);
    }
    const sendInput = vi.fn();
    const down = event(key("C", { code: "KeyC", ctrlKey: true, shiftKey: true }));
    expect(terminalKeyOutcome(down, false)).toBe("copy");
    expect(terminalKeyHandler({ sendInput, apple: false })(down as unknown as KeyboardEvent)).toBe(false);
    expect(down.preventDefault, "Chrome opens DevTools on it otherwise").toHaveBeenCalled();
    expect(sendInput, "copying types nothing into the session").not.toHaveBeenCalled();
  });

  it("leaves Ctrl+C to the session and Ctrl+Shift+V to the browser's paste", () => {
    expect(terminalKeyOutcome(key("c", { code: "KeyC", ctrlKey: true }), false)).toBe("pass");
    expect(terminalKeyOutcome(key("V", { code: "KeyV", ctrlKey: true, shiftKey: true }), false)).toBe("pass");
    expect(terminalKeyOutcome(key("c", { code: "KeyC", metaKey: true }), true), "Cmd+C copies through xterm").toBe("pass");
  });

  it("sends ESC + the letter for Option with Claude Code's Meta letters on a Mac, by the glyph the US layout types", () => {
    for (const [letter, k] of Object.entries(MAC_META_KEYS)) {
      const down = key(k.glyph, { code: k.code, altKey: true });
      expect(terminalKeyOutcome(down, true), letter).toBe("meta");
      expect(terminalKeyInput(down, "meta")).toBe(`\x1b${letter}`);
      expect(terminalKeyOutcome(down, false), "only on a Mac: elsewhere xterm already sends ESC + letter").toBe("pass");
    }
    expect(Object.keys(MAC_META_KEYS).sort(), "the letters Claude Code documents for Meta/Alt").toEqual(["b", "d", "f", "o", "p", "t", "y"]);
    const sendInput = vi.fn();
    const down = event(key("π", { code: "KeyP", altKey: true }));
    expect(terminalKeyHandler({ sendInput, apple: true })(down as unknown as KeyboardEvent)).toBe(false);
    expect(down.preventDefault, "no π typed after it").toHaveBeenCalled();
    expect(sendInput.mock.calls).toEqual([["\x1bp"]]);
  });

  it("types the letter a layout puts on Option, and leaves Option+Enter and other Option keys to xterm", () => {
    expect(macMetaLetter(key("ó", { code: "KeyO", altKey: true })), "Polish Option+O is a letter").toBeNull();
    expect(macMetaLetter(key("∏", { code: "KeyP", altKey: true, shiftKey: true }))).toBeNull();
    expect(macMetaLetter(key("@", { code: "KeyL", altKey: true })), "German Option+L").toBeNull();
    expect(macMetaLetter(key("π", { code: "KeyP", altKey: true, ctrlKey: true }))).toBeNull();
    expect(terminalKeyOutcome(key("Enter", { code: "Enter", altKey: true }), true), "xterm sends ESC CR itself").toBe("pass");
  });
});

describe("the keys xterm.js sends nothing for, sent as native terminals send them", () => {
  const event = (k: TerminalKey) => ({ ...k, preventDefault: vi.fn(), stopPropagation: vi.fn() });

  it("sends Ctrl+/ and Ctrl+2…8 as xterm and Ghostty do — Ctrl+/ is Claude Code's undo, Ctrl+_", () => {
    const want: Record<string, string> = { "/": "\x1f", "2": "\x00", "3": "\x1b", "4": "\x1c", "5": "\x1d", "6": "\x1e", "7": "\x1f", "8": "\x7f", "^": "\x1e" };
    expect(CONTROL_SYMBOLS).toEqual(want);
    for (const [k, bytes] of Object.entries(want)) {
      const down = key(k, { ctrlKey: true, shiftKey: k === "^" });
      expect(terminalKeyOutcome(down, false), k).toBe("send");
      expect(terminalKeyInput(down, "send", false), k).toBe(bytes);
    }
    expect(controlSymbolInput(key("/", { ctrlKey: true, altKey: true })), "AltGr layouts type with Ctrl+Alt").toBeNull();
    expect(controlSymbolInput(key("/", { ctrlKey: true, metaKey: true }))).toBeNull();
    expect(controlSymbolInput(key("/")), "a plain / is typed by xterm").toBeNull();
    expect(controlSymbolInput(key("a", { ctrlKey: true })), "letters are xterm's").toBeNull();
    const sendInput = vi.fn();
    const down = event(key("/", { code: "Slash", ctrlKey: true }));
    expect(terminalKeyHandler({ sendInput, apple: false })(down as unknown as KeyboardEvent)).toBe(false);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(sendInput.mock.calls).toEqual([["\x1f"]]);
  });

  it("edits the line with Cmd and moves by word with Option on a Mac, as Ghostty and VS Code's terminal do", () => {
    const cases: Array<[string, Partial<TerminalKey>, string]> = [
      ["ArrowLeft", { metaKey: true }, "\x01"], ["ArrowRight", { metaKey: true }, "\x05"], ["Backspace", { metaKey: true }, "\x15"],
      ["ArrowLeft", { altKey: true }, "\x1bb"], ["ArrowRight", { altKey: true }, "\x1bf"],
    ];
    for (const [k, mods, bytes] of cases) {
      const down = key(k, mods);
      expect(terminalKeyOutcome(down, true), `${k} ${JSON.stringify(mods)}`).toBe("send");
      expect(terminalKeyInput(down, "send", true)).toBe(bytes);
      expect(terminalKeyOutcome(down, false), "elsewhere xterm's own encoding stands").toBe("pass");
    }
    expect(macEditInput(key("ArrowLeft", { metaKey: true, shiftKey: true })), "Shift selects; not a line edit").toBeNull();
    expect(macEditInput(key("ArrowLeft", { altKey: true, metaKey: true }))).toBeNull();
    expect(macEditInput(key("ArrowUp", { metaKey: true }))).toBeNull();
  });
});

describe("the board's keys while the stage is open", () => {
  const BODY = { tagName: "BODY" };
  const ask = (k: string, o: { repeat?: boolean; target?: object | null; modalOpen?: boolean } = {}) =>
    stageKeyIntent({ key: k, repeat: o.repeat ?? false, target: o.target === undefined ? BODY : o.target, modalOpen: o.modalOpen ?? false });

  it("walks the sessions on j and k, in both cases, and keeps walking on a held key", () => {
    for (const k of ["j", "J"]) expect(ask(k)).toEqual({ kind: "step", direction: 1 });
    for (const k of ["k", "K"]) expect(ask(k)).toEqual({ kind: "step", direction: -1 });
    expect(ask("j", { repeat: true })).toEqual({ kind: "step", direction: 1 });
  });

  it("puts the keys in the pane on Enter and i, and takes the next ask on n and w — once per press", () => {
    for (const k of ["Enter", "i", "I"]) expect(ask(k), k).toEqual({ kind: "focus-pane" });
    for (const k of ["n", "N", "w", "W"]) expect(ask(k), k).toEqual({ kind: "next-ask" });
    for (const k of ["Enter", "i", "n", "w"]) expect(ask(k, { repeat: true }), k).toBeNull();
  });

  it("claims nothing else: every other key is the deck's, as before", () => {
    for (const k of [" ", "c", "r", "f", "z", "l", "d", "t", "?", "Delete", "Escape", "ArrowDown", "Tab", "1"]) {
      expect(ask(k), JSON.stringify(k)).toBeNull();
    }
  });

  it("claims nothing behind a dialog", () => {
    for (const k of ["j", "k", "Enter", "i", "n", "w"]) expect(ask(k, { modalOpen: true }), k).toBeNull();
  });

  it("leaves a field being typed in, and a control that picks by letter, their keys", () => {
    const owners = [
      { tagName: "INPUT", type: "text" }, { tagName: "TEXTAREA" }, { tagName: "DIV", isContentEditable: true },
      { tagName: "SELECT" }, { tagName: "DIV", role: "listbox" }, { tagName: "DIV", role: "slider" },
    ];
    for (const target of owners) {
      for (const k of ["j", "k", "i", "n", "w", "Enter"]) expect(ask(k, { target }), `${k} on ${JSON.stringify(target)}`).toBeNull();
    }
  });

  it("takes no letter from the button that caught a pane's keys as its connection was lost", () => {
    // The letters still coming were meant for the session: an n in mid-word
    // took the next ask and typed the rest into another session's prompt.
    const caught = { tagName: "BUTTON", caught: true };
    for (const k of ["j", "k", "i", "n", "w", "N"]) expect(ask(k, { target: caught }), k).toBeNull();
    expect(ask("Enter", { target: caught }), "its Enter is still its own press").toBeNull();
    expect(ask("n", { target: { tagName: "BUTTON", caught: false } })).toEqual({ kind: "next-ask" });
  });

  it("reads the catch off the focused element's own mark", () => {
    const src = readFileSync(new URL("../use-deck-shortcuts.ts", import.meta.url), "utf8");
    expect(src).toMatch(/caught: el\?\.hasAttribute\?\.\(CAUGHT_KEYS_ATTR\) === true,/);
    expect(CAUGHT_KEYS_ATTR).toBe("data-caught-keys");
  });

  it("takes a button's letters but not its Enter — the release leaves focus on one", () => {
    for (const target of [{ tagName: "BUTTON" }, { tagName: "DIV", role: "button" }]) {
      expect(ask("j", { target })).toEqual({ kind: "step", direction: 1 });
      expect(ask("n", { target })).toEqual({ kind: "next-ask" });
      expect(ask("i", { target })).toEqual({ kind: "focus-pane" });
      expect(ask("Enter", { target }), "Enter presses the button, which is its own").toBeNull();
    }
  });

  it("answers from no focus at all — the window, or the document", () => {
    expect(ask("j", { target: null })).toEqual({ kind: "step", direction: 1 });
    expect(ask("Enter", { target: {} })).toEqual({ kind: "focus-pane" });
  });

  it("waits 160ms of rest before the stage follows a flip", () => {
    expect(STAGE_FLIP_REST_MS).toBe(160);
  });
});

describe("which session j and k land on", () => {
  const order = ["a", "b", "c"];

  it("moves one along the navigator's reading order, and wraps at both ends", () => {
    expect(stepSession(order, "a", 1)).toBe("b");
    expect(stepSession(order, "c", 1)).toBe("a");
    expect(stepSession(order, "a", -1)).toBe("c");
    expect(stepSession(order, "b", -1)).toBe("a");
  });

  it("starts at the first for j and the last for k from a session the navigator does not show, or none", () => {
    for (const from of [null, undefined, "gone"]) {
      expect(stepSession(order, from, 1), String(from)).toBe("a");
      expect(stepSession(order, from, -1), String(from)).toBe("c");
    }
  });

  it("lands nowhere on an empty navigator, and on itself when there is one session", () => {
    expect(stepSession([], "a", 1)).toBeNull();
    expect(stepSession(["a"], "a", 1)).toBe("a");
  });
});
