import { describe, expect, it } from "vitest";
import { discoverySummary, filterWorkspaceStreams, workspaceStreams } from "../radio-discovery";
const streams = workspaceStreams([]);
const empty = { country: "", genre: "", language: "" };
describe("mixed radio discovery", () => {
  it("keeps nongeographic streams in Global without fabricating directory metadata", () => {
    expect(filterWorkspaceStreams(streams, "", { ...empty, country: "GLOBAL" }, "discover", [])).toEqual(streams);
    for (const filters of [{ ...empty, country: "FR" }, { ...empty, genre: "chill" }, { ...empty, language: "english" }]) {
      expect(filterWorkspaceStreams(streams, "", filters, "discover", [])).toEqual([]);
    }
  });
  it("searches stream names and retains collection order, excluding stale IDs", () => {
    expect(filterWorkspaceStreams(streams, " LOFI ", empty, "discover", [])).toHaveLength(4);
    expect(filterWorkspaceStreams(streams, "", empty, "favorites", ["removed", "good-life-radio", "claude-fm"]).map(s => s.id)).toEqual(["good-life-radio", "claude-fm"]);
    expect(filterWorkspaceStreams(streams, "claude", empty, "recent", ["good-life-radio", "claude-fm"]).map(s => s.id)).toEqual(["claude-fm"]);
  });
  it("counts source types independently, including empty and singular results", () => {
    expect(discoverySummary(300, 7)).toBe("7 workspace streams · 300 radio stations");
    expect(discoverySummary(1, 0)).toBe("1 radio station");
    expect(discoverySummary(0, 1)).toBe("1 workspace stream");
    expect(discoverySummary(0, 0)).toBe("No matching results");
  });
});
