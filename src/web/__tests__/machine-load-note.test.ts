import { describe, expect, it } from "vitest";
import { loadQueueNote } from "../machine-readings";

describe("live load context shared by the panel and history dialog", () => {
  it("explains two and three times the logical-core capacity", () => {
    expect(loadQueueNote(24, 12)).toBe("2.0× more work queued than cores to run it");
    expect(loadQueueNote(36, 12)).toBe("3.0× more work queued than cores to run it");
    expect(loadQueueNote(28.8, 12)).toBe("2.4× more work queued than cores to run it");
  });
  it("stays quiet when the queue fits", () => {
    for (const value of [0, 6, 12]) expect(loadQueueNote(value, 12)).toBeNull();
  });
  it("never invents a ratio for missing or invalid readings", () => {
    for (const value of [undefined, null, NaN, Infinity, -1]) expect(loadQueueNote(value, 12)).toBeNull();
    for (const cores of [0, -1, NaN, Infinity]) expect(loadQueueNote(24, cores)).toBeNull();
  });
});
