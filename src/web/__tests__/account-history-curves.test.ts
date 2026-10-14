import { describe, expect, it } from "vitest";
import { smoothHistoryPath } from "../account-history";

describe("smooth observation guides", () => {
  it("keeps single observations and duplicate timestamps honest", () => {
    expect(smoothHistoryPath([])).toBe("");
    expect(smoothHistoryPath([{ x: 1, y: 0 }])).toBe("M1,0");
    expect(
      smoothHistoryPath([
        { x: 1, y: 0 },
        { x: 1, y: 100 },
      ]),
    ).toBe("M1,0L1,100");
  });

  it.each([
    [
      { x: 0, y: 0 },
      { x: 1, y: 100 },
      { x: 30, y: 100 },
      { x: 31, y: 2 },
      { x: 90, y: 0 },
    ],
    [
      { x: 0, y: 50 },
      { x: 5, y: 0 },
      { x: 6, y: 100 },
      { x: 100, y: 50 },
    ],
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ],
  ])(
    "passes through every reading without overshooting between observations",
    (...points) => {
      const path = smoothHistoryPath(points);
      const segments = path.split("C").slice(1);
      expect(segments).toHaveLength(points.length - 1);
      segments.forEach((segment, index) => {
        const values = segment
          .match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)!
          .map(Number);
        const a = points[index],
          b = points[index + 1];
        expect(values.slice(4)).toEqual([b.x, b.y]);
        for (let step = 0; step <= 100; step++) {
          const t = step / 100,
            u = 1 - t;
          const y =
            u * u * u * a.y +
            3 * u * u * t * values[1] +
            3 * u * t * t * values[3] +
            t * t * t * b.y;
          expect(y).toBeGreaterThanOrEqual(Math.min(a.y, b.y) - 1e-8);
          expect(y).toBeLessThanOrEqual(Math.max(a.y, b.y) + 1e-8);
        }
      });
    },
  );
});
