import { expect, it, vi } from "vitest";
import { flush, mount, one, textOf } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const { default: JiraCommentForm } = await import("../components/JiraCommentForm");
const { default: JiraTransition } = await import("../components/JiraTransition");
const { useJiraWriteState } = await import("../jira-write-state");

const button = (tree: unknown, label: string) => one(tree, el => el.type === "button" && textOf(el) === label)!;

it("keeps a move locked across panel unmounts for the same connection", () => {
  let write!: ReturnType<typeof useJiraWriteState>;
  const first = mount(() => { write = useJiraWriteState("move-test", "", "move"); }, {});
  expect(write.begin()).toBe(true);
  first.unmount();
  const next = mount(() => { write = useJiraWriteState("move-test", "", "move"); }, {});
  expect(write.state.busy).toBe(true);
  expect(write.begin()).toBe(false);
  write.update({ busy: false, uncertain: true });
  expect(write.begin()).toBe(false);
  write.update({ uncertain: false });
  expect(write.begin()).toBe(true);
  write.update({ busy: false }); next.unmount();
});

it("keeps an in-flight comment locked when leaving and reopening its issue", async () => {
  vi.stubGlobal("window", globalThis);
  let finish!: (response: Response) => void;
  const api = vi.fn((path: string) => path === "write-guard" ? Promise.resolve(Response.json({ operations: [] })) : new Promise<Response>(resolve => { finish = resolve; }));
  const props = { api, connectionId: "lifecycle", issueKey: "MOCK-510", onChanged: vi.fn() };
  const first = mount(JiraCommentForm, props);
  await flush();
  (one(first.tree, e => e.type === "textarea")!.props.onChange as (e: unknown) => void)({ target: { value: "draft" } });
  const pending = (button(first.tree, "Add comment").props.onClick as () => Promise<void>)();
  first.unmount();
  const next = mount(JiraCommentForm, props);
  expect(button(next.tree, "Sending…").props["aria-busy"]).toBe(true);
  finish(Response.json({ error: { kind: "upstream", message: "unconfirmed" } }, { status: 502 }));
  await pending; await flush();
  expect(button(next.tree, "Add comment").props.disabled).toBe(true);
  expect(one(next.tree, e => e.type === "textarea")!.props.value).toBe("draft");
  expect(button(next.tree, "I checked the comments")).toBeTruthy();
  (one(next.tree, e => e.type === "textarea")!.props.onChange as (e: unknown) => void)({ target: { value: "edited draft" } });
  expect(one(next.tree, e => e.type === "textarea")!.props.value).toBe("edited draft");
  (button(next.tree, "I checked the comments").props.onClick as () => void)(); await flush();
  expect(one(next.tree, e => e.type === "textarea")!.props.value).toBe("edited draft");
  next.unmount(); vi.unstubAllGlobals();
});

it("keeps an unconfirmed transition blocked after reopening its issue", async () => {
  vi.stubGlobal("window", globalThis);
  const api = vi.fn(async (_path: string, init?: RequestInit) => _path === "write-guard" ? Response.json({ operations: [] }) : init?.method === "POST"
    ? Response.json({ error: { kind: "upstream", message: "unconfirmed" } }, { status: 502 })
    : Response.json({ transitions: [{ id: "11", name: "Start", to: "In Progress", requiresScreen: false }] }));
  const props = { api, connectionId: "lifecycle", issueKey: "MOCK-511", onChanged: vi.fn() };
  const first = mount(JiraTransition, props);
  (button(first.tree, "Change status").props.onClick as () => void)(); await flush();
  (one(first.tree, e => e.type === "select")!.props.onChange as (e: unknown) => void)({ target: { value: "11" } });
  await (button(first.tree, "Apply").props.onClick as () => Promise<void>)(); await flush();
  first.unmount();
  const next = mount(JiraTransition, props);
  await flush();
  expect(button(next.tree, "Change status").props["aria-expanded"]).toBe(true);
  expect(button(next.tree, "I checked the status")).toBeTruthy();
  expect(button(next.tree, "Apply").props.disabled).toBe(true);
  next.unmount(); vi.unstubAllGlobals();
});

it("clears a successful draft even when another form mounted during the write", async () => {
  vi.stubGlobal("window", globalThis);
  let finish!: (response: Response) => void;
  const api = vi.fn((path: string) => path === "write-guard" ? Promise.resolve(Response.json({ operations: [] })) : new Promise<Response>(resolve => { finish = resolve; }));
  const props = { api, connectionId: "lifecycle", issueKey: "MOCK-512", onChanged: vi.fn() };
  const first = mount(JiraCommentForm, props);
  await flush();
  (one(first.tree, e => e.type === "textarea")!.props.onChange as (e: unknown) => void)({ target: { value: "draft" } });
  const pending = (button(first.tree, "Add comment").props.onClick as () => Promise<void>)();
  first.unmount();
  const next = mount(JiraCommentForm, props);
  finish(Response.json({ ok: true, issueKey: "MOCK-512" })); await pending; await flush();
  expect(one(next.tree, e => e.type === "textarea")!.props.value).toBe("");
  expect(button(next.tree, "Add comment").props.disabled).toBe(true);
  next.unmount(); vi.unstubAllGlobals();
});

it("keeps locks separate between connections with the same issue key", async () => {
  vi.stubGlobal("window", globalThis);
  let finish!: (response: Response) => void;
  const api = vi.fn((path: string) => path === "write-guard" ? Promise.resolve(Response.json({ operations: [] })) : new Promise<Response>(resolve => { finish = resolve; }));
  const props = { api, connectionId: "connection-a", issueKey: "MOCK-513", onChanged: vi.fn() };
  const first = mount(JiraCommentForm, props);
  await flush();
  (one(first.tree, e => e.type === "textarea")!.props.onChange as (e: unknown) => void)({ target: { value: "draft" } });
  const pending = (button(first.tree, "Add comment").props.onClick as () => Promise<void>)();
  const other = mount(JiraCommentForm, { ...props, connectionId: "connection-b" });
  expect(one(other.tree, e => e.type === "textarea")!.props.readOnly).toBe(false);
  expect(one(other.tree, e => e.type === "textarea")!.props.value).toBe("");
  finish(Response.json({ ok: true, issueKey: "MOCK-513" })); await pending; await flush();
  first.unmount(); other.unmount(); vi.unstubAllGlobals();
});

it("treats an explicit Jira 400 rejection as definite", async () => {
  vi.stubGlobal("window", globalThis);
  const api = vi.fn(async (path: string) => path === "write-guard" ? Response.json({ operations: [] }) : Response.json({ error: { kind: "upstream", message: "Rejected", status: 400 } }, { status: 502 }));
  const view = mount(JiraCommentForm, { api, connectionId: "lifecycle", issueKey: "MOCK-514", onChanged: vi.fn() });
  await flush();
  (one(view.tree, e => e.type === "textarea")!.props.onChange as (e: unknown) => void)({ target: { value: "draft" } });
  await (button(view.tree, "Add comment").props.onClick as () => Promise<void>)(); await flush();
  expect(button(view.tree, "Add comment").props.disabled).toBe(false);
  expect(one(view.tree, e => e.type === "button" && textOf(e) === "I checked the comments")).toBeNull();
  expect(one(view.tree, e => e.type === "textarea")!.props.value).toBe("draft");
  (one(view.tree, e => e.type === "textarea")!.props.onChange as (e: unknown) => void)({ target: { value: "fixed draft" } });
  view.unmount();
  const reopened = mount(JiraCommentForm, { api, connectionId: "lifecycle", issueKey: "MOCK-514", onChanged: vi.fn() });
  expect(one(reopened.tree, e => e.type === "textarea")!.props.value).toBe("fixed draft");
  reopened.unmount(); vi.unstubAllGlobals();
});
