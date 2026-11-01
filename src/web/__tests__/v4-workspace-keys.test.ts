// V4 Workspace: the keys. Ctrl + backtick is Board or Workspace from anywhere,
// also with the keys in the terminal, and it never reaches the session; j and
// k walk the Sessions list and open nothing; Enter on a row opens the session
// with the keys; and with the Command Panel off none of it is claimed or named.
import { afterEach, describe, it, expect } from "vitest";
import { resetLanguageForTest, setLanguage } from "../i18n";
import { sourceOf } from "./client-source";
import { withoutComments } from "./tsx-scan";
import {
  VIEW_CHORD, isViewChord, stageKeyIntent, stepSession, terminalKeyHandler, terminalKeyInput, terminalKeyOutcome,
  type TerminalKey,
} from "../terminal-keys";
import { holdKey, startTypeAhead } from "../type-ahead";
import { documentedKeys, keyHelpFor, KEY_HELP, WORKSPACE_KEY_ROW } from "../key-help";
import { BOARD_HINTS, DECK_HINTS, statusViewFor, type StatusInput } from "../status-hints";

const key = (over: Partial<TerminalKey>): TerminalKey => ({
  key: "`", code: "Backquote", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, type: "keydown", ...over,
});

describe("the chord", () => {
  it("is Control and the backtick, spelled once", () => {
    expect(VIEW_CHORD).toMatchObject({ key: "`", code: "Backquote", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
  });

  it("matches by the character on a US layout and by the key's position on any other", () => {
    expect(isViewChord(key({}))).toBe(true);
    // A Cyrillic layout types ё there; a German one a dead accent: the position is what says backtick.
    expect(isViewChord(key({ key: "ё" }))).toBe(true);
    expect(isViewChord(key({ key: "Dead" }))).toBe(true);
    // The character alone is enough where the position is unreported.
    expect(isViewChord(key({ code: undefined }))).toBe(true);
  });

  it("is not a Cmd chord (the OS switches windows with it), not Shift, not Alt, not bare", () => {
    expect(isViewChord(key({ ctrlKey: false, metaKey: true }))).toBe(false);
    expect(isViewChord(key({ ctrlKey: false }))).toBe(false);
    expect(isViewChord(key({ shiftKey: true }))).toBe(false);
    expect(isViewChord(key({ altKey: true }))).toBe(false);
    expect(isViewChord(key({ ctrlKey: true, key: "a", code: "KeyA" }))).toBe(false);
  });

  it("is kept from xterm for every event type, so the session never sees it", () => {
    for (const type of ["keydown", "keypress", "keyup"]) {
      expect(terminalKeyOutcome(key({ type }), false), type).toBe("view");
    }
    expect(terminalKeyInput(key({}), "view", false)).toBeNull();
    const calls: string[] = [];
    let prevented = 0;
    const handler = terminalKeyHandler({ sendInput: d => calls.push(d), apple: false });
    const e = Object.assign(key({}), { preventDefault: () => { prevented++; } }) as unknown as KeyboardEvent;
    expect(handler(e), "xterm is told not to handle it").toBe(false);
    expect(prevented, "the browser gets no backtick either").toBe(1);
    expect(calls).toEqual([]);
  });

  it("leaves Escape the session's and the release chord the release", () => {
    expect(terminalKeyOutcome(key({ key: "Escape", code: "Escape", ctrlKey: false }), false)).toBe("pass");
    expect(terminalKeyOutcome(key({ key: "x", code: "KeyX", shiftKey: true }), false)).toBe("release");
  });

  it("is not typed ahead and does not spoil what is held", () => {
    const ahead = startTypeAhead(0);
    expect(holdKey(ahead, { ...key({}), repeat: false } as never, false)).toBeNull();
    const typed = holdKey(ahead, { key: "a", code: "KeyA", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false } as never, false);
    expect(typed).not.toBeNull();
    expect(typed).not.toBe("end");
  });
});

describe("the window listener", () => {
  const src = withoutComments(sourceOf("use-deck-shortcuts.ts"));

  it("answers the chord before it gives the pane its early return", () => {
    const chord = src.indexOf("isViewChord(e)");
    const pane = src.indexOf("if (inTerminalPanel(el))");
    expect(chord).toBeGreaterThan(-1);
    expect(pane).toBeGreaterThan(chord);
  });

  it("claims it only where it is available, behind the dialog gate, once per press", () => {
    const at = src.indexOf("isViewChord(e)");
    const body = src.slice(at, src.indexOf("if (inTerminalPanel(el))"));
    expect(body).toContain("view?.available");
    expect(body).toContain("canvasModalOpen(");
    expect(body).toContain("e.preventDefault()");
    expect(body).toContain("if (!e.repeat) view.toggle()");
    // Not available: no preventDefault on the way, so the page keeps the chord.
    expect(body.indexOf("view?.available")).toBeLessThan(body.indexOf("e.preventDefault()"));
  });
});

describe("j and k in Workspace", () => {
  const src = withoutComments(sourceOf("use-deck-shortcuts.ts"));
  const stage = withoutComments(sourceOf("use-stage.ts"));

  it("walk the list's rows and never switch the pane", () => {
    const rail = src.slice(src.indexOf('stage.mode === "rail"'), src.indexOf("const from = flip"));
    expect(rail).toContain("stage.focusTile(to)");
    expect(rail).not.toContain("setTimeout");
    expect(rail).not.toContain("switchTo");
  });

  it("read the rows as drawn, and none while Zoom has folded the list", () => {
    expect(stage).toContain('.session-list .sl-row[data-session]');
    expect(stage).toMatch(/workspace \? \(expanded \? \[\] : railOrder\(document\)\)/);
  });

  it("wrap along a list of rows like the navigator's tiles", () => {
    expect(stepSession(["a", "b", "c"], "c", 1)).toBe("a");
    expect(stepSession(["a", "b", "c"], null, -1)).toBe("c");
    expect(stepSession([], "a", 1)).toBeNull();
  });

  it("are still the board's letters on a row button, and Enter on it is the row's own", () => {
    const onButton = { tagName: "BUTTON", role: null, type: "button", pointerFocused: false, caught: false };
    expect(stageKeyIntent({ key: "j", repeat: false, target: onButton, modalOpen: false })).toEqual({ kind: "step", direction: 1 });
    expect(stageKeyIntent({ key: "Enter", repeat: false, target: onButton, modalOpen: false })).toBeNull();
  });
});

describe("Enter on a row", () => {
  const parts = withoutComments(sourceOf("components/RailParts.tsx"));

  it("opens the session with the keys, not through the click", () => {
    // The handler is openKeysOnEnter (run in v4-workspace-keys-behavior.test.ts).
    expect(parts).toContain('e.key !== "Enter"');
    expect(parts).toContain("e.preventDefault();");
    expect(parts).toContain("onOpenKeys(sessionId)");
    // Only where Workspace gives the row a handler: the Board's Enter is the click.
    expect(parts).toContain("if (!onOpenKeys) return undefined;");
    expect(parts).toContain("onKeyDown={openKeysOnEnter(r.sessionId, onOpenKeys)}");
  });

  it("names the row by session, for the list to be walked", () => {
    expect(parts).toContain("data-session={r.sessionId}");
  });
});

describe("what names the chord", () => {
  const input = (over: Partial<StatusInput> = {}): StatusInput =>
    ({ stageOpen: false, pane: null, onCard: true, zoomedOut: true, singleKeys: true, platform: "Linux", ...over });

  it("is silent about it where the Command Panel is off: the tables are the tables they were", () => {
    expect(statusViewFor(input()).hints).toEqual([...BOARD_HINTS]);
    expect(statusViewFor(input({ stageOpen: true })).hints).toEqual([...DECK_HINTS]);
    expect(keyHelpFor(true)).toBe(KEY_HELP);
  });

  it("names Workspace from the Board and the Board from Workspace, last, and keeps it with the single keys off", () => {
    const board = statusViewFor(input({ viewChord: "workspace" }));
    const last = board.hints[board.hints.length - 1];
    expect(last.word).toBe("workspace");
    expect(last.caps.map(c => c.text)).toEqual(["Ctrl+`"]);
    expect(last.binds).toEqual([]);
    const ws = statusViewFor(input({ stageOpen: true, viewChord: "board" }));
    expect(ws.hints[ws.hints.length - 1].word).toBe("board");
    expect(ws.label).toBe("Keys on the deck");
    const off = statusViewFor(input({ stageOpen: true, viewChord: "board", singleKeys: false }));
    // Enter, a named key, stays too; the chord is the last.
    expect(off.hints.map(h => h.word)).toEqual(["open and type", "board"]);
  });

  it("adds the sheet's row only where the Command Panel is on, after Quick open's, and writes the key down", () => {
    const rows = keyHelpFor(true, () => true, true).flatMap(g => g.rows);
    expect(rows).toContain(WORKSPACE_KEY_ROW);
    const panels = keyHelpFor(true, () => true, true).find(g => g.title === "Panels and dialogs")!;
    expect(panels.rows[0].cap).toBe("Ctrl + K");
    expect(panels.rows[1]).toBe(WORKSPACE_KEY_ROW);
    expect(keyHelpFor(true).flatMap(g => g.rows)).not.toContain(WORKSPACE_KEY_ROW);
    expect(WORKSPACE_KEY_ROW.chord, "a chord stays with the single keys off").toBe(true);
    expect(keyHelpFor(false, () => true, true).flatMap(g => g.rows).map(r => r.cap)).toContain(WORKSPACE_KEY_ROW.cap);
    expect(documentedKeys().has("`")).toBe(true);
  });

  // The group was found by its English title, so in every other language the row was missing.
  describe("in another language", () => {
    afterEach(() => { setLanguage("en"); resetLanguageForTest(); });
    for (const code of ["de", "ja"]) {
      it(`still sits right after Quick open's row (${code})`, () => {
        setLanguage(code);
        const panels = keyHelpFor(true, () => true, true).find(g => g.id === "panels-and-dialogs")!;
        expect(panels.title, "the title is the translated one").not.toBe("Panels and dialogs");
        expect(panels.rows[0].cap).toBe("Ctrl + K");
        expect(panels.rows[1]).toBe(WORKSPACE_KEY_ROW);
      });
    }
  });
});
