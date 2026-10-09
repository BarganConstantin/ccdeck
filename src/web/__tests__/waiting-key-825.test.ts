// #825: the most urgent navigation in the product — going to the session that
// is blocked on you — had no key. The "N waiting" button jumped to the oldest
// blocked session by mouse only, J and K walk every agent in position order, and
// the sheet listed nothing for waiting sessions. W goes there now: oldest first,
// and each press after it to the next, wrapping.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nextWaiting, type BlockedSession } from "../ambient-counts";
import { KEY_HELP } from "../key-help";

// The keydown handler moved to use-deck-shortcuts.ts and the waiting button to
// components/TopbarReadouts.tsx; the keys and the rest of the deck are read as one.
const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8")
  + "\n" + readFileSync(fileURLToPath(new URL("../use-deck-shortcuts.ts", import.meta.url)), "utf8")
  + "\n" + readFileSync(fileURLToPath(new URL("../components/TopbarReadouts.tsx", import.meta.url)), "utf8");

/** Oldest first, the order blockedSessions returns. */
const queue = (...ids: string[]) =>
  ids.map(id => ({ id, label: id, waiting: {} }) as unknown as BlockedSession);

describe("which blocked session W goes to (#825)", () => {
  it("goes nowhere when nothing is waiting", () => {
    expect(nextWaiting([], null)).toBeNull();
    expect(nextWaiting([], "s1")).toBeNull();
  });

  it("starts at the one that has waited longest", () => {
    expect(nextWaiting(queue("old", "mid", "new"), null)!.id).toBe("old");
  });

  it("moves on to the next oldest on each press, and wraps", () => {
    const q = queue("old", "mid", "new");
    expect(nextWaiting(q, "old")!.id).toBe("mid");
    expect(nextWaiting(q, "mid")!.id).toBe("new");
    expect(nextWaiting(q, "new")!.id).toBe("old");
  });

  it("starts again at the oldest when the one visited last is no longer blocked", () => {
    expect(nextWaiting(queue("a", "b"), "answered-meanwhile")!.id).toBe("a");
  });
});

describe("W is a key, the button is its twin, and the sheet says so (#825)", () => {
  it("binds W to the next blocked session", () => {
    expect(app).toMatch(/if \(e\.key === "w" \|\| e\.key === "W"\) \{/);
    expect(app).toMatch(/nextWaiting\(blockedSessions\(stateRef\.current\.agents\.values\(\)\), waitingCursorRef\.current\)/);
  });

  it("lets the waiting button set where W moves on from", () => {
    expect(app).toMatch(/waitingCursorRef\.current = waitingSessions\[0\]\.id;\s*focusSession\(waitingSessions\[0\]\.id\);/);
    // W only while W does anything — Settings › General's single-key switch
    // (WCAG 2.1.4). The count used to say "click, or press W" in its title;
    // since the topbar's hint replaced titles (use-hint.tsx) it names W in a
    // keycap and in aria-keyshortcuts, both only while the switch is on, and
    // the click is offered either way. edge-keys-switch.test.ts draws both.
    expect(app).toContain('aria-keyshortcuts={singleKeys ? "W" : undefined}');
    expect(app).toContain('keys: singleKeys ? "W" : undefined');
  });

  it("lets a name in the waiting queue set where W moves on from, in W's own order", () => {
    // The queue names the blocked sessions in blockedSessions() order — the
    // order nextWaiting walks — and a press on one puts W's cursor on it, so
    // the next W goes to the name after it, and the last wraps to the first.
    // A name pressed and a W pressed can never disagree about "next".
    expect(app).toMatch(/const go = \(id: string\) => \{\s*waitingCursorRef\.current = id;\s*focusSession\(id\);\s*\};/);
    expect(app).toMatch(/const named = waitingSessions\.slice\(0, fit\);/);
    expect(app).toMatch(/\{named\.map\(w => \([\s\S]{0,200}?onClick=\{\(\) => go\(w\.id\)\}/);
    const q = queue("old", "mid", "new");
    for (const [pressed, then] of [["old", "mid"], ["mid", "new"], ["new", "old"]]) {
      expect(nextWaiting(q, pressed)!.id, `W after a press on ${pressed}`).toBe(then);
    }
  });

  it("lists W in the sheet", () => {
    const row = KEY_HELP.flatMap(g => g.rows).find(r => r.cap === "W");
    expect(row, "no W row in the keyboard sheet").toBeTruthy();
    expect(row!.binds).toEqual(["w", "W"]);
    expect(row!.action).toMatch(/waiting on you/);
  });
});
