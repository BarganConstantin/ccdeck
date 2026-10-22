// The Jira backlog as it is drawn (#2178), rendered to static markup with a
// small board: what every row carries, and what a sprint's header says. No
// DOM and no effects — the markup is the evidence, the way the page's first
// paint would be.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JiraBacklog, { type JiraBacklogProps } from "../components/JiraBacklog";
import { groupsFor } from "../jira-board";
import type { JiraBoardOverview, JiraIssue, JiraSprint, StatusCategory } from "../jira-api";
import type { BoardSnapshot } from "../use-jira-board";
import type { IntegrationConnection } from "../integrations/types";

const STORY = { name: "Story", icon: null, subtask: false, epic: false };
const SUB = { name: "Sub-task", icon: null, subtask: true, epic: false };
const ME = { id: "me", name: "Jane Doe", avatar: null };
const ALEX = { id: "alex", name: "Alex Kim", avatar: null };
const status = (name: string, category: StatusCategory) => ({ name, category });

let n = 0;
function issue(key: string, extra: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: String(++n), key, summary: `Summary of ${key}`, url: `https://jira.example.com/browse/${key}`, type: STORY,
    status: status("To Do", "new"), priority: null, assignee: null, mine: false, parent: null, subtaskKeys: [], epic: null,
    fixVersions: [], estimate: null, remaining: null, points: null, flagged: false, updated: "", ...extra,
  };
}
const subOf = (key: string, parent: JiraIssue, extra: Partial<JiraIssue> = {}) => issue(key, {
  type: SUB, parent: { key: parent.key, summary: parent.summary, type: parent.type, status: parent.status, priority: parent.priority }, ...extra,
});

const SPRINT: JiraSprint = { id: 13, name: "Sprint 13", state: "active", startDate: null, endDate: null, completeDate: null, goal: "" };
const OVERVIEW: JiraBoardOverview = {
  board: { id: 1, name: "Board", type: "scrum", projectKey: "MOCK", projectName: "Mock" },
  estimation: { kind: "time", fieldId: null, label: "Original estimate" },
  quickFilters: [],
  sprints: { active: [SPRINT], future: [] },
  hasSprints: true,
  hasBacklog: false,
  timeTracking: { hoursPerDay: 8, daysPerWeek: 5 },
};
const CONN = { id: "c1", kind: "jira", name: "Jira", baseUrl: "https://jira.example.com", account: {}, meta: {}, allowedOrigins: [], createdAt: "", updatedAt: "", tokenSaved: true } as unknown as IntegrationConnection;

/** The backlog of one active sprint holding `issues`, drawn. */
function drawBoard(issues: JiraIssue[], props: Partial<JiraBacklogProps> = {}, overview: JiraBoardOverview = OVERVIEW): string {
  const groups = groupsFor(overview);
  const snap: BoardSnapshot = {
    overview,
    groups: { [groups[0].id]: { status: "ready", issues, next: "", total: issues.length, capped: false, error: null, more: false } },
    subtasks: {},
    closed: { shown: false, sprints: [], total: 0, isLast: false, loading: false, error: null },
    loadedAt: 1,
  };
  const all: JiraBacklogProps = {
    conn: CONN, overview, groups, snap, expanded: {}, onToggleGroup: () => {}, filter: { search: "", hideDone: false },
    mine: false, filtered: false, selected: null, onOpen: () => {}, onRetryGroup: () => {}, onMore: () => {},
    onShowClosed: () => {}, onMoreClosed: () => {}, loadSubtasks: () => {}, onReconnect: () => {}, ...props,
  };
  return renderToStaticMarkup(createElement(JiraBacklog, all));
}

/** Each row's button, by issue key: its whole markup. */
function rows(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<button[^>]*class="jr-row-main"[^>]*data-key="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)) out[m[1]] = m[0];
  return out;
}

describe("every row says what state its issue is in", () => {
  it("draws Jira's status lozenge on each row and sub-row, by category, with the whole name in its title", () => {
    const story = issue("MOCK-10", { status: status("In Progress", "indeterminate"), subtaskKeys: ["MOCK-11"] });
    const html = drawBoard([
      story,
      subOf("MOCK-11", story, { status: status("Selected for Development", "new") }),
      issue("MOCK-30", { status: status("Done", "done") }),
    ]);
    const drawn = rows(html);
    expect(drawn["MOCK-10"]).toContain('<span class="jr-status ig-chip" data-cat="indeterminate" title="In Progress">In Progress</span>');
    expect(drawn["MOCK-30"]).toContain('<span class="jr-status ig-chip" data-cat="done" title="Done">Done</span>');
    // A done issue keeps its struck-through key as well.
    expect(drawn["MOCK-30"]).toMatch(/class="jr-key" data-done="true"/);
  });

  it("gives a parent drawn for its sub-tasks its own status too", () => {
    const theirs = issue("MOCK-20", { status: status("In Review", "indeterminate") });
    const html = drawBoard([subOf("MOCK-21", theirs, { mine: true, assignee: ME })]);
    expect(rows(html)["MOCK-20"]).toContain('title="In Review">In Review</span>');
  });

  it("sizes the status cell to the board's longest status name, never past the lozenge's cap", () => {
    expect(drawBoard([issue("A-1", { status: status("In Progress", "indeterminate") })])).toContain("--jr-status-ch:11");
    expect(drawBoard([issue("A-1", { status: status("Waiting for the customer to reply", "new") })])).toContain("--jr-status-ch:16");
  });
});

describe("the reader's own issues are marked as theirs", () => {
  it("rings their face, says so in the row's label and title, and says nothing extra for someone else's", () => {
    const html = drawBoard([
      issue("MOCK-1", { assignee: ME, mine: true }),
      issue("MOCK-2", { assignee: ALEX }),
      issue("MOCK-3"),
    ]);
    const drawn = rows(html);
    expect(drawn["MOCK-1"]).toMatch(/aria-label="MOCK-1: Summary of MOCK-1\. Story, To Do, Jane Doe, assigned to you"/);
    expect(drawn["MOCK-1"]).toMatch(/<span class="jr-assignee" title="Jane Doe \(you\)"><span class="ig-avatar ig-avatar-initials"[^>]*data-you="true"/);
    expect(drawn["MOCK-2"]).toMatch(/aria-label="MOCK-2: Summary of MOCK-2\. Story, To Do, Alex Kim"/);
    expect(drawn["MOCK-2"]).not.toContain("data-you");
    expect(drawn["MOCK-3"]).toMatch(/<span class="jr-assignee" title="Unassigned"><span class="ig-avatar ig-avatar-none"/);
  });

  it("rings the reader in the sprint's stack of people, which names everyone once", () => {
    const html = drawBoard([issue("MOCK-1", { assignee: ME, mine: true }), issue("MOCK-2", { assignee: ALEX })]);
    expect(html).toMatch(/<span class="ig-stack" role="img" aria-label="Assigned to (Jane Doe and Alex Kim|Alex Kim and Jane Doe)"/);
    const stack = /<span class="ig-stack"[\s\S]*?<\/span><\/span>|<span class="ig-stack"[\s\S]*?(?=<span class="jr-totals")/.exec(html)![0];
    expect(stack.match(/data-you="true"/g)).toHaveLength(1);
  });

  it("names a sub-task as the reader's once, not twice", () => {
    // A sub-task whose parent is not in the list is drawn under that parent.
    const theirs = issue("MOCK-10");
    const html = drawBoard([subOf("MOCK-11", theirs, { assignee: ME, mine: true })]);
    const label = /aria-label="(MOCK-11:[^"]*)"/.exec(html)?.[1] ?? "";
    expect(label).not.toBe("");
    expect(label.match(/assigned to you|yours/g) ?? []).toEqual(["assigned to you"]);
  });
});

describe("the list is one Tab stop", () => {
  const stops = (html: string) => [...html.matchAll(/<button[^>]*class="(jr-row-main|jr-group-toggle)"[^>]*>/g)]
    .filter(m => !/tabindex="-1"/.test(m[0])).map(m => /data-nav="([^"]+)"/.exec(m[0])![1]);

  it("puts the first row in the Tab order and every sprint header out of it", () => {
    const html = drawBoard([issue("MOCK-1"), issue("MOCK-2")]);
    expect(stops(html)).toHaveLength(1);
    expect(stops(html)[0]).toMatch(/\/MOCK-1$/);
    expect(html).toMatch(/class="jr-group-toggle"[^>]*tabindex="-1"/);
  });

  it("falls back to the first sprint header when no row is drawn", () => {
    const html = drawBoard([]);
    expect(stops(html)).toHaveLength(1);
    expect(stops(html)[0]).toMatch(/^g:/);
  });
});

