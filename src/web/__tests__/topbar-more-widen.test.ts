// The topbar's ⋯ menu jumped to the window's top-left corner when the window
// grew past a phone's width while it was open.
//
// Under 480px, History, Browser watch and Feedback fold into the ⋯
// (TopbarMore.tsx), and above it the sheet hides the ⋯ and draws the three
// again. A menu open across that line was placed against a button that was no
// longer drawn: AnchoredPopover follows its anchor on every resize, a hidden
// element's box is all zeros, and the menu went to the window's corner, open
// and holding focus, under a button nobody could see.
//
// Now a popover whose anchor stops being drawn closes, the way one whose anchor
// is gone already did, and focus inside it goes where the caller says — for
// the ⋯, the button the focused item stands for, back on the bar.
//
// Run, not read: AnchoredPopover and TopbarMore are drawn on fake-react.ts's
// React, against a window whose resize the test fires and a document whose
// elements the test lays out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mount, one, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
// Escape, the Tab trap and the stack are the hook's, and not what is asked
// here: a ref for the surface is all the popover takes from it.
vi.mock("../components/use-modal-dismiss", async () => {
  const { react } = await import("./fake-react");
  return { useModalDismiss: () => react.useRef(null) };
});
vi.mock("../components/use-outside-press", () => ({ useOutsidePress: () => {} }));

const { default: AnchoredPopover } = await import("../components/AnchoredPopover");
const { default: TopbarMore } = await import("../components/TopbarMore");

type Box = { top: number; right: number; bottom: number; left: number; width: number; height: number };
const NONE: Box = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };

/** An element of the page: its box while drawn, and focus. */
interface Fake {
  id?: string;
  drawn: boolean;
  box: Box;
  focus: (o?: unknown) => void;
  getBoundingClientRect: () => Box;
  getClientRects: () => Box[];
}
let page: { activeElement: unknown; body: object; getElementById: (id: string) => unknown; querySelectorAll: (s: string) => unknown[] };
const listeners = new Map<string, Set<(e?: unknown) => void>>();

function fake(id: string, box: Box): Fake {
  const f: Fake = {
    id, drawn: true, box,
    focus: () => { page.activeElement = f; },
    getBoundingClientRect: () => (f.drawn ? f.box : NONE),
    getClientRects: () => (f.drawn ? [f.box] : []),
  };
  return f;
}

/** The ⋯ at the right end of a 420px bar. */
let more: Fake;
/** History, Browser watch and Feedback, as the bar draws them above 480px. */
let folded: Fake[];
/** The menu's three items, once it is drawn. */
let items: Fake[];
/** The popover's own surface: its size, and where `place` put it. */
let surface: { style: Record<string, string>; dataset: Record<string, string>; offsetWidth: number; offsetHeight: number; contains: (n: unknown) => boolean; querySelectorAll: () => unknown[] };

beforeEach(() => {
  listeners.clear();
  more = fake("tb-more", { top: 11, bottom: 41, left: 380, right: 410, width: 30, height: 30 });
  folded = ["history", "watch", "feedback"].map((n, i) => {
    const f = fake(n, { top: 11, bottom: 41, left: 300 + i * 40, right: 330 + i * 40, width: 30, height: 30 });
    f.drawn = false;
    return f;
  });
  items = ["Usage history", "Browser watch", "Send feedback"].map(n => fake(n, NONE));
  surface = {
    style: {}, dataset: {}, offsetWidth: 200, offsetHeight: 110,
    contains: n => items.includes(n as Fake),
    querySelectorAll: () => items,
  };
  page = {
    activeElement: null,
    body: {},
    getElementById: id => (id === "tb-more" ? more : id === "tb-more-menu" ? surface : null),
    querySelectorAll: (s: string) => (s === '#tb-more-menu [role="menuitem"]' ? items : s === ".topbar .tb-fold" ? folded : []),
  };
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", {
    innerWidth: 420, innerHeight: 800,
    addEventListener: (t: string, f: (e?: unknown) => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f); },
    removeEventListener: (t: string, f: (e?: unknown) => void) => { listeners.get(t)?.delete(f); },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Attaches the popover's ref to its surface, as React would before effects. */
function attach(tree: unknown) {
  const pop = tree && typeof tree === "object" && "ref" in tree ? (tree as Drawn).ref : null;
  if (pop && typeof pop === "object") (pop as { current: unknown }).current = surface;
}

/** The window grows past 480px: the sheet hides the ⋯ and draws the three. */
function widen() {
  (window as unknown as { innerWidth: number }).innerWidth = 700;
  more.drawn = false;
  for (const f of folded) f.drawn = true;
  for (const f of listeners.get("resize") ?? []) f();
}

function openMenu(fallbackFocus?: () => unknown) {
  const onClose = vi.fn();
  mount(AnchoredPopover as (p: Record<string, unknown>) => unknown, {
    anchorId: "tb-more", id: "tb-more-menu", role: "menu", labelledBy: "tb-more", onClose, fallbackFocus, children: null,
  }, { commit: attach });
  return onClose;
}

describe("a popover whose anchor stops being drawn", () => {
  it("is placed beside its anchor while the anchor is drawn", () => {
    openMenu();
    expect(Number.parseFloat(surface.style.top)).toBeGreaterThanOrEqual(41);
    expect(Number.parseFloat(surface.style.left)).toBeGreaterThan(150);
  });

  it("closes rather than going to the window's corner", () => {
    const onClose = openMenu();
    const at = { ...surface.style };
    widen();
    // Not moved: it was placed at the anchor and left there for its last frame.
    expect(surface.style).toEqual(at);
    expect(onClose).toHaveBeenCalled();
  });

  it("hands focus where its caller says when the focus was inside it", () => {
    const onClose = openMenu(() => folded[1]);
    items[1].focus();
    widen();
    expect(onClose).toHaveBeenCalled();
    expect(page.activeElement).toBe(folded[1]);
  });

  it("leaves focus alone when it was somewhere else", () => {
    const elsewhere = fake("canvas", NONE);
    openMenu(() => folded[0]);
    elsewhere.focus();
    widen();
    expect(page.activeElement).toBe(elsewhere);
  });
});

describe("the topbar's ⋯ when the window grows past a phone's width", () => {
  /** The ⋯, opened, and the popover it draws. */
  function opened() {
    const view = mount(TopbarMore, { watchUnseen: 0, setUsageHistoryOpen: () => {}, setBrowserWatchOpen: () => {}, onFeedback: () => {} });
    (one(view.tree, el => el.type === "button")!.props.onClick as () => void)();
    const popover = one(view.tree, el => el.type === AnchoredPopover)!;
    return popover.props.fallbackFocus as () => Fake | null;
  }

  it("gives focus to the button the focused item stands for, back on the bar", () => {
    const fallback = opened();
    for (const [i, item] of items.entries()) {
      item.focus();
      expect(fallback(), `${i}`).toBe(folded[i]);
    }
  });
});
