// A popover taller than the window keeps what was scrolled when it renders again.
//
// AnchoredPopover places itself on every render, and measures itself uncapped
// first so that a squeezed popover can grow back (peek-short-window.test.ts).
// Uncapped, it has nothing to scroll, so the browser took its scroll back to
// the top at that measure, and the cap put back after it did not return it.
// The Command Panel's New session popover renders again within a second of
// opening, so on a 320 x 640 phone, where it is capped at about 390px and
// Cancel and Start sit below that, a scroll down to them was undone before a
// finger could reach them; with touch's 32px rows they were not drawn at all.
//
// The popover runs under fake-react with a box that scrolls the way a browser's
// does: what is scrolled never passes the end, and a layout that leaves less to
// scroll takes it back.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));

/** The popover's own element, as useModalDismiss hands it over. */
const box = { ref: { current: null as unknown } };
vi.mock("../components/use-modal-dismiss", () => ({ useModalDismiss: () => box.ref }));
vi.mock("../components/use-outside-press", () => ({ useOutsidePress: () => {} }));

import { mount } from "./fake-react";
import AnchoredPopover from "../components/AnchoredPopover";
import { POPOVER_GAP, POPOVER_MARGIN } from "../popover-place";

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.document;
  delete g.window;
  box.ref.current = null;
});

/** A box `content` px tall inside, capped by its max-height: what it can scroll,
 *  and the layout that clamps that whenever its height is read. */
function scrollingBox(content: number) {
  let scrolled = 0;
  const el = {
    style: { top: "", left: "", maxHeight: "" } as Record<string, string>,
    dataset: {} as Record<string, string>,
    offsetWidth: 304,
    get offsetHeight() {
      const cap = parseFloat(el.style.maxHeight);
      const h = Number.isFinite(cap) ? Math.min(cap, content) : content;
      scrolled = Math.min(scrolled, content - h);
      return h;
    },
    get scrollTop() { return Math.min(scrolled, content - el.offsetHeight); },
    set scrollTop(v: number) { scrolled = Math.max(0, Math.min(v, content - el.offsetHeight)); },
    contains: () => false,
  };
  return el;
}

function popoverOnPhone(content: number, overAnchor = false) {
  const g = globalThis as Record<string, unknown>;
  const window = { innerWidth: 320, innerHeight: 640, addEventListener: () => {}, removeEventListener: () => {} };
  // New session, about a third of the way down a 640px phone.
  const anchor = { getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 202, bottom: 238, left: 24, right: 140 }), focus: () => {} };
  g.window = window;
  g.document = { body: {}, activeElement: null, getElementById: (id: string) => (id === "anchor" ? anchor : null) };
  const el = scrollingBox(content);
  box.ref.current = el;
  const view = mount(AnchoredPopover, {
    anchorId: "anchor", id: "ns-pop", role: "dialog", labelledBy: "t", onClose: () => {}, align: "start", overAnchor,
    children: "the form",
  } as never);
  return { view, el, window };
}

// New session asks to stay whole (popover-place.ts, overAnchor): where the
// window holds the form it covers its anchor rather than scroll, and only a
// window shorter than the form leaves it something to scroll.
describe("a form that asks to stay whole, as New session does", () => {
  it("covers its anchor rather than scroll, where the window holds it", () => {
    const { el, view } = popoverOnPhone(473, true);
    expect(el.style.maxHeight).toBe("");
    expect(el.offsetHeight).toBe(473);
    expect(el.style.top).toBe(`${640 - POPOVER_MARGIN - 473}px`);
    expect(el.dataset.side).toBe("below");
    view.unmount();
  });

  it("in a window shorter than itself takes all the window has, and keeps a scroll down to Cancel and Start", () => {
    const { el, view } = popoverOnPhone(700, true);
    expect(el.style.top).toBe(`${POPOVER_MARGIN}px`);
    expect(el.style.maxHeight).toBe(`${640 - POPOVER_MARGIN * 2}px`);
    el.scrollTop = 1e6;
    const end = el.scrollTop;
    expect(end, "it can be scrolled to its end at all").toBeGreaterThan(0);
    view.rerender();
    expect(el.scrollTop, "still at Cancel and Start after the render").toBe(end);
    view.unmount();
  });
});

describe("a popover taller than the window, as it renders again", () => {
  it("refits an expanding native disclosure even when its wrapper did not rerender", () => {
    let resized: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
    const { view, el } = popoverOnPhone(200);
    const initial = el.offsetHeight;
    Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => el.style.maxHeight ? Math.min(600, Number.parseFloat(el.style.maxHeight)) : 600 });
    resized!();
    expect(el.style.maxHeight).not.toBe("");
    expect(el.offsetHeight).toBeGreaterThan(initial);
    expect(Number.parseFloat(el.style.top) + el.offsetHeight).toBeLessThanOrEqual(640 - POPOVER_MARGIN);
    view.unmount();
    vi.unstubAllGlobals();
  });
  it("is capped to the room below its anchor and scrolls the rest", () => {
    const { el, view } = popoverOnPhone(473);
    const room = 640 - POPOVER_MARGIN - (238 + POPOVER_GAP);
    expect(el.style.maxHeight).toBe(`${room}px`);
    expect(el.offsetHeight).toBe(room);
    view.unmount();
  });

  it("keeps a scroll down to its last controls across a render", () => {
    const { el, view } = popoverOnPhone(473);
    el.scrollTop = 1e6;
    const end = el.scrollTop;
    expect(end, "it can be scrolled to its end at all").toBeGreaterThan(0);
    view.rerender();
    expect(el.scrollTop, "still at Cancel and Start after the render").toBe(end);
    view.rerender();
    expect(el.scrollTop).toBe(end);
    view.unmount();
  });

  it("and a scroll part of the way, where it was", () => {
    const { el, view } = popoverOnPhone(473);
    el.scrollTop = 40;
    view.rerender();
    expect(el.scrollTop).toBe(40);
    view.unmount();
  });

  it("still grows back to its natural height when the window has room again", () => {
    const { el, view, window } = popoverOnPhone(473);
    el.scrollTop = 1e6;
    window.innerHeight = 900;
    view.rerender();
    expect(el.style.maxHeight).toBe("");
    expect(el.offsetHeight).toBe(473);
    expect(el.scrollTop, "nothing left to scroll").toBe(0);
    view.unmount();
  });
});
