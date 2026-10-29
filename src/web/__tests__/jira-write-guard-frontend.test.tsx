import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, mount } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const { useJiraWriteState } = await import("../jira-write-state");
const { failureOf } = await import("../integrations/client");
const store = await import("../jira-write-store");
const operation = { operationId: "11111111-1111-1111-1111-111111111111", connectionId: "guard-test", kind: "comment", issueKey: "MOCK-1", state: "pending" };
beforeEach(() => { vi.stubGlobal("window", globalThis); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("write guard polling lifetime", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function stalledRead(phase: "headers" | "body") {
    const signals: Array<AbortSignal | null | undefined> = [];
    const release: Array<() => void> = [];
    const api = vi.fn((_path: string, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      signals.push(signal);
      if (phase === "headers") return new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        release.push(() => resolve(Response.json({ operations: [] })));
      });
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"operations":['));
        let ended = false;
        signal?.addEventListener("abort", () => { if (!ended) { ended = true; controller.error(new DOMException("Aborted", "AbortError")); } }, { once: true });
        release.push(() => { if (!ended) { ended = true; controller.enqueue(new TextEncoder().encode("]}")); controller.close(); } });
      } })));
    });
    return { api, signals, release: () => release.forEach(finish => finish()) };
  }

  for (const phase of ["headers", "body"] as const) {
    it(`bounds a stalled ${phase} read without overlapping polls, then recovers`, async () => {
      const h = stalledRead(phase);
      let write!: ReturnType<typeof useJiraWriteState>;
      const view = mount(() => { write = useJiraWriteState(`poll-deadline-${phase}`, "MOCK-1", "comment", h.api); }, {});
      try {
        await flush();
        write.update({ draft: "keep my draft" });
        await vi.advanceTimersByTimeAsync(9000);
        expect(h.api).toHaveBeenCalledTimes(1);
        expect(write.begin()).toBe(false);
        await vi.advanceTimersByTimeAsync(21000); await flush();
        expect(h.signals[0]?.aborted).toBe(true);
        expect(write.state).toMatchObject({ loading: false, uncertain: true, draft: "keep my draft" });
        expect(write.state.error).toContain("Could not check Jira write safety");
        expect(write.begin()).toBe(false);
        h.release(); await flush();
        h.api.mockImplementation(async () => Response.json({ operations: [] }));
        const beforeRetry = h.api.mock.calls.length;
        await vi.advanceTimersByTimeAsync(3000); await flush();
        expect(h.api.mock.calls.length).toBeGreaterThan(beforeRetry);
        expect(await write.acknowledge()).toBe(true);
        expect(write.state.draft).toBe("keep my draft");
        expect(write.begin("keep my draft")).toBe(true);
        write.update({ busy: false, draft: "" });
      } finally { view.unmount(); h.release(); await flush(); }
    });

    it.each(["unmount", "key switch"] as const)(`aborts a stalled ${phase} read on %s`, async lifecycle => {
      const h = stalledRead(phase);
      const connectionId = `poll-cleanup-${phase}-${lifecycle}`;
      const key = JSON.stringify([connectionId, "MOCK-1", "comment"]);
      const view = mount(({ issueKey }) => useJiraWriteState(connectionId, issueKey, "comment", h.api), { issueKey: "MOCK-1" });
      try {
        await flush();
        if (lifecycle === "unmount") view.unmount();
        else view.rerender({ issueKey: "MOCK-2" });
        expect(h.signals[0]?.aborted).toBe(true);
        await flush();
        expect(store.states.has(key)).toBe(false);
        const afterCleanup = h.api.mock.calls.length;
        await vi.advanceTimersByTimeAsync(9000);
        expect(h.api).toHaveBeenCalledTimes(afterCleanup);
      } finally { view.unmount(); h.release(); await flush(); }
      expect(h.signals.every(signal => signal?.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  }
});

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

it("accepts acknowledgement when a poll observes the same completed write", async () => {
  vi.useFakeTimers();
  try {
    const op = { ...operation, connectionId: "poll-ack", kind: "status", state: "uncertain" };
    let guard = false;
    let resolve!: (response: Response) => void;
    const api = vi.fn((path: string) => path === "write-guard"
      ? Promise.resolve(Response.json({ operations: guard ? [op] : [] }))
      : new Promise<Response>(r => { resolve = r; }));
    let write!: ReturnType<typeof useJiraWriteState>;
    const view = mount(() => { write = useJiraWriteState("poll-ack", "MOCK-1", "transition", api); }, {});
    await flush();
    expect(write.begin()).toBe(true);
    write.update({ busy: false });
    const pending = write.acknowledge(op.operationId);
    guard = true;
    await vi.advanceTimersByTimeAsync(3000); await flush();
    guard = false; // The successful acknowledgement removed the receipt.
    resolve(Response.json({ ok: true }));
    expect(await pending).toBe(true);
    expect(write.state.uncertain).toBe(false);
    view.unmount();
  } finally { vi.useRealTimers(); }
});

it("keeps a replacement move's context when the first move finishes", async () => {
  const b = { ...operation, connectionId: "move-replaced", kind: "move", issueKey: undefined, issueKeys: ["MOCK-2"], boardId: 42, operationId: "22222222-2222-2222-2222-222222222222", state: "uncertain" };
  let replaced = false;
  const api = vi.fn(async (path: string) => path === "write-guard" ? Response.json({ operations: replaced ? [b] : [] }) : new Response("", { status: 409 }));
  let write!: ReturnType<typeof useJiraWriteState>;
  const view = mount(() => { write = useJiraWriteState("move-replaced", "", "move", api); }, {});
  await flush();
  // The move was already in flight when B was discovered.
  write.update({ busy: true, uncertain: false, operation: undefined, draft: "MOCK-1 · Board 42" });
  replaced = true;
  expect(await write.acknowledge(operation.operationId)).toBe(false);
  write.finishMove(true, "MOCK-1 · Board 42", operation.operationId);
  expect(write.state.operation?.operationId).toBe(b.operationId);
  expect(write.state.uncertain).toBe(true);
  expect(write.state.draft).toContain("MOCK-2");
  view.unmount();
});

it("discards a guard read that resolves after unmount and does not recreate its cache", async () => {
  let resolve!: (response: Response) => void;
  const api = vi.fn(() => new Promise<Response>(r => { resolve = r; }));
  const key = JSON.stringify(["stale-read", "MOCK-1", "comment"]);
  const view = mount(() => useJiraWriteState("stale-read", "MOCK-1", "comment", api), {});
  view.unmount();
  resolve(Response.json({ operations: [{ ...operation, connectionId: "stale-read", state: "uncertain" }] }));
  await flush();
  expect(store.states.has(key)).toBe(false);
  expect(store.revisions.has(key)).toBe(false);
});

it("settles an acknowledgement across unmount without resurrecting idle state", async () => {
  let resolve!: (response: Response) => void;
  const api = vi.fn((path: string) => path === "write-guard" ? Promise.resolve(Response.json({ operations: [] })) : new Promise<Response>(r => { resolve = r; }));
  let write!: ReturnType<typeof useJiraWriteState>;
  const key = JSON.stringify(["unmounted-ack", "MOCK-1", "comment"]);
  const view = mount(() => { write = useJiraWriteState("unmounted-ack", "MOCK-1", "comment", api); }, {});
  await flush();
  const pending = write.acknowledge(operation.operationId);
  view.unmount();
  resolve(Response.json({ ok: true }));
  expect(await pending).toBe(true);
  expect(store.states.has(key)).toBe(false);
  expect(store.revisions.has(key)).toBe(false);
});

it("releases a stalled acknowledgement and keeps the write locked", async () => {
  vi.useFakeTimers();
  try {
    const api = vi.fn((path: string, init?: RequestInit) => path === "write-guard" ? Promise.resolve(Response.json({ operations: [] })) : new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    let write!: ReturnType<typeof useJiraWriteState>;
    const view = mount(() => { write = useJiraWriteState("ack-timeout", "MOCK-1", "comment", api); }, {});
    await flush();
    const pending = write.acknowledge(operation.operationId);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(false);
    expect(write.state.loading).toBe(false);
    expect(write.state.uncertain).toBe(true);
    expect(write.begin()).toBe(false);
    view.unmount();
  } finally { vi.useRealTimers(); }
});

it("checks for a replacement after an acknowledgement succeeds", async () => {
  const a = { ...operation, connectionId: "ack-new-after-delete", state: "uncertain" };
  const b = { ...a, operationId: "22222222-2222-2222-2222-222222222222" };
  let current = a;
  let resolve!: (response: Response) => void;
  const api = vi.fn((path: string) => path === "write-guard"
    ? Promise.resolve(Response.json({ operations: [current] }))
    : new Promise<Response>(r => { resolve = r; }));
  let write!: ReturnType<typeof useJiraWriteState>;
  const view = mount(() => { write = useJiraWriteState(a.connectionId, "MOCK-1", "comment", api); }, {});
  await flush();
  const pending = write.acknowledge();
  current = b; // A was deleted and another tab started B before A's response arrived.
  resolve(Response.json({ ok: true }));
  expect(await pending).toBe(false);
  expect(write.state.operation?.operationId).toBe(b.operationId);
  expect(write.begin()).toBe(false);
  view.unmount();
});

it("does not restore a move warning after the replacement was checked", async () => {
  const b = { ...operation, connectionId: "move-checked", kind: "move", issueKey: undefined, issueKeys: ["MOCK-2"], boardId: 42, operationId: "22222222-2222-2222-2222-222222222222", state: "uncertain" };
  let current: typeof b | undefined;
  const api = vi.fn(async (path: string, init?: RequestInit) => path === "write-guard"
    ? Response.json({ operations: current ? [current] : [] })
    : JSON.parse(String(init?.body)).operationId === current?.operationId ? (current = undefined, Response.json({ ok: true })) : new Response("", { status: 409 }));
  let write!: ReturnType<typeof useJiraWriteState>;
  const view = mount(() => { write = useJiraWriteState(b.connectionId, "", "move", api); }, {});
  await flush();
  write.update({ busy: true, draft: "MOCK-1 · Board 42" });
  current = b;
  expect(await write.acknowledge(operation.operationId)).toBe(false);
  expect(write.state.operation?.operationId).toBe(b.operationId);
  const checkpoint = write.checkpoint();
  expect(await write.acknowledge()).toBe(true);
  write.finishMove(true, "MOCK-1 · Board 42", operation.operationId, checkpoint);
  expect(write.state.uncertain).toBe(false);
  expect(write.state.draft).toBe("");
  view.unmount();
});

it("lets a replacement acknowledgement finish while the old move refresh completes", async () => {
  const b = { ...operation, connectionId: "move-check-inflight", kind: "move", issueKey: undefined, issueKeys: ["MOCK-2"], boardId: 42, operationId: "22222222-2222-2222-2222-222222222222", state: "uncertain" };
  let current: typeof b | undefined;
  let resolve!: (response: Response) => void;
  const api = vi.fn((path: string, init?: RequestInit) => {
    if (path === "write-guard") return Promise.resolve(Response.json({ operations: current ? [current] : [] }));
    if (JSON.parse(String(init?.body)).operationId !== b.operationId) return Promise.resolve(new Response("", { status: 409 }));
    return new Promise<Response>(r => { resolve = r; });
  });
  let write!: ReturnType<typeof useJiraWriteState>;
  const view = mount(() => { write = useJiraWriteState(b.connectionId, "", "move", api); }, {});
  await flush();
  write.update({ busy: true, draft: "MOCK-1 · Board 42" });
  current = b;
  expect(await write.acknowledge(operation.operationId)).toBe(false);
  const checkpoint = write.checkpoint();
  const pending = write.acknowledge();
  write.finishMove(true, "MOCK-1 · Board 42", operation.operationId, checkpoint);
  current = undefined;
  resolve(Response.json({ ok: true }));
  expect(await pending).toBe(true);
  expect(write.state).toMatchObject({ busy: false, uncertain: false, draft: "" });
  view.unmount();
});
