// The Jira panel's rules apart from React: what an issue's detail says about
// the work on it, and (as the panel grows) what a row and a sprint's header
// say about the issues in them. No DOM: the helpers are pure.
import { describe, it, expect } from "vitest";
import { shownQuickFilters, timeLine } from "../jira-board";

const TIME = { hoursPerDay: 8, daysPerWeek: 5 };
const DAY = 8 * 3600;

describe("the detail's one line of time", () => {
  it("names the estimate, what is left and what was logged, as Jira counts days", () => {
    expect(timeLine({ estimate: 3 * DAY, remaining: DAY, timeSpent: 2 * DAY }, TIME)).toBe("3d estimated · 1d left · 2d logged");
  });

  it("leaves out what Jira does not have, and a 'left' that only repeats the estimate", () => {
    expect(timeLine({ estimate: 3 * DAY, remaining: 3 * DAY, timeSpent: null }, TIME)).toBe("3d estimated");
    expect(timeLine({ estimate: null, remaining: null, timeSpent: 4 * 3600 }, TIME)).toBe("4h logged");
    expect(timeLine({ estimate: null, remaining: null, timeSpent: null }, TIME)).toBe("");
  });

  it("keeps 'left' once work was logged, even when it equals the estimate", () => {
    expect(timeLine({ estimate: DAY, remaining: DAY, timeSpent: 3600 }, TIME)).toBe("1d estimated · 1d left · 1h logged");
  });
});

describe("the board's own quick filters", () => {
  const filters = ["Only My Issues", "Recently Updated", "Only bugs"].map((name, i) => ({ id: String(i), name, description: "" }));

  it("leave out the board's Only My Issues, which the panel's own chip does, in any case and spacing", () => {
    expect(shownQuickFilters(filters).map(q => q.name)).toEqual(["Recently Updated", "Only bugs"]);
    expect(shownQuickFilters([{ id: "x", name: "  only my issues ", description: "" }])).toEqual([]);
  });

  it("keep a filter that only starts the same way, or is named in another language", () => {
    const kept = [{ id: "a", name: "Only my issues in review", description: "" }, { id: "b", name: "Nur meine Vorgänge", description: "" }];
    expect(shownQuickFilters(kept)).toEqual(kept);
  });
});
