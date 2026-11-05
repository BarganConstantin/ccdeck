// The Jira row menu: one issue's menu reads first (Open), then moves, then
// Copy link under a rule; several chosen issues get Move alone. Open and Copy
// link close the menu before they act.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { all, mount, one, textOf } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const { default: JiraMovePopover } = await import("../components/JiraMovePopover");
import type { GroupDef } from "../jira-board";
import type { JiraIssue } from "../jira-api";

beforeEach(() => vi.stubGlobal("window", globalThis));
afterEach(() => vi.unstubAllGlobals());

const backlog: GroupDef = { id: "backlog", kind: "backlog", title: "Backlog", defaultOpen: true, paged: true } as GroupDef;
const issue = (key: string) => ({
  id: key, key, summary: `Summary of ${key}`, url: `https://jira.example.test/browse/${key}`,
  type: { name: "Story", icon: null, subtask: false, epic: false }, status: { name: "To Do", category: "new" },
  priority: null, assignee: null, mine: false, parent: null, subtaskKeys: [], epic: null, fixVersions: [],
  estimate: null, remaining: null, points: null, flagged: false, updated: "",
}) as unknown as JiraIssue;

const props = (items: { issue: JiraIssue; group: GroupDef }[]) => ({
  items, groups: [backlog], snap: {} as never, anchorId: "anchor", portalId: "board", busy: false, error: "",
  initialView: "menu" as const, onMove: vi.fn(async () => true), onClose: vi.fn(), onOpen: vi.fn(), onCopyLink: vi.fn(),
});
const items = (tree: unknown) => all(tree, e => e.props?.role === "menuitem").map(e => textOf(e));

it("offers one issue Open, Move… and, under a rule, Copy link", () => {
  const p = props([{ issue: issue("MOCK-1"), group: backlog }]);
  const view = mount(JiraMovePopover, p);
  expect(items(view.tree)).toEqual(["Open", "Move…", "Copy link"]);
  expect(one(view.tree, e => e.props?.role === "separator")?.props.className).toBe("jr-action-sep");
  (one(view.tree, e => e.props?.role === "menuitem" && textOf(e) === "Open")!.props.onClick as () => void)();
  expect(p.onClose).toHaveBeenCalledTimes(1);
  expect(p.onOpen).toHaveBeenCalledTimes(1);
  expect(p.onClose.mock.invocationCallOrder[0]).toBeLessThan(p.onOpen.mock.invocationCallOrder[0]);
  (one(view.tree, e => e.props?.role === "menuitem" && textOf(e) === "Copy link")!.props.onClick as () => void)();
  expect(p.onCopyLink).toHaveBeenCalledTimes(1);
  view.unmount();
});

it("offers several chosen issues Move alone", () => {
  const view = mount(JiraMovePopover, props([{ issue: issue("MOCK-1"), group: backlog }, { issue: issue("MOCK-2"), group: backlog }]));
  expect(items(view.tree)).toEqual(["Move 2 issues…"]);
  expect(one(view.tree, e => e.props?.role === "separator")).toBeNull();
  view.unmount();
});

it("leaves Copy link out when the issue has no address to copy", () => {
  const view = mount(JiraMovePopover, { ...props([{ issue: issue("MOCK-1"), group: backlog }]), onCopyLink: undefined });
  expect(items(view.tree)).toEqual(["Open", "Move…"]);
  view.unmount();
});
