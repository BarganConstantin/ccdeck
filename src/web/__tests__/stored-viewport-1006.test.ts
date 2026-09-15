// #1006: a stored viewport is checked against the canvas's own zoom bounds
// before the canvas is handed it.
//
// loadViewport asked `typeof … === "number"` of x, y and zoom and nothing more,
// so a stored `{"x":0,"y":0,"zoom":0}` came back as a viewport, turned the
// opening fit off, and was applied: a blank canvas on every load, which the
// drift watchdog cannot rescue because it stands down for a zoom it cannot fit
// from. These cases pin the check in stored-viewport.ts, and pin App.tsx to
// reading the key through it, so neither half can be dropped on its own.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, parseStoredViewport } from "../stored-viewport";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

/** The check loadViewport made before #1006, verbatim apart from the return. */
function oldCheck(raw: string): boolean {
  try {
    const vp = JSON.parse(raw);
    return !(typeof vp?.x !== "number" || typeof vp?.y !== "number" || typeof vp?.zoom !== "number");
  } catch { return false; }
}

const REFUSED: Array<[string, string]> = [
  ["a zero zoom", '{"x":0,"y":0,"zoom":0}'],
  ["a negative zoom", '{"x":0,"y":0,"zoom":-3}'],
  ["a zoom further out than the canvas allows", '{"x":0,"y":0,"zoom":0.1}'],
  ["a zoom further in than the canvas allows", '{"x":0,"y":0,"zoom":5}'],
  // JSON has no spelling for Infinity, but a literal too large for a double
  // overflows to it on the way in, and `typeof Infinity` is "number".
  ["a zoom that overflows to Infinity", '{"x":0,"y":0,"zoom":1e400}'],
  ["an x that overflows to -Infinity", '{"x":-1e400,"y":0,"zoom":1}'],
];

describe("a stored viewport", () => {
  it("comes back when it is one the canvas could have been left at", () => {
    expect(parseStoredViewport('{"x":12,"y":-40,"zoom":0.8}')).toEqual({ x: 12, y: -40, zoom: 0.8 });
    // Both bounds are inclusive: they are values the canvas itself can stop at.
    expect(parseStoredViewport(`{"x":0,"y":0,"zoom":${CANVAS_MIN_ZOOM}}`)?.zoom).toBe(CANVAS_MIN_ZOOM);
    expect(parseStoredViewport(`{"x":0,"y":0,"zoom":${CANVAS_MAX_ZOOM}}`)?.zoom).toBe(CANVAS_MAX_ZOOM);
    // A long way off is still a viewport. Bringing the board back from one is
    // the drift watchdog's job, and it can do that once the zoom is sane.
    expect(parseStoredViewport('{"x":-90000,"y":42000,"zoom":1}')).toEqual({ x: -90000, y: 42000, zoom: 1 });
  });

  it.each(REFUSED)("is refused when it carries %s", (_name, raw) => {
    expect(parseStoredViewport(raw)).toBeNull();
  });

  it("was let through by the check it replaces, for every case refused above", () => {
    // The canary for the table: a case the old check ALSO refused would pass
    // the one above without testing anything. Every one of these was a
    // viewport to loadViewport before #1006.
    expect(REFUSED.filter(([, raw]) => !oldCheck(raw)).map(([name]) => name)).toEqual([]);
  });

  it("is refused when it is not a viewport at all", () => {
    for (const raw of [null, "", "not json", "null", "[]", "3", '{"x":"0","y":0,"zoom":1}', '{"x":0,"y":0}']) {
      expect(parseStoredViewport(raw), String(raw)).toBeNull();
    }
  });

  it("hands back its own three numbers rather than whatever else the stored object carried", () => {
    expect(parseStoredViewport('{"x":1,"y":2,"zoom":1,"extra":true}')).toEqual({ x: 1, y: 2, zoom: 1 });
  });
});

describe("App.tsx", () => {
  it("reads the viewport key through the check", () => {
    const at = app.indexOf("function loadViewport(");
    expect(at, "loadViewport is gone from App.tsx").toBeGreaterThan(-1);
    const body = app.slice(at, app.indexOf("\n}\n", at));
    expect(body).toContain("parseStoredViewport(");
    // And does not parse the key a second way beside it.
    expect(body).not.toContain("JSON.parse");
  });

  it("bounds the canvas with the same two numbers the check uses", () => {
    expect(app).toContain("minZoom={CANVAS_MIN_ZOOM}");
    expect(app).toContain("maxZoom={CANVAS_MAX_ZOOM}");
    expect(app).not.toMatch(/minZoom=\{\d/);
    expect(app).not.toMatch(/maxZoom=\{\d/);
  });
});
