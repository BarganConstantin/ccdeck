// Skill activity on the right stripe, beside Tool activity.
//
// Skills were a tab inside Tool activity, and users wrote that they could not
// find where skills were. The stripe now carries a door to each, Tool activity
// first and Skill activity right under it, and each opens its own view, titled
// for itself, with no tabs between them — the way Account capacity and Reset
// calendar were split. On a phone the two are rows under More, side by side.
//
// These pin the order, the press, the view each door opens on, and that the
// dialog has no tab strip left.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, mount, one, textOf } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
vi.mock("../use-single-key-shortcuts", () => ({ useSingleKeyShortcuts: () => true }));

const { railItems } = await import("../rail-items");
const { EdgeDock } = await import("../components/EdgeRails");
const { default: ToolAuditModal } = await import("../components/ToolAuditModal");

const noop = () => {};
const ref = () => ({ current: null });
const toggles = { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() };

function rails(openToolActivity?: (view: string) => void) {
  return railItems({
    providers: { kind: "reported", claude: true, codex: true },
    sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
    usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
    setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
    openSettings: noop, onFeedback: noop, toggles, openCapacity: noop, openToolActivity,
  } as unknown as Parameters<typeof railItems>[0]);
}

const ids = (items: { id: string }[]) => items.map(i => i.id);

describe("the right stripe's two doors into Tool activity", () => {
  it("stand together under Usage history, Tool activity first", () => {
    expect(ids(rails(noop).right[1])).toEqual(["history", "tool-activity", "skill-activity", "browser-watch"]);
  });

  it("open the dialog on the view each one names, as a dialog and not a panel", () => {
    const opened: string[] = [];
    const [, tools, skills] = rails(view => opened.push(view)).right[1];
    tools.onPress();
    skills.onPress();
    expect(opened).toEqual(["tools", "skills"]);
    expect([tools.kind, skills.kind]).toEqual(["dialog", "dialog"]);
    expect([tools.ariaLabel, skills.ariaLabel]).toEqual(["Tool activity", "Skill activity"]);
    expect([tools.short, skills.short]).toEqual(["Tools", "Skills"]);
  });

  it("draw two different marks, so neither is mistaken for the other", () => {
    const [, tools, skills] = rails(noop).right[1];
    expect((tools.glyph as { type: unknown }).type).not.toBe((skills.glyph as { type: unknown }).type);
  });

  it("go together where the deck has no Tool activity to open", () => {
    expect(ids(rails().right[1])).toEqual(["history", "browser-watch"]);
  });

  it("are rows under More on a phone, side by side", () => {
    const r = rails(noop);
    const view = mount(EdgeDock, {
      items: [...r.left, ...r.right[0], r.utilities[0]],
      more: [...r.capacity, ...r.right.slice(1).flat(), ...r.integrations, r.utilities[1]],
    });
    const more = one(view.tree, e => typeof e.type === "function" && "items" in e.props && "index" in e.props)!;
    const rows = ids(more.props.items as { id: string }[]);
    expect(rows.indexOf("skill-activity")).toBe(rows.indexOf("tool-activity") + 1);
  });
});

describe("the dialog opens on the view it was asked for", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { activeElement: null, body: {}, addEventListener: noop, removeEventListener: noop });
    // What the dialog asks of the element that had focus when it opened.
    vi.stubGlobal("HTMLElement", class {});
    vi.stubGlobal("window", {
      addEventListener: noop, removeEventListener: noop, requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
      setTimeout: () => 0, clearTimeout: noop,
      matchMedia: () => ({ matches: true, addEventListener: noop, removeEventListener: noop }),
    });
    // The report is read in an effect; nothing here waits for it.
    vi.stubGlobal("fetch", () => new Promise(() => {}));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const opened = (view: "tools" | "skills") => {
    const drawn = mount(ToolAuditModal, { view, onClose: noop, sessionLabel: () => null, onOpenSession: noop });
    const dialog = one(drawn.tree, e => e.props.role === "dialog")!;
    const title = one(drawn.tree, e => e.props.id === "tool-audit-title")!;
    const close = all(drawn.tree, e => e.type === "button" && e.props.title === "Close (Esc)")[0];
    // No tab strip: each door opens one view.
    const tabs = all(drawn.tree, e => e.props.role === "tab" || e.props.role === "tablist").length;
    return { view: dialog.props["data-view"], title: textOf(title), close: close.props["aria-label"], tabs };
  };

  it("the tools, titled Tool activity", () => {
    expect(opened("tools")).toEqual({ view: "tools", title: "Tool activity", close: "Close tool activity", tabs: 0 });
  });

  it("the skills, titled Skill activity", () => {
    expect(opened("skills")).toEqual({ view: "skills", title: "Skill activity", close: "Close skill activity", tabs: 0 });
  });
});
