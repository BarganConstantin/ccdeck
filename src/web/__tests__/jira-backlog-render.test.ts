// The Jira backlog as it is drawn (#2178), rendered to static markup with a
// small board: what every row carries, and what a sprint's header says. No
// DOM and no effects — the markup is the evidence, the way the page's first
// paint would be.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntegrationFailure } from "../integrations/client";
import JiraBacklog, { type JiraBacklogProps } from "../components/JiraBacklog";
import { groupsFor, type GroupDef } from "../jira-board";
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
function drawBoard(issues: JiraIssue[], props: Partial<JiraBacklogProps> = {}, overview: JiraBoardOverview = OVERVIEW,
  subtasks: BoardSnapshot["subtasks"] = {}): string {
  const groups = groupsFor(overview);
  const snap: BoardSnapshot = {
    overview,
    groups: { [groups[0].id]: { status: "ready", issues, next: "", total: issues.length, capped: false, error: null, more: false } },
    subtasks,
    closed: { shown: false, sprints: [], total: 0, isLast: false, loading: false, error: null },
    loadedAt: 1,
  };
  const all: JiraBacklogProps = {
    conn: CONN, overview, groups, snap, expanded: {}, onToggleGroup: () => {}, filter: { search: "", hideDone: false },
    mine: false, filtered: false, selected: null, onOpen: () => {}, rowsOpen: {}, onToggleRow: () => {}, onRetryGroup: () => {}, onMore: () => {},
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

describe("explicit moves without changing the existing read-only contract", () => {
  const onMove = async () => ({});
  const writable = { ...OVERVIEW, moves: { enabled: true } };
  it("keeps older servers read-only and exposes actions for blocked top-level work", () => {
    expect(drawBoard([issue("MOCK-1")], { onMove })).not.toContain('class="jr-move-button"');
    const html = drawBoard([
      issue("MOCK-1"), issue("MOCK-2", { status: status("Done", "done") }),
      issue("MOCK-3", { type: { ...STORY, epic: true } }),
    ], { onMove }, writable);
    expect(html.match(/class="jr-move-button"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Actions for MOCK-2"');
    expect(html).toContain('aria-label="Actions for MOCK-3"');
    expect(html).toContain('aria-label="Actions for MOCK-1"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('draggable="true"');
    expect(html).toContain("Alt+M opens Move");
    expect(html).toContain("Right-click or Shift+F10 opens actions");
    expect(rows(html)["MOCK-2"]).toContain('aria-haspopup="menu"');
  });
  it("exposes expanded state and priority on the roving keyboard control", () => {
    const html = drawBoard([issue("MOCK-1", { subtaskKeys: ["MOCK-2"], priority: { name: "High", icon: null } })], { rowsOpen: { "MOCK-1": true } });
    expect(rows(html)["MOCK-1"]).toContain('aria-expanded="true"');
    expect(rows(html)["MOCK-1"]).toContain('aria-controls="jr-toggle-sprint-13-MOCK-1-children"');
    expect(rows(html)["MOCK-1"]).toContain("priority High");
    expect(html).toContain('id="jr-toggle-sprint-13-MOCK-1-children"');
  });
});

describe("dragging the selected first issue", () => {
  it("allows dragging an opened Done issue", () => {
    const html = drawBoard([issue("MOCK-1", { status: status("Done", "done") })],
      { selected: "MOCK-1", onMove: async () => ({}) }, { ...OVERVIEW, moves: { enabled: true } });
    expect(html).toMatch(/class="jr-row ig-row"[^>]*data-current="true"[^>]*draggable="true"/);
  });
});

describe("row selection and current-detail highlight", () => {
  it("keeps the current issue highlighted without an extra icon", () => {
    const html = drawBoard([issue("MOCK-1"), issue("MOCK-2")], { selected: "MOCK-1" });
    expect(html).toContain('data-current="true"');
    expect(html).toContain('data-selected="true"');
    expect(html).not.toContain('class="jr-current-mark"');
    expect(html).not.toContain('type="checkbox"');
    // The type glyph remains factual, not a selection checkbox.
    expect(rows(html)["MOCK-1"]).toContain('aria-label="Story"');
  });
});

describe("title-first row content", () => {
  it("uses a compact version count without dropping full values", () => {
    const versions = ["Release Europe", "Release America", "Service compatibility"];
    const html = drawBoard([issue("MOCK-1", { fixVersions: versions }), issue("MOCK-2")]);
    const drawn = rows(html);
    expect(drawn["MOCK-1"]).toContain('data-has-meta="true"');
    expect(drawn["MOCK-1"]).toContain('title="Release Europe, Release America, Service compatibility"');
    expect(drawn["MOCK-1"]).toContain("3 versions");
    expect(drawn["MOCK-1"].match(/class="jr-version"/g)).toHaveLength(1);
    expect(drawn["MOCK-2"]).not.toContain('data-has-meta="true"');
  });
  it("keeps a single version's name and the original keyboard row label", () => {
    const html = drawBoard([issue("MOCK-1", { summary: "Full identifying title", fixVersions: ["V6"] })]);
    const row = rows(html)["MOCK-1"];
    expect(row).toContain('title="V6">V6</span>');
    expect(row).toContain('aria-label="MOCK-1: Full identifying title.');
    expect(row).toContain('aria-describedby="');
  });
});

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


/** The header of the board's first group, from its name to its totals. */
const headOf = (html: string) => /<div class="jr-group-head">[\s\S]*?(?=<div id="jr-group-|<\/section>)/.exec(html)![0];
const words = (html: string) => html.replace(/<span class="vis-hidden">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
const DAY = 8 * 3600;
const HIGHEST = { name: "Highest", icon: null };

describe("a sprint's header says what it holds in words", () => {
  it("names the reader's issues, the flagged and the highest that are not done, and nothing that is zero", () => {
    const head = headOf(drawBoard([
      issue("MOCK-1", { assignee: ME, mine: true, flagged: true }),
      issue("MOCK-2", { assignee: ME, mine: true, status: status("Done", "done") }),
      issue("MOCK-3", { priority: HIGHEST }),
      issue("MOCK-4", { flagged: true, status: status("Done", "done") }),
    ]));
    expect(words(/<span class="jr-tally">[\s\S]*?<\/span><\/span>/.exec(head)![0])).toBe("2 yours · 1 flagged · 1 highest");
    expect(head).toContain('title="1 of 2 yours done">2 yours</span>');
    expect(head).not.toMatch(/Mine \d/);
    expect(headOf(drawBoard([issue("MOCK-5")]))).not.toContain("jr-tally");
  });

  it("with Only my issues on, says how many of the reader's are done", () => {
    const head = headOf(drawBoard([
      issue("MOCK-1", { assignee: ME, mine: true }),
      issue("MOCK-2", { assignee: ME, mine: true, status: status("Done", "done") }),
    ], { mine: true }));
    expect(words(/<span class="jr-tally">[\s\S]*?<\/span><\/span>/.exec(head)![0])).toBe("1 of 2 done");
  });

  it("names each estimate total in words and leaves out the empty ones", () => {
    const head = headOf(drawBoard([
      issue("MOCK-1", { estimate: 3 * DAY }),
      issue("MOCK-2", { estimate: 2 * 3600, status: status("Done", "done") }),
      issue("MOCK-3", { status: status("In Progress", "indeterminate") }),
    ]));
    expect(head).toContain('<span class="jr-total" data-cat="new" title="To do: 3d estimated">To do 3d</span>');
    expect(head).toContain('<span class="jr-total" data-cat="done" title="Done: 2h estimated">Done 2h</span>');
    expect(head).not.toContain('data-cat="indeterminate"');
    expect(head).not.toMatch(/>0m<|In progress 0/);
  });

  it("names story points as such, and gives a board that counts issues no totals at all", () => {
    const points = { ...OVERVIEW, estimation: { kind: "points" as const, fieldId: "f", label: "Story points" } };
    expect(headOf(drawBoard([issue("MOCK-1", { points: 5 })], {}, points))).toContain('title="To do: 5 story points">To do 5</span>');
    const count = { ...OVERVIEW, estimation: { kind: "count" as const, fieldId: null, label: "Issue count" } };
    expect(headOf(drawBoard([issue("MOCK-1"), issue("MOCK-2")], {}, count))).not.toContain("jr-totals");
  });

  it("gives a kanban column, one status already, a single total", () => {
    const kanban = { ...OVERVIEW, board: { ...OVERVIEW.board, type: "kanban" }, hasSprints: false, sprints: { active: [], future: [] } };
    const head = headOf(drawBoard([issue("MOCK-1", { estimate: DAY }), issue("MOCK-2", { estimate: 2 * DAY })], {}, kanban));
    expect(head.match(/class="jr-total"/g)).toHaveLength(1);
    expect(head).toContain('<span class="jr-total" title="Total: 3d estimated">Total 3d</span>');
  });

  it("marks the active sprint in sentence case", () => {
    expect(headOf(drawBoard([issue("MOCK-1")]))).toContain('<span class="jr-badge">Active</span>');
  });

  it("gives a closed sprint not yet opened a dash, not a count on its way", () => {
    const closed: GroupDef = { id: "sprint:9", kind: "closed", title: "Sprint 9", sprint: { ...SPRINT, id: 9, name: "Sprint 9", state: "closed" }, defaultOpen: false, paged: true };
    const html = drawBoard([issue("MOCK-1")], { groups: [...groupsFor(OVERVIEW), closed] });
    const head = /<section class="jr-group" data-kind="closed"[\s\S]*?<\/section>/.exec(html)![0];
    expect(head).toContain('<span class="jr-group-count" title="Counted when you open it"><span aria-hidden="true">—</span><span class="vis-hidden">issues counted when opened</span></span>');
    expect(head).not.toContain("…");
  });
});

describe("Needs attention keeps the issues to look at first", () => {
  it("keeps a flagged issue and a parent drawn for a sub-task that needs attention, and only that sub-task under it", () => {
    const theirs = issue("MOCK-10", { subtaskKeys: ["MOCK-11", "MOCK-12"] });
    const urgent = subOf("MOCK-11", theirs, { assignee: ME, mine: true, priority: HIGHEST });
    const calm = subOf("MOCK-12", theirs, { assignee: ME, mine: true });
    const html = drawBoard([urgent, calm, issue("MOCK-20", { flagged: true }), issue("MOCK-30")],
      { filter: { search: "", hideDone: false, attention: true }, filtered: true }, OVERVIEW,
      { "MOCK-10": { status: "ready", issues: [urgent, calm], error: null } });
    expect(Object.keys(rows(html)).sort()).toEqual(["MOCK-10", "MOCK-11", "MOCK-20"]);
  });
});

describe("what the reader opens fades in, and nothing else does", () => {
  const sheet = readFileSync(fileURLToPath(new URL("../styles/jira.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const source = readFileSync(fileURLToPath(new URL("../components/JiraBacklog.tsx", import.meta.url)), "utf8");

  it("draws a group open from the start, and a parent's sub-tasks open from the start, without a fade", () => {
    const theirs = issue("MOCK-10");
    const html = drawBoard([subOf("MOCK-11", theirs, { assignee: ME, mine: true }), issue("MOCK-20")]);
    expect(html).toContain('class="jr-group-body"');
    expect(html).toContain('class="jr-subrows"');
    expect(html).not.toContain("data-fade");
  });

  it("fades for 120ms in opacity only, skips a list of more than 30 rows, and stays still under reduced motion", () => {
    expect(sheet).toMatch(/\.jr-group-body\[data-fade\], \.jr-subrows\[data-fade\] \{ animation: jr-open 120ms ease-out; \}/);
    expect(/@keyframes jr-open \{([^}]*)\}/.exec(sheet)?.[1].trim()).toBe("from { opacity: 0;");
    expect(source).toMatch(/const fades = \(rows: number\) => rows <= 30;/);
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(sheet)?.[1] ?? "";
    expect(reduced).toMatch(/\.jr-group-body\[data-fade\], \.jr-subrows\[data-fade\] \{ animation: none; \}/);
  });
});

describe("nothing on a narrow screen widens its pane or loses its words", () => {
  const sheet = readFileSync(fileURLToPath(new URL("../styles/jira.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const block = (at: string) => {
    const start = sheet.indexOf(at);
    expect(start, at).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = sheet.indexOf("{", start); i < sheet.length; i++) {
      if (sheet[i] === "{") depth++;
      else if (sheet[i] === "}" && --depth === 0) return sheet.slice(start, i + 1);
    }
    return "";
  };

  it("wraps a sprint's named totals rather than running them past a 320px list", () => {
    expect(sheet).toMatch(/\.jr-totals \{[^}]*flex-wrap: wrap;[^}]*min-width: 0;/);
  });

  it("keeps a person in an issue's field to the field's width, so a long name ends in an ellipsis", () => {
    expect(sheet).toMatch(/\.jr-field dd > \.ig-person \{ max-width: 100%; \}/);
  });

  it("on a narrow panel, keeps freshness visible above a full-width search and reachable filters", () => {
    const phone = block("@container jira-panel (max-width: 700px)");
    expect(phone).toMatch(/\.jr-toolbar \{ display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
    expect(phone).toMatch(/\.jr-filters \{[^}]*grid-column: 1 \/ -1;[^}]*grid-row: 2;/);
    expect(phone).toMatch(/\.jr-filters > \.ig-search \{ flex: 1 1 100%; \}/);
  });

  it("on a phone, keeps a row's flag, epic and estimate on its third line, the epic giving way", () => {
    const narrow = block("@container jira-list (max-width: 360px)");
    expect(narrow).toMatch(/\.jr-facts \.jr-meta \{[^}]*grid-row: 3;[^}]*flex-wrap: nowrap;/);
    // Fix versions, cut to a character or two beside an epic, wait for the issue's page.
    expect(narrow).toMatch(/\.jr-facts \.jr-meta > \.jr-version \{ display: none; \}/);
    expect(sheet).toMatch(/\.jr-meta > \* \{ min-width: 0; flex: 0 1 auto; \}/);
  });

  it("on a phone, keeps an issue's key whole and lets its status give way", () => {
    const narrow = block("@container jira-list (max-width: 360px)");
    // The key's column takes its words' width first; the status's takes what
    // is left. Only a key longer than the line is cut.
    expect(narrow).toMatch(/\.jr-row-main \{[^}]*grid-template-columns: 16px 16px minmax\(0, max-content\) minmax\(0, 1fr\) 20px;/);
    expect(narrow).toMatch(/\.jr-row-main > \.jr-key \{ grid-column: 3; grid-row: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/);
    expect(narrow).toMatch(/\.jr-facts \.jr-status-cell > \.jr-status \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;/);
    expect(sheet).toMatch(/\.jr-status(?:, [^{]+)? \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
  });
});


describe("group read failures and closed-sprint discovery", () => {
  const failure = new IntegrationFailure("network", "Offline for this test");
  const snapshot = (): BoardSnapshot => ({ overview: OVERVIEW, groups: {
    "sprint:13": { status: "ready", issues: [], next: "", total: 0, capped: false, error: null, more: false },
  }, subtasks: {}, closed: { shown: true, sprints: [], total: 0, isLast: false, loading: false, error: null }, loadedAt: 1 });
  it("renders a failed further page without removing loaded issues or its cursor", () => {
    const snap = snapshot();
    const group = groupsFor(OVERVIEW)[0];
    snap.groups = { [group.id]: { status: "ready", issues: [issue("MOCK-1")], next: "next-page", total: 2, capped: false, more: false, error: failure } };
    const html = drawBoard([], { snap, groups: [{ ...group, paged: true }] });
    expect(html).toContain("More issues could not be read");
    expect(html).toContain("Try again");
    expect(html).toContain('data-key="MOCK-1"');
    expect(html).toContain("Show more (1 of 2)");
  });
  it("uses quiet empty styling only for a confirmed, complete, successful read", () => {
    const snap = snapshot(); const group = groupsFor(OVERVIEW)[0];
    snap.groups = { [group.id]: { status: "ready", issues: [], next: "", total: 0, capped: false, error: null, more: false } };
    expect(drawBoard([], { snap })).toContain('data-empty="true"');
    snap.groups[group.id].error = failure;
    expect(drawBoard([], { snap })).not.toContain('data-empty="true"');
    snap.groups[group.id].error = null; snap.groups[group.id].next = "next-page";
    expect(drawBoard([], { snap })).not.toContain('data-empty="true"');
    snap.groups[group.id].next = ""; snap.groups[group.id].status = "loading";
    expect(drawBoard([], { snap })).not.toContain('data-empty="true"');
  });
  it("shows a closed discovery error with direct recovery, without claiming emptiness", () => {
    const snap = snapshot(); snap.closed.error = failure;
    const html = drawBoard([], { snap });
    expect(html).toContain("Closed sprints could not be read");
    expect(html).toContain("Try again");
    expect(html).not.toContain("No closed sprints on this board.");
  });
  it("distinguishes loading, confirmed emptiness and hidden discovery", () => {
    const snap = snapshot(); snap.closed.loading = true;
    const loading = drawBoard([], { snap });
    expect(loading).toContain("Reading closed sprints…");
    expect(loading).not.toContain("No closed sprints on this board.");
    expect(loading).toContain('aria-expanded="true"');
    snap.closed.loading = false;
    expect(drawBoard([], { snap })).toContain("No closed sprints on this board.");
    snap.closed.shown = false; snap.closed.error = failure;
    const hidden = drawBoard([], { snap });
    expect(hidden).not.toContain("Closed sprints could not be read");
    expect(hidden).toContain("Show closed sprints");
  });
});
