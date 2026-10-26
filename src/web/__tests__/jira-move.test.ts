import { afterEach, describe, expect, it, vi } from "vitest";
import { issueMove, movableIssue, moveDestination } from "../jira-move";
import { moveJiraIssue, type JiraIssue } from "../jira-api";
import type { GroupDef } from "../jira-board";

const sprint: GroupDef = { id: "sprint:1", kind: "active", title: "Sprint 1", sprint: { id: 1, name: "Sprint 1", state: "active", goal: "", startDate: null, endDate: null, completeDate: null }, defaultOpen: true, paged: false };
const backlog: GroupDef = { id: "backlog", kind: "backlog", title: "Backlog", defaultOpen: true, paged: true };
const issue: JiraIssue = { id: "1", key: "MOCK-1", summary: "Move me", url: "", type: { name: "Task", subtask: false, epic: false, icon: null }, status: { name: "To Do", category: "new" }, priority: null, assignee: null, mine: true, parent: null, subtaskKeys: [], epic: null, fixVersions: [], estimate: null, remaining: null, points: null, flagged: false, updated: "" };

describe("one explicit Jira move", () => {
  it("keeps same-group drops meaningful and forbids self anchors", () => {
    expect(issueMove(issue, sprint, sprint)).toBeNull();
    expect(issueMove(issue, sprint, sprint, { key: issue.key, side: "before" })).toBeNull();
    expect(issueMove(issue, sprint, sprint, { key: "MOCK-2", side: "after" })).toEqual({ issueKey: "MOCK-1", target: { kind: "sprint", sprintId: 1 }, afterIssue: "MOCK-2" });
  });
  it("moves to backlog or before an explicit loaded neighbor, without changing status", () => {
    expect(issueMove(issue, sprint, backlog)).toEqual({ issueKey: "MOCK-1", target: { kind: "backlog" } });
    expect(issueMove(issue, backlog, sprint, { key: "MOCK-2", side: "before" })).toEqual({ issueKey: "MOCK-1", target: { kind: "sprint", sprintId: 1 }, beforeIssue: "MOCK-2" });
  });
  it("never offers closed sprints, workflow columns, subtasks, epics or completed work", () => {
    expect(moveDestination({ ...sprint, kind: "closed" })).toBeNull();
    expect(moveDestination({ ...sprint, sprint: { ...sprint.sprint!, state: "closed" } })).toBeNull();
    expect(moveDestination({ ...backlog, kind: "column", column: "todo" })).toBeNull();
    expect(movableIssue({ ...issue, type: { ...issue.type, subtask: true } }, sprint)).toBe(false);
    expect(movableIssue({ ...issue, type: { ...issue.type, epic: true } }, sprint)).toBe(false);
    expect(movableIssue({ ...issue, status: { name: "Done", category: "done" } }, sprint)).toBe(false);
  });
});

describe("Jira write transport", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const setup = () => vi.stubGlobal("window", { setTimeout, clearTimeout });
  const move = { issueKey: issue.key, target: { kind: "backlog" as const } };
  it("sends only the explicit move to this board's typed endpoint", async () => {
    setup();
    const api = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(moveJiraIssue(api, "123", move)).resolves.toEqual({});
    expect(api).toHaveBeenCalledTimes(1);
    const [path, init] = api.mock.calls[0];
    expect(path).toBe("board/123/move");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(move);
  });
  it("preserves permission errors without retrying or claiming success", async () => {
    setup();
    const api = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { kind: "permission", message: "Jira refused this move." } }), { status: 403 }));
    await expect(moveJiraIssue(api, "1", move)).rejects.toMatchObject({ kind: "permission", message: "Jira refused this move." });
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("does not replay an uncertain write after a disconnect or malformed success", async () => {
    setup();
    const api = vi.fn().mockRejectedValue(new Error("Disconnected"));
    await expect(moveJiraIssue(api, "1", move)).rejects.toThrow("Refresh the board before trying again");
    expect(api).toHaveBeenCalledTimes(1);
    const malformed = vi.fn().mockResolvedValue(new Response("Not JSON"));
    await expect(moveJiraIssue(malformed, "1", move)).rejects.toThrow("could not be confirmed");
    expect(malformed).toHaveBeenCalledTimes(1);
  });
  it.each([{ ok: false }, [], { ok: true, issueKey: "MOCK-2" }, { ok: true, issueKey: "MOCK-1", notice: { text: "Not a string" } }])("rejects an invalid success envelope %j", async body => {
    setup();
    const api = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(moveJiraIssue(api, "1", move)).rejects.toThrow("could not be confirmed");
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("keeps the deadline active while a response body stalls", async () => {
    vi.useFakeTimers();
    setup();
    const cancelled = vi.fn();
    const api = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {}, cancel: cancelled })));
    const pending = expect(moveJiraIssue(api, "1", move)).rejects.toThrow("could not be confirmed");
    await vi.advanceTimersByTimeAsync(45_001);
    await pending;
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
