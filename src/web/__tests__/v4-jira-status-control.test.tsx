// The status is the control that changes it (V4's Figma). Opening it only reads the workflow
// actions; nothing is written until Apply, and Apply still goes through the write guard.
import { expect, it, vi } from "vitest";
import { flush, mount, one, textOf } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const { default: JiraTransition } = await import("../components/JiraTransition");

it("opening the status control only reads /transitions; the POST waits for Apply", async () => {
  vi.stubGlobal("window", globalThis);
  try {
    const api = vi.fn(async (path: string, init?: RequestInit) => path === "write-guard" ? Response.json({ operations: [] })
      : init?.method === "POST" ? Response.json({ ok: true, issueKey: "MOCK-3" })
      : Response.json({ transitions: [{ id: "11", name: "Start", to: "In Progress", requiresScreen: false }] }));
    const view = mount(JiraTransition, { api, connectionId: "status-control", issueKey: "MOCK-3", onChanged: vi.fn(), status: "To Do" });
    const status = one(view.tree, el => el.type === "button" && textOf(el) === "To Do")!;
    expect(status.props["aria-label"]).toBe("Change status: To Do");
    (status.props.onClick as () => void)(); await flush();
    const posts = () => api.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(api.mock.calls.some(([path]) => String(path) === "issue/MOCK-3/transitions")).toBe(true);
    expect(posts()).toHaveLength(0);
    (one(view.tree, el => el.type === "select")!.props.onChange as (event: unknown) => void)({ target: { value: "11" } });
    await flush();
    expect(posts()).toHaveLength(0);
    const apply = one(view.tree, el => el.type === "button" && textOf(el) === "Apply")!;
    await (apply.props.onClick as () => Promise<void>)(); await flush();
    expect(posts()).toHaveLength(1);
    // the write guard was asked first, as before
    expect(api.mock.calls.findIndex(([path]) => path === "write-guard")).toBeLessThan(api.mock.calls.findIndex(([, init]) => init?.method === "POST"));
    view.unmount();
  } finally { vi.unstubAllGlobals(); }
});
