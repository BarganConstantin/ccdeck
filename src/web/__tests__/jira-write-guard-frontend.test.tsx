import { expect, it, vi } from "vitest";
import { flush, mount } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const { useJiraWriteState } = await import("../jira-write-state");
const { failureOf } = await import("../integrations/client");
const store = await import("../jira-write-store");
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

it("accepts a completed guard read while a comment draft is edited", async () => {
  let resolve!: (r: Response) => void;
  const api = vi.fn(() => new Promise<Response>(r => { resolve = r; }));
  let write!: ReturnType<typeof useJiraWriteState>;
  const view = mount(() => { write = useJiraWriteState("draft-read", "MOCK-1", "comment", api); }, {});
  write.update({ draft: "typing" });
  resolve(Response.json({ operations: [] })); await flush();
  expect(write.state.loading).toBe(false);
  expect(write.state.draft).toBe("typing");
  expect(write.begin("typing")).toBe(true);
  write.update({ busy: false, draft: "" }); view.unmount();
});

it("reconciles an acknowledgement already completed in another tab", async () => {
  const op = { ...operation, connectionId: "cross-tab", state: "uncertain" };
  let present = true;
  const api = vi.fn(async (path: string) => path === "write-guard" ? Response.json({ operations: present ? [op] : [] }) : new Response("", { status: 409 }));
  let write!: ReturnType<typeof useJiraWriteState>;
  const view = mount(() => { write = useJiraWriteState("cross-tab", "MOCK-1", "comment", api); }, {});
  await flush();
  present = false;
  expect(await write.acknowledge()).toBe(true);
  expect(write.state.uncertain).toBe(false);
  view.unmount();
});

it("keeps a replacement operation locked after an acknowledgement conflict", async () => {
  const a = { ...operation, connectionId: "cross-tab-new", state: "uncertain" };
  const b = { ...a, operationId: "22222222-2222-2222-2222-222222222222" };
  let current = a;
  const api = vi.fn(async (path: string) => path === "write-guard" ? Response.json({ operations: [current] }) : new Response("", { status: 409 }));
  let write!: ReturnType<typeof useJiraWriteState>;
  const view = mount(() => { write = useJiraWriteState("cross-tab-new", "MOCK-1", "comment", api); }, {});
  await flush(); current = b;
  expect(await write.acknowledge()).toBe(false);
  expect(write.state.operation?.operationId).toBe(b.operationId);
  expect(write.state.uncertain).toBe(true);
  view.unmount();
});

it("does not clear a newer uncertain operation when an old acknowledgement returns", async () => {
  const a = { ...operation, connectionId: "ack-race", state: "uncertain" as const };
  const b = { ...a, operationId: "22222222-2222-2222-2222-222222222222" };
  let resolve!: (r: Response) => void;
  const api = vi.fn((path: string) => path === "write-guard" ? Promise.resolve(Response.json({ operations: [a] })) : new Promise<Response>(r => { resolve = r; }));
  let write!: ReturnType<typeof useJiraWriteState>;
  const view = mount(() => { write = useJiraWriteState("ack-race", "MOCK-1", "comment", api); }, {});
  await flush();
  const pending = write.acknowledge();
  write.update({ operation: b, uncertain: true, error: "Check the new write" });
  resolve(Response.json({ ok: true }));
  expect(await pending).toBe(false);
  expect(write.state.operation).toEqual(b);
  expect(write.state.uncertain).toBe(true);
  expect(write.state.error).toBe("Check the new write");
  view.unmount();
});

it("preserves local uncertainty when a guard read finds no receipt", async () => {
  const api = vi.fn(async () => Response.json({ operations: [] }));
  let write!: ReturnType<typeof useJiraWriteState>;
  const first = mount(() => { write = useJiraWriteState("local-uncertain", "MOCK-1", "comment", api); }, {});
  await flush(); write.update({ uncertain: true, draft: "keep" }); first.unmount();
  const next = mount(() => { write = useJiraWriteState("local-uncertain", "MOCK-1", "comment", api); }, {});
  await flush();
  expect(write.state.uncertain).toBe(true);
  expect(write.state.draft).toBe("keep");
  next.unmount();
});

it("releases idle cache entries but keeps unfinished work across unmounts", async () => {
  const api = vi.fn(async () => Response.json({ operations: [] }));
  let write!: ReturnType<typeof useJiraWriteState>;
  const idleKey = JSON.stringify(["cache-idle", "MOCK-1", "comment"]);
  const idle = mount(() => { write = useJiraWriteState("cache-idle", "MOCK-1", "comment", api); }, {});
  await flush(); idle.unmount();
  expect(store.states.has(idleKey)).toBe(false);
  expect(store.revisions.has(idleKey)).toBe(false);
  const heldKey = JSON.stringify(["cache-held", "MOCK-1", "comment"]);
  const held = mount(() => { write = useJiraWriteState("cache-held", "MOCK-1", "comment", api); }, {});
  await flush(); write.update({ draft: "draft", uncertain: true }); held.unmount();
  expect(store.states.get(heldKey)).toMatchObject({ draft: "draft", uncertain: true });
  const reopened = mount(() => { write = useJiraWriteState("cache-held", "MOCK-1", "comment", api); }, {});
  await flush(); expect(write.state.uncertain).toBe(true);
  expect(await write.acknowledge()).toBe(true);
  write.update({ draft: "" }); reopened.unmount();
  expect(store.states.has(heldKey)).toBe(false);
  expect(store.revisions.has(heldKey)).toBe(false);
});
