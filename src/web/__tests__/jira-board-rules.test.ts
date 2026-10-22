// The Jira panel's rules apart from React: what an issue's detail says about
// the work on it, and (as the panel grows) what a row and a sprint's header
// say about the issues in them. No DOM: the helpers are pure.
import { describe, it, expect } from "vitest";
import { buildRows, filterRows, needsAttention, rowKey, shownQuickFilters, subtaskShown, timeLine } from "../jira-board";
import type { JiraIssue, StatusCategory } from "../jira-api";

const TIME = { hoursPerDay: 8, daysPerWeek: 5 };
const STORY = { name: "Story", icon: null, subtask: false, epic: false };
const SUB = { name: "Sub-task", icon: null, subtask: true, epic: false };
const status = (category: StatusCategory) => ({ name: category, category });
const priority = (name: string) => ({ name, icon: null });
let n = 0;
function issue(key: string, extra: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: String(++n), key, summary: `Summary of ${key}`, url: `https://jira.example.com/browse/${key}`, type: STORY, status: status("new"),
    priority: null, assignee: null, mine: false, parent: null, subtaskKeys: [], epic: null, fixVersions: [], estimate: null, remaining: null,
    points: null, flagged: false, updated: "", ...extra,
  };
}
const subOf = (key: string, parent: JiraIssue, extra: Partial<JiraIssue> = {}) => issue(key, {
  type: SUB, parent: { key: parent.key, summary: parent.summary, type: parent.type, status: parent.status, priority: parent.priority }, ...extra,
});
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

describe("what needs attention", () => {
  it("is an issue not done that is flagged, or at the top of either priority scale", () => {
    expect(needsAttention(issue("A-1", { flagged: true }))).toBe(true);
    for (const name of ["Highest", "Blocker", "Critical"]) expect(needsAttention(issue("A-2", { priority: priority(name) })), name).toBe(true);
    for (const name of ["High", "Major", "Medium"]) expect(needsAttention(issue("A-3", { priority: priority(name) })), name).toBe(false);
    expect(needsAttention(issue("A-4"))).toBe(false);
  });

  it("is never an issue that is done, however it is marked", () => {
    expect(needsAttention(issue("A-1", { flagged: true, priority: priority("Highest"), status: status("done") }))).toBe(false);
  });

  it("keeps a row while a sub-task under it needs attention, and only those sub-tasks", () => {
    const quiet = issue("A-10", { subtaskKeys: ["A-11", "A-12"] });
    const urgent = subOf("A-11", quiet, { flagged: true });
    const calm = subOf("A-12", quiet);
    const loud = issue("A-20", { priority: priority("Blocker") });
    const other = issue("A-30");
    const rows = buildRows([quiet, urgent, calm, loud, other]);
    const filter = { search: "", hideDone: false, attention: true };
    const subtasks = (key: string) => (key === "A-10" ? [urgent, calm] : undefined);
    const kept = filterRows(rows, filter, subtasks);
    expect(kept.map(rowKey)).toEqual(["A-10", "A-20"]);
    expect([urgent, calm].filter(s => subtaskShown(s, filter)).map(s => s.key)).toEqual(["A-11"]);
  });

  it("asks both Hide done and Needs attention of a sub-task when both are on", () => {
    const parent = issue("A-1");
    const filter = { search: "", hideDone: true, attention: true };
    expect(subtaskShown(subOf("A-2", parent, { flagged: true }), filter)).toBe(true);
    expect(subtaskShown(subOf("A-3", parent, { flagged: true, status: status("done") }), filter)).toBe(false);
    expect(subtaskShown(subOf("A-4", parent), filter)).toBe(false);
    expect(subtaskShown(subOf("A-5", parent, { status: status("done") }), { search: "", hideDone: false })).toBe(true);
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
