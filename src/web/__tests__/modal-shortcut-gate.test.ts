// Every single-key shortcut except `c` fired while a modal was open.
//
// The handler's gate asks the focused element whether it owns the keystroke.
// That is right for a text field and wrong for a dialog: use-modal-dismiss.ts
// states outright that "clicking a paragraph of modal text drops focus on
// `<body>`", and BODY is in neither KEY_OWNING_TAGS nor KEY_OWNING_ROLES. So
// opening a tool call, clicking its JSON payload to read it, and pressing a
// letter ran that letter against the canvas behind the scrim.
//
// R is the one that hurt. handleRelayout clears every pin, every stored
// position and both localStorage keys — the hand-built arrangement is gone with
// no undo, and the user does not see it happen until they close the modal. On
// the same press H stacked a second modal over the first, Space paused the
// stream, and A/U/L opened panels underneath.
//
// The rule was not new. App.tsx's own comment above modalOpenRef describes this
// exact focus path and was written for `c`; what was missing is that the ref had
// exactly one caller.
import { describe, it, expect } from "vitest";
import { shortcutBlocked } from "../shortcuts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CANVAS_KEYS = [" ", "c", "r", "f", "l", "h", "u", "a", "j", "k", "t", "m"];

describe("a canvas shortcut while a modal is open", () => {
  it("is blocked for every key that acts on what the scrim is covering", () => {
    for (const key of CANVAS_KEYS) {
      expect(shortcutBlocked({ key, modalOpen: true, sheetOpen: false }), key).toBe(true);
      expect(shortcutBlocked({ key, modalOpen: true, sheetOpen: true }), key).toBe(true);
    }
  });

  it("is not blocked when no modal is up, which is the ordinary case", () => {
    for (const key of CANVAS_KEYS) {
      expect(shortcutBlocked({ key, modalOpen: false, sheetOpen: false }), key).toBe(false);
    }
  });

  it("lets `?` close the sheet it opened", () => {
    // The one exception, and it is narrow: `?` is advertised as a toggle, so it
    // has to be able to close what it opened.
    expect(shortcutBlocked({ key: "?", modalOpen: true, sheetOpen: true })).toBe(false);
  });

  it("does not let `?` stack a second modal over somebody else's", () => {
    // Over a tool modal or the usage history, `?` would open the sheet on top of
    // it — two dialogs competing for one Escape, which is the thing the gate
    // exists to prevent.
    expect(shortcutBlocked({ key: "?", modalOpen: true, sheetOpen: false })).toBe(true);
    expect(shortcutBlocked({ key: "?", modalOpen: false, sheetOpen: false })).toBe(false);
  });
});

describe("the handler actually consults it", () => {
  // The rule is pure and tested above; this is the half that cannot be — that
  // App.tsx asks the question at all, and asks it BEFORE the key table rather
  // than after it.
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const handler = app.slice(
    app.indexOf("const onKey = (e: KeyboardEvent) => {"),
    app.indexOf('window.addEventListener("keydown", onKey);'),
  );

  it("gates the key table on shortcutBlocked", () => {
    expect(handler).toContain("shortcutBlocked({");
    expect(handler.indexOf("shortcutBlocked({"))
      .toBeLessThan(handler.indexOf('e.key === " "'));
  });

  it("still has a key table to gate, so this is not vacuous", () => {
    expect(handler).toContain('e.key === "r" || e.key === "R"');
    expect(handler).toContain("handleRelayout()");
  });
});
