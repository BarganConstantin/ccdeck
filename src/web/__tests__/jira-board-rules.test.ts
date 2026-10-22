// The Jira panel's first screen, as rules apart from React: what the toolbar
// says about how current the board is, and (below) what a row and a sprint
// header say about the issues in them. No DOM: the helpers are pure, and the
// markup they feed is checked through renderToStaticMarkup where it matters.
import { describe, it, expect } from "vitest";
import { freshnessLine } from "../jira-board";

const MIN = 60_000;

describe("the toolbar's freshness line", () => {
  const now = Date.UTC(2026, 9, 19, 9, 30);

  it("says the board was updated, and how long ago, after a read that worked", () => {
    expect(freshnessLine({ loading: false, loadedAt: now - 5 * MIN, failed: false }, now)).toEqual({ text: "Updated 5m ago", stale: false });
  });

  it("never claims an update after a refresh that failed: it names the last answer, in the warn tone", () => {
    expect(freshnessLine({ loading: false, loadedAt: now - 5 * MIN, failed: true }, now)).toEqual({ text: "Not updated · last answer 5m ago", stale: true });
    expect(freshnessLine({ loading: false, loadedAt: 0, failed: true }, now)).toEqual({ text: "Not updated", stale: true });
  });

  it("says what is happening while a read is out", () => {
    expect(freshnessLine({ loading: true, loadedAt: now - MIN, failed: false }, now).text).toBe("Updating…");
    expect(freshnessLine({ loading: true, loadedAt: 0, failed: false }, now).text).toBe("Reading…");
    expect(freshnessLine({ loading: false, loadedAt: 0, failed: false }, now).text).toBe("");
  });
});
