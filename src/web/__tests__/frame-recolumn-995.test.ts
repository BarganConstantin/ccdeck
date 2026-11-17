// #995 re-columned the board whenever the frame a fit shows it in changed
// enough to change the column count: closing the accounts and usage panels on
// a 1280px window took the frame from 457.5 to 963.2 units, and a board packed
// as one strip for the first stayed a strip in the second until R.
//
// CHANGED ON PURPOSE (V4 critique, round 2). The whole board now flows into its
// columns on a fresh board's first layout and on R — never on a panel opening
// or closing or a window resize. Re-columning
// on the frame moved every session under the reader's eye: selecting a card
// opens the Inspector, the Inspector narrows the canvas, and the card that was
// just pressed went to another column. What a frame change does now is frame
// the board again; v4-board-columns.test.ts pins the flow itself, and
// frame-resize-camera.test.ts runs the reframe.
//
// No DOM: what is pinned is which code may move a card.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as layout from "../layout";

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
const app = read("App.tsx");
const reframe = read("use-reframe.ts");

describe("a frame change frames the board again and moves no card", () => {
  it("asks no question about columns any more", () => {
    expect("columnsWouldChange" in layout).toBe(false);
    expect(reframe).not.toMatch(/columnsWouldChange/);
  });

  it("throws no position away and schedules no rebuild", () => {
    // What the old effect did to re-column: emptied the cached positions and
    // moved the epoch the board memo lists.
    expect(reframe).not.toMatch(/positionsRef/);
    expect(reframe).not.toMatch(/setLayoutEpoch/);
    expect(reframe).not.toMatch(/saveLayout\(/);
    // And it still fits, which is the half of the old effect that stays.
    expect(reframe).toMatch(/fitLeft\(\)/);
    expect(app).toMatch(/\buseReframe\(\{/);
  });

  it("remembers the frame across a reload, so a deck reopened in another window is framed for it", () => {
    const storage = read("layout-storage.ts");
    expect(storage.includes('const LAYOUT_FRAME_KEY = "agent-dag.layoutFrame"'), "the frame the board was shown in is not persisted").toBe(true);
    const layoutState = read("use-board-layout.ts");
    expect(/useRef<Frame \| null>\(restoredLayoutFrame\)/.test(layoutState), "the restored frame does not seed the reframe comparison").toBe(true);
    expect(/const restoredLayoutFrame = useState\(loadLayoutFrame\)\[0\]/.test(layoutState), "the stored frame is not read through a lazy initialiser (#612)").toBe(true);
    expect(reframe, "the reframe no longer reads the frame from the layout it is handed").toMatch(/const \{[^}]*\blastLayoutFrameRef\b[^}]*\} = layout;/);
    // And it goes when the layout it describes goes.
    const cleared = /function clearStoredLayout\(\): void \{[\s\S]*?\n\}/.exec(storage);
    expect(cleared, "clearStoredLayout is gone from layout-storage.ts").not.toBeNull();
    expect(cleared![0]).toMatch(/removeStored\(LAYOUT_FRAME_KEY\)/);
  });
});
