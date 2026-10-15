// Closing a docked panel with its own control dropped keyboard focus to <body>.
//
// Usage, This machine, Claude accounts, the detail panel and the session list
// each close with a × (the list with a ‹) that goes with the panel. A keyboard
// user who tabbed to one and pressed Enter was left on <body>: the next Tab
// started again at "Skip to the canvas", and a screen reader said nothing.
// The rule is panel-press.ts's (#518), through useFocusRescue (#1762): the
// control the update takes away hands focus to the nearest thing that outlived
// it — the button that opens the panel, and for the detail panel the card it
// was about, or the canvas when that card is not drawn. The four panel buttons
// stand on the window's edges since 2026-10-08 (EdgeRails.tsx), or in the
// phone's dock, and the one ref per panel lands on whichever of the two is
// drawn.
//
// The hand-off is one hook, run here on a React of two hooks against a
// document whose focused element the test sets. App and the topbar are
// components the suite has no DOM to mount, so their wiring to it is read from
// the markup, the way #1762's is.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sourceOf } from "./client-source";

const hooks = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  interface Instance {
    slots: unknown[];
    effects: Array<{ deps: Deps }>;
    queued: Array<{ index: number; run: () => void; deps: Deps }>;
    cursor: number;
    effectCursor: number;
  }
  let current: Instance | null = null;
  const moved = (prev: Deps, next: Deps) => !prev || !next || next.some((d, k) => !Object.is(d, prev[k]));
  const react = {
    useRef<T>(init: T) {
      const inst = current!;
      const i = inst.cursor++;
      if (!(i in inst.slots)) inst.slots[i] = { current: init };
      return inst.slots[i] as { current: T };
    },
    useEffect(run: () => void, deps?: readonly unknown[]) {
      const inst = current!;
      const index = inst.effectCursor++;
      const prev = inst.effects[index];
      if (!prev || moved(prev.deps, deps)) inst.queued.push({ index, run, deps });
    },
  };
  function mount<P, R>(hook: (props: P) => R, props: P) {
    const inst: Instance = { slots: [], effects: [], queued: [], cursor: 0, effectCursor: 0 };
    let result!: R;
    const render = (next: P) => {
      inst.cursor = 0;
      inst.effectCursor = 0;
      inst.queued = [];
      current = inst;
      try { result = hook(next); } finally { current = null; }
      for (const q of inst.queued) { inst.effects[q.index] = { deps: q.deps }; q.run(); }
    };
    render(props);
    return { get now() { return result; }, rerender: (next: P) => render(next) };
  }
  return { react, mount };
});

vi.mock("react", () => hooks.react);

const { usePanelReturn } = await import("../use-panel-return");

type Shown = Parameters<typeof usePanelReturn>[0];
const SHOWN: Shown = {
  sessionListShown: true, usageShown: true, machineShown: true, accountsShown: true, detailShown: true,
  primarySelectedId: "s1", canvasRef: { current: null },
};

interface Focusable { tagName: string; focus: ReturnType<typeof vi.fn>; matches: (q: string) => boolean }
const control = (keyboard: boolean): Focusable => ({
  tagName: "BUTTON", focus: vi.fn(), matches: q => q === ":focus-visible" && keyboard,
});

let page: { activeElement: { tagName: string } | null; querySelector: ReturnType<typeof vi.fn> };
let card: Focusable | null;

beforeEach(() => {
  card = null;
  page = { activeElement: null, querySelector: vi.fn(() => card) };
  vi.stubGlobal("document", page);
  vi.stubGlobal("CSS", { escape: (s: string) => s });
});

afterEach(() => { vi.unstubAllGlobals(); });

/** Press a panel's own close from the keyboard (or not), and let it go. */
function close(panel: "sessionList" | "usage" | "machine" | "accounts" | "detail", keyboard = true, extra: Partial<Shown> = {}) {
  const view = hooks.mount(usePanelReturn, { ...SHOWN, ...extra });
  const toggles = {
    sessionList: control(false), usage: control(false), accounts: control(false), machine: control(false),
  };
  for (const k of Object.keys(toggles) as (keyof typeof toggles)[]) {
    (view.now.toggles[k] as { current: unknown }).current = toggles[k];
  }
  page.activeElement = control(keyboard);
  view.now[panel]();
  // The control leaves with its panel; focus falls to <body>.
  page.activeElement = { tagName: "BODY" };
  view.rerender({ ...SHOWN, ...extra, [`${panel}Shown`]: false });
  return toggles;
}

describe("a docked panel's own close hands keyboard focus back", () => {
  it("to the button that opens it, for each of the four that have one", () => {
    expect(close("usage").usage.focus).toHaveBeenCalledTimes(1);
    expect(close("machine").machine.focus).toHaveBeenCalledTimes(1);
    expect(close("accounts").accounts.focus).toHaveBeenCalledTimes(1);
    expect(close("sessionList").sessionList.focus).toHaveBeenCalledTimes(1);
  });

  it("to the selected card for the detail panel, without scrolling the canvas under it", () => {
    card = control(false);
    close("detail");
    expect(page.querySelector).toHaveBeenCalledWith('.react-flow__node[data-id="s1"]');
    expect(card.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("to the canvas when the selected card is not drawn", () => {
    const canvas = control(false);
    close("detail", true, { canvasRef: { current: canvas as unknown as HTMLElement } });
    expect(canvas.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("leaves a mouse press's focus where #851 wants it", () => {
    // Left on the panel's button, the focus would keep Space for that button,
    // and the next Space would reopen the panel rather than pause the stream.
    const toggles = close("usage", false);
    expect(toggles.usage.focus).not.toHaveBeenCalled();
  });
});

describe("the wiring", () => {
  const app = sourceOf("App.tsx");
  const rails = sourceOf("rail-items.tsx");
  const edge = sourceOf("components/EdgeRails.tsx");
  const detail = sourceOf("components/DetailAside.tsx");

  it("arms each panel's hand-off on the close that panel draws", () => {
    expect(app).toMatch(/onClose=\{\(\) => \{ panelReturn\.accounts\(\); closeAccountsPanel\(\); \}\}/);
    expect(app).toMatch(/onClose=\{\(\) => \{ panelReturn\.sessionList\(\); closeSessionList\(\); \}\}/);
    expect(app).toMatch(/onClose=\{\(\) => \{ panelReturn\.usage\(\); setUsagePanelOpen\(false\); \}\}/);
    expect(app).toMatch(/onClose=\{\(\) => \{ panelReturn\.machine\(\); setMachinePanelOpen\(false\); \}\}/);
    expect(app).toMatch(/onClose=\{\(\) => \{ panelReturn\.detail\(\); setDetailOpen\(false\); \}\}/);
    expect(detail).toMatch(/aria-label="Close detail panel"\s+onClick=\{onClose\}/);
  });

  it("says whether each panel is still drawn, by the same test that draws it", () => {
    // The two left panels animate out of the left column since 2026-10-08 and
    // are drawn by `sessionListDrawn` and `accountsDrawn` (panel-exit.ts,
    // isDrawn), which is what their hand-offs read too.
    expect(app).toMatch(/const panelReturn = usePanelReturn\(\{\s*sessionListShown: sessionListDrawn, usageShown: isMounted\(usagePhase\), machineShown: isMounted\(machinePhase\),\s*accountsShown: accountsDrawn, detailShown, primarySelectedId, canvasRef,\s*\}\);/);
    expect(app).toMatch(/\{sessionListDrawn && \(\s*<SessionList/);
    expect(app).toMatch(/\{accountsDrawn && \(\s*<AccountsPanel/);
  });

  it("hands the chrome its four toggles' refs, and every placement puts them on the button", () => {
    // App hands the refs to the one definition of the chrome's controls; each
    // panel's control carries its own; the button every placement draws — a
    // stripe's, the dock's — takes the ref of the control it draws. Only one
    // placement is mounted at a time (App.tsx draws the dock or the stripes),
    // so a ref never has two buttons to choose between.
    expect(app).toMatch(/railItems\(\{[\s\S]*?toggles: panelReturn\.toggles,[\s\S]*?\}\)/);
    for (const [ref, item] of [
      ["sessionList", "sessionList"], ["usage", "usage"], ["accounts", "accounts"], ["machine", "machine"],
    ]) {
      expect(rails, item).toMatch(new RegExp(`const ${item}: RailItem = \\{[\\s\\S]*?buttonRef: toggles\\.${ref},`));
    }
    expect(edge).toMatch(/<button\s+ref=\{item\.buttonRef\}/);
    expect(app).toMatch(/\{phone\s*\?\s*<EdgeDock[\s\S]*?:\s*<EdgeRail side="left"/);
    expect(app).toMatch(/\{!phone && <EdgeRail side="right"/);
  });
});
