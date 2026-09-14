// #845: D with nothing selected flipped a hidden flag and showed nothing.
//
// The detail panel renders only beside a selection (`detailOpen && selected`),
// so the key toggled `detailOpen` into a state with no visible effect: it
// looked broken, and the next card clicked then opened the panel by surprise —
// or, pressed twice, did not. Since #814 selecting opens the panel, so D with
// nothing selected now selects first: the session that has waited longest, the
// one the "N waiting" button would jump to, or else the card j would land on.
// Read as text, the way details-on-select-814.test.ts reads App.tsx.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blockedSessions } from "../ambient-counts";
import type { AgentNodeData } from "../types";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const appCode = app
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

/** The block the D key runs, from its `if` to the brace that closes it. */
function dBlock(): string {
  const opening = 'if (e.key === "d" || e.key === "D") {';
  const at = appCode.indexOf(opening);
  if (at < 0) throw new Error("d-without-selection-845: D no longer opens a block");
  let depth = 0;
  for (let i = at + opening.length - 1; i < appCode.length; i++) {
    if (appCode[i] === "{") depth++;
    else if (appCode[i] === "}" && --depth === 0) return appCode.slice(at, i + 1);
  }
  throw new Error("d-without-selection-845: unbalanced D block");
}

describe("D with nothing selected picks something first (#845)", () => {
  const block = dBlock();

  it("still toggles the panel when an agent is selected", () => {
    expect(block).toMatch(/if \(primarySelectedIdRef\.current\) setDetailOpen\(o => !o\);/);
  });

  it("goes to the session that has waited longest, as the waiting button does", () => {
    expect(block).toMatch(/blockedSessions\(stateRef\.current\.agents\.values\(\)\)/);
    expect(block).toMatch(/focusSession\(waiting\[0\]\.id\)/);
    // The button's click is a block since #825, which has it tell W where it
    // went; where it goes is unchanged.
    expect(appCode).toMatch(/waitingCursorRef\.current = waitingSessions\[0\]\.id;\s*focusSession\(waitingSessions\[0\]\.id\);/);
  });

  it("otherwise lands where j would", () => {
    expect(block).toMatch(/else stepAgent\(1\);/);
  });

  it("re-registers the key handler when focusSession changes", () => {
    expect(appCode).toMatch(/window\.addEventListener\("keydown", onKey\);[\s\S]*?\}, \[[^\]]*\bfocusSession\b[^\]]*\]\);/);
  });

  it("means the longest wait by `waiting[0]`", () => {
    // blockedSessions sorts oldest block first; D leans on that order.
    const root = (id: string, since: number) => ({
      id, kind: "root", label: id, sessionId: id, waiting: { since, kind: "permission", message: "" },
    }) as unknown as AgentNodeData;
    expect(blockedSessions([root("late", 3_000), root("early", 1_000)])[0].id).toBe("early");
  });
});
