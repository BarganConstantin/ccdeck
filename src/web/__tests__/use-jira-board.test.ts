import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, mount } from "./fake-react";
import type { JiraApi, JiraBoardOverview, JiraIssue, JiraIssuePage, JiraSprint } from "../jira-api";
import { IntegrationFailure } from "../integrations/client";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../jira-api", () => ({
  readBoard: vi.fn(), readIssues: vi.fn(), readClosedSprints: vi.fn(),
  readSubtasks: vi.fn(), readIssue: vi.fn(),
}));
const { readBoard, readIssues, readClosedSprints } = await import("../jira-api");
const { useJiraBoard } = await import("../use-jira-board");

const overview: JiraBoardOverview = {
  board: { id: 1, name: "Test board", type: "scrum", projectKey: "TEST", projectName: "Test" },
  estimation: { kind: "count", fieldId: null, label: "Issues" }, quickFilters: [],
  sprints: { active: [], future: [] }, hasSprints: true, hasBacklog: true,
  timeTracking: { hoursPerDay: 8, daysPerWeek: 5 },
};
const sprint: JiraSprint = {
  id: 7, name: "Past sprint", state: "closed", startDate: null, endDate: null, completeDate: null, goal: "",
};
const closedPage = { sprints: [sprint], startAt: 0, total: 1, isLast: true };
const page = (extra: Partial<JiraIssuePage> = {}): JiraIssuePage => ({ issues: [], next: "", total: 0, capped: false, ...extra });
const issue = (key: string): JiraIssue => ({
  id: key, key, summary: key, url: `https://jira.example.com/browse/${key}`,
  type: { name: "Task", icon: null, subtask: false, epic: false }, status: { name: "To Do", category: "new" },
  priority: null, assignee: null, mine: false, parent: null, subtaskKeys: [], epic: null,
  fixVersions: [], estimate: null, remaining: null, points: null, flagged: false, updated: "",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
let connection = 0;
const unmounts: Array<() => void> = [];
async function open() {
  let state!: ReturnType<typeof useJiraBoard>;
  const connId = `hook-test-${++connection}`;
  const api: JiraApi = async () => { throw new Error("Unexpected transport call"); };
  const view = mount(() => { state = useJiraBoard(api, connId, "1", { mine: false, quick: [] }); }, {});
  unmounts.push(view.unmount);
  await flush();
  return { get state() { return state; }, get backlog() { return state.groups.find(g => g.kind === "backlog")!; } };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readBoard).mockResolvedValue(overview);
  vi.mocked(readIssues).mockResolvedValue(page());
});
afterEach(() => { for (const unmount of unmounts.splice(0)) unmount(); });

describe("closed sprint discovery", () => {
  it("keeps a user's Hide choice when the pending first page arrives, and caches its results", async () => {
    const pending = deferred<typeof closedPage>();
    vi.mocked(readClosedSprints).mockReturnValue(pending.promise);
    const view = await open();
    view.state.showClosed(true);
    expect(view.state.snap.closed.loading).toBe(true);
    view.state.showClosed(false);
    pending.resolve(closedPage);
    await flush();
    expect(view.state.snap.closed).toMatchObject({ shown: false, loading: false, sprints: [sprint] });
    expect(view.state.groups.some(g => g.kind === "closed")).toBe(false);
    view.state.showClosed(true);
    expect(view.state.groups.some(g => g.kind === "closed")).toBe(true);
    expect(readClosedSprints).toHaveBeenCalledTimes(1);
  });

  it("also preserves Hide while an older page is pending", async () => {
    vi.mocked(readClosedSprints).mockResolvedValueOnce({ ...closedPage, total: 2, isLast: false });
    const pending = deferred<typeof closedPage>();
    vi.mocked(readClosedSprints).mockReturnValueOnce(pending.promise);
    const view = await open();
    view.state.showClosed(true);
    await flush();
    view.state.moreClosed();
    view.state.showClosed(false);
    const older = { ...sprint, id: 6 };
    pending.resolve({ sprints: [older], startAt: 1, total: 2, isLast: true });
    await flush();
    expect(view.state.snap.closed).toMatchObject({ shown: false, loading: false, sprints: [sprint, older] });
  });

  it("retries a failed first read directly through showClosed(true), without duplicate pending reads", async () => {
    const failure = new IntegrationFailure("network", "Cannot read sprints");
    vi.mocked(readClosedSprints).mockRejectedValueOnce(failure);
    const view = await open();
    view.state.showClosed(true);
    await flush();
    expect(view.state.snap.closed).toMatchObject({ shown: true, loading: false, error: failure, sprints: [] });
    const retry = deferred<typeof closedPage>();
    vi.mocked(readClosedSprints).mockReturnValueOnce(retry.promise);
    view.state.showClosed(true);
    view.state.showClosed(true);
    expect(view.state.snap.closed).toMatchObject({ shown: true, loading: true, error: null });
    expect(readClosedSprints).toHaveBeenCalledTimes(2);
    retry.resolve(closedPage);
    await flush();
    expect(view.state.snap.closed).toMatchObject({ shown: true, loading: false, error: null, sprints: [sprint] });
    expect(readClosedSprints).toHaveBeenLastCalledWith(expect.anything(), "1", 0);
  });
});

describe("backlog pagination recovery", () => {
  it("retains rows and cursor on failure, then retries that same page without replacing loaded rows", async () => {
    const first = issue("TEST-1"), second = issue("TEST-2");
    vi.mocked(readIssues).mockResolvedValueOnce(page({ issues: [first], next: "cursor-2", total: 2 }));
    const view = await open();
    const failure = new IntegrationFailure("rate-limit", "Please wait");
    vi.mocked(readIssues).mockRejectedValueOnce(failure);
    view.state.loadMore(view.backlog);
    await flush();
    expect(view.state.snap.groups[view.backlog.id]).toMatchObject({
      status: "ready", issues: [first], next: "cursor-2", error: failure, more: false,
    });
    const retry = deferred<JiraIssuePage>();
    vi.mocked(readIssues).mockReturnValueOnce(retry.promise);
    view.state.loadMore(view.backlog);
    view.state.loadMore(view.backlog);
    expect(readIssues).toHaveBeenCalledTimes(3);
    expect(view.state.snap.groups[view.backlog.id]).toMatchObject({ error: null, more: true });
    expect(readIssues).toHaveBeenLastCalledWith(expect.anything(), "1", expect.objectContaining({ source: "backlog", cursor: "cursor-2" }));
    retry.resolve(page({ issues: [first, second], total: null }));
    await flush();
    expect(view.state.snap.groups[view.backlog.id]).toMatchObject({
      status: "ready", issues: [first, second], next: "", total: 2, error: null, more: false,
    });
  });

  it("adopts the next page's cap metadata so truncated results remain disclosed", async () => {
    vi.mocked(readIssues).mockResolvedValueOnce(page({ issues: [issue("TEST-1")], next: "cursor-2" }));
    const view = await open();
    vi.mocked(readIssues).mockResolvedValueOnce(page({ issues: [issue("TEST-2")], capped: true }));
    view.state.loadMore(view.backlog);
    await flush();
    expect(view.state.snap.groups[view.backlog.id]).toMatchObject({ capped: true, next: "", more: false });
  });
});
