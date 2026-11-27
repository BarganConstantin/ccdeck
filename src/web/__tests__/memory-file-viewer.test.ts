// The Context tab's memory files, read: each row of either list (the one
// Claude Code's /context printed, the one the deck found on disk) is a button
// that opens MemoryFileDialog, which asks GET /api/session/memory-file for the
// row's path as it is written (`~/` included) and shows the answer as plain
// text in a <pre>, or one line when it cannot be read, or a note when only the
// first 256 KB came back. Escape closes it and focus goes back to the row.
//
// On fake-react.ts's React, so a press and the answer after it can be followed
// without a DOM; context-snapshot-tab.test.ts draws the rows' markup and
// memory-file-route.test.ts holds the route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";
import type { AgentNodeData, ContextSnapshot } from "../types";

vi.mock("react", async () => (await import("./fake-react")).react);
// The dialog is portalled to the body; here it is drawn where it is asked for.
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));

const { default: MemoryFileDialog } = await import("../components/MemoryFileDialog");
const { default: ContextSnapshotView } = await import("../components/ContextSnapshot");
const { ContextView } = await import("../components/ContextModal");
const { DialogHeader } = await import("../components/Dialog");
const { Loader } = await import("../components/Loader");
const { modalStack } = await import("../modal-dismiss");
const { setLanguage } = await import("../i18n");

type Props = Parameters<typeof MemoryFileDialog>[0];
const cls = (name: string) => (el: Drawn) => el.props.className === name;
const isType = (type: unknown) => (el: Drawn) => el.type === type;
const press = (el: Drawn | null) => (el!.props.onClick as () => void)();

let answer: { status: number; body: unknown };
let fetchMock: ReturnType<typeof vi.fn>;
let active: { tagName: string; isConnected: boolean; focus: () => void } | null;

beforeEach(() => {
  setLanguage("en");
  active = null;
  answer = { status: 200, body: { path: "/home/me/.claude/CLAUDE.md", name: "CLAUDE.md", scope: "user", bytes: 30, text: "# Rules\n<script>x</script>\n", truncated: false } };
  fetchMock = vi.fn(async () => ({ ok: answer.status < 300, status: answer.status, json: async () => answer.body }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("document", {
    get activeElement() { return active; },
    body: { tagName: "BODY" },
    documentElement: { dataset: {} },
  });
  vi.stubGlobal("window", {
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function open(over: Partial<Props> = {}) {
  const onClose = vi.fn();
  const view = mount(MemoryFileDialog, {
    target: { path: "~/.claude/CLAUDE.md", source: "loaded" }, session: "s1", provider: "claude", onClose, ...over,
  } as Props);
  return { view, onClose };
}
const asked = () => {
  const url = new URL(String(fetchMock.mock.calls[0][0]), "http://deck");
  return { route: url.pathname, query: Object.fromEntries(url.searchParams) };
};

describe("the viewer", () => {
  it("asks for the row's path as written, for the session, and shows the text in a <pre>", async () => {
    const { view } = open();
    // Waiting: the kit's Loader beside the words, which carry the status.
    expect(one(view.tree, isType(Loader))).not.toBeNull();
    expect(textOf(one(view.tree, cls("mf-state")))).toBe("Reading the file…");
    expect(one(view.tree, cls("mf-state"))!.props.role).toBe("status");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(asked()).toEqual({ route: "/api/session/memory-file", query: { session: "s1", provider: "claude", path: "~/.claude/CLAUDE.md" } });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    const pre = one(view.tree, isType("pre"))!;
    // The text itself as the child: never markup.
    expect(pre.props.children).toBe("# Rules\n<script>x</script>\n");
    expect(pre.props.dangerouslySetInnerHTML).toBeUndefined();
    expect(all(view.tree, el => el.props.dangerouslySetInnerHTML !== undefined)).toEqual([]);
    expect(one(view.tree, isType(Loader))).toBeNull();
    expect(one(view.tree, cls("mf-note"))).toBeNull();
    view.unmount();
  });

  it("is titled by the file's name, with its path, its kind and where the row came from", async () => {
    const { view } = open();
    expect(one(view.tree, isType(DialogHeader))!.props.title).toBe("CLAUDE.md");
    // Before the answer: the row's own path, and only the source.
    expect(textOf(one(view.tree, cls("mf-scope")))).toBe("Loaded by Claude Code");
    await flush();
    expect(textOf(one(view.tree, cls("mf-scope")))).toBe("User · Loaded by Claude Code");
    const path = all(view.tree, el => typeof el.props.path === "string")[0];
    expect(path.props.path).toBe("/home/me/.claude/CLAUDE.md");
    expect(textOf(one(view.tree, cls("mf-readonly")))).toBe("Read-only");
    view.unmount();
  });

  it("says in one line when the file can no longer be read", async () => {
    answer = { status: 404, body: { reason: "not_found" } };
    const { view } = open();
    await flush();
    expect(textOf(one(view.tree, cls("mf-state")))).toBe("This file can no longer be read.");
    expect(one(view.tree, isType("pre"))).toBeNull();
    expect(one(view.tree, isType(Loader))).toBeNull();
    view.unmount();
  });

  it("treats an answer of the wrong shape, or a failed fetch, the same way", async () => {
    answer = { status: 200, body: { path: "/x/CLAUDE.md", text: 7 } };
    const first = open();
    await flush();
    expect(textOf(one(first.view.tree, cls("mf-state")))).toBe("This file can no longer be read.");
    first.view.unmount();
    fetchMock.mockImplementationOnce(async () => { throw new TypeError("offline"); });
    const second = open();
    await flush();
    expect(textOf(one(second.view.tree, cls("mf-state")))).toBe("This file can no longer be read.");
    second.view.unmount();
  });

  it("says when only the first 256 KB came back", async () => {
    answer = { status: 200, body: { path: "/w/CLAUDE.md", name: "CLAUDE.md", scope: "project", bytes: 400_000, text: "a".repeat(10), truncated: true } };
    const { view } = open({ target: { path: "/w/CLAUDE.md", source: "disk" } });
    await flush();
    expect(textOf(one(view.tree, cls("mf-note")))).toBe("Showing the first 256 KB.");
    expect(one(view.tree, isType("pre"))!.props.children).toBe("aaaaaaaaaa");
    expect(textOf(one(view.tree, cls("mf-scope")))).toBe("Project · Found on disk");
    view.unmount();
  });

  it("asks for a Codex session's AGENTS.md as Codex", async () => {
    answer = { status: 200, body: { path: "/w/AGENTS.md", name: "AGENTS.md", scope: "project", bytes: 3, text: "hi\n", truncated: false } };
    const { view } = open({ target: { path: "/w/AGENTS.md", source: "disk" }, session: "codex-1", provider: "codex" });
    await flush();
    expect(asked().query).toEqual({ session: "codex-1", provider: "codex", path: "/w/AGENTS.md" });
    view.unmount();
  });

  it("copies the file's path", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { view } = open();
    await flush();
    const button = one(view.tree, el => el.type === "button" && textOf(el) === "Copy path");
    press(button);
    await flush();
    expect(writeText).toHaveBeenCalledWith("/home/me/.claude/CLAUDE.md");
    expect(one(view.tree, el => el.type === "button" && textOf(el) === "Path copied")).not.toBeNull();
    view.unmount();
  });

  it("closes on Escape and gives focus back to the row that opened it", async () => {
    const row = { tagName: "BUTTON", isConnected: true, focus: vi.fn() };
    active = row;
    const { view, onClose } = open();
    await flush();
    // Escape reaches the dialog on top (use-deck-shortcuts.ts → dismissTop).
    expect(modalStack.dismissTop()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    // The dialog leaves; focus had dropped to the floor with it.
    active = null;
    view.unmount();
    expect(row.focus).toHaveBeenCalledTimes(1);
    expect(modalStack.depth()).toBe(0);
  });
});

// ─── The rows that open it ──────────────────────────────────────────────────

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
const snapshot = (): ContextSnapshot => ({
  at: new Date(Date.now() - 60_000).toISOString(), model: "claude-opus-4-7", used: 30_000, max: 200_000, pct: 15, estimated: false,
  categories: [{ name: "Memory files", tokens: 26_900, pct: 13, deferred: false }],
  free: 170_000, buffer: null, mcpTools: [], mcpServers: [], agents: [], skills: [], more: {},
  memory: [{ type: "User", path: "~/.claude/CLAUDE.md", tokens: 12_400 }, { type: "Project", path: "/work/shop/CLAUDE.md", tokens: 14_500 }],
});
const agent = (over: Partial<AgentNodeData> = {}) => ({
  id: "s1", sessionId: "s1", label: "shop", kind: "root", state: "active", childCount: 0, tools: [], toolCount: 0,
  usage: NO_USAGE, prompts: [], startedAt: 1000, model: "claude-opus-4-7", contextWindow: 200_000, cwd: "/work/shop",
  context: { msgsUser: 1, msgsAssistant: 1, toolUses: 0, toolResults: 0, systemReminders: 0, currentContextTokens: 30_000, memoryFiles: [{ path: "/work/shop/CLAUDE.md", bytes: 2048 }] },
  ...over,
}) as unknown as AgentNodeData;
const opened = (tree: unknown) => one(tree, isType(MemoryFileDialog));

describe("the rows", () => {
  it("of the disk scan are buttons that open the viewer on the file, for the root session", () => {
    const view = mount(ContextView, { agent: agent({ id: "s1::sub", kind: "subagent", parentId: "s1" } as Partial<AgentNodeData>) });
    expect(opened(view.tree)).toBeNull();
    const rows = all(view.tree, cls("ctx-md-open"));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("button");
    expect(rows[0].props.type).toBe("button");
    press(rows[0]);
    expect(opened(view.tree)!.props).toMatchObject({
      target: { path: "/work/shop/CLAUDE.md", source: "disk" }, session: "s1", provider: "claude",
    });
    (opened(view.tree)!.props.onClose as () => void)();
    expect(opened(view.tree)).toBeNull();
    view.unmount();
  });

  it("of a Codex session open its AGENTS.md as Codex", () => {
    const view = mount(ContextView, { agent: agent({ provider: "codex", context: { ...agent().context!, memoryFiles: [{ path: "/w/AGENTS.md", bytes: 10 }] } }) });
    press(one(view.tree, cls("ctx-md-open")));
    expect(opened(view.tree)!.props).toMatchObject({ target: { path: "/w/AGENTS.md", source: "disk" }, provider: "codex" });
    view.unmount();
  });

  it("of /context's list are buttons that pass the path as printed, `~/` and all", () => {
    const view = mount(ContextView, { agent: agent({ context: { ...agent().context!, snapshot: snapshot() } }) });
    const snap = one(view.tree, isType(ContextSnapshotView))!;
    // The snapshot view draws its lists in a child of its own.
    const inner = mount(ContextSnapshotView, snap.props as Parameters<typeof ContextSnapshotView>[0]);
    const lists = all(inner.tree, el => typeof el.type === "function" && (el.type as { name: string }).name === "Lists")[0];
    const listView = mount(lists.type as (p: unknown) => unknown, lists.props);
    const rows = all(listView.tree, cls("ctx-md-open"));
    expect(rows.map(r => r.type)).toEqual(["button", "button"]);
    press(rows[0]);
    expect(opened(view.tree)!.props).toMatchObject({ target: { path: "~/.claude/CLAUDE.md", source: "loaded" }, session: "s1", provider: "claude" });
    listView.unmount();
    inner.unmount();
    view.unmount();
  });
});
