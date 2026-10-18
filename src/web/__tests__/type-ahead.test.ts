// The keys typed before the pane can take them (type-ahead.ts): what a hold
// keeps, as the program would have been sent it, and what it leaves to the
// deck — a chord, Tab, the arrows, an input method's keys, a field's typing.
import { describe, expect, it } from "vitest";
import { TYPE_AHEAD_MAX, TYPE_AHEAD_MS, holdKey, startTypeAhead, typesItself, type HeldKeyEvent } from "../type-ahead";

const key = (k: string, extra: Partial<HeldKeyEvent> = {}): HeldKeyEvent => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...extra });
const run = (keys: HeldKeyEvent[]) => keys.reduce((a, e) => { const n = holdKey(a, e); return n && n !== "end" ? n : a; }, startTypeAhead(0));

describe("a hold", () => {
  it("waits TYPE_AHEAD_MS from the press, holding nothing yet", () => {
    expect(startTypeAhead(1000)).toEqual({ text: "", until: 1000 + TYPE_AHEAD_MS });
  });

  it("keeps characters, Enter and Backspace as xterm sends them", () => {
    expect(run([key("l"), key("S"), key(" "), key("ö"), key("😀"), key("Enter"), key("Backspace")]).text).toBe("lS ö😀\r\x7f");
  });

  it("keeps what AltGr types, which is not a chord", () => {
    const altGr = key("@", { ctrlKey: true, altKey: true, getModifierState: m => m === "AltGraph" });
    expect(run([altGr]).text).toBe("@");
  });

  it("ends on Esc", () => {
    expect(holdKey(startTypeAhead(0), key("Escape"))).toBe("end");
  });

  it("leaves every other key as it was", () => {
    const a = startTypeAhead(0);
    for (const e of [
      key("c", { ctrlKey: true }), key("k", { metaKey: true }), key("b", { altKey: true }), key("Tab"), key("ArrowLeft"),
      key("F1"), key("Shift"), key("Dead"), key("a", { isComposing: true }), key("Process", { keyCode: 229 }),
    ]) expect(holdKey(a, e), e.key).toBeNull();
  });

  it("holds a burst, not a paste", () => {
    const full = run(Array.from({ length: TYPE_AHEAD_MAX }, () => key("x")));
    expect(full.text).toHaveLength(TYPE_AHEAD_MAX);
    expect(holdKey(full, key("y"))).toBeNull();
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
    for (const el of [null, { tagName: "BODY" }, { tagName: "BUTTON" }, pane]) expect(typesItself(el as unknown as Element)).toBe(false);
  });
});
