// A double-click on a card under reduced motion opened nothing. The click
// goes to the card's session and, under reduced motion, the camera jumps
// rather than travels — so it jumped on the first press, and the second
// landed on the empty canvas or on another card. Measured on a real deck with
// Playwright (`reducedMotion: "reduce"`, a real mouse double-click on each of
// eight cards): one panel opened, on the one card the jump happened to leave
// under the pointer; without reduced motion, all eight.
//
// Under reduced motion the click now selects at once and holds its jump until
// a double-click can no longer follow (focus-hold.ts); the double-click takes
// it over. Without reduced motion nothing changed.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFocusHold, DOUBLE_CLICK_MS } from "../focus-hold";

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

describe("the jump a click holds under reduced motion", () => {
  it("lands once the double-click window has passed, and not before", () => {
    const { h, clock, focused } = hold();
    h.hold("card-a");
    clock.advance(DOUBLE_CLICK_MS - 1);
    expect(focused).toEqual([]);
    clock.advance(1);
    expect(focused).toEqual(["card-a"]);
    expect(clock.pending()).toBe(0);
  });

  it("waits about as long as an animated focus takes to arrive, and no shorter than a common double-click", () => {
    expect(DOUBLE_CLICK_MS).toBeGreaterThanOrEqual(400);
    expect(DOUBLE_CLICK_MS).toBeLessThanOrEqual(600);
  });

  it("is dropped by a cancel — the double-click takes it over", () => {
    const { h, clock, focused } = hold();
    h.hold("card-a");
    clock.advance(150);
    h.cancel();
    clock.advance(DOUBLE_CLICK_MS * 2);
    expect(focused).toEqual([]);
  });

  it("is replaced by a newer click, which waits its own full window", () => {
    const { h, clock, focused } = hold();
    h.hold("card-a");
    clock.advance(300);
    h.hold("card-b");
    clock.advance(DOUBLE_CLICK_MS - 1);
    expect(focused).toEqual([]);
    clock.advance(1);
    expect(focused).toEqual(["card-b"]);
  });

  it("swallows a card that left the board in the meantime, and a cancel with nothing held", () => {
    const clock = fakeTimers();
    const h = createFocusHold({ focus: () => { throw new Error("gone"); }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    h.cancel();
    h.hold("card-a");
    expect(() => clock.advance(DOUBLE_CLICK_MS)).not.toThrow();
  });
});

// The handlers are React Flow's props, read as text the way
// details-on-select-814.test.ts reads them.
const clicks = readFileSync(fileURLToPath(new URL("../use-canvas-clicks.ts", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
const handler = (name: string) => {
  const at = clicks.indexOf(`const ${name} = `);
  if (at < 0) throw new Error(`no ${name} in use-canvas-clicks.ts`);
  const end = clicks.indexOf("\n  };", at);
  return clicks.slice(at, end < 0 ? undefined : end);
};

describe("the canvas's clicks under reduced motion", () => {
  it("holds a plain click's jump under reduced motion, and moves as before otherwise", () => {
    const click = handler("onNodeClick");
    expect(click).toMatch(/if \(e\.shiftKey\) return;[\s\S]*if \(prefersReducedMotion\(\)\) \{\s*focusHold\.hold\(id\);\s*\} else if \(detailShown\) \{\s*window\.setTimeout\(\(\) => \{ try \{ focusAgent\(id\); \} catch \{\} \}, 80\);\s*\} else \{\s*focusAgent\(id\);\s*\}/);
    // A Shift+click widens the selection and leaves a held jump alone.
    expect(click.slice(click.indexOf("const id = "), click.indexOf("if (e.shiftKey) return;"))).not.toContain("focusHold.");
  });

  it("lets the double-click take the held jump over before it selects", () => {
    expect(handler("onNodeDoubleClick")).toMatch(/focusHold\.cancel\(\);\s*const id = [^\n]*\n\s*selectAgent\(id, false\);/);
  });

  it("drops the held jump with the selection it was for", () => {
    expect(handler("onPaneClick")).toMatch(/focusHold\.cancel\(\);[^\n]*clearSelection\(\);/);
    expect(handler("onNodeClick")).toMatch(/if \(n\.type === "sessionGroup"\) \{ focusHold\.cancel\(\); clearSelection\(\); return; \}/);
  });

  it("makes the hold once, reads the newest focusAgent when it fires, and drops it with the canvas", () => {
    expect(clicks).toMatch(/const \[focusHold\] = useState\(\(\) => createFocusHold\(\{/);
    expect(clicks).toMatch(/focusRef\.current = focusAgent;/);
    expect(clicks).toMatch(/useEffect\(\(\) => \(\) => focusHold\.cancel\(\), \[focusHold\]\);/);
  });
});
