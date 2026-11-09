import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { BUCKET_MS, labelsUnder, oldestBucketMs, pointsOf, record, resetHistory } from "../../server/metrics-history.mjs";

afterEach(() => resetHistory());

describe("metric history when the clock moves backwards", () => {
  it("merges revisited minutes by maximum and keeps every series chronological", () => {
    record("cpu:all", 80, 600_000);
    record("cpu:all", 20, 660_000);
    record("cpu:all", 40, 600_000);
    record("cpu:all", 30, 660_000);
    record("thermal:GPU", 72, 630_000);
    expect(pointsOf("cpu:all")).toEqual([{ t: 600_000, v: 80 }, { t: 660_000, v: 30 }]);
    expect(pointsOf("thermal:GPU")).toEqual([{ t: 600_000, v: 72 }]);
    expect(labelsUnder("thermal:")).toEqual(["GPU"]);
  });

  it("inserts a previously unsampled minute without filling sleep gaps", () => {
    record("cpu:all", 20, 660_000);
    record("cpu:all", 30, 900_000);
    record("cpu:all", 80, 600_000);
    record("cpu:all", 25, 780_000);
    expect(oldestBucketMs()).toBe(600_000);
    expect(pointsOf("cpu:all")).toEqual([
      { t: 600_000, v: 80 }, { t: 660_000, v: 20 },
      { t: 780_000, v: 25 }, { t: 900_000, v: 30 },
    ]);
  });

  it("retains the newest 1,440 distinct minutes when a late reading precedes the ring", () => {
    for (let minute = 1; minute <= 1441; minute++) record("cpu:all", 10, minute * BUCKET_MS);
    record("cpu:all", 90, BUCKET_MS);
    record("cpu:all", 80, 2 * BUCKET_MS);
    const points = pointsOf("cpu:all");
    expect(points).toHaveLength(1440);
    expect(points[0]).toEqual({ t: 2 * BUCKET_MS, v: 80 });
    expect(points.at(-1)).toEqual({ t: 1441 * BUCKET_MS, v: 10 });
    expect(oldestBucketMs()).toBe(2 * BUCKET_MS);
  });
});
