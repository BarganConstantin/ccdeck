// The Context tab's inventories, read: "All skills" at the foot of /context's
// Skills list opens SkillsDialog, which asks GET /api/session/skills for the
// session and sets the answer against the snapshot's Skills list: loaded (with
// its tokens) or installed. A search keeps the skills whose name or description
// holds it; a row opens the skill's detail in the same dialog, with its path to
// copy. Escape closes it and focus goes back to the button that opened it.
//
// On fake-react.ts's React, so a press and the answer after it can be followed
// without a DOM; context-inventory-route.test.ts holds the route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";
import type { AgentNodeData, ContextSnapshot } from "../types";

vi.mock("react", async () => (await import("./fake-react")).react);
// The dialog is portalled to the body; here it is drawn where it is asked for.
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));

const { default: SkillsDialog } = await import("../components/SkillsDialog");
const { default: ContextSnapshotView } = await import("../components/ContextSnapshot");
const { ContextView } = await import("../components/ContextModal");
const { DialogHeader } = await import("../components/Dialog");
const { Loader } = await import("../components/Loader");
const { default: PathText } = await import("../components/PathText");
const { modalStack } = await import("../modal-dismiss");
const { setLanguage } = await import("../i18n");
const { filterSkills, skillInventory } = await import("../context-inventory");

const cls = (name: string) => (el: Drawn) => el.props.className === name;
const isType = (type: unknown) => (el: Drawn) => el.type === type;
const press = (el: Drawn | null) => (el!.props.onClick as () => void)();
const button = (tree: unknown, text: string) => one(tree, el => el.type === "button" && textOf(el) === text);

const DISK = [
  { name: "deploy", scope: "user", description: "Ship the build to the staging box.", path: "/home/me/.claude/skills/deploy/SKILL.md" },
  { name: "review", scope: "project", description: "Review pull requests before merge.", path: "/work/shop/.claude/skills/review/SKILL.md" },
  { name: "Lint Fixer", scope: "project", description: "Fix what the linter reports.", path: "/work/shop/.claude/skills/lint/SKILL.md" },
];

let answer: { status: number; body: unknown };
let fetchMock: ReturnType<typeof vi.fn>;
let active: { tagName: string; isConnected: boolean; focus: () => void } | null;

beforeEach(() => {
  setLanguage("en");
  active = null;
  answer = { status: 200, body: { skills: DISK, truncated: false } };
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

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
const snapshot = (over: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
  at: new Date(Date.now() - 60_000).toISOString(), model: "claude-opus-4-7", used: 30_000, max: 200_000, pct: 15, estimated: false,
  categories: [{ name: "Skills", tokens: 2_000, pct: 1, deferred: false }],
  free: 170_000, buffer: null, mcpTools: [], mcpServers: [], agents: [], memory: [], more: {},
  skills: [
    { name: "deploy", source: "User", tokens: 120 },
    // Listed by its folder's name, not its frontmatter's.
    { name: "lint", source: "Project", tokens: 64 },
    { name: "docx", source: "Plugin (anthropic-skills)", tokens: 1_500 },
  ],
  ...over,
});

type Props = Parameters<typeof SkillsDialog>[0];
function open(over: Partial<Props> = {}) {
  const onClose = vi.fn();
  const view = mount(SkillsDialog, { session: "s1", snapshot: snapshot(), onClose, ...over } as Props);
  return { view, onClose };
}
const rowsOf = (tree: unknown) => all(tree, cls("ctx-md-open inv-row"));
const rowText = (row: Drawn) => ({
  name: textOf(one(row, cls("inv-row-name"))),
  state: textOf(one(row, cls("inv-row-state"))),
  sub: textOf(one(row, cls("inv-row-sub"))),
});

describe("the skills dialog", () => {
  it("asks for the session's skills, never cached, and waits with the kit's Loader", async () => {
    const { view } = open();
    expect(one(view.tree, isType(Loader))).not.toBeNull();
    expect(textOf(one(view.tree, cls("inv-state")))).toBe("Reading the skills…");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://deck");
    expect(url.pathname).toBe("/api/session/skills");
    expect(Object.fromEntries(url.searchParams)).toEqual({ session: "s1" });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    expect(one(view.tree, isType(DialogHeader))!.props).toMatchObject({ title: "Skills", note: "4" });
    view.unmount();
  });

  it("says which are loaded, with their tokens, and which are only installed", async () => {
    const { view } = open();
    await flush();
    expect(rowsOf(view.tree).map(rowText)).toEqual([
      { name: "deploy", state: "Loaded · 120", sub: "User · Ship the build to the staging box." },
      // Only /context knows a plugin's skill: loaded, with no description.
      { name: "docx", state: "Loaded · 1.5k", sub: "Plugin" },
      { name: "Lint Fixer", state: "Loaded · 64", sub: "Project · Fix what the linter reports." },
      { name: "review", state: "Installed", sub: "Project · Review pull requests before merge." },
    ]);
    expect(rowsOf(view.tree).every(r => r.type === "button" && r.props.type === "button")).toBe(true);
    view.unmount();
  });

  it("reads every skill as installed when the session has no snapshot", async () => {
    const { view } = open({ snapshot: null });
    await flush();
    expect(rowsOf(view.tree).map(r => rowText(r).state)).toEqual(["Installed", "Installed", "Installed"]);
    view.unmount();
  });

  it("keeps the skills whose name or description holds the search, and says how many", async () => {
    const { view } = open();
    await flush();
    const search = one(view.tree, el => el.type === "input")!;
    expect(search.props).toMatchObject({ type: "search", "aria-label": "Search skills", placeholder: "Search skills" });
    (search.props.onChange as (e: unknown) => void)({ currentTarget: { value: "STAGING" } });
    expect(rowsOf(view.tree).map(r => rowText(r).name)).toEqual(["deploy"]);
    expect(one(view.tree, isType(DialogHeader))!.props.note).toBe("1 of 4");
    (search.props.onChange as (e: unknown) => void)({ currentTarget: { value: "lint" } });
    expect(rowsOf(view.tree).map(r => rowText(r).name)).toEqual(["Lint Fixer"]);
    (search.props.onChange as (e: unknown) => void)({ currentTarget: { value: "nothing like it" } });
    expect(rowsOf(view.tree)).toEqual([]);
    expect(textOf(one(view.tree, cls("inv-state")))).toBe("No skill matches “nothing like it”.");
    view.unmount();
  });

  it("opens a skill's detail in the same dialog, and goes back to the list", async () => {
    const { view } = open();
    await flush();
    press(rowsOf(view.tree)[0]);
    expect(rowsOf(view.tree)).toEqual([]);
    expect(one(view.tree, el => el.type === "input")).toBeNull();
    expect(textOf(one(view.tree, cls("inv-detail-name")))).toBe("deploy");
    expect(textOf(one(view.tree, cls("inv-detail-meta")))).toBe("User · Loaded · 120");
    expect(textOf(one(view.tree, cls("inv-detail-desc")))).toBe("Ship the build to the staging box.");
    expect(one(view.tree, isType(PathText))!.props.path).toBe("/home/me/.claude/skills/deploy/SKILL.md");
    // Only the frontmatter's two strings were ever asked for: no second fetch for the body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(all(view.tree, el => el.props.dangerouslySetInnerHTML !== undefined)).toEqual([]);
    press(button(view.tree, "All skills"));
    expect(rowsOf(view.tree)).toHaveLength(4);
    view.unmount();
  });

  it("says a skill /context alone knows has no description and no path to copy", async () => {
    const { view } = open();
    await flush();
    press(rowsOf(view.tree)[1]);
    expect(textOf(one(view.tree, cls("inv-detail-meta")))).toBe("Plugin · Loaded · 1.5k");
    expect(textOf(one(view.tree, cls("inv-detail-desc")))).toBe("No description.");
    expect(one(view.tree, isType(PathText))).toBeNull();
    expect(button(view.tree, "Copy path")).toBeNull();
    view.unmount();
  });

  it("copies the skill's SKILL.md path", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { view } = open();
    await flush();
    expect(button(view.tree, "Copy path")).toBeNull();
    press(rowsOf(view.tree)[3]);
    press(button(view.tree, "Copy path"));
    await flush();
    expect(writeText).toHaveBeenCalledWith("/work/shop/.claude/skills/review/SKILL.md");
    expect(button(view.tree, "Path copied")).not.toBeNull();
    view.unmount();
  });

  it("says when /context left loaded skills unnamed, and when the list was cut", async () => {
    answer = { status: 200, body: { skills: DISK, truncated: true } };
    const { view } = open({ snapshot: snapshot({ more: { skills: { count: 40, tokens: 9_800 } } }) });
    await flush();
    expect(all(view.tree, cls("inv-note")).map(textOf)).toEqual([
      "The last /context left 40 loaded skills unnamed, so some marked Installed may be loaded.",
      "Showing the first 4 skills.",
    ]);
    view.unmount();
  });

  it("says in one line when the skills cannot be read, and when there are none", async () => {
    answer = { status: 404, body: { reason: "not_found" } };
    const failed = open();
    await flush();
    expect(textOf(one(failed.view.tree, cls("inv-state")))).toBe("The skills could not be read.");
    failed.view.unmount();
    answer = { status: 200, body: { skills: [], truncated: false } };
    const none = open({ snapshot: null });
    await flush();
    expect(textOf(one(none.view.tree, cls("inv-state")))).toBe("No skills are installed for this project.");
    expect(one(none.view.tree, el => el.type === "input")).toBeNull();
    none.view.unmount();
  });

  it("drops an answer of the wrong shape, row by row", async () => {
    answer = { status: 200, body: { skills: [DISK[0], { name: "x", scope: "system", description: "", path: "/x" }, { name: 3 }] } };
    const { view } = open({ snapshot: null });
    await flush();
    expect(rowsOf(view.tree).map(r => rowText(r).name)).toEqual(["deploy"]);
    view.unmount();
  });

  it("closes on Escape and gives focus back to the button that opened it", async () => {
    const opener = { tagName: "BUTTON", isConnected: true, focus: vi.fn() };
    active = opener;
    const { view, onClose } = open();
    await flush();
    press(rowsOf(view.tree)[0]);
    expect(modalStack.dismissTop()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    active = null;
    view.unmount();
    expect(opener.focus).toHaveBeenCalledTimes(1);
    expect(modalStack.depth()).toBe(0);
  });
});

describe("the inventory", () => {
  it("matches /context's row by name or folder, from the same source first", () => {
    const rows = skillInventory([
      { name: "deploy", scope: "user", description: "", path: "/u/skills/deploy/SKILL.md" },
      { name: "deploy", scope: "project", description: "", path: "/p/.claude/skills/deploy/SKILL.md" },
    ], snapshot({ skills: [{ name: "deploy", source: "Project", tokens: 50 }] }));
    expect(rows.map(r => [r.source, r.loaded, r.tokens])).toEqual([["project", true, 50], ["user", false, undefined]]);
  });

  it("searches names and descriptions, case aside, and keeps everything for an empty search", () => {
    const rows = skillInventory(DISK as never, null);
    expect(filterSkills(rows, "  ").map(r => r.name)).toEqual(["deploy", "Lint Fixer", "review"]);
    expect(filterSkills(rows, "MERGE").map(r => r.name)).toEqual(["review"]);
  });
});

// ─── The button that opens it ───────────────────────────────────────────────

const agent = (over: Partial<AgentNodeData> = {}) => ({
  id: "s1", sessionId: "s1", label: "shop", kind: "root", state: "active", childCount: 0, tools: [], toolCount: 0,
  usage: NO_USAGE, prompts: [], startedAt: 1000, model: "claude-opus-4-7", contextWindow: 200_000, cwd: "/work/shop",
  context: { msgsUser: 1, msgsAssistant: 1, toolUses: 0, toolResults: 0, systemReminders: 0, currentContextTokens: 30_000, memoryFiles: [], snapshot: snapshot() },
  ...over,
}) as unknown as AgentNodeData;
const opened = (tree: unknown) => one(tree, isType(SkillsDialog));

/** The snapshot view's lists, drawn: it draws them in a child of its own. */
function listsOf(view: { tree: unknown }) {
  const snap = one(view.tree, isType(ContextSnapshotView))!;
  const inner = mount(ContextSnapshotView, snap.props as Parameters<typeof ContextSnapshotView>[0]);
  const lists = all(inner.tree, el => typeof el.type === "function" && (el.type as { name: string }).name === "Lists")[0];
  const listView = mount(lists.type as (p: unknown) => unknown, lists.props);
  const drawn = all(listView.tree, el => typeof el.type === "function" && (el.type as { name: string }).name === "List")
    .map(list => ({ label: String(list.props.label), view: mount(list.type as (p: unknown) => unknown, list.props) }));
  return { drawn, done: () => { for (const d of drawn) d.view.unmount(); listView.unmount(); inner.unmount(); } };
}

describe("All skills", () => {
  it("ends the Skills list, quietly, and opens the dialog on the root session with its snapshot", () => {
    const view = mount(ContextView, { agent: agent({ id: "s1::sub", kind: "subagent", parentId: "s1" } as Partial<AgentNodeData>) });
    expect(opened(view.tree)).toBeNull();
    const { drawn, done } = listsOf(view);
    const skillsList = drawn.find(d => d.label === "Skills")!;
    const act = one(skillsList.view.tree, cls("btn ctx-snap-act"))!;
    expect(act.type).toBe("button");
    expect(act.props).toMatchObject({ type: "button", "aria-haspopup": "dialog" });
    expect(textOf(act)).toBe("All skills");
    // It sits inside the disclosure, after the list: nothing shows while it is closed.
    const details = one(skillsList.view.tree, el => el.type === "details")!;
    const kids = details.props.children as unknown[];
    expect(kids[kids.length - 1]).toBe(act);
    press(act);
    expect(opened(view.tree)!.props).toMatchObject({ session: "s1" });
    expect((opened(view.tree)!.props.snapshot as ContextSnapshot).skills).toHaveLength(3);
    (opened(view.tree)!.props.onClose as () => void)();
    expect(opened(view.tree)).toBeNull();
    done();
    view.unmount();
  });

  it("is on no other list", () => {
    const view = mount(ContextView, { agent: agent({
      context: { ...agent().context!, snapshot: snapshot({
        agents: [{ type: "code-reviewer", source: "Project", tokens: 100 }],
        memory: [{ type: "Project", path: "/work/shop/CLAUDE.md", tokens: 1000 }],
      }) },
    }) });
    const { drawn, done } = listsOf(view);
    expect(drawn.map(d => [d.label, all(d.view.tree, cls("btn ctx-snap-act")).map(textOf)])).toEqual([
      ["Memory files", []], ["Custom agents", []], ["Skills", ["All skills"]],
    ]);
    done();
    view.unmount();
  });
});
