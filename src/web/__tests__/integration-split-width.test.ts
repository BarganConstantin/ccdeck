import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, mount, type Drawn } from "./fake-react";
import type { IntegrationSplitProps } from "../components/IntegrationSplit";
import { autoList, clampList, listCss, listMost, readSplitWidth, splitCss, splitList, writeListWidth } from "../integrations/layout";

vi.mock("react", async () => ({ ...(await import("./fake-react")).react, useId: () => "split-test" }));
vi.mock("../use-media-query", () => ({ useMediaQuery: () => false }));
const { default: IntegrationSplit } = await import("../components/IntegrationSplit");

const store = new Map<string, string>();
const unmounts: Array<() => void> = [];
beforeEach(() => {
  store.clear();
  vi.stubGlobal("window", { innerWidth: 1200, localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  } });
  vi.stubGlobal("document", { activeElement: null, body: {} });
  vi.stubGlobal("HTMLElement", class {});
});
afterEach(() => { for (const unmount of unmounts.splice(0)) unmount(); vi.unstubAllGlobals(); });

function open(extra: Partial<IntegrationSplitProps> = {}) {
  const props: IntegrationSplitProps = { list: "List", detail: "Detail", storageKey: "jira", backLabel: "Back", onBack: vi.fn(), ...extra };
  const parent = mount(IntegrationSplit, props);
  unmounts.push(parent.unmount);
  const css = new Map<string, string>();
  const workspace = { clientWidth: 1200, style: { setProperty: (key: string, value: string) => css.set(key, value) }, setAttribute: vi.fn(), removeAttribute: vi.fn() };
  // Attach only the workspace geometry needed by the splitter; no DOM/layout simulation.
  ((parent.tree as Drawn).ref as { current: unknown }).current = workspace;
  const splitter = () => all(parent.tree, e => typeof e.type === "function" && "onCommit" in e.props)[0];
  const spec = splitter();
  const child = mount(spec.type as (p: Record<string, unknown>) => unknown, spec.props);
  unmounts.push(child.unmount);
  ((child.tree as Drawn).ref as { current: unknown }).current = { setAttribute: vi.fn() };
  function event(name: string, values: Record<string, unknown> = {}) {
    const handler = (child.tree as Drawn).props[name] as (e: unknown) => void;
    handler({ preventDefault: vi.fn(), ...values });
    child.rerender(splitter().props);
  }
  return {
    parent, css, workspace, event,
    get widthCss() { return ((parent.tree as Drawn).props.style as Record<string, string>)["--ig-list-w"]; },
    get shown() { return (child.tree as Drawn).props["aria-valuenow"]; },
    get props() { return (child.tree as Drawn).props; },
  };
}

// CHANGED ON PURPOSE: the divider's value is the list's width now, not the
// detail's. The list is held between 280px and 60 % of the room and the detail
// takes the rest, so resizing the dialog keeps the list where the reader left
// it. Until the reader drags it the list takes what the provider's automatic
// detail share leaves, as the detail took that share before.
describe("the list's width beside an integration's detail", () => {
  it("takes what the provider's detail share leaves, between 280px and 60%", () => {
    expect(autoList(1200)).toBe(600);
    expect(autoList(1200, 0.4277)).toBe(687); // Jira's share
    expect(autoList(1200, 0.5705)).toBe(515); // a forge's share
    expect(autoList(1200, 0.3)).toBe(720); // 70 % is past the 60 % cap
    expect(autoList(400)).toBe(280); // 200 is under the 280 floor
    expect(listMost(1200)).toBe(720);
    expect(listMost(300)).toBe(280);
    expect(listCss(null)).toBe("clamp(280px, 50%, 60%)");
    expect(listCss(null, 0.4277)).toBe("clamp(280px, 57.23%, 60%)");
    expect(listCss(640)).toBe("clamp(280px, 640px, 60%)");
  });

  it("falls back consistently in CSS and JS for invalid shares and widths", () => {
    for (const share of [NaN, Infinity, -0.4, 0, 1, 2]) {
      expect(autoList(1200, share)).toBe(600);
      expect(listCss(null, share)).toBe(listCss(null));
    }
    expect(clampList(NaN, 1200)).toBe(600);
    expect(clampList(100, 1200)).toBe(280);
    expect(clampList(5000, 1200)).toBe(720);
  });

  it("renders the provider's share at once, with matching splitter ARIA and no saved preference", () => {
    const jira = open({ automaticDetailShare: 0.4277 });
    expect(jira.widthCss).toBe(listCss(null, 0.4277));
    expect(jira.shown).toBe(687);
    expect(jira.props["aria-valuemin"]).toBe(280);
    expect(jira.props["aria-valuemax"]).toBe(720);
    expect(jira.props["aria-controls"]).toBe("split-test-list");
    expect(jira.props.role).toBe("separator");
    expect(readSplitWidth("jira")).toBeNull();
    const gitlab = open({ storageKey: "gitlab" });
    expect(gitlab.widthCss).toBe(listCss(null));
    expect(gitlab.shown).toBe(600);
  });

  it("honors a stored list width per provider", () => {
    writeListWidth("jira", 500);
    const view = open({ automaticDetailShare: 0.4277 });
    expect(view.widthCss).toBe("clamp(280px, 500px, 60%)");
    expect(view.shown).toBe(500);
    expect(store.get("agent-dag.integrations.jira.list-width")).toBe("500");
    expect(readSplitWidth("gitlab")).toBeNull();
  });

  it("keeps a detail width dragged before as the list beside it, and forgets it at the next commit", () => {
    store.set("agent-dag.integrations.jira.detail-width", "700");
    expect(readSplitWidth("jira")).toEqual({ detail: 700 });
    expect(splitCss({ detail: 700 })).toBe("clamp(280px, calc(100% - 1px - 700px), 60%)");
    expect(splitList({ detail: 700 }, 1200)).toBe(499);
    const view = open({ automaticDetailShare: 0.4277 });
    expect(view.widthCss).toBe("clamp(280px, calc(100% - 1px - 700px), 60%)");
    expect(view.shown).toBe(499);
    view.event("onKeyDown", { key: "ArrowRight" });
    expect(view.shown).toBe(531);
    expect(store.get("agent-dag.integrations.jira.list-width")).toBe("531");
    expect(store.has("agent-dag.integrations.jira.detail-width")).toBe(false);
  });

  it("reads nothing it did not write", () => {
    for (const raw of ["abc", "100", "279", "20000", "", "NaN"]) {
      store.set("agent-dag.integrations.jira.list-width", raw);
      expect(readSplitWidth("jira")).toBeNull();
    }
  });

  it("Enter and double-click clear the saved width and go back to the provider's share", () => {
    writeListWidth("jira", 500);
    const view = open({ automaticDetailShare: 0.4277 });
    view.event("onKeyDown", { key: "Enter" });
    expect(view.widthCss).toBe(listCss(null, 0.4277));
    expect(view.css.get("--ig-list-w")).toBe(listCss(null, 0.4277));
    expect(view.shown).toBe(687);
    expect(readSplitWidth("jira")).toBeNull();
    view.event("onKeyDown", { key: "ArrowLeft" });
    expect(readSplitWidth("jira")).toEqual({ list: 655 });
    view.event("onDoubleClick");
    expect(view.widthCss).toBe(listCss(null, 0.4277));
    expect(view.shown).toBe(687);
    expect(readSplitWidth("jira")).toBeNull();
  });

  it("moves 32 with an arrow, 128 with Shift, and Home and End go to 280 and 60%", () => {
    const view = open({ storageKey: "gitlab" });
    view.event("onKeyDown", { key: "ArrowLeft", shiftKey: true });
    expect(view.shown).toBe(472);
    view.event("onKeyDown", { key: "ArrowRight" });
    expect(view.shown).toBe(504);
    view.event("onKeyDown", { key: "Home" });
    expect(view.shown).toBe(280);
    view.event("onKeyDown", { key: "ArrowLeft" });
    expect(view.shown).toBe(280);
    view.event("onKeyDown", { key: "End" });
    expect(view.shown).toBe(720);
    view.event("onKeyDown", { key: "ArrowRight", shiftKey: true });
    expect(view.shown).toBe(720);
    expect(readSplitWidth("gitlab")).toEqual({ list: 720 });
    view.event("onKeyDown", { key: "Enter" });
    expect(view.shown).toBe(600);
    expect(view.widthCss).toBe(listCss(null));
    expect(readSplitWidth("gitlab")).toBeNull();
  });

  it("ignores every other key, so typing never moves it", () => {
    const view = open({ storageKey: "gitlab" });
    const preventDefault = vi.fn();
    ((view.props.onKeyDown) as (e: unknown) => void)({ key: "a", preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(readSplitWidth("gitlab")).toBeNull();
  });

  it("drags from the automatic width, applies live pixels within the bounds and persists only on release", () => {
    const view = open({ automaticDetailShare: 0.4277 });
    view.event("onPointerDown", { button: 0, clientX: 700, pointerId: 1, currentTarget: { setPointerCapture: vi.fn() } });
    expect(view.workspace.setAttribute).toHaveBeenCalledWith("data-resizing", "");
    view.event("onPointerMove", { clientX: 600 });
    expect(view.css.get("--ig-list-w")).toBe("clamp(280px, 587px, 60%)");
    view.event("onPointerMove", { clientX: -1000 });
    expect(view.css.get("--ig-list-w")).toBe("clamp(280px, 280px, 60%)");
    view.event("onPointerMove", { clientX: 2000 });
    expect(view.css.get("--ig-list-w")).toBe("clamp(280px, 720px, 60%)");
    view.event("onPointerMove", { clientX: 653 });
    expect(readSplitWidth("jira")).toBeNull();
    view.event("onPointerUp");
    expect(view.widthCss).toBe("clamp(280px, 640px, 60%)");
    expect(readSplitWidth("jira")).toEqual({ list: 640 });
    expect(view.workspace.removeAttribute).toHaveBeenCalledWith("data-resizing");
  });

  it("ignores a press that is not the main button", () => {
    const view = open();
    const setPointerCapture = vi.fn();
    view.event("onPointerDown", { button: 2, clientX: 700, pointerId: 1, currentTarget: { setPointerCapture } });
    expect(setPointerCapture).not.toHaveBeenCalled();
    view.event("onPointerMove", { clientX: 600 });
    expect(view.css.has("--ig-list-w")).toBe(false);
  });
});
