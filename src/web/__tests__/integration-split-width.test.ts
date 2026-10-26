import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, mount, type Drawn } from "./fake-react";
import type { IntegrationSplitProps } from "../components/IntegrationSplit";
import { autoDetail, autoDetailCss, readDetailWidth, writeDetailWidth } from "../integrations/layout";

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
    get widthCss() { return ((parent.tree as Drawn).props.style as Record<string, string>)["--ig-detail-w"]; },
    get shown() { return (child.tree as Drawn).props["aria-valuenow"]; },
  };
}

describe("automatic integration detail shares", () => {
  it("keeps other providers at 50% and allows 40% with identical bounds", () => {
    expect(autoDetail(1200)).toBe(600);
    expect(autoDetail(1200, 0.4)).toBe(480);
    expect(autoDetailCss()).toBe("clamp(320px, 50%, 1600px)");
    expect(autoDetailCss(0.4)).toBe("clamp(320px, 40%, 1600px)");
    expect(autoDetail(700, 0.4)).toBe(320);
    expect(autoDetail(900, 0.9)).toBe(472); // Leaves the same 420px list + 8px splitter.
    expect(autoDetail(5000, 0.4)).toBe(1600);
  });

  it("falls back consistently in CSS and JS for invalid shares", () => {
    for (const share of [NaN, Infinity, -0.4, 0, 1, 2]) {
      expect(autoDetail(1200, share)).toBe(600);
      expect(autoDetailCss(share)).toBe(autoDetailCss());
    }
  });

  it("renders the chosen share immediately, with matching splitter ARIA and no saved preference", () => {
    const custom = open({ automaticDetailShare: 0.4 });
    expect(custom.widthCss).toBe(autoDetailCss(0.4));
    expect(custom.shown).toBe(480);
    expect(readDetailWidth("jira")).toBeNull();
    const standard = open({ storageKey: "gitlab" });
    expect(standard.widthCss).toBe(autoDetailCss());
    expect(standard.shown).toBe(600);
  });

  it("honors an existing pixel width instead of overwriting it with a provider share", () => {
    writeDetailWidth("jira", 700);
    const view = open({ automaticDetailShare: 0.4 });
    expect(view.widthCss).toBe("700px");
    expect(view.shown).toBe(700);
    expect(store.get("agent-dag.integrations.jira.detail-width")).toBe("700");
    expect(readDetailWidth("gitlab")).toBeNull();
  });

  it("Enter and double-click clear the saved width and reset to the provider's automatic share", () => {
    writeDetailWidth("jira", 700);
    const view = open({ automaticDetailShare: 0.4 });
    view.event("onKeyDown", { key: "Enter" });
    expect(view.widthCss).toBe(autoDetailCss(0.4));
    expect(view.css.get("--ig-detail-w")).toBe(autoDetailCss(0.4));
    expect(view.shown).toBe(480);
    expect(readDetailWidth("jira")).toBeNull();
    view.event("onKeyDown", { key: "ArrowLeft" });
    expect(readDetailWidth("jira")).toBe(496);
    view.event("onDoubleClick");
    expect(view.widthCss).toBe(autoDetailCss(0.4));
    expect(view.shown).toBe(480);
    expect(readDetailWidth("jira")).toBeNull();
  });

  it("keeps arrow increments and Home/End bounds, and the default reset stays 50%", () => {
    const view = open({ storageKey: "gitlab" });
    view.event("onKeyDown", { key: "ArrowRight", shiftKey: true });
    expect(view.shown).toBe(536);
    view.event("onKeyDown", { key: "Home" });
    expect(view.shown).toBe(320);
    view.event("onKeyDown", { key: "End" });
    expect(view.shown).toBe(772);
    view.event("onKeyDown", { key: "Enter" });
    expect(view.shown).toBe(600);
    expect(view.widthCss).toBe(autoDetailCss());
    expect(readDetailWidth("gitlab")).toBeNull();
  });

  it("drags from the custom automatic width, applies live pixels and persists only on release", () => {
    const view = open({ automaticDetailShare: 0.4 });
    view.event("onPointerDown", { button: 0, clientX: 700, pointerId: 1, currentTarget: { setPointerCapture: vi.fn() } });
    view.event("onPointerMove", { clientX: 660 });
    expect(view.css.get("--ig-detail-w")).toBe("520px");
    expect(readDetailWidth("jira")).toBeNull();
    view.event("onPointerUp");
    expect(view.widthCss).toBe("520px");
    expect(readDetailWidth("jira")).toBe(520);
    expect(view.workspace.removeAttribute).toHaveBeenCalledWith("data-resizing");
  });
});
