// A click on a card under reduced motion holds its camera jump until a
// double-click can no longer follow (focus-hold.ts). Pressing `g` inside that
// window opened the git view, which framed the camera for the card — and then
// the held jump landed on top of it: measured on the fixture board at
// 1440×900, the frame at 0.28 was replaced 130 ms later by the click's jump to
// 0.8, so the canvas beside the open view showed one card and nothing of its
// session. Animated, the view's frame cuts the click's move short and wins.
//
// A camera move the git view makes on purpose — its frame, and the camera it
// gives back as it closes — now drops every jump still held, so both settings
// end on the same camera.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cancelHeldFocus, createFocusHold, DOUBLE_CLICK_MS } from "../focus-hold";

const view = readFileSync(fileURLToPath(new URL("../components/GitView.tsx", import.meta.url)), "utf8");

/** A clock the test turns by hand. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => { const h = next++; due.set(h, { at: now + ms, fn }); return h; },
    clearTimeout: (h: number) => { due.delete(h); },
    advance(ms: number) {
      now += ms;
      for (const [h, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        due.delete(h);
        t.fn();
      }
    },
    pending: () => due.size,
  };
}

function hold() {
  const clock = fakeTimers();
  const focused: string[] = [];
  const h = createFocusHold({ focus: id => focused.push(id), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  return { h, clock, focused };
}

describe("a camera move the deck makes while a click's jump is held", () => {
  it("drops the jump, on every hold that has one waiting", () => {
    const card = hold();
    const name = hold();
    card.h.hold("card-a");
    name.h.hold("session-b");
    cancelHeldFocus();
    card.clock.advance(DOUBLE_CLICK_MS * 2);
    name.clock.advance(DOUBLE_CLICK_MS * 2);
    expect(card.focused).toEqual([]);
    expect(name.focused).toEqual([]);
    expect(card.clock.pending()).toBe(0);
    expect(name.clock.pending()).toBe(0);
  });

  it("leaves a click made after it to land as ever", () => {
    const { h, clock, focused } = hold();
    h.hold("card-a");
    cancelHeldFocus();
    h.hold("card-b");
    clock.advance(DOUBLE_CLICK_MS);
    expect(focused).toEqual(["card-b"]);
  });

  it("does nothing to a jump that has already landed, or when none is held", () => {
    const { h, clock, focused } = hold();
    cancelHeldFocus();
    h.hold("card-a");
    clock.advance(DOUBLE_CLICK_MS);
    cancelHeldFocus();
    expect(focused).toEqual(["card-a"]);
    h.hold("card-b");
    clock.advance(DOUBLE_CLICK_MS);
    expect(focused).toEqual(["card-a", "card-b"]);
  });

  it("is what the git view does before its frame and before it gives the camera back", () => {
    expect(view).toContain('import { cancelHeldFocus } from "../focus-hold";');
    expect(view).toMatch(/cancelHeldFocus\(\);\n(?:\s*\/\/.*\n)*\s*framedEpoch\.current = moveCamera\(plan\.viewport, duration\);/);
    expect(view).toMatch(/cancelHeldFocus\(\);\n\s+restoring\.current = \{ to: savedViewport\.current, epoch: moveCamera\(savedViewport\.current, duration\) \};/);
  });
});
