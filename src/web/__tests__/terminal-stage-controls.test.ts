// The stage's two controls with state of their own: the divider and the New
// session form, run under fake-react and pressed the way a browser would.
//
// The divider is pinned for what DESIGN-UI decision 6 asks of it — whole
// columns, soft detents, one resize per gesture, a separator a keyboard can
// drive — and the form for what v3 drew: an agent, a project the board already
// knows (or a full path), and a button that says what it will start.
import { describe, it, expect, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { all, mount, one, textOf, type Drawn } from "./fake-react";
import Divider, { dividerKey, type DividerProps } from "../components/terminal/Divider";
import { MODE_CHOICES, NewSessionForm, launchOptions, startLabel, startTarget, type NewSessionFormProps } from "../components/terminal/NewSessionPopover";
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
      "aria-orientation": "vertical", "aria-label": "Stage width", tabIndex: 0,
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
    const plates = all(m.tree, el => el.props.className === "ts-detent");
    expect(plates.map(el => textOf(el)), "the detents stand over the edge while it is held").toEqual(["80 col", "100 col", "120 col", "160 col"]);
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
    expect(all(m.tree, el => el.props.className === "ts-detent")).toHaveLength(0);
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
  const props = (over: Partial<NewSessionFormProps> = {}): NewSessionFormProps =>
    ({ projects, onStart: vi.fn(), onCancel: vi.fn(), ...over });
  const startButton = (tree: unknown) => one(tree, el => el.type === "button" && /^Start /.test(textOf(el)))!;
  const agents = (tree: unknown) => one(tree, el => el.props.className === "uh-range ns-agents")!.props.children as Drawn[];
  const strip = (tree: unknown, label: string) =>
    all(tree, el => el.props.className === "uh-range ns-choices" && el.props["aria-labelledby"] === label)[0];
  const choice = (tree: unknown, label: string, name: string) =>
    one(strip(tree, label), el => el.type === "button" && textOf(el).trim() === name)!;
  const options = (tree: unknown) => all(tree, el => el.props.role === "option");
  const field = (tree: unknown) => one(tree, el => el.type === "input")!;
  const click = (el: Drawn) => (el.props.onClick as (e?: unknown) => void)({});

  it("starts Claude in the first project by default, and says so on the button", () => {
    const p = props();
    const m = mount(NewSessionForm, p);
    expect(textOf(startButton(m.tree))).toBe("Start Claude in paycore");
    expect(agents(m.tree).map(r => r.props["aria-pressed"])).toEqual([true, false]);
    expect(options(m.tree)[0].props["aria-selected"]).toBe(true);
    expect(field(m.tree).props["aria-activedescendant"], "the field is where the keyboard is").toBe("ns-opt-0");
    click(startButton(m.tree));
    expect(p.onStart).toHaveBeenCalledWith("claude", "/home/u/code/paycore");
  });

  it("offers a new Claude its model, how it asks, and a worktree, each Default until chosen", () => {
    const p = props();
    const m = mount(NewSessionForm, p);
    expect(choice(m.tree, "ns-model-label", "Default").props["aria-pressed"]).toBe(true);
    expect(choice(m.tree, "ns-mode-label", "Default").props["aria-pressed"]).toBe(true);
    click(choice(m.tree, "ns-model-label", "Haiku"));
    click(choice(m.tree, "ns-mode-label", "Plan"));
    click(one(m.tree, el => el.props.role === "switch")!);
    expect(choice(m.tree, "ns-model-label", "Haiku").props["aria-pressed"]).toBe(true);
    click(startButton(m.tree));
    expect(p.onStart).toHaveBeenCalledWith("claude", "/home/u/code/paycore", { model: "haiku", permissionMode: "plan", worktree: true });
    expect(MODE_CHOICES.map(c => c.value), "never a mode that stops asking").not.toContain("bypassPermissions");
  });

  it("starts Codex as it is: none of Claude's choices are drawn or passed", () => {
    const p = props();
    const m = mount(NewSessionForm, p);
    click(choice(m.tree, "ns-model-label", "Opus"));
    click(agents(m.tree)[1]);
    expect(strip(m.tree, "ns-model-label")).toBeUndefined();
    expect(one(m.tree, el => el.props.role === "switch")).toBeNull();
    click(startButton(m.tree));
    expect(p.onStart).toHaveBeenCalledWith("codex", "/home/u/code/paycore");
    expect(launchOptions(null, null, false), "Default passes nothing").toBeUndefined();
  });

  it("switches the agent and the project, and the button follows", () => {
    const p = props();
    const m = mount(NewSessionForm, p);
    click(agents(m.tree)[1]);
    click(options(m.tree)[1]);
    expect(textOf(startButton(m.tree))).toBe("Start Codex in ccdeck");
    click(startButton(m.tree));
    expect(p.onStart).toHaveBeenCalledWith("codex", "/home/u/personal/ccdeck");
  });

  it("walks the projects from the field with the arrows and starts on Enter, as a combobox", () => {
    const p = props();
    const m = mount(NewSessionForm, p);
    const press = (key: string) => (field(m.tree).props.onKeyDown as (e: unknown) => void)(keyEvent(key));
    expect(field(m.tree).props.role).toBe("combobox");
    expect(field(m.tree).props["aria-controls"]).toBe("ns-projects");
    press("ArrowDown");
    expect(field(m.tree).props["aria-activedescendant"]).toBe("ns-opt-1");
    expect(options(m.tree)[1].props["data-highlighted"], "the highlight ring follows").toBe(true);
    press("ArrowDown");
    expect(field(m.tree).props["aria-activedescendant"], "it wraps").toBe("ns-opt-0");
    press("Enter");
    expect(p.onStart).toHaveBeenCalledWith("claude", "/home/u/code/paycore");
  });

  it("takes a typed full path over the list, and refuses one the deck could not start in", () => {
    const p = props();
    const m = mount(NewSessionForm, p);
    (field(m.tree).props.onChange as (e: unknown) => void)({ target: { value: "~/code/elsewhere" } });
    expect(startButton(m.tree).props.disabled, "a tilde is not a path the deck can expand").toBe(true);
    expect(field(m.tree).props["aria-invalid"]).toBe(true);
    expect(options(m.tree).every(o => o.props["aria-selected"] === false), "the list stands aside while a path is typed").toBe(true);
    (field(m.tree).props.onChange as (e: unknown) => void)({ target: { value: "/srv/elsewhere" } });
    expect(textOf(startButton(m.tree))).toBe("Start Claude in elsewhere");
    (field(m.tree).props.onKeyDown as (e: unknown) => void)(keyEvent("Enter"));
    expect(p.onStart).toHaveBeenCalledWith("claude", "/srv/elsewhere");
  });

  it("says in one sentence that the session joins the board and outlives the stage", () => {
    const text = textOf(mount(NewSessionForm, props()).tree);
    expect(text).toContain("It joins the board as its own cluster and opens here, inside the deck's tmux — closing the stage never stops it.");
  });

  it("offers only the path when the board has no projects yet", () => {
    const m = mount(NewSessionForm, props({ projects: [] }));
    expect(options(m.tree)).toHaveLength(0);
    expect(startButton(m.tree).props.disabled).toBe(true);
    expect(startTarget([], 0, "")).toBeNull();
    expect(startLabel("codex", null)).toBe("Start Codex");
  });
});
