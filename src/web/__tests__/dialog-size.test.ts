// A tracker dialog's size (integrations/dialog-size.ts): the default, the
// limits, what a window change does to a remembered size, a drag on each edge
// and corner, a keyboard step, the Size menu's presets, and the memory per
// provider. Plain arithmetic, so it is called directly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  centredRect, chosenFor, clampSize, defaultSize, DIALOG_CAP, DIALOG_MIN, dragRect, edgeSides, EDGES, keepInRoom, largestSize, offsetOf,
  presetOf, readChosenSize, rectOf, shownSize, sizeProperties, smallestSize, stepRect, writeChosenSize, type Rect,
} from "../integrations/dialog-size";

const desk = { width: 1440, height: 900 };
const wide = { width: 2560, height: 1440 };
const small = { width: 1024, height: 640 };

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("the default size", () => {
  it("is 88% of the window each way", () => {
    expect(defaultSize(desk)).toEqual({ width: 1267, height: 792 });
    expect(defaultSize(small)).toEqual({ width: 901, height: 563 });
  });

  it("never passes 1680 x 1120", () => {
    expect(defaultSize(wide)).toEqual({ width: 1680, height: 1120 });
    expect(defaultSize({ width: 5120, height: 2880 })).toEqual(DIALOG_CAP);
  });

  it("stays at least 720 x 480 while the window has room for it", () => {
    // 88 % of 800 x 520 is 704 x 458: under the floor.
    expect(defaultSize({ width: 800, height: 560 })).toEqual({ width: 720, height: 493 });
    expect(defaultSize({ width: 800, height: 520 })).toEqual({ width: 720, height: 480 });
  });

  it("opens centred, under the desktop app's title bar when there is one", () => {
    expect(centredRect({ width: 1267, height: 792 }, desk)).toEqual({ width: 1267, height: 792, left: 86.5, top: 54 });
    expect(centredRect({ width: 1267, height: 792 }, { ...desk, top: 40 })).toEqual({ width: 1267, height: 792, left: 86.5, top: 74 });
  });
});

describe("the limits", () => {
  it("are 720 x 480 at least and the window less 16 a side at most", () => {
    expect(smallestSize(desk)).toEqual(DIALOG_MIN);
    expect(largestSize(desk)).toEqual({ width: 1408, height: 868 });
    expect(largestSize({ ...desk, top: 40 })).toEqual({ width: 1408, height: 828 });
    expect(clampSize({ width: 100, height: 100 }, desk)).toEqual({ width: 720, height: 480 });
    expect(clampSize({ width: 5000, height: 5000 }, desk)).toEqual({ width: 1408, height: 868 });
    expect(clampSize({ width: NaN, height: Infinity }, desk)).toEqual({ width: 720, height: 480 });
  });

  it("give way to a window smaller than the floor: the dialog shrinks with it", () => {
    expect(smallestSize({ width: 600, height: 400 })).toEqual({ width: 568, height: 368 });
    expect(clampSize({ width: 900, height: 600 }, { width: 600, height: 400 })).toEqual({ width: 568, height: 368 });
  });

  it("keep the whole dialog in the window, so the header, its × and the toolbar stay in view", () => {
    expect(keepInRoom({ left: -50, top: -50, width: 1000, height: 700 }, desk)).toEqual({ left: 16, top: 16, width: 1000, height: 700 });
    expect(keepInRoom({ left: 1000, top: 600, width: 1000, height: 700 }, desk)).toEqual({ left: 424, top: 184, width: 1000, height: 700 });
    expect(keepInRoom({ left: 100, top: 0, width: 1000, height: 700 }, { ...desk, top: 40 }).top).toBe(56);
  });
});

describe("a window that changes size", () => {
  it("shrinks a remembered size with it and gives it back when the window grows", () => {
    const chosen = { width: 1600, height: 1000 };
    expect(shownSize(chosen, wide)).toEqual(chosen);
    expect(shownSize(chosen, small)).toEqual({ width: 992, height: 608 });
    expect(shownSize(chosen, wide)).toEqual(chosen);
  });

  it("follows the window with the default, and fills it with Fill the window", () => {
    expect(shownSize(null, small)).toEqual(defaultSize(small));
    expect(shownSize(null, wide)).toEqual(defaultSize(wide));
    expect(shownSize("fill", desk)).toEqual(largestSize(desk));
    expect(shownSize("fill", small)).toEqual({ width: 992, height: 608 });
  });
});

describe("the place", () => {
  it("is an offset from the centre that comes back to the same rect", () => {
    const rect: Rect = { left: 100, top: 50, width: 1000, height: 700 };
    const offset = offsetOf(rect, desk);
    expect(offset).toEqual({ x: -120, y: -50 });
    expect(rectOf(rect, offset, desk)).toEqual(rect);
    expect(rectOf({ width: 1000, height: 700 }, null, desk)).toEqual({ width: 1000, height: 700, left: 220, top: 100 });
  });
});

describe("a drag on an edge or a corner", () => {
  const start: Rect = { left: 200, top: 100, width: 1000, height: 700 }; // right 1200, bottom 800
  const right = (r: Rect) => r.left + r.width;
  const bottom = (r: Rect) => r.top + r.height;

  it("moves the east edge and keeps the west one", () => {
    const r = dragRect(start, "e", 100, 40, desk);
    expect(r).toEqual({ left: 200, top: 100, width: 1100, height: 700 });
    expect(right(dragRect(start, "e", 1000, 0, desk))).toBe(1424);
    expect(dragRect(start, "e", -500, 0, desk).width).toBe(720);
  });

  it("moves the west edge and keeps the east one", () => {
    const r = dragRect(start, "w", -100, 40, desk);
    expect(r).toEqual({ left: 100, top: 100, width: 1100, height: 700 });
    expect(right(r)).toBe(1200);
    const far = dragRect(start, "w", -1000, 0, desk);
    expect([far.left, right(far)]).toEqual([16, 1200]);
    const narrow = dragRect(start, "w", 500, 0, desk);
    expect([narrow.width, right(narrow)]).toEqual([720, 1200]);
  });

  it("moves the north edge and keeps the south one", () => {
    const r = dragRect(start, "n", 40, -50, desk);
    expect(r).toEqual({ left: 200, top: 50, width: 1000, height: 750 });
    const far = dragRect(start, "n", 0, -500, desk);
    expect([far.top, bottom(far)]).toEqual([16, 800]);
    const short = dragRect(start, "n", 0, 400, desk);
    expect([short.height, bottom(short)]).toEqual([480, 800]);
    // Under the desktop app's title bar, the top stops below it.
    expect(dragRect(start, "n", 0, -500, { ...desk, top: 40 }).top).toBe(56);
  });

  it("moves the south edge and keeps the north one", () => {
    expect(dragRect(start, "s", 40, 50, desk)).toEqual({ left: 200, top: 100, width: 1000, height: 750 });
    expect(bottom(dragRect(start, "s", 0, 500, desk))).toBe(884);
  });

  it("moves both of a corner's edges and keeps the opposite corner", () => {
    expect(dragRect(start, "se", 100, 50, desk)).toEqual({ left: 200, top: 100, width: 1100, height: 750 });
    const nw = dragRect(start, "nw", -100, -50, desk);
    expect(nw).toEqual({ left: 100, top: 50, width: 1100, height: 750 });
    expect([right(nw), bottom(nw)]).toEqual([1200, 800]);
    const ne = dragRect(start, "ne", 100, -50, desk);
    expect(ne).toEqual({ left: 200, top: 50, width: 1100, height: 750 });
    expect(bottom(ne)).toBe(800);
    const sw = dragRect(start, "sw", -100, 50, desk);
    expect(sw).toEqual({ left: 100, top: 100, width: 1100, height: 750 });
    expect(right(sw)).toBe(1200);
  });

  it("names the sides it moves the way the sheet reads them", () => {
    expect(EDGES).toHaveLength(8);
    expect(edgeSides("se")).toBe("s e");
    expect(edgeSides("nw")).toBe("n w");
    expect(edgeSides("e")).toBe("e");
  });
});

describe("a keyboard step", () => {
  const rect: Rect = { left: 200, top: 100, width: 1000, height: 700 };

  it("grows with Right and Down and shrinks with Left and Up, by 32 about the centre", () => {
    expect(stepRect(rect, "ArrowRight", false, desk)).toEqual({ left: 184, top: 100, width: 1032, height: 700 });
    expect(stepRect(rect, "ArrowLeft", false, desk)).toEqual({ left: 216, top: 100, width: 968, height: 700 });
    expect(stepRect(rect, "ArrowDown", false, desk)).toEqual({ left: 200, top: 84, width: 1000, height: 732 });
    expect(stepRect(rect, "ArrowUp", false, desk)).toEqual({ left: 200, top: 116, width: 1000, height: 668 });
  });

  it("steps 128 with Shift", () => {
    expect(stepRect(rect, "ArrowRight", true, desk)).toEqual({ left: 136, top: 100, width: 1128, height: 700 });
  });

  it("stops at the limits and stays in the window", () => {
    expect(stepRect({ left: 16, top: 16, width: 1408, height: 868 }, "ArrowRight", false, desk)?.width).toBe(1408);
    expect(stepRect({ left: 300, top: 200, width: 720, height: 480 }, "ArrowUp", true, desk)?.height).toBe(480);
    expect(stepRect({ left: 16, top: 16, width: 1000, height: 700 }, "ArrowRight", true, desk)?.left).toBe(16);
  });

  it("answers no other key", () => {
    for (const key of ["Enter", "Escape", "Tab", "a", " ", "Home"]) expect(stepRect(rect, key, false, desk)).toBeNull();
  });
});

describe("the Size menu's sizes", () => {
  it("knows which one is on", () => {
    expect(presetOf(null)).toBe("default");
    expect(presetOf("fill")).toBe("fill");
    expect(presetOf({ width: 720, height: 480 })).toBe("smaller");
    expect(presetOf({ width: 800, height: 600 })).toBeNull();
  });

  it("remembers the default as nothing, so it follows the window", () => {
    expect(chosenFor("default")).toBeNull();
    expect(chosenFor("fill")).toBe("fill");
    expect(chosenFor("smaller")).toEqual({ width: 720, height: 480 });
  });

  it("hands the sheet the chosen size and the offset, and nothing for the default", () => {
    expect(sizeProperties(null, null)).toEqual({});
    expect(sizeProperties({ width: 900, height: 600 }, null)).toEqual({ "--ig-w": "900px", "--ig-h": "600px" });
    expect(sizeProperties("fill", { x: 5, y: -6 })).toEqual({ "--ig-w": "100vw", "--ig-h": "100dvh", "--ig-x": "5px", "--ig-y": "-6px" });
    expect(sizeProperties(null, { x: 0, y: 12 })).toEqual({ "--ig-x": "0px", "--ig-y": "12px" });
  });
});

describe("the memory", () => {
  const key = (kind: string) => `agent-dag.integrations.${kind}.dialog-size`;

  it("is per provider and per browser", () => {
    expect(readChosenSize("jira")).toBeNull();
    writeChosenSize("jira", { width: 900.4, height: 600.6 });
    expect(store.get(key("jira"))).toBe('{"width":900,"height":601}');
    expect(readChosenSize("jira")).toEqual({ width: 900, height: 601 });
    expect(readChosenSize("gitlab")).toBeNull();
    writeChosenSize("gitlab", "fill");
    expect(store.get(key("gitlab"))).toBe('"fill"');
    expect(readChosenSize("gitlab")).toBe("fill");
    expect(readChosenSize("jira")).toEqual({ width: 900, height: 601 });
  });

  it("forgets the size on Reset, back to the default", () => {
    writeChosenSize("jira", { width: 900, height: 600 });
    writeChosenSize("jira", null);
    expect(store.has(key("jira"))).toBe(false);
    expect(readChosenSize("jira")).toBeNull();
  });

  it("reads anything it did not write as the default", () => {
    for (const raw of ["not json", '{"width":-1,"height":5}', '{"width":"900","height":600}', "[1,2]", '"big"', '{"width":200000,"height":500}', "null", "7"]) {
      store.set(key("jira"), raw);
      expect(readChosenSize("jira")).toBeNull();
    }
  });

  it("costs nothing where the browser refuses its store", () => {
    vi.stubGlobal("window", { get localStorage(): Storage { throw new Error("blocked"); } });
    expect(readChosenSize("jira")).toBeNull();
    expect(() => writeChosenSize("jira", { width: 900, height: 600 })).not.toThrow();
    expect(() => writeChosenSize("jira", null)).not.toThrow();
  });
});
