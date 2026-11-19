// V4 Workspace: the keys. Ctrl + backtick is Board or Workspace from anywhere,
// also with the keys in the terminal, and it never reaches the session; j and
// k walk the Sessions list and open nothing; Enter on a row opens the session
// with the keys; and with the Command Panel off none of it is claimed or named.
import { afterEach, describe, it, expect } from "vitest";
import { resetLanguageForTest, setLanguage } from "../i18n";
import { sourceOf } from "./client-source";
import { withoutComments } from "./tsx-scan";
import {
  VIEW_CHORD, isViewChord, paneFocusChordLabel, paneFocusDirection, stageKeyIntent, stepSession, terminalKeyHandler, terminalKeyInput, terminalKeyOutcome,
  type TerminalKey,
} from "../terminal-keys";
import { adjacentPane } from "../workspace-split";
import { holdKey, startTypeAhead } from "../type-ahead";
import { documentedKeys, keyHelpFor, KEY_HELP, WORKSPACE_KEY_ROW } from "../key-help";
import { isReleaseChord } from "../terminal-keys";
import { textSizeChord } from "../terminal-text-size";
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
    // On a card the board's table less Space (the card's own key); off a card
    // the table less ↵ select (a card's key). Either way no chord is added.
    expect(statusViewFor(input()).hints).toEqual(BOARD_HINTS.filter(h => !h.offCard));
    expect(statusViewFor(input({ onCard: false })).hints).toEqual(BOARD_HINTS.filter(h => !h.onCard));
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

  it("adds the sheet's row only where the Command Panel is on, in V4's Workspace group, and writes the key down", () => {
    const rows = keyHelpFor(true, () => true, true).flatMap(g => g.rows);
    expect(rows).toContain(WORKSPACE_KEY_ROW);
    // CHANGED ON PURPOSE (first use of Workspace): the row heads a Workspace
    // group of its own, with how a session gets into a pane and 1 to 4; the
    // Terminal group after it holds the keys inside a pane. Both sit between
    // The question and Canvas, where a reader new to V4 finds them first.
    const groups = keyHelpFor(true, () => true, true);
    const workspace = groups.find(g => g.id === "workspace")!;
    expect(workspace.title).toBe("Workspace");
    expect(workspace.rows[0]).toBe(WORKSPACE_KEY_ROW);
    expect(workspace.rows.map(r => r.cap)).toEqual(["Ctrl + `", paneFocusChordLabel(), "click", "Enter", "Shift + Enter", "drag", "1 – 4"]);
    expect(workspace.rows.map(r => r.action)).toEqual([
      "switch between the Board and the Workspace — also with the keys in the terminal",
      "switch pane",
      "a session in the list: show it in the pane",
      "a session in the list: show it and type into it",
      "a session in the list: open it in a pane beside — four at most",
      "a session onto a pane: in its place, or beside it at an edge",
      "the keys to that pane, with panes side by side",
    ]);
    const terminal = groups.find(g => g.id === "terminal")!;
    expect(terminal.title).toBe("Terminal");
    expect(terminal.rows.map(r => [r.cap, r.macCap, r.action])).toEqual([
      ["Esc", undefined, "goes to the session while you type in a pane"],
      ["Ctrl + Shift + X", "⌃ ⇧ X", "the keys back to the deck"],
      ["Ctrl + =", "⌘ =", "larger terminal text"],
      ["Ctrl + -", "⌘ -", "smaller terminal text"],
      ["Ctrl + 0", "⌘ 0", "terminal text back to 100%"],
    ]);
    expect(groups.map(g => g.id)).toEqual(["deck", "question", "workspace", "terminal", "canvas", "panels"]);
    expect(keyHelpFor(true).flatMap(g => g.rows)).not.toContain(WORKSPACE_KEY_ROW);
    expect(keyHelpFor(true).map(g => g.id), "neither group without the Command Panel").toEqual(["deck", "question", "canvas", "panels"]);
    expect(WORKSPACE_KEY_ROW.chord, "a chord stays with the single keys off").toBe(true);
    expect(keyHelpFor(false, () => true, true).flatMap(g => g.rows).map(r => r.cap)).toContain(WORKSPACE_KEY_ROW.cap);
    expect(documentedKeys().has("`")).toBe(true);
    for (const key of ["1", "2", "3", "4"]) expect(documentedKeys().has(key), key).toBe(true);
  });

  // With the single keys off the deck's handler does not answer 1 to 4
  // (use-deck-shortcuts.ts), so the row goes; the chords and the named keys
  // stay, and the Terminal group stays whole.
  it("keeps Workspace's named keys and every Terminal key with the single keys off, and drops 1 to 4", () => {
    const groups = keyHelpFor(false, () => true, true);
    expect(groups.find(g => g.id === "workspace")!.rows.map(r => r.cap)).toEqual(["Ctrl + `", paneFocusChordLabel(), "click", "Enter", "Shift + Enter", "drag"]);
    expect(groups.find(g => g.id === "terminal")!.rows.map(r => r.cap)).toEqual(["Esc", "Ctrl + Shift + X", "Ctrl + =", "Ctrl + -", "Ctrl + 0"]);
  });

  it("says the canvas's click opens the Command Panel only where it is on", () => {
    const click = (workspace: boolean) => keyHelpFor(true, () => true, workspace)
      .find(g => g.id === "canvas")!.rows.find(r => r.cap === "click")!.action;
    expect(click(false)).toBe("a card: go to it and its session");
    expect(click(true)).toBe("a card: open its session in the Command Panel");
  });

  // The caps are the keys the pane's handlers answer, held against them here:
  // the release chord is Control and Shift and X on a Mac too, the text size
  // is Ctrl off a Mac and ⌘ on one.
  it("names the keys the pane answers, on every keyboard", () => {
    const press = (key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean }) =>
      ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
    expect(isReleaseChord(press("X", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isReleaseChord(press("x", { metaKey: true, shiftKey: true })), "⌘ is not the release chord's key").toBe(false);
    for (const apple of [false, true]) {
      const mod = apple ? { metaKey: true } : { ctrlKey: true };
      expect([textSizeChord(press("=", mod), apple), textSizeChord(press("-", mod), apple), textSizeChord(press("0", mod), apple)])
        .toEqual(["larger", "smaller", "reset"]);
    }
  });

  // The group was found by its English title, so in every other language the row was missing.
  describe("in another language", () => {
    afterEach(() => { setLanguage("en"); resetLanguageForTest(); });
    for (const code of ["de", "ja"]) {
      // CHANGED ON PURPOSE (first use of Workspace): the row heads the
      // Workspace group now, and the group's title is the language's own.
      it(`still sits in its own Workspace group (${code})`, () => {
        setLanguage(code);
        const workspace = keyHelpFor(true, () => true, true).find(g => g.id === "workspace")!;
        expect(workspace.rows[0]).toBe(WORKSPACE_KEY_ROW);
        expect(workspace.title).toBe(code === "ja" ? "ワークスペース" : "Workspace");
        expect(keyHelpFor(true, () => true, true).find(g => g.id === "terminal")!.title).toBe(code === "ja" ? "ターミナル" : "Terminal");
        // CHANGED ON PURPOSE (V4's Figma): the group is found by its id, and the
        // titles around it are the language's own where it has one. German keeps
        // "Canvas" as its own word; Japanese translates it. (The V4 names Deck,
        // The question, Terminal and Panels fall back to English until
        // translated.)
        const canvas = keyHelpFor(true, () => true, true).find(g => g.id === "canvas")!;
        expect(canvas.title).toBe(code === "ja" ? "キャンバス" : "Canvas");
        if (code === "ja") expect(canvas.title, "the title is the translated one").not.toBe("Canvas");
      });
    }
  });
});


describe("directional split focus", () => {
  it("uses platform-specific modifiers, including a browser-safe Mac binding", () => {
    const down = key({ key: "ArrowDown", ctrlKey: false });
    expect(paneFocusDirection({ ...down, metaKey: true, altKey: true }, true, true)).toBe("down");
    expect(paneFocusDirection({ ...down, metaKey: true, altKey: true }, true, false)).toBeNull();
    expect(paneFocusDirection({ ...down, altKey: true, shiftKey: true }, true, false)).toBe("down");
    expect(paneFocusDirection({ ...down, ctrlKey: true, shiftKey: true }, false, false)).toBe("down");
    expect(paneFocusDirection({ ...down, ctrlKey: true, shiftKey: true }, false, true)).toBe("down");
    expect(paneFocusDirection(down, false, false)).toBeNull();
  });

  it("follows each edge in a split and stops at outer edges", () => {
    const panes = new Map([
      ["a", { x: 0, y: 0, w: 200, h: 150 }],
      ["b", { x: 201, y: 0, w: 200, h: 150 }],
      ["c", { x: 0, y: 151, w: 200, h: 150 }],
      ["d", { x: 201, y: 151, w: 200, h: 150 }],
    ]);
    expect(adjacentPane(panes, "a", "right")).toBe("b");
    expect(adjacentPane(panes, "b", "left")).toBe("a");
    expect(adjacentPane(panes, "a", "down")).toBe("c");
    expect(adjacentPane(panes, "d", "up")).toBe("b");
    expect(adjacentPane(panes, "a", "up")).toBeNull();
    expect(adjacentPane(panes, "d", "right")).toBeNull();
  });
});
