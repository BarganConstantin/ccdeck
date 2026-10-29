import { expect, it, vi } from "vitest";
import { flush, mount } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const { useJiraWriteState } = await import("../jira-write-state");
const { failureOf } = await import("../integrations/client");
const operation = { operationId: "11111111-1111-1111-1111-111111111111", connectionId: "guard-test", kind: "comment", issueKey: "MOCK-1", state: "pending" };

it("parses a guard conflict and retains its operation", async () => {
  const failure = await failureOf(Response.json({ ok: false, code: "jira_write_guard_conflict", operation }, { status: 409 }));
  expect(failure.operation).toEqual(operation);
});

it("hydrates a pending operation, preserves edits, and refuses acknowledgement until it finishes", async () => {
  let resolve!: (r: Response) => void;
  const api = vi.fn((path: string) => path === "write-guard" ? new Promise<Response>(r => { resolve = r; }) : Promise.resolve(Response.json({ ok: true })));
  let write!: ReturnType<typeof useJiraWriteState>;
  const view = mount(() => { write = useJiraWriteState("guard-test", "MOCK-1", "comment", api); }, {});
  expect(write.begin()).toBe(false);
  write.update({ draft: "my draft" });
  resolve(Response.json({ operations: [operation] })); await flush();
  expect(write.state.draft).toBe("my draft");
  expect(write.state.operation?.state).toBe("pending");
  expect(write.begin()).toBe(false);
  expect(await write.acknowledge()).toBe(false);
  expect(api.mock.calls.filter(([path]) => path === "write-guard/acknowledge")).toHaveLength(0);
  view.unmount();
});

it("keeps a confirmed write locked if acknowledgement fails", async () => {
  const api = vi.fn(async (path: string) => path === "write-guard" ? Response.json({ operations: [] }) : new Response("", { status: 503 }));
  let write!: ReturnType<typeof useJiraWriteState>;
  const view = mount(() => { write = useJiraWriteState("guard-other", "MOCK-2", "comment", api); }, {});
  await flush();
  expect(await write.acknowledge(operation.operationId)).toBe(false);
  expect(write.state.uncertain).toBe(true);
  expect(write.begin()).toBe(false);
  view.unmount();
});

it.each([401, 403])("treats a guarded %s response as uncertain regardless of error kind", async status => {
  const { definiteJiraWriteFailure } = await import("../jira-write-state");
  const failure = await failureOf(Response.json({ error: { kind: status === 401 ? "auth" : "permission", message: "Rejected", status }, operation: { ...operation, state: "uncertain" }, refresh: false }, { status }));
  expect(failure.operation?.state).toBe("uncertain");
  expect(definiteJiraWriteFailure(failure)).toBe(false);
});
