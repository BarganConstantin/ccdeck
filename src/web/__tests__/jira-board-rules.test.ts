// The Jira panel's rules apart from React: what an issue's detail says about
// the work on it, and (as the panel grows) what a row and a sprint's header
// say about the issues in them, and which issues a board has on screen. No
// DOM: the helpers are pure.
import { describe, it, expect } from "vitest";
import {
  boardRows, buildRows, drawnIssues, filterRows, groupsFor, groupStats, needsAttention, rowKey, shownQuickFilters, subtaskShown, timeLine,
  type GroupRead,
} from "../jira-board";
import type { JiraBoardOverview, JiraIssue, JiraSprint, StatusCategory } from "../jira-api";

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

describe("what a sprint's header counts as needing attention", () => {
  it("counts the flagged and the highest that are not done, an issue that is both in each", () => {
    const rows = buildRows([
      issue("B-1", { flagged: true }),
      issue("B-2", { flagged: true, priority: priority("Highest") }),
      issue("B-3", { priority: priority("Critical") }),
      issue("B-4", { flagged: true, priority: priority("Blocker"), status: status("done") }),
      issue("B-5", { priority: priority("High") }),
    ]);
    const stats = groupStats(rows, "count");
    expect([stats.flagged, stats.highest]).toEqual([2, 2]);
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

describe("which issues a board has on screen", () => {
  // The panel puts a remembered issue back only when the board, as drawn,
  // still shows it: an open group's rows, and the sub-tasks under open rows;
  // with nothing to put back it opens the board's first issue.
  const sprint = (id: number, name: string): JiraSprint => ({ id, name, state: "active", startDate: null, endDate: null, completeDate: null, goal: "" });
  const overview = {
    hasSprints: true, hasBacklog: true, sprints: { active: [sprint(13, "Sprint 13")], future: [sprint(14, "Sprint 14")] },
  } as unknown as JiraBoardOverview;
  const groups = groupsFor(overview);
  const ready = (...issues: JiraIssue[]): GroupRead => ({ status: "ready", issues });
  const none = { search: "", hideDone: false };
  const story = issue("C-10", { subtaskKeys: ["C-11"] });
  const child = subOf("C-11", story);
  const data = {
    "sprint:13": ready(story, issue("C-20")),
    "sprint:14": ready(issue("C-40")),
    backlog: ready(issue("C-50")),
  };

  it("counts the rows of the open groups only, the active sprint open and the others folded", () => {
    const { keys, complete } = drawnIssues(boardRows(groups, data, () => undefined, none), {}, {}, {}, none, false);
    expect([...keys]).toEqual(["C-10", "C-20"]);
    expect(complete).toBe(true);
    const opened = drawnIssues(boardRows(groups, data, () => undefined, none), { "sprint:14": true }, {}, {}, none, false);
    expect([...opened.keys]).toEqual(["C-10", "C-20", "C-40"]);
  });

  it("counts a sub-task under an open row, read or in the group's own results", () => {
    const built = boardRows(groups, data, () => undefined, none);
    expect(drawnIssues(built, {}, { "C-10": true }, { "C-10": ready(child) }, none, false).keys.has("C-11")).toBe(true);
    expect(drawnIssues(built, {}, {}, { "C-10": ready(child) }, none, false).keys.has("C-11")).toBe(false);
  });

  it("is not complete while an open group, or an open row's sub-tasks, are still being read", () => {
    const loading = { ...data, "sprint:13": { status: "loading" as const, issues: [] } };
    expect(drawnIssues(boardRows(groups, loading, () => undefined, none), {}, {}, {}, none, false).complete).toBe(false);
    const built = boardRows(groups, data, () => undefined, none);
    expect(drawnIssues(built, {}, { "C-10": true }, {}, none, false).complete).toBe(false);
    expect(drawnIssues(built, {}, { "C-10": true }, { "C-10": { status: "loading", issues: [] } }, none, false).complete).toBe(false);
    // A folded group being read stops nothing: nothing in it is drawn.
    const backlogLoading = { ...data, backlog: { status: "loading" as const, issues: [] } };
    expect(drawnIssues(boardRows(groups, backlogLoading, () => undefined, none), {}, {}, {}, none, false).complete).toBe(true);
  });

  it("follows the filters: an issue the search hides is not on screen", () => {
    const search = { search: "c-20", hideDone: false };
    const { keys, first } = drawnIssues(boardRows(groups, data, () => undefined, search), {}, {}, {}, search, true);
    expect([...keys]).toEqual(["C-20"]);
    expect(first).toBe("C-20");
  });

  it("names the first issue of the first open group, in the board's order", () => {
    expect(drawnIssues(boardRows(groups, data, () => undefined, none), {}, {}, {}, none, false).first).toBe("C-10");
    // A folded group is passed over, and so is an open one with no rows.
    expect(drawnIssues(boardRows(groups, data, () => undefined, none), { "sprint:13": false, backlog: true }, {}, {}, none, false).first).toBe("C-50");
    const emptySprint = { ...data, "sprint:13": ready() };
    expect(drawnIssues(boardRows(groups, emptySprint, () => undefined, none), { "sprint:14": true }, {}, {}, none, false).first).toBe("C-40");
  });

  it("names no first issue while an open group above it is being read, or the board shows none", () => {
    const loading = { ...data, "sprint:13": { status: "loading" as const, issues: [] } };
    expect(drawnIssues(boardRows(groups, loading, () => undefined, none), { "sprint:14": true }, {}, {}, none, false).first).toBeNull();
    const empty = { "sprint:13": ready(), "sprint:14": ready(), backlog: ready() };
    expect(drawnIssues(boardRows(groups, empty, () => undefined, none), {}, {}, {}, none, false)).toMatchObject({ complete: true, first: null });
  });
});
