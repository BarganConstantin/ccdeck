// The stage's two controls with state of their own: the divider and the New
// session form, run under fake-react and pressed the way a browser would.
//
// The divider is pinned for what the stage's design asks of it — whole
// columns, soft detents, one resize per gesture, a separator a keyboard can
// drive — and the form for what v3 drew and internal #106 sharpened: a search
// over the reader's projects (or a full path, or the desktop's folder dialog),
// Enter that chooses, an agent, and a button that says what it will start.
import { describe, it, expect, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";
import Divider, { dividerKey, type DividerProps } from "../components/terminal/Divider";
import { MODE_CHOICES, NEW_SESSION_NOTE_MSG, NEW_SESSION_NOTE_WINDOWS_MSG, NewSessionForm, launchOptions, startLabel, type NewSessionDeps, type NewSessionFormProps } from "../components/terminal/NewSessionPopover";
import { FORGOTTEN_KEY, RECENT_KEY } from "../components/terminal/project-picker";
import type { FolderAnswer } from "../terminal-api";
import { en } from "../i18n/en";

// CHANGED ON PURPOSE (the UI in every language): the notes are read through
// their keys now, and the English catalog holds the words.
const NEW_SESSION_NOTE = en[NEW_SESSION_NOTE_MSG];
const NEW_SESSION_NOTE_WINDOWS = en[NEW_SESSION_NOTE_WINDOWS_MSG];
import { colsRange, NAV_MIN, stageWidthFor } from "../stage-geometry";
import type { ProjectChoice } from "../components/terminal/stage-model";

const keyEvent = (key: string) => ({ key, preventDefault: vi.fn(), stopPropagation: vi.fn() });

describe("the divider", () => {
  const appW = 1920;
  const cellW = 8;
  const range = colsRange(appW, cellW, NAV_MIN);
  const props = (over: Partial<DividerProps> = {}): DividerProps => ({
    cols: 120, rows: 40, range, appW, navW: appW - stageWidthFor(120, cellW), cellW,
    onCols: vi.fn(), onReset: vi.fn(), onHold: vi.fn(), ...over,
  });
  const separator = (tree: unknown) => one(tree, el => el.props.role === "separator")!;

  it("is a separator a screen reader can read as a number of columns", () => {
    const sep = separator(mount(Divider, props()).tree);
    expect(sep.props).toMatchObject({
      "aria-orientation": "vertical", "aria-label": "Command Panel width", tabIndex: 0,
      "aria-valuemin": 80, "aria-valuemax": range.max, "aria-valuenow": 120, "aria-valuetext": "120 columns",
    });
  });

  it("steps between detents with the arrows, runs to the ends, and goes back to the default on Enter", () => {
    const p = props();
    const sep = separator(mount(Divider, p).tree);
    const press = (key: string) => (sep.props.onKeyDown as (e: unknown) => void)(keyEvent(key));
    press("ArrowLeft");
    press("ArrowRight");
    press("Home");
    press("End");
    expect((p.onCols as ReturnType<typeof vi.fn>).mock.calls).toEqual([[160, true], [100, true], [range.max, true], [80, true]]);
    const enter = keyEvent("Enter");
    (sep.props.onKeyDown as (e: unknown) => void)(enter);
    expect(p.onReset).toHaveBeenCalledTimes(1);
    expect(enter.stopPropagation, "the deck's window listener must not also read Enter as type-in-the-pane").toHaveBeenCalled();
    press("a");
    expect(p.onCols).toHaveBeenCalledTimes(4);
    expect(dividerKey("ArrowUp")).toBeNull();
  });

  it("drags in whole columns pulled onto detents, holds the pane until let go, and settles once", () => {
    const p = props();
    const m = mount(Divider, p);
    const stageLeft = p.navW;
    const target = { setPointerCapture: vi.fn(), parentElement: { getBoundingClientRect: () => ({ left: stageLeft }) } };
    const sep = () => separator(m.tree);
    (sep().props.onPointerDown as (e: unknown) => void)({ button: 0, pointerId: 1, preventDefault() {}, currentTarget: target });
    expect(p.onHold).toHaveBeenLastCalledWith(true);
    // CHANGED ON PURPOSE: V4 draws no plate for the detents (they were 10px
    // type); held, the pane side says the bare "cols × rows" readout alone.
    expect(all(m.tree, el => el.props.className === "ts-detent"), "no detent plates").toHaveLength(0);
    expect(all(m.tree, el => el.props.className === "ts-readout").map(el => textOf(el)), "the readout stands while it is held").toEqual(["120 × 40"]);
    // 1920 − x − 44 = 8 × cols: x = 1920 − 44 − 8 × 112 = 980 asks for 112.
    const at = (cols: number) => appW - 44 - cellW * cols;
    (sep().props.onPointerMove as (e: unknown) => void)({ clientX: at(112) });
    (sep().props.onPointerMove as (e: unknown) => void)({ clientX: at(118) });
    (sep().props.onPointerMove as (e: unknown) => void)({ clientX: at(118.4) });
    expect((p.onCols as ReturnType<typeof vi.fn>).mock.calls, "118 is pulled onto 120, and the same width twice is said once")
      .toEqual([[112, false], [120, false]]);
    (sep().props.onPointerUp as () => void)();
    (sep().props.onLostPointerCapture as () => void)();
    expect((p.onCols as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([120, true]);
    expect((p.onCols as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[1] === true), "one release, one settle").toHaveLength(1);
    expect(p.onHold).toHaveBeenLastCalledWith(false);
    expect(all(m.tree, el => el.props.className === "ts-readout")).toHaveLength(0);
  });

  it("ignores a press that is not the main button", () => {
    const p = props();
    const sep = separator(mount(Divider, p).tree);
    (sep.props.onPointerDown as (e: unknown) => void)({ button: 2, preventDefault() {}, currentTarget: {} });
    expect(p.onHold).not.toHaveBeenCalled();
  });
});

describe("the New session form", () => {
  const projects: ProjectChoice[] = [
    { cwd: "/home/u/code/paycore", name: "paycore", hue: 270 },
    { cwd: "/home/u/personal/ccdeck", name: "ccdeck", hue: 20 },
  ];
  /** The browser's storage, in a Map: what the form keeps between visits. */
  const memStore = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
  };
  const folderOk = vi.fn(async (cwd: string): Promise<FolderAnswer> => ({ ok: true, cwd }));
  const props = (over: Partial<NewSessionFormProps> = {}, deps: Partial<NewSessionDeps> = {}): NewSessionFormProps =>
    ({ projects, onStart: vi.fn(), onCancel: vi.fn(), ...over, deps: { checkFolder: folderOk, loadProjects: undefined, store: memStore(), now: () => 1_000, apple: false, ...deps } });
  const startButton = (tree: unknown) => one(tree, el => el.type === "button" && /^Start /.test(textOf(el)))!;
  const chooseButton = (tree: unknown) => one(tree, el => el.type === "button" && String(el.props.className).split(" ").includes("ns-choose"))!;
  const agents = (tree: unknown) => one(tree, el => el.props.className === "uh-range ns-agents")!.props.children as Drawn[];
  const strip = (tree: unknown, label: string) =>
    all(tree, el => el.type === "select" && el.props["aria-labelledby"] === label)[0];
  const selectSetting = (tree: unknown, label: string, value: string) =>
    (strip(tree, label).props.onChange as (e: unknown) => void)({ currentTarget: { value } });
  /** One of Claude's switches, by the id of the label that names it. */
  const toggle = (tree: unknown, label: string) => one(tree, el => el.props.role === "switch" && el.props["aria-labelledby"] === label)!;
  const options = (tree: unknown) => all(tree, el => el.props.role === "option");
  const names = (tree: unknown) => options(tree).map(o => textOf(one(o, el => el.props.className === "ns-name")));
  const field = (tree: unknown) => one(tree, el => el.type === "input")!;
  const alert = (tree: unknown) => one(tree, el => el.props.role === "alert");
  const said = (tree: unknown) => textOf(one(tree, el => el.props.className === "ns-said"));
  const where = (tree: unknown) => textOf(one(tree, el => el.props.className === "ns-where"));
  const click = (el: Drawn) => (el.props.onClick as (e?: unknown) => void)({ stopPropagation: vi.fn() });
  const type = (m: { tree: unknown }, value: string) => (field(m.tree).props.onChange as (e: unknown) => void)({ target: { value } });
  const press = (m: { tree: unknown }, key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) => {
    const e = { ...keyEvent(key), ...mods };
    (field(m.tree).props.onKeyDown as (e: unknown) => void)(e);
    return e;
  };

  it('loads other local projects, keeps the chosen project and supports searching their paths', async () => {
    const loadProjects = vi.fn(async () => ({ projects: [{ cwd: '/srv/team/other-project', name: 'other-project' }] }));
    const p = props({}, { loadProjects }); const view = mount(NewSessionForm, p);
    await flush();
    expect(loadProjects).toHaveBeenCalledTimes(1);
    expect(names(view.tree)).toContain('other-project');
    expect(textOf(startButton(view.tree))).toBe('Start Claude in paycore');
    (field(view.tree).props.onChange as (e: unknown) => void)({ target: { value: 'other-project' } });
    expect(names(view.tree)).toEqual(['other-project']);
    expect(p.onStart).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps folder selection usable while discovery loads, fails, or is cancelled on close', async () => {
    let resolve!: (r: { projects: never[]; truncated: boolean }) => void;
    let signal!: AbortSignal;
    const view = mount(NewSessionForm, props({}, { loadProjects: s => {
      signal = s;
      return new Promise(r => { resolve = r; });
    } }));
    expect(textOf(view.tree)).toContain('Looking for local projects');
    expect(textOf(startButton(view.tree))).toBe('Start Claude in paycore');
    resolve({ projects: [], truncated: true }); await flush();
    expect(textOf(view.tree)).toContain('More projects may be available');
    view.unmount(); expect(signal.aborted).toBe(true);
    const failed = mount(NewSessionForm, props({}, { loadProjects: async () => { throw new Error('offline'); } }));
    await flush();
    expect(textOf(failed.tree)).toContain('Local projects could not be loaded');
    expect(textOf(startButton(failed.tree))).toBe('Start Claude in paycore');
    failed.unmount();
  });

  it('groups worktrees by project and starts in the selected worktree on Windows', async () => {
    const windowsRoot = "C:/work/paycore";
    const existing = "C:/trees/login";
    const p = props({ projects: [{ cwd: windowsRoot, name: "paycore", hue: 1 }], windows: true }, {
      loadProjects: async () => ({ projects: [
        { cwd: "C:\\work\\paycore", name: "paycore" },
        { cwd: existing, name: "login", worktree: { projectCwd: "C:\\work\\paycore", projectName: "paycore", branch: "fix/oauth" } },
      ] }),
    });
    const view = mount(NewSessionForm, p);
    await flush();
    expect(names(view.tree)).toEqual(["paycore"]);
    click(one(view.tree, el => String(el.props.className).includes("ns-worktree-toggle"))!);
    const group = one(view.tree, el => el.props.role === "group" && el.props["aria-label"] === "Worktrees · paycore");
    expect(names(group)).toEqual(["paycore", "login"]);
    type(view, "paycore oauth");
    expect(names(view.tree)).toEqual(["login"]);
    press(view, "Enter");
    expect(p.onStart).not.toHaveBeenCalled();
    click(startButton(view.tree));
    await flush();
    expect(p.onStart).toHaveBeenCalledWith("claude", existing);
    view.unmount();
  });

  it("starts Claude in the first project by default, once the deck has said the folder is there", async () => {
    const p = props();
    const m = mount(NewSessionForm, p);
    expect(textOf(startButton(m.tree))).toBe("Start Claude in paycore");
    expect(agents(m.tree).map(r => r.props["aria-pressed"])).toEqual([true, false]);
    expect(options(m.tree)[0].props["aria-selected"]).toBe(true);
    expect(where(m.tree), "where Start goes, said whole").toBe("Folder/home/u/code/paycore");
    expect(field(m.tree).props["aria-activedescendant"], "the field is where the keyboard is").toBe("ns-opt-0");
    click(startButton(m.tree));
    expect(p.onStart, "not before the folder is checked").not.toHaveBeenCalled();
    await flush();
    expect(p.deps!.checkFolder).toHaveBeenCalledWith("/home/u/code/paycore");
    expect(p.onStart).toHaveBeenCalledWith("claude", "/home/u/code/paycore");
  });

  it("never offers nor chooses the folder that is gone, for a pane's Choose folder…: the reader picks another", async () => {
    const store = memStore();
    store.setItem(RECENT_KEY, JSON.stringify([{ cwd: "/home/u/code/paycore", at: 900 }]));
    const p = props({ gone: "/home/u/code/paycore/", initialAgent: "codex" }, { store });
    const m = mount(NewSessionForm, p);
    expect(names(m.tree), "not a row, from the board or from the folders kept").toEqual(["ccdeck"]);
    expect(textOf(startButton(m.tree)), "no folder chosen yet").toBe("Start Codex");
    expect(startButton(m.tree).props.disabled).toBe(true);
    expect(one(m.tree, el => el.props.className === "ns-where"), "nothing said chosen").toBeNull();
    expect(agents(m.tree).map(r => r.props["aria-pressed"]), "the pane's agent").toEqual([false, true]);
    press(m, "Enter");
    expect(textOf(startButton(m.tree)), "the reader's own pick").toBe("Start Codex in ccdeck");
    click(startButton(m.tree));
    await flush();
    expect(p.onStart).toHaveBeenCalledWith("codex", "/home/u/personal/ccdeck");
    m.unmount();
  });

  it("offers a new Claude its model, how it asks, and a worktree, each Default until chosen", async () => {
    const p = props();
    const m = mount(NewSessionForm, p);
    expect(strip(m.tree, "ns-model-label").props.value).toBe("");
    expect(strip(m.tree, "ns-mode-label").props.value).toBe("");
    selectSetting(m.tree, "ns-model-label", "haiku");
    selectSetting(m.tree, "ns-mode-label", "plan");
    // CHANGED ON PURPOSE: the worktree is one of two switches now, named by
    // its label (Skip permission checks is the other).
    click(toggle(m.tree, "ns-worktree-label"));
    expect(strip(m.tree, "ns-model-label").props.value).toBe("haiku");
    click(startButton(m.tree));
    await flush();
    expect(p.onStart).toHaveBeenCalledWith("claude", "/home/u/code/paycore", { model: "haiku", permissionMode: "plan", worktree: true });
    expect(MODE_CHOICES.map(c => c.value), "never a mode that stops asking").not.toContain("bypassPermissions");
  });

  // Skip permission checks: a switch of its own under Claude's options, off at
  // every open, said in one sentence beside it, and named in the collapsed
  // summary while on. It stands in for the permission mode, which comes back
  // when it is turned off, and it reaches only the launch it was on for.
  describe("Skip permission checks", () => {
    const skipSwitch = (tree: unknown) => toggle(tree, "ns-skip-label");
    const summary = (tree: unknown) => textOf(one(tree, el => el.props.className === "ns-options-value"));
    const CWD = "/home/u/code/paycore";

    it("is off at first, says what it does beside it, and is a switch the keyboard reaches", () => {
      const m = mount(NewSessionForm, props());
      const sw = skipSwitch(m.tree);
      expect(sw.type, "a real button: Tab reaches it, Space and Enter press it").toBe("button");
      expect(sw.props).toMatchObject({ role: "switch", "aria-checked": false, "aria-labelledby": "ns-skip-label", "aria-describedby": "ns-skip-hint" });
      expect(sw.props.tabIndex, "never taken out of the tab order").toBeUndefined();
      expect(textOf(one(m.tree, el => el.props.id === "ns-skip-label"))).toBe("Skip permission checks");
      expect(textOf(one(m.tree, el => el.props.id === "ns-skip-hint"))).toBe("Claude can run tools without asking for approval.");
      expect(summary(m.tree)).toBe("Uses your settings");
      m.unmount();
    });

    it("on, holds the permission mode, says so in the summary, and starts that Claude with the flag's option alone", async () => {
      const p = props();
      const m = mount(NewSessionForm, p);
      selectSetting(m.tree, "ns-mode-label", "plan");
      expect(summary(m.tree)).toBe("Default · Plan");
      click(skipSwitch(m.tree));
      expect(skipSwitch(m.tree).props["aria-checked"]).toBe(true);
      expect(summary(m.tree), "the collapsed options name it").toBe("Default · Skip permission checks");
      const mode = strip(m.tree, "ns-mode-label");
      expect(mode.props.disabled, "the permission mode is not a choice while it is on").toBe(true);
      expect(mode.props.value).toBe("skip");
      expect(textOf(all(mode, el => el.type === "option").find(o => o.props.value === "skip")), "and the select says what holds it").toBe("Skip permission checks");
      click(startButton(m.tree));
      await flush();
      expect(p.onStart, "no permission mode beside it").toHaveBeenCalledWith("claude", CWD, { skipPermissions: true });
      m.unmount();
    });

    it("off again, gives back the permission mode chosen before", async () => {
      const p = props();
      const m = mount(NewSessionForm, p);
      selectSetting(m.tree, "ns-model-label", "opus");
      selectSetting(m.tree, "ns-mode-label", "acceptEdits");
      click(skipSwitch(m.tree));
      click(skipSwitch(m.tree));
      const mode = strip(m.tree, "ns-mode-label");
      expect(mode.props.disabled).toBe(false);
      expect(mode.props.value, "the mode as it was").toBe("acceptEdits");
      expect(all(mode, el => el.type === "option").map(o => o.props.value), "the stand-in is gone").not.toContain("skip");
      expect(summary(m.tree)).toBe("Opus · Edits");
      click(startButton(m.tree));
      await flush();
      expect(p.onStart).toHaveBeenCalledWith("claude", CWD, { model: "opus", permissionMode: "acceptEdits" });
      m.unmount();
    });

    it("starts off every time New session opens, so the next start after an opted-in one carries nothing", async () => {
      const first = props();
      const a = mount(NewSessionForm, first);
      click(skipSwitch(a.tree));
      click(startButton(a.tree));
      await flush();
      expect(first.onStart).toHaveBeenCalledWith("claude", CWD, { skipPermissions: true });
      a.unmount();
      const next = props();
      const b = mount(NewSessionForm, next);
      expect(skipSwitch(b.tree).props["aria-checked"], "reopened: off").toBe(false);
      expect(summary(b.tree)).toBe("Uses your settings");
      click(startButton(b.tree));
      await flush();
      expect(next.onStart, "an ordinary start: no options at all").toHaveBeenCalledWith("claude", CWD);
      b.unmount();
    });

    it("is not drawn for Codex, never reaches a Codex start, and is off again when Claude comes back", async () => {
      const p = props();
      const m = mount(NewSessionForm, p);
      click(skipSwitch(m.tree));
      click(agents(m.tree)[1]);
      expect(all(m.tree, el => el.props.role === "switch"), "hidden, not just disabled").toHaveLength(0);
      expect(textOf(m.tree)).not.toContain("Skip permission checks");
      click(startButton(m.tree));
      await flush();
      expect(p.onStart).toHaveBeenCalledWith("codex", CWD);
      m.unmount();
      const back = props();
      const n = mount(NewSessionForm, back);
      click(skipSwitch(n.tree));
      click(agents(n.tree)[1]);
      click(agents(n.tree)[0]);
      expect(skipSwitch(n.tree).props["aria-checked"], "leaving Claude turned it off").toBe(false);
      click(startButton(n.tree));
      await flush();
      expect(back.onStart).toHaveBeenCalledWith("claude", CWD);
      n.unmount();
    });

    it("passes the one option, and the permission mode only without it", () => {
      expect(launchOptions(null, "plan", false, true)).toEqual({ skipPermissions: true });
      expect(launchOptions("opus", null, true, true)).toEqual({ model: "opus", skipPermissions: true, worktree: true });
      expect(launchOptions(null, "plan", false, false)).toEqual({ permissionMode: "plan" });
      expect(launchOptions(null, null, false), "off by default").toBeUndefined();
    });
  });

  it("starts Codex as it is: none of Claude's choices are drawn or passed", async () => {
    const p = props();
    const m = mount(NewSessionForm, p);
    selectSetting(m.tree, "ns-model-label", "opus");
    click(agents(m.tree)[1]);
    expect(strip(m.tree, "ns-model-label")).toBeUndefined();
    expect(one(m.tree, el => el.props.role === "switch")).toBeNull();
    click(startButton(m.tree));
    await flush();
    expect(p.onStart).toHaveBeenCalledWith("codex", "/home/u/code/paycore");
    expect(launchOptions(null, null, false), "Default passes nothing").toBeUndefined();
  });

  it("switches the agent and the project, and the button follows", async () => {
    const p = props();
    const m = mount(NewSessionForm, p);
    click(agents(m.tree)[1]);
    click(options(m.tree)[1]);
    expect(textOf(startButton(m.tree))).toBe("Start Codex in ccdeck");
    expect(options(m.tree)[1].props["aria-selected"]).toBe(true);
    click(startButton(m.tree));
    await flush();
    expect(p.onStart).toHaveBeenCalledWith("codex", "/home/u/personal/ccdeck");
  });

  it("walks the projects with the arrows; Enter chooses and never starts; Ctrl+Enter starts", async () => {
    const p = props();
    const m = mount(NewSessionForm, p);
    expect(field(m.tree).props.role).toBe("combobox");
    expect(field(m.tree).props["aria-controls"]).toBe("ns-projects");
    expect(field(m.tree).props["aria-label"]).toBe("Search projects or enter a path");
    press(m, "ArrowDown");
    expect(field(m.tree).props["aria-activedescendant"]).toBe("ns-opt-1");
    expect(options(m.tree)[1].props["data-highlighted"], "the highlight ring follows").toBe(true);
    press(m, "Enter");
    await flush();
    expect(p.onStart, "Enter chooses a project, it does not start an agent").not.toHaveBeenCalled();
    expect(textOf(startButton(m.tree))).toBe("Start Claude in ccdeck");
    press(m, "ArrowDown");
    expect(field(m.tree).props["aria-activedescendant"], "it wraps").toBe("ns-opt-0");
    press(m, "ArrowUp");
    expect(field(m.tree).props["aria-activedescendant"]).toBe("ns-opt-1");
    press(m, "Enter", { ctrlKey: true });
    await flush();
    expect(p.onStart).toHaveBeenCalledWith("claude", "/home/u/personal/ccdeck");
  });

  it("names its keys for a screen reader: ⌘ on a Mac, Ctrl elsewhere", () => {
    const keys = (apple: boolean) => {
      const m = mount(NewSessionForm, props({}, { apple }));
      const id = field(m.tree).props["aria-describedby"];
      return textOf(one(m.tree, el => el.props.id === id));
    };
    expect(keys(false)).toContain("Ctrl+Enter starts");
    expect(keys(true)).toContain("⌘+Enter starts");
    expect(keys(false)).toContain("Enter chooses one");
  });

  it("searches names and paths, and tells two folders of one name apart", () => {
    const m = mount(NewSessionForm, props({ projects: [
      ...projects,
      { cwd: "/home/u/work/ccdeck", name: "ccdeck", hue: 90 },
      { cwd: "/home/u/work/ccdeck/.claude/worktrees/fix-x", name: "fix-x", hue: 140 },
    ] }));
    type(m, "ccd");
    expect(names(m.tree)).toEqual(["ccdeck", "ccdeck", "fix-x"]);
    const paths = options(m.tree).map(o => textOf(one(o, el => el.props.className === "ns-path")));
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths.slice(0, 2).sort()).toEqual(["…/personal/ccdeck", "…/work/ccdeck"]);
    type(m, "work");
    expect(names(m.tree), "a word in the path finds the folder; a worktree is its own entry").toEqual(["ccdeck", "fix-x"]);
    type(m, "zzz");
    expect(options(m.tree)).toHaveLength(0);
    expect(textOf(one(m.tree, el => el.props.className === "ns-empty"))).toBe("No project matches “zzz”. A full path opens another folder.");
    expect(textOf(startButton(m.tree)), "a search that finds nothing keeps the chosen folder").toBe("Start Claude in paycore");
  });

  it("offers a typed full path as its own option, checks it with the deck, and keeps it", async () => {
    const store = memStore();
    const p = props({}, { store });
    const m = mount(NewSessionForm, p);
    type(m, "/srv/elsewhere/");
    expect(names(m.tree)[0]).toBe("Use elsewhere");
    press(m, "Enter");
    await flush();
    expect(p.deps!.checkFolder).toHaveBeenCalledWith("/srv/elsewhere");
    expect(p.onStart).not.toHaveBeenCalled();
    expect(textOf(startButton(m.tree))).toBe("Start Claude in elsewhere");
    expect(field(m.tree).props.value, "the search steps aside once chosen").toBe("");
    expect(JSON.parse(store.m.get(RECENT_KEY)!)).toEqual([{ cwd: "/srv/elsewhere", at: 1_000 }]);
    // And a later visit offers it, even with nothing on the board.
    const again = mount(NewSessionForm, props({ projects: [] }, { store }));
    expect(names(again.tree)).toEqual(["elsewhere"]);
  });

  it("says why a typed folder cannot be used, and keeps the one already chosen", async () => {
    const checkFolder = vi.fn(async (): Promise<FolderAnswer> => ({ ok: false, code: "missing" }));
    const m = mount(NewSessionForm, props({}, { checkFolder }));
    type(m, "/srv/gone");
    press(m, "Enter");
    await flush();
    expect(textOf(alert(m.tree))).toBe("This folder is not there any more: /srv/gone");
    expect(textOf(startButton(m.tree)), "never silently another folder").toBe("Start Claude in paycore");
  });

  it("says a ~/ or ./ path needs to be full rather than searching it", () => {
    const m = mount(NewSessionForm, props());
    type(m, "~/code/elsewhere");
    expect(options(m.tree)).toHaveLength(0);
    expect(textOf(one(m.tree, el => el.props.className === "ns-empty"))).toBe("A full path, starting with /.");
    const win = mount(NewSessionForm, props({ windows: true }));
    type(win, ".\\api");
    expect(textOf(one(win.tree, el => el.props.className === "ns-empty"))).toBe("A full path, starting with a drive, like C:\\.");
  });

  it("says at Start a folder that went away or may not be opened, keeps it chosen, and Start works again", async () => {
    let answer: FolderAnswer = { ok: false, code: "missing" };
    const checkFolder = vi.fn(async (cwd: string): Promise<FolderAnswer> => (answer.ok ? { ok: true, cwd } : answer));
    const p = props({}, { checkFolder });
    const m = mount(NewSessionForm, p);
    click(startButton(m.tree));
    await flush();
    expect(p.onStart).not.toHaveBeenCalled();
    expect(textOf(alert(m.tree))).toBe("This folder is not there any more: /home/u/code/paycore");
    expect(startButton(m.tree).props.disabled, "Start stays, to press again").toBe(false);
    answer = { ok: false, code: "denied" };
    click(startButton(m.tree));
    await flush();
    expect(textOf(alert(m.tree))).toBe("This account may not open this folder: /home/u/code/paycore");
    // A folder on a drive or a network folder that is disconnected right now.
    answer = { ok: false, code: "unreachable" };
    click(startButton(m.tree));
    await flush();
    expect(textOf(alert(m.tree))).toBe("This folder is not reachable right now. Reconnect its drive or network folder: /home/u/code/paycore");
    expect(p.onStart, "never started there").not.toHaveBeenCalled();
    answer = { ok: false, code: "offline" };
    click(startButton(m.tree));
    await flush();
    expect(textOf(alert(m.tree))).toContain("The deck did not answer.");
    expect(textOf(startButton(m.tree))).toBe("Start Claude in paycore");
    answer = { ok: true, cwd: "" };
    click(startButton(m.tree));
    click(startButton(m.tree));
    await flush();
    click(startButton(m.tree));
    await flush();
    expect(p.onStart, "one press, one agent").toHaveBeenCalledTimes(1);
    expect(p.onStart).toHaveBeenCalledWith("claude", "/home/u/code/paycore");
  });

  it("still starts with a deck that cannot answer the folder question (the launch checks it)", async () => {
    const p = props({}, { checkFolder: async () => ({ ok: false, code: "unavailable" }) });
    const m = mount(NewSessionForm, p);
    click(startButton(m.tree));
    await flush();
    expect(p.onStart).toHaveBeenCalledWith("claude", "/home/u/code/paycore");
    expect(alert(m.tree)).toBeNull();
  });

  it("remembers the folder an agent started in, newest first", async () => {
    const store = memStore();
    let now = 1_000;
    const start = async (pick: number) => {
      const m = mount(NewSessionForm, props({}, { store, now: () => now }));
      click(options(m.tree)[pick]);
      click(startButton(m.tree));
      await flush();
    };
    await start(1);
    now = 2_000;
    await start(0);
    expect(JSON.parse(store.m.get(RECENT_KEY)!)).toEqual([
      { cwd: "/home/u/code/paycore", at: 2_000 },
      { cwd: "/home/u/personal/ccdeck", at: 1_000 },
    ]);
    const later = mount(NewSessionForm, props({ projects: [] }, { store }));
    expect(names(later.tree), "the board forgot them; the list did not").toEqual(["paycore", "ccdeck"]);
  });

  it("takes a project off the list with Shift+Delete or its ×, and only off the list", () => {
    const store = memStore();
    const p = props({}, { store });
    const m = mount(NewSessionForm, p);
    const e = press(m, "Delete", { shiftKey: true });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(names(m.tree)).toEqual(["ccdeck"]);
    expect(textOf(startButton(m.tree)), "the chosen one went: the next is chosen").toBe("Start Claude in ccdeck");
    expect(said(m.tree)).toBe("paycore is off the list. Its folder and sessions are untouched.");
    expect(JSON.parse(store.m.get(FORGOTTEN_KEY)!)).toEqual(["/home/u/code/paycore"]);
    expect(p.onStart).not.toHaveBeenCalled();
    click(one(options(m.tree)[0], el => el.props.className === "ns-forget")!);
    expect(options(m.tree)).toHaveLength(0);
    expect(textOf(one(m.tree, el => el.props.className === "ns-empty"))).toBe("No projects yet. Choose a folder, or type its full path.");
    expect(startButton(m.tree).props.disabled).toBe(true);
    // The board still has them; the list keeps them off until chosen again.
    expect(names(mount(NewSessionForm, props({}, { store })).tree)).toEqual([]);
  });

  it("Choose another folder… takes the desktop dialog's folder, checked, and says a closed dialog", async () => {
    const store = memStore();
    let picked: string | null = "/opt/picked";
    const chooseFolder = vi.fn(async () => picked);
    const p = props({}, { store, chooseFolder });
    const m = mount(NewSessionForm, p);
    click(chooseButton(m.tree));
    await flush();
    expect(chooseFolder).toHaveBeenCalledTimes(1);
    expect(p.deps!.checkFolder).toHaveBeenCalledWith("/opt/picked");
    expect(textOf(startButton(m.tree))).toBe("Start Claude in picked");
    expect(p.onStart, "choosing a folder never starts an agent").not.toHaveBeenCalled();
    expect(JSON.parse(store.m.get(RECENT_KEY)!)[0].cwd).toBe("/opt/picked");
    picked = null;
    click(chooseButton(m.tree));
    await flush();
    expect(said(m.tree)).toBe("No folder chosen. The project stays as it was.");
    expect(textOf(startButton(m.tree))).toBe("Start Claude in picked");
  });

  it("in a browser, Choose another folder… asks for the full path in the field", () => {
    const m = mount(NewSessionForm, props());
    click(chooseButton(m.tree));
    expect(said(m.tree)).toBe("Type the folder's full path in the field above, like /path/to/project.");
    const win = mount(NewSessionForm, props({ windows: true }));
    click(chooseButton(win.tree));
    expect(said(win.tree)).toBe("Type the folder's full path in the field above, like C:\\path\\to\\project.");
  });

  it("clears a search on the first Escape and leaves the second to close the popover", () => {
    const m = mount(NewSessionForm, props());
    type(m, "pay");
    const first = press(m, "Escape");
    expect(first.stopPropagation).toHaveBeenCalled();
    expect(field(m.tree).props.value).toBe("");
    const second = press(m, "Escape");
    expect(second.stopPropagation).not.toHaveBeenCalled();
  });

  it("says in one sentence that the session joins the board and outlives the stage", () => {
    const text = textOf(mount(NewSessionForm, props()).tree);
    expect(text).toContain("Closing the panel keeps the session running.");
    expect(NEW_SESSION_NOTE).toBe("Closing the panel keeps the session running.");
  });

  it("on Windows, says the session runs in the session host, never in the deck's tmux", () => {
    const text = textOf(mount(NewSessionForm, props({ windows: true })).tree);
    expect(text).toContain("Closing the panel keeps the session running.");
    expect(text).toContain(NEW_SESSION_NOTE_WINDOWS);
    expect(text).not.toMatch(/tmux/);
  });

  it("says there are no projects yet when the board and the list are empty", () => {
    const m = mount(NewSessionForm, props({ projects: [] }));
    expect(options(m.tree)).toHaveLength(0);
    expect(one(m.tree, el => el.props.role === "listbox")!.props.hidden).toBe(true);
    expect(textOf(one(m.tree, el => el.props.className === "ns-empty"))).toBe("No projects yet. Choose a folder, or type its full path.");
    expect(startButton(m.tree).props.disabled).toBe(true);
    expect(startLabel("codex", null)).toBe("Start Codex");
  });
});
