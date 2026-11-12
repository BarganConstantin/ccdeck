// The pane's own zoom: the steps, the keys that take them, where the value is
// kept, and the header control that shows it (terminal-text-size.ts,
// TextSizeControl.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BASE_FONT_SIZE,
  DEFAULT_STEP,
  TERM_TEXT_SIZE_KEY,
  TEXT_STEPS,
  canGoLarger,
  canGoSmaller,
  fontSizeFor,
  forgetTerminalTextStep,
  nextTextStep,
  resolveTextStep,
  setTerminalTextStep,
  stepTerminalText,
  subscribeTerminalText,
  terminalTextStep,
  textSizeChord,
  textSizeKeysLabel,
} from "../terminal-text-size";
import { STAGE_FONT_SIZE } from "../use-terminal-session";
import { terminalKeyOutcome, type TerminalKey } from "../terminal-keys";
import { en } from "../i18n/en";

const chord = (over: Partial<TerminalKey>) =>
  ({ type: "keydown", key: "a", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over });

describe("the steps", () => {
  it("100% is the 13.3px the stage has always drawn at", () => {
    expect(BASE_FONT_SIZE).toBe(STAGE_FONT_SIZE);
    expect(fontSizeFor(DEFAULT_STEP)).toBe(13.3);
  });

  it("are the browser's own zoom steps between two thirds and twice", () => {
    expect([...TEXT_STEPS]).toEqual([67, 75, 80, 90, 100, 110, 125, 150, 175, 200]);
    expect(fontSizeFor(200)).toBe(26.6);
    expect(fontSizeFor(110)).toBe(14.63);
  });

  it("go one at a time, and stop at either end", () => {
    expect(nextTextStep(100, "larger")).toBe(110);
    expect(nextTextStep(100, "smaller")).toBe(90);
    expect(nextTextStep(200, "larger")).toBe(200);
    expect(nextTextStep(67, "smaller")).toBe(67);
    expect(nextTextStep(175, "reset")).toBe(100);
    expect(canGoLarger(200)).toBe(false);
    expect(canGoSmaller(67)).toBe(false);
    expect(canGoLarger(67) && canGoSmaller(200)).toBe(true);
  });

  it("read a stored value as the nearest step, and anything else as 100", () => {
    expect(resolveTextStep("125")).toBe(125);
    expect(resolveTextStep("112")).toBe(110);
    expect(resolveTextStep("999")).toBe(200);
    expect(resolveTextStep("10")).toBe(67);
    for (const junk of [null, undefined, "", "big", NaN, {}]) expect(resolveTextStep(junk)).toBe(100);
  });
});

describe("the keys, as a native terminal has them", () => {
  it("Ctrl and = or + make the text larger, - smaller, 0 goes back to 100%", () => {
    expect(textSizeChord(chord({ key: "=", ctrlKey: true }), false)).toBe("larger");
    expect(textSizeChord(chord({ key: "+", ctrlKey: true, shiftKey: true }), false)).toBe("larger");
    expect(textSizeChord(chord({ key: "+", code: "NumpadAdd", ctrlKey: true }), false)).toBe("larger");
    expect(textSizeChord(chord({ key: "-", ctrlKey: true }), false)).toBe("smaller");
    expect(textSizeChord(chord({ key: "-", code: "NumpadSubtract", ctrlKey: true }), false)).toBe("smaller");
    expect(textSizeChord(chord({ key: "0", ctrlKey: true }), false)).toBe("reset");
  });

  it("Shift with minus is Ctrl+_, the session's undo, and never zooms", () => {
    expect(textSizeChord(chord({ key: "_", ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(textSizeChord(chord({ key: "-", ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });

  it("Alt is never part of it: AltGr arrives as Ctrl+Alt on Windows", () => {
    expect(textSizeChord(chord({ key: "=", ctrlKey: true, altKey: true }), false)).toBeNull();
  });

  it("on a Mac only ⌘ zooms; Control there stays the session's", () => {
    expect(textSizeChord(chord({ key: "=", metaKey: true }), true)).toBe("larger");
    expect(textSizeChord(chord({ key: "-", metaKey: true }), true)).toBe("smaller");
    expect(textSizeChord(chord({ key: "0", metaKey: true }), true)).toBe("reset");
    expect(textSizeChord(chord({ key: "=", ctrlKey: true }), true)).toBeNull();
    expect(textSizeChord(chord({ key: "=", ctrlKey: true, metaKey: true }), true)).toBeNull();
    expect(textSizeChord(chord({ key: "=", metaKey: true }), false), "⌘ is not Control elsewhere").toBeNull();
  });

  it("are named for the keyboard they are on", () => {
    expect(textSizeKeysLabel(true)).toBe("⌘+ · ⌘− · ⌘0");
    expect(textSizeKeysLabel(false)).toBe("Ctrl++ · Ctrl+− · Ctrl+0");
  });

  it("are kept from the pane (outcome zoom) after Escape and the release chord, before anything that sends", () => {
    expect(terminalKeyOutcome(chord({ key: "=", ctrlKey: true }), false)).toBe("zoom");
    expect(terminalKeyOutcome(chord({ key: "0", ctrlKey: true }), false)).toBe("zoom");
    expect(terminalKeyOutcome(chord({ key: "=", metaKey: true }), true)).toBe("zoom");
    expect(terminalKeyOutcome(chord({ key: "_", ctrlKey: true, shiftKey: true }), false)).not.toBe("zoom");
    expect(terminalKeyOutcome(chord({ key: "Escape", ctrlKey: true }), false)).toBe("pass");
    expect(terminalKeyOutcome(chord({ key: "x", code: "KeyX", ctrlKey: true, shiftKey: true }), false)).toBe("release");
  });
});

describe("the one value, kept per browser", () => {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  beforeEach(() => {
    store.clear();
    listeners.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      },
      addEventListener: (type: string, fn: (e: unknown) => void) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); },
      removeEventListener: (type: string, fn: (e: unknown) => void) => { listeners.get(type)?.delete(fn); },
      dispatchEvent: () => true,
    });
    forgetTerminalTextStep();
  });
  afterEach(() => { vi.unstubAllGlobals(); forgetTerminalTextStep(); });

  it("starts at 100%, and is kept under the agent-dag namespace", () => {
    expect(terminalTextStep()).toBe(100);
    stepTerminalText("larger");
    expect(store.get(TERM_TEXT_SIZE_KEY)).toBe("110");
    expect(TERM_TEXT_SIZE_KEY.startsWith("agent-dag.")).toBe(true);
  });

  it("is read back on the next page", () => {
    store.set(TERM_TEXT_SIZE_KEY, "150");
    expect(terminalTextStep()).toBe(150);
  });

  it("tells every pane that listens, once per change", () => {
    const heard: number[] = [];
    const off = subscribeTerminalText(() => heard.push(terminalTextStep()));
    stepTerminalText("larger");
    stepTerminalText("larger");
    setTerminalTextStep(125);
    stepTerminalText("reset");
    off();
    stepTerminalText("larger");
    expect(heard).toEqual([110, 125, 100]);
  });

  it("follows another tab of the same deck through the storage event", () => {
    const heard: number[] = [];
    const off = subscribeTerminalText(() => heard.push(terminalTextStep()));
    store.set(TERM_TEXT_SIZE_KEY, "175");
    for (const fn of listeners.get("storage") ?? []) fn({ key: TERM_TEXT_SIZE_KEY });
    for (const fn of listeners.get("storage") ?? []) fn({ key: "agent-dag.theme" });
    off();
    expect(heard).toEqual([175]);
    expect(listeners.get("storage")?.size ?? 0, "the last listener gone, the window listener goes too").toBe(0);
  });
});

describe("the header's Aa", () => {
  const control = readFileSync(fileURLToPath(new URL("../components/terminal/TextSizeControl.tsx", import.meta.url)), "utf8");
  const header = readFileSync(fileURLToPath(new URL("../components/terminal/StageHeader.tsx", import.meta.url)), "utf8");
  const stage = readFileSync(fileURLToPath(new URL("../components/terminal/TerminalStage.tsx", import.meta.url)), "utf8");

  it("leads the header's tools, and is two rows of the ⋯ menu in the takeover", () => {
    const tools = header.slice(header.indexOf('<div className="ts-tools">'));
    expect(tools.indexOf("<TextSizeControl")).toBeGreaterThan(-1);
    expect(tools.indexOf("<TextSizeControl")).toBeLessThan(tools.indexOf("<KeyboardGlyph"));
    expect(header).toContain('id: "text-larger"');
    expect(header).toContain('id: "text-smaller"');
  });

  it("is drawn only while there is a terminal to size: not on the empty pane, a card, or Chat", () => {
    expect(stage).toContain('textSize={p.show.kind === "empty" || PANELESS.has(phase.kind) || chatOn ? undefined');
    expect(stage).toContain("fontSize: fontSizeFor(textStep)");
  });

  it("says the size it is at, and is filled while that is not 100%", () => {
    expect(control).toContain("data-changed={changed || undefined}");
    expect(control).toContain('t("board.stage.textSizeTip", { percent })');
    expect(en["board.stage.textSizeTip"]).toBe("Text size · {percent}");
  });

  it("keeps the focus at either end: aria-disabled, never disabled", () => {
    expect(control).not.toMatch(/\sdisabled=/);
    expect(control.match(/aria-disabled=/g)).toHaveLength(3);
  });

  it("names the keys, so the reader learns they exist", () => {
    expect(control).toContain('t("board.stage.textKeys", { keys: unbroken(textSizeKeysLabel()) })');
    // The chords as one run, so a narrow line breaks before them, not between them.
    expect(control).toContain('keys.replace(/ /g, "\\u00a0")');
    expect(en["board.stage.textKeys"]).toBe("While you type: {keys}");
  });
});
