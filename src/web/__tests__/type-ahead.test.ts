// The keys typed before the pane can take them (type-ahead.ts): what a hold
// keeps, as the pane would have sent it; what spoils it — a key it cannot
// send, which goes where it always went, and after which it delivers
// nothing; and what ends it.
import { describe, expect, it } from "vitest";
import {
  TYPE_AHEAD_MAX, TYPE_AHEAD_MS, heldText, holdKey, isPaneInput, startTypeAhead, typesItself,
  type HeldKeyEvent, type TypeAhead,
} from "../type-ahead";
import { SHIFT_ENTER_INPUT } from "../terminal-keys";

const key = (k: string, extra: Partial<HeldKeyEvent> = {}): HeldKeyEvent => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...extra });
/** The keys, in order, through the hold — on a PC unless `apple`. */
function run(keys: HeldKeyEvent[], apple = false): { ahead: TypeAhead; swallowed: boolean[] } {
  let ahead = startTypeAhead(0);
  const swallowed: boolean[] = [];
  for (const e of keys) {
    const next = holdKey(ahead, e, apple);
    if (next && next !== "end") ahead = next.ahead;
    swallowed.push(!!next && next !== "end" && next.swallow);
  }
  return { ahead, swallowed };
}
const typed = (keys: HeldKeyEvent[], apple = false) => heldText(run(keys, apple).ahead);

describe("a hold", () => {
  it("waits TYPE_AHEAD_MS from the press, holding nothing yet", () => {
    expect(startTypeAhead(1000)).toEqual({ text: "", until: 1000 + TYPE_AHEAD_MS });
  });

  it("keeps characters, Enter and Backspace as xterm sends them, and Shift+Enter as the pane does", () => {
    expect(typed([key("l"), key("S", { shiftKey: true }), key(" "), key("ö"), key("😀"), key("Enter"), key("Backspace")])).toBe("lS ö😀\r\x7f");
    expect(typed([key("a"), key("Enter", { shiftKey: true }), key("b")]), "a new line in the prompt, not a submit").toBe(`a${SHIFT_ENTER_INPUT}b`);
  });

  it("keeps what AltGr types, and on a Mac what Option types, which are not chords", () => {
    expect(typed([key("@", { ctrlKey: true, altKey: true, getModifierState: m => m === "AltGraph" })])).toBe("@");
    expect(typed([key("@", { altKey: true, code: "KeyL" })], true), "a German Mac's @").toBe("@");
    expect(typed([key("π", { altKey: true, code: "KeyP" })], true), "Option+P is Claude Code's Meta+P, as the pane sends it").toBe("\x1bp");
    expect(typed([key("ArrowLeft", { altKey: true })], true), "a Mac's word motion").toBe("\x1bb");
  });

  it("adds nothing for a held Enter's auto-repeat, and still keeps it from the page", () => {
    const { ahead, swallowed } = run([key("Enter"), key("Enter", { repeat: true }), key("Enter", { repeat: true })]);
    expect(heldText(ahead)).toBe("\r");
    expect(swallowed).toEqual([true, true, true]);
    expect(typed([key("Backspace"), key("Backspace", { repeat: true })]), "a held Backspace erases as it would").toBe("\x7f\x7f");
  });

  it("changes nothing for a modifier on its own or a dead key", () => {
    for (const k of ["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead"]) expect(holdKey(startTypeAhead(0), key(k)), k).toBeNull();
  });

  it("ends on Esc and on the release chord", () => {
    expect(holdKey(startTypeAhead(0), key("Escape"))).toBe("end");
    expect(holdKey(startTypeAhead(0), key("X", { ctrlKey: true, shiftKey: true, code: "KeyX" }))).toBe("end");
  });

  it("is spoiled by a key it cannot send, which goes on as usual, and delivers nothing after it", () => {
    for (const e of [
      key("ArrowLeft"), key("Tab"), key("Delete"), key("Home"), key("F5"), key("c", { ctrlKey: true }), key("k", { metaKey: true }),
      key("b", { altKey: true }), key("Enter", { ctrlKey: true }), key("a", { isComposing: true }), key("Process", { keyCode: 229 }),
    ]) {
      const { ahead, swallowed } = run([key("h"), e, key("j")]);
      expect(swallowed, e.key).toEqual([true, false, true]);
      expect(heldText(ahead), `${e.key}: "h", the key, then "j" is not what was typed`).toBe("");
    }
  });

  it("holds a burst, not a paste: past TYPE_AHEAD_MAX it keeps the keys from the page and delivers nothing", () => {
    const full = run(Array.from({ length: TYPE_AHEAD_MAX }, () => key("x")));
    expect(heldText(full.ahead)).toHaveLength(TYPE_AHEAD_MAX);
    const over = holdKey(full.ahead, key("j"));
    expect(over && over !== "end" && over.swallow, "j would have walked the stage").toBe(true);
    expect(over && over !== "end" && heldText(over.ahead)).toBe("");
  });
});

describe("a real keydown", () => {
  // A KeyboardEvent's fields are getters on its prototype, not its own: a
  // hold that spread one read every field as undefined, threw on the first
  // key, and let every letter through to the deck's shortcuts (the hands-on
  // run, after the plain objects above had all passed).
  class Keydown {
    #init: HeldKeyEvent;
    constructor(init: HeldKeyEvent) { this.#init = init; }
    get key() { return this.#init.key; }
    get code() { return this.#init.code ?? ""; }
    get ctrlKey() { return this.#init.ctrlKey; }
    get shiftKey() { return this.#init.shiftKey ?? false; }
    get metaKey() { return this.#init.metaKey; }
    get altKey() { return this.#init.altKey; }
    get repeat() { return this.#init.repeat ?? false; }
    get isComposing() { return this.#init.isComposing ?? false; }
    get keyCode() { return this.#init.keyCode ?? 0; }
    getModifierState(m: string) { return this.#init.getModifierState?.(m) ?? false; }
  }
  const real = (k: string, extra: Partial<HeldKeyEvent> = {}) => new Keydown(key(k, extra)) as unknown as HeldKeyEvent;

  it("is read through its getters", () => {
    expect(Object.keys(real("a")), "nothing of its own to spread").toEqual([]);
    expect(typed([real("h"), real("i"), real("Enter", { shiftKey: true }), real("Enter")])).toBe(`hi${SHIFT_ENTER_INPUT}\r`);
    expect(typed([real("Enter"), real("Enter", { repeat: true })])).toBe("\r");
    expect(holdKey(startTypeAhead(0), real("X", { ctrlKey: true, shiftKey: true, code: "KeyX" })), "the release chord").toBe("end");
    expect(typed([real("@", { ctrlKey: true, altKey: true, getModifierState: m => m === "AltGraph" })])).toBe("@");
  });
});

describe("where the hold has no say", () => {
  it("in a field, a select or an editor", () => {
    for (const el of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
      expect(typesItself(el as unknown as Element), el.tagName).toBe(true);
    }
  });

  it("but on the body, a card, a button and the pane's own textarea it has", () => {
    const pane = { tagName: "TEXTAREA", classList: { contains: (c: string) => c === "xterm-helper-textarea" } };
    expect(isPaneInput(pane as unknown as Element)).toBe(true);
    for (const el of [null, { tagName: "BODY" }, { tagName: "BUTTON" }, pane]) expect(typesItself(el as unknown as Element)).toBe(false);
  });
});
