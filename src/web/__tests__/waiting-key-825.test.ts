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

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

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
    expect(app).toMatch(/click, or press W, to go to the one that has been stuck longest/);
  });

  it("lists W in the sheet", () => {
    const row = KEY_HELP.flatMap(g => g.rows).find(r => r.cap === "W");
    expect(row, "no W row in the keyboard sheet").toBeTruthy();
    expect(row!.binds).toEqual(["w", "W"]);
    expect(row!.action).toMatch(/waiting on you/);
  });
});
