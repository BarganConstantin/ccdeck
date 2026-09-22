// #1174: the stored canvas layout, read and written.
//
// Every reload restores the board through this string, and until #1174 the
// parse, the v1 migration and the save merge lived inside App.tsx where no test
// could call them — only source pins named the functions. Flipping the v1/v2
// check, losing the pins when the field is absent, writing the pinned positions
// before the auto ones or tightening the entry filter all shipped green, and
// each one ends the same way: a hand-arranged board comes back with its dragged
// cards snapped to dagre's positions and nothing on screen saying why.
//
// These pin the pure half in stored-layout.ts, and pin App.tsx to reading and
// writing the keys through it, so neither half can be dropped on its own.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseLayoutFrame, parseStoredLayout, restoreLayout, serializeLayout } from "../stored-layout";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

const at = (entries: Array<[string, number, number]>) =>
  new Map(entries.map(([id, x, y]) => [id, { x, y }]));

describe("parseStoredLayout", () => {
  it("reads a v1 map of drags as all-pinned, so an upgrade keeps the arrangement", () => {
    // v1 stored only what the user dragged. Reading it as unpinned would hand
    // every one of those cards back to dagre on the first load after upgrading.
    const out = parseStoredLayout('{"n1":{"x":10,"y":20},"n2":{"x":"a","y":0}}');
    expect(out.positions).toEqual([["n1", { x: 10, y: 20 }]]);
    expect(out.pins).toEqual(["n1"]);   // and n2, with no numeric x, is dropped
  });

  it("reads v2's positions and pins, and pins only what the pins list names", () => {
    const out = parseStoredLayout('{"v":2,"positions":{"a":{"x":1,"y":2},"b":{"x":3,"y":4}},"pins":["b"]}');
    expect(out.positions).toEqual([["a", { x: 1, y: 2 }], ["b", { x: 3, y: 4 }]]);
    expect(out.pins).toEqual(["b"]);
    const restored = restoreLayout(out);
    expect([...restored.positions.keys()]).toEqual(["a", "b"]);
    expect([...restored.pinned]).toEqual([["b", { x: 3, y: 4 }]]);
  });

  it("drops the v2 entries that are not points", () => {
    const out = parseStoredLayout('{"v":2,"positions":{"a":{"x":1,"y":2},"b":{"x":1},"c":null,"d":{"x":1,"y":"2"}},"pins":[]}');
    expect(out.positions).toEqual([["a", { x: 1, y: 2 }]]);
  });

  it("reads a v2 pins field that is not a list as no pins, and missing positions as none", () => {
    expect(parseStoredLayout('{"v":2,"positions":{"b":{"x":3,"y":4}},"pins":"b"}').pins).toEqual([]);
    expect(parseStoredLayout('{"v":2,"positions":{"b":{"x":3,"y":4}}}').pins).toEqual([]);
    expect(parseStoredLayout('{"v":2,"pins":["b"]}').positions).toEqual([]);
  });

  it("reads anything that is not a layout as an empty one, without throwing", () => {
    // App reads this inside a useState initialiser, and src/web has no error
    // boundary: a throw here is a blank deck, not a lost arrangement.
    for (const raw of [null, "", "not json", "null", "5", "[]", '"x"']) {
      expect(() => parseStoredLayout(raw), String(raw)).not.toThrow();
      expect(parseStoredLayout(raw), String(raw)).toEqual({ positions: [], pins: [] });
    }
  });
});

describe("serializeLayout", () => {
  it("writes v2, with a drag winning over the layout's position for the same card", () => {
    // Both maps can hold the same id: the layout pass computed a position for
    // a card the user then dragged. The drag is the one that has to come back.
    const json = JSON.parse(serializeLayout(at([["a", 0, 0]]), at([["a", 50, 60]])));
    expect(json.v).toBe(2);
    expect(json.positions.a).toEqual({ x: 50, y: 60 });
    expect(json.pins).toEqual(["a"]);
  });

  it("round-trips through the parse and the restore to the maps it was given", () => {
    const positions = at([["a", 0, 0], ["b", 10, 20], ["c", 30, 40]]);
    const pinned = at([["b", 99, 98], ["d", 5, 6]]);   // d was dragged and never laid out
    const back = restoreLayout(parseStoredLayout(serializeLayout(positions, pinned)));
    expect(back.pinned).toEqual(pinned);
    expect(back.positions).toEqual(at([["a", 0, 0], ["b", 99, 98], ["c", 30, 40], ["d", 5, 6]]));
  });
});

describe("parseLayoutFrame", () => {
  it("hands back a frame with a positive width and height", () => {
    expect(parseLayoutFrame('{"width":800,"height":600}')).toEqual({ width: 800, height: 600 });
  });

  it("reads anything else as no frame, which the reframe effect compares nothing against", () => {
    // A frame of zero is "not measured yet", not "a frame that wants one
    // column" (#995): reading one as real would recolumn the board against it.
    for (const raw of [
      '{"width":0,"height":600}', '{"width":-1,"height":600}', '{"width":"800","height":600}',
      '{"width":800}', "garbage", "null", null, "",
    ]) {
      expect(parseLayoutFrame(raw), String(raw)).toBeNull();
    }
  });
});

describe("App.tsx", () => {
  const body = (name: string) => {
    const start = app.indexOf(`function ${name}(`);
    expect(start, `${name} is gone from App.tsx`).toBeGreaterThan(-1);
    return app.slice(start, app.indexOf("\n}\n", start));
  };

  it("reads and writes the layout key through the format above", () => {
    expect(body("loadLayout")).toContain("parseStoredLayout(window.localStorage.getItem(LAYOUT_STORAGE_KEY))");
    expect(body("saveLayout")).toContain("serializeLayout(positions, pinned)");
    expect(body("loadLayoutFrame")).toContain("parseLayoutFrame(window.localStorage.getItem(LAYOUT_FRAME_KEY))");
    // And does not parse or build either value a second way beside it.
    for (const name of ["loadLayout", "saveLayout", "loadLayoutFrame"]) {
      expect(body(name), name).not.toMatch(/JSON\.(parse|stringify)/);
    }
  });
});
