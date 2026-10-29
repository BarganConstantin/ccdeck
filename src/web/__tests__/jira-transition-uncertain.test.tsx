import { expect, it, vi } from "vitest";
import { flush, mount, one, textOf } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const { default: JiraTransition } = await import("../components/JiraTransition");

it("blocks another transition after an unconfirmed write until the user checks", async () => {
  vi.stubGlobal("window", globalThis);
  try {
    const api = vi.fn(async (_path: string, init?: RequestInit) => _path === "write-guard" ? Response.json({ operations: [] }) : init?.method === "POST"
      ? Response.json({ error: { kind: "upstream", message: "unconfirmed" } }, { status: 502 })
      : Response.json({ transitions: [{ id: "11", name: "Start", to: "In Progress", requiresScreen: false }] }));
    const view = mount(JiraTransition, { api, connectionId: "transition-test", issueKey: "MOCK-1", onChanged: vi.fn() });
    const button = (label: string) => one(view.tree, el => el.type === "button" && textOf(el) === label)!;
    (button("Change status").props.onClick as () => void)(); await flush();
    const select = one(view.tree, el => el.type === "select")!;
    (select.props.onChange as (event: unknown) => void)({ target: { value: "11" } });
    await (button("Apply").props.onClick as () => Promise<void>)(); await flush();
    expect(button("Apply").props.disabled).toBe(true);
    expect(api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    (button("I checked the status").props.onClick as () => void)(); await flush();
    expect(button("Apply").props.disabled).toBe(false);
    view.unmount();
  } finally { vi.unstubAllGlobals(); }
});
