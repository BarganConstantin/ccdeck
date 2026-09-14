// #851: after any mouse click on a topbar or panel button, every single-key
// shortcut was dead until Esc, with nothing on screen to say so.
//
// A click leaves focus on the button it pressed, and the key handler leaves a
// focused control its own keys — so click `$`, press `L`, and nothing happened.
// Mouse users rarely press Esc first; the keys read as broken exactly when
// somebody mixed mouse and keyboard, which is how the deck is used.
//
// The rule now tells the two arrivals apart. A button the POINTER focused does
// not own a letter; it still owns Space and Enter, the keys that activate it.
// A button reached by Tab keeps every key, as before. The browser cannot be
// asked at keydown time — `:focus-visible` is re-decided by the keystroke
// itself — so App.tsx marks a focus that lands right after a press.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ownsKeystroke } from "../shortcuts";

const button = (pointerFocused: boolean) => ({ tagName: "BUTTON", pointerFocused });

describe("a button the mouse pressed leaves the letters to the deck (#851)", () => {
  it("gives a letter back when the pointer put focus there", () => {
    expect(ownsKeystroke(button(true), "l")).toBe(false);
    expect(ownsKeystroke(button(true), "L")).toBe(false);
    expect(ownsKeystroke({ tagName: "SPAN", role: "button", pointerFocused: true }, "u")).toBe(false);
  });

  it("keeps Space and Enter, which are how the button is pressed", () => {
    expect(ownsKeystroke(button(true), " ")).toBe(true);
    expect(ownsKeystroke(button(true), "Enter")).toBe(true);
  });

  it("keeps every key for a button reached by keyboard", () => {
    expect(ownsKeystroke(button(false), "l")).toBe(true);
    expect(ownsKeystroke({ tagName: "BUTTON" }, "l")).toBe(true);
  });

  it("changes nothing for the controls that really use letters", () => {
    // A <select>'s type-ahead and a text field are why the gate exists: a bare
    // "c" from a dropdown once reached Clear.
    expect(ownsKeystroke({ tagName: "SELECT", pointerFocused: true }, "c")).toBe(true);
    expect(ownsKeystroke({ tagName: "INPUT", type: "text", pointerFocused: true }, "c")).toBe(true);
  });

  it("answers as before when the caller does not say which key", () => {
    expect(ownsKeystroke(button(true))).toBe(true);
  });
});

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const appCode = app
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

describe("the wiring that knows how focus arrived (#851)", () => {
  it("marks a focus that lands right after a pointer press", () => {
    expect(appCode).toMatch(/window\.addEventListener\("pointerdown", onPress, true\)/);
    expect(appCode).toMatch(/window\.addEventListener\("focusin", onFocus, true\)/);
    expect(appCode).toMatch(/pointerFocusRef\.current = performance\.now\(\) - pressedAt < 250 \? e\.target : null;/);
  });

  it("hands the mark and the key to the gate", () => {
    expect(appCode).toMatch(/pointerFocused: el != null && el === pointerFocusRef\.current,/);
    expect(appCode).toMatch(/ownsKeystroke\(target, e\.key\)/);
  });
});
