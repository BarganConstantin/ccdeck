import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, mount } from "./fake-react";
import type { JiraApi, JiraBoardOverview, JiraIssue, JiraIssuePage, JiraSprint } from "../jira-api";
import { IntegrationFailure } from "../integrations/client";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../jira-api", () => ({
  readBoard: vi.fn(), readIssues: vi.fn(), readClosedSprints: vi.fn(),
  readSubtasks: vi.fn(), readIssue: vi.fn(),
}));
const { readBoard, readIssues, readClosedSprints, readSubtasks } = await import("../jira-api");
const { useJiraBoard, invalidateJiraConnection } = await import("../use-jira-board");

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

it("refuses an old board refresh after switching to another board", async () => {
  let state!: ReturnType<typeof useJiraBoard>;
  const api: JiraApi = async () => { throw new Error("Unexpected transport call"); };
  const conn = `hook-test-${++connection}`;
  const view = mount(({ board }: { board: string }) => { state = useJiraBoard(api, conn, board, { mine: false, quick: [] }); }, { board: "1" });
  unmounts.push(view.unmount);
  await flush();
  const oldRefresh = state.refresh;
  view.rerender({ board: "2" }); await flush();
  vi.mocked(readBoard).mockClear();
  await oldRefresh();
  expect(readBoard).not.toHaveBeenCalled();
});

it("refuses a late refresh after the board panel unmounts", async () => {
  const view = await open();
  const oldRefresh = view.state.refresh;
  unmounts.pop()!();
  vi.mocked(readBoard).mockClear();
  await oldRefresh();
  expect(readBoard).not.toHaveBeenCalled();
});

it("clears loading when switching from a pending board to a fresh cached board", async () => {
  const api: JiraApi = async () => { throw new Error("Unexpected transport call"); };
  const conn = `hook-test-${++connection}`;
  let state!: ReturnType<typeof useJiraBoard>;
  const view = mount(({ board }: { board: string }) => { state = useJiraBoard(api, conn, board, { mine: false, quick: [] }); }, { board: "1" });
  unmounts.push(view.unmount); await flush();
  const pending = deferred<JiraBoardOverview>();
  vi.mocked(readBoard).mockReturnValueOnce(pending.promise);
  view.rerender({ board: "2" }); await flush();
  expect(state.loading).toBe(true);
  view.rerender({ board: "1" }); await flush();
  expect(state.loading).toBe(false);
  pending.resolve(overview);
});

it("can load another backlog page after a refresh fails", async () => {
  vi.mocked(readIssues).mockResolvedValueOnce(page({ issues: [issue("TEST-1")], next: "next" }));
  const view = await open();
  vi.mocked(readBoard).mockRejectedValueOnce(new Error("offline"));
  await view.state.refresh();
  vi.mocked(readIssues).mockResolvedValueOnce(page({ issues: [issue("TEST-2")] }));
  view.state.loadMore(view.backlog); await flush();
  expect(view.state.snap.groups.backlog).toMatchObject({ issues: [issue("TEST-1"), issue("TEST-2")], more: false });
});

it("clears a closed-sprint read started during a refresh that fails", async () => {
  const view = await open();
  let fail!: (reason: unknown) => void;
  const overviewRead = new Promise<JiraBoardOverview>((_resolve, reject) => { fail = reject; });
  vi.mocked(readBoard).mockReturnValueOnce(overviewRead);
  const refresh = view.state.refresh();
  const closed = deferred<typeof closedPage>();
  vi.mocked(readClosedSprints).mockReturnValueOnce(closed.promise);
  view.state.showClosed(true);
  fail(new Error("offline")); await refresh;
  expect(view.state.snap.closed.loading).toBe(false);
  closed.resolve(closedPage);
});

it("refreshes a reopened board after an earlier panel's write finishes", async () => {
  const api: JiraApi = async () => { throw new Error("Unexpected transport call"); };
  const conn = `hook-test-${++connection}`;
  const first = mount(() => useJiraBoard(api, conn, "1", { mine: false, quick: [] }), {});
  await flush(); first.unmount();
  const reopened = mount(() => useJiraBoard(api, conn, "1", { mine: false, quick: [] }), {});
  unmounts.push(reopened.unmount); await flush();
  vi.mocked(readBoard).mockClear();
  invalidateJiraConnection(conn, true); await flush();
  expect(readBoard).toHaveBeenCalledOnce();
});

it("retries an interrupted refresh instead of reopening a stale snapshot as fresh", async () => {
  const api: JiraApi = async () => { throw new Error("Unexpected transport call"); };
  const conn = `hook-test-${++connection}`;
  const first = mount(() => useJiraBoard(api, conn, "1", { mine: false, quick: [] }), {});
  await flush();
  const pending = deferred<JiraIssuePage>();
  vi.mocked(readIssues).mockReturnValue(pending.promise);
  void invalidateJiraConnection(conn, true); await flush();
  first.unmount();
  vi.mocked(readBoard).mockClear();
  vi.mocked(readIssues).mockResolvedValue(page());
  let current!: ReturnType<typeof useJiraBoard>;
  const reopened = mount(() => { current = useJiraBoard(api, conn, "1", { mine: false, quick: [] }); }, {});
  unmounts.push(reopened.unmount); await flush();
  expect(readBoard).toHaveBeenCalledOnce();
  pending.resolve(page({ issues: [issue("MOCK-999")] })); await flush();
  expect(current.snap.groups.backlog?.issues).toEqual([]);
});

it("retries a partial refresh when the board is reopened", async () => {
  const api: JiraApi = async () => { throw new Error("Unexpected transport call"); };
  const conn = `hook-test-${++connection}`;
  vi.mocked(readIssues).mockRejectedValueOnce(new IntegrationFailure("upstream", "temporary group error"));
  const first = mount(() => useJiraBoard(api, conn, "1", { mine: false, quick: [] }), {});
  await flush(); first.unmount();
  vi.mocked(readBoard).mockClear();
  const reopened = mount(() => useJiraBoard(api, conn, "1", { mine: false, quick: [] }), {});
  unmounts.push(reopened.unmount); await flush();
  expect(readBoard).toHaveBeenCalledOnce();
});

describe("closed sprint discovery", () => {
  it("resumes an older closed-sprint page even if the list was hidden during refresh", async () => {
    const older = { ...sprint, id: 6, name: "Older" };
    vi.mocked(readClosedSprints).mockResolvedValueOnce({ ...closedPage, total: 2, isLast: false });
    const view = await open();
    view.state.showClosed(true); await flush();
    const pending = deferred<typeof closedPage>();
    vi.mocked(readClosedSprints).mockReturnValueOnce(pending.promise);
    view.state.moreClosed(); view.state.showClosed(false);
    vi.mocked(readClosedSprints).mockResolvedValueOnce({ ...closedPage, startAt: 1, total: 2, sprints: [older] });
    await view.state.refresh();
    pending.resolve(closedPage); await flush();
    expect(view.state.snap.closed).toMatchObject({ shown: false, loading: false, sprints: [sprint, older] });
  });
  it("rereads an interrupted hidden closed sprint even when it has old rows", async () => {
    const api: JiraApi = async () => { throw new Error("Unexpected transport call"); };
    const conn = `hook-test-${++connection}`;
    vi.mocked(readClosedSprints).mockResolvedValue(closedPage);
    let state!: ReturnType<typeof useJiraBoard>;
    const render = () => { state = useJiraBoard(api, conn, "1", { mine: false, quick: [] }); };
    const first = mount(render, {}); await flush();
    state.showClosed(true); await flush();
    const group = state.groups.find(g => g.kind === "closed")!;
    vi.mocked(readIssues).mockResolvedValueOnce(page({ issues: [issue("TEST-OLD")] }));
    state.ensureGroup(group); await flush();
    const pending = deferred<JiraIssuePage>();
    vi.mocked(readIssues).mockImplementation((_api, _board, q) => q.source === "sprint" ? pending.promise : Promise.resolve(page()));
    void state.refresh(); await flush();
    expect(state.snap.groups[group.id].status).toBe("loading");
    state.showClosed(false); first.unmount();
    vi.mocked(readIssues).mockResolvedValue(page({ issues: [issue("TEST-NEW")] }));
    const reopened = mount(render, {}); unmounts.push(reopened.unmount); await flush();
    state.showClosed(true); state.ensureGroup(group); await flush();
    expect(state.snap.groups[group.id].issues).toEqual([issue("TEST-NEW")]);
    pending.resolve(page());
  });
  it("continues closed-sprint discovery when filters change during the read", async () => {
    const api: JiraApi = async () => { throw new Error("Unexpected transport call"); };
    const conn = `hook-test-${++connection}`;
    let state!: ReturnType<typeof useJiraBoard>;
    const view = mount(({ mine }: { mine: boolean }) => { state = useJiraBoard(api, conn, "1", { mine, quick: [] }); }, { mine: false });
    unmounts.push(view.unmount); await flush();
    const pending = deferred<typeof closedPage>();
    vi.mocked(readClosedSprints).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(closedPage);
    state.showClosed(true);
    view.rerender({ mine: true }); await flush();
    expect(state.snap.closed).toMatchObject({ shown: true, loading: false, sprints: [sprint] });
    pending.resolve(closedPage);
  });
  it("resumes closed-sprint discovery after reopening a panel during its first read", async () => {
    const api: JiraApi = async () => { throw new Error("Unexpected transport call"); };
    const conn = `hook-test-${++connection}`;
    let state!: ReturnType<typeof useJiraBoard>;
    const render = () => { state = useJiraBoard(api, conn, "1", { mine: false, quick: [] }); };
    const first = mount(render, {}); await flush();
    const pending = deferred<typeof closedPage>();
    vi.mocked(readClosedSprints).mockReturnValueOnce(pending.promise);
    state.showClosed(true); first.unmount();
    vi.mocked(readClosedSprints).mockResolvedValueOnce(closedPage);
    const reopened = mount(render, {}); unmounts.push(reopened.unmount); await flush();
    expect(state.snap.closed).toMatchObject({ shown: true, loading: false, sprints: [sprint] });
    pending.resolve(closedPage);
  });
  it("ignores closed-sprint results from before a board refresh", async () => {
    const view = await open();
    const pending = deferred<typeof closedPage>();
    vi.mocked(readClosedSprints).mockReturnValueOnce(pending.promise);
    view.state.showClosed(true);
    const freshSprint = { ...sprint, id: 8, name: "Fresh sprint" };
    vi.mocked(readClosedSprints).mockResolvedValueOnce({ ...closedPage, sprints: [freshSprint] });
    await view.state.refresh();
    pending.resolve(closedPage); await flush();
    expect(view.state.snap.closed).toMatchObject({ loading: false, sprints: [freshSprint] });
  });
  it("retries a closed sprint interrupted before closing the panel", async () => {
    const api: JiraApi = async () => { throw new Error("Unexpected transport call"); };
    const conn = `hook-test-${++connection}`;
    vi.mocked(readClosedSprints).mockResolvedValue(closedPage);
    let state!: ReturnType<typeof useJiraBoard>;
    const render = () => { state = useJiraBoard(api, conn, "1", { mine: false, quick: [] }); };
    const first = mount(render, {}); await flush();
    state.showClosed(true); await flush();
    const group = state.groups.find(g => g.kind === "closed")!;
    const pending = deferred<JiraIssuePage>();
    vi.mocked(readIssues).mockReturnValueOnce(pending.promise);
    state.ensureGroup(group);
    expect(state.snap.groups[group.id].status).toBe("loading");
    state.showClosed(false); first.unmount();
    const reopened = mount(render, {}); unmounts.push(reopened.unmount); await flush();
    state.showClosed(true);
    state.ensureGroup(group); await flush();
    expect(state.snap.groups[group.id].status).toBe("ready");
    pending.resolve(page());
  });
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
    expect(readClosedSprints).toHaveBeenLastCalledWith(expect.anything(), "1", 0, expect.any(AbortSignal));
  });
});

describe("backlog pagination recovery", () => {
  it("ignores subtasks read before the refreshed overview arrived", async () => {
    const view = await open();
    const overviewRead = deferred<JiraBoardOverview>();
    vi.mocked(readBoard).mockReturnValueOnce(overviewRead.promise);
    const refresh = view.state.refresh();
    const subtasks = deferred<{ issues: JiraIssue[] }>();
    vi.mocked(readSubtasks).mockReturnValueOnce(subtasks.promise);
    view.state.loadSubtasks("TEST-1");
    overviewRead.resolve(overview); await refresh;
    subtasks.resolve({ issues: [issue("TEST-OLD")] }); await flush();
    expect(view.state.snap.subtasks["TEST-1"]).toBeUndefined();
  });
  it("ignores an old page that completes after a refresh", async () => {
    vi.mocked(readIssues).mockResolvedValueOnce(page({ issues: [issue("TEST-1")], next: "next" }));
    const view = await open();
    const pending = deferred<JiraIssuePage>();
    vi.mocked(readIssues).mockReturnValueOnce(pending.promise);
    view.state.loadMore(view.backlog);
    vi.mocked(readIssues).mockResolvedValueOnce(page({ issues: [issue("TEST-2")], next: "fresh" }));
    await view.state.refresh();
    pending.resolve(page({ issues: [issue("TEST-OLD")], next: "old" })); await flush();
    expect(view.state.snap.groups.backlog).toMatchObject({ issues: [issue("TEST-2")], next: "fresh", more: false });
  });
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
    expect(readIssues).toHaveBeenLastCalledWith(expect.anything(), "1", expect.objectContaining({ source: "backlog", cursor: "cursor-2" }), expect.any(AbortSignal));
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
