// Chat's older turns (ChatView.tsx): the quiet button at the top only while the
// host has more, what it says while it reads and after a failure, the page
// before asked for by itself once the top is in reach (chat-older.ts decides
// when), the line being read kept in place when older turns arrive above it,
// and each turn keeping its row (its key) when they do.
//
// Run under the suite's stand-in React (fake-react.ts). It has no layout, so
// the scrolling region is a stand-in whose height `commit` sets from what was
// drawn: ROW per turn, and the button's row when there is one. With no
// IntersectionObserver the view measures the scroll; one stubbed in is called
// as the browser would.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatOlder, ChatSource, ChatTurn } from "../components/chat/chat-model";
import ChatView from "../components/chat/ChatView";
import { YourMessage } from "../components/chat/ChatTurn";
import { Loader } from "../components/Loader";
import { OLDER_MARGIN, OLDER_RUN } from "../components/chat/chat-older";
import { all, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

afterEach(() => { vi.unstubAllGlobals(); });

const ROW = 100;
const BUTTON = 40;
const VIEW = 500;
const turns = (from: number, to: number): ChatTurn[] => Array.from({ length: to - from }, (_, i) => ({ kind: "user", text: `u${from + i}` }));
const older = (over: Partial<ChatOlder> = {}): ChatOlder => ({ load: vi.fn(), loading: false, failed: false, ...over });

function rig(first: ChatSource, session = "s1") {
  const el = { scrollTop: 0, scrollHeight: 0, clientHeight: VIEW, focus: vi.fn() };
  // The button as the page holds it, for an observer to watch and the focus to sit on.
  const mark = { older: true };
  let source = first;
  let shown = session;
  const height = (s: ChatSource) => (s.state === "ready" ? s.turns.length * ROW + (s.older ? BUTTON : 0) : 0);
  const view = mount(ChatView, { source, session }, {
    commit(tree) {
      const body = one(tree, d => d.props.className === "chat-body");
      if (body) (body.ref as { current: unknown }).current = el;
      const button = one(tree, d => d.type === "button" && String(d.props.className).includes("chat-older"));
      if (button) (button.ref as { current: unknown }).current = mark;
      el.scrollHeight = height(source);
    },
  });
  const body = () => one(view.tree, d => d.props.className === "chat-body")!;
  return {
    el, view, mark,
    show(next: ChatSource, to = shown) { source = next; shown = to; view.rerender({ source, session: shown }); },
    /** The reader scrolls to `top`, as the region's own scroll event says. */
    scroll(top: number) { el.scrollTop = top; (body().props.onScroll as (e: unknown) => void)({ currentTarget: el }); },
    /** A turn of the wheel: up when `deltaY` is below 0. */
    wheel(deltaY: number) { (body().props.onWheel as (e: unknown) => void)({ deltaY }); },
    button: () => one(view.tree, d => d.type === "button" && String(d.props.className).includes("chat-older")),
    keyOf: (text: string) => (all(view.tree, d => d.type === YourMessage).find(d => d.props.text === text) as (Drawn & { key: string }) | undefined)?.key,
  };
}

describe("the button", () => {
  it("is drawn only while the host offers older turns, first in the column", () => {
    const r = rig({ state: "ready", turns: turns(0, 3) });
    expect(r.button()).toBeNull();
    r.show({ state: "ready", turns: turns(0, 3), older: older() });
    const col = one(r.view.tree, d => d.props.className === "chat-col")!;
    const ready = (col.props.children as unknown[]).find(c => c && typeof c === "object") as Drawn;
    expect((ready.props.children as unknown[]).find(Boolean)).toBe(r.button());
    expect(textOf(r.button())).toBe("Load older messages");
    expect(r.button()!.props.className).toBe("chat-retry chat-older");
  });

  it("asks the host once per press, and not again while it reads, with the Loader beside its words", () => {
    const load = vi.fn();
    // Far from the top, so only the press asks.
    const r = rig({ state: "ready", turns: turns(0, 30), older: older({ load }) });
    expect(load).not.toHaveBeenCalled();
    expect(one(r.button(), d => d.type === Loader)).toBeNull();
    (r.button()!.props.onClick as () => void)();
    expect(load).toHaveBeenCalledTimes(1);
    r.show({ state: "ready", turns: turns(0, 30), older: older({ load, loading: true }) });
    expect(textOf(r.button())).toBe("Loading older messages…");
    expect(r.button()!.props["aria-busy"]).toBe(true);
    expect(one(r.button(), d => d.type === Loader)).not.toBeNull();
    (r.button()!.props.onClick as () => void)();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("says a failed read, and pressing it tries again", () => {
    const load = vi.fn();
    const r = rig({ state: "ready", turns: turns(0, 3), older: older({ load, failed: true }) });
    expect(textOf(r.button())).toBe("Older messages could not be read. Try again");
    expect(r.button()!.props["aria-busy"]).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    (r.button()!.props.onClick as () => void)();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("is not drawn while loading the conversation or after an error", () => {
    expect(rig({ state: "loading" }).button()).toBeNull();
    expect(rig({ state: "error", message: "x" }).button()).toBeNull();
  });
});

describe("older turns arriving above", () => {
  it("keep the line being read in place", () => {
    const r = rig({ state: "ready", turns: turns(5, 15), older: older() });
    r.scroll(0);
    expect(r.el.scrollTop).toBe(0);
    // Five older turns go in front: the height above the reader grows by five rows.
    r.show({ state: "ready", turns: turns(0, 15), older: older(), head: 5 });
    expect(r.el.scrollTop).toBe(5 * ROW);
    // The last of them: the button's row goes too.
    r.scroll(120);
    r.show({ state: "ready", turns: turns(-3, 15), head: 8 });
    expect(r.el.scrollTop).toBe(120 + 3 * ROW - BUTTON);
  });

  it("leave a reader at the bottom at the bottom", () => {
    const r = rig({ state: "ready", turns: turns(5, 15), older: older() });
    expect(r.el.scrollTop).toBe(10 * ROW + BUTTON);
    r.show({ state: "ready", turns: turns(0, 15), older: older(), head: 5 });
    expect(r.el.scrollTop).toBe(15 * ROW + BUTTON);
  });

  it("move nothing when the head did not move: new turns at the bottom are the live window's", () => {
    const r = rig({ state: "ready", turns: turns(5, 15), older: older(), head: 5 });
    r.scroll(200);
    r.show({ state: "ready", turns: turns(5, 18), older: older(), head: 5 });
    expect(r.el.scrollTop).toBe(200);
  });

  it("each turn keeps its key, so its row and what is open in it stay its own", () => {
    const r = rig({ state: "ready", turns: turns(5, 15), older: older() });
    expect(r.keyOf("u5")).toBe("0");
    expect(r.keyOf("u14")).toBe("9");
    r.show({ state: "ready", turns: turns(0, 15), older: older(), head: 5 });
    expect(r.keyOf("u5")).toBe("0");
    expect(r.keyOf("u14")).toBe("9");
    expect(r.keyOf("u0")).toBe("-5");
  });

  it("hand the keys to the reading region when the pressed button goes with the last page", () => {
    vi.stubGlobal("document", { activeElement: null, body: {} });
    const r = rig({ state: "ready", turns: turns(5, 15), older: older() });
    r.scroll(0);
    (r.button()!.props.onClick as () => void)();
    r.show({ state: "ready", turns: turns(0, 15), head: 5 });
    expect(r.el.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("leave the focus alone while the button is still there", () => {
    vi.stubGlobal("document", { activeElement: null, body: {} });
    const r = rig({ state: "ready", turns: turns(5, 15), older: older() });
    (r.button()!.props.onClick as () => void)();
    r.show({ state: "ready", turns: turns(0, 15), older: older(), head: 5 });
    expect(r.el.focus).not.toHaveBeenCalled();
  });
});

describe("older turns by themselves, as the top comes in reach (measured on scroll)", () => {
  it("asks for the page before once the top is within a view's height, once however often the scroll moves", () => {
    const load = vi.fn();
    const r = rig({ state: "ready", turns: turns(10, 40), older: older({ load }) });
    // Opened at the latest, 30 rows from the top: nothing asked.
    expect(r.el.scrollTop).toBe(30 * ROW + BUTTON);
    expect(load).not.toHaveBeenCalled();
    r.scroll(1500);
    expect(load).not.toHaveBeenCalled();
    // A view's height from the top, and on up as fast as a wheel goes.
    for (const top of [VIEW, 400, 300, 120, 0]) r.scroll(top);
    expect(load).toHaveBeenCalledTimes(1);
    r.show({ state: "ready", turns: turns(10, 40), older: older({ load, loading: true }) });
    r.scroll(0);
    r.wheel(-60);
    expect(load).toHaveBeenCalledTimes(1);
    // The page is in: the line being read stays, now ten rows down, out of reach.
    r.show({ state: "ready", turns: turns(0, 40), older: older({ load }), head: 10 });
    expect(r.el.scrollTop).toBe(10 * ROW);
    expect(load).toHaveBeenCalledTimes(1);
    r.scroll(VIEW - 100);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("asks nothing at the start: the button goes, and nothing waits at the top", () => {
    const load = vi.fn();
    const r = rig({ state: "ready", turns: turns(5, 40), older: older({ load }) });
    r.scroll(0);
    expect(load).toHaveBeenCalledTimes(1);
    r.show({ state: "ready", turns: turns(0, 40), head: 5 });
    expect(r.button()).toBeNull();
    r.scroll(0);
    r.wheel(-60);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it(`fills a first page shorter than the view, ${OLDER_RUN} pages at most, until the reader asks for more`, () => {
    const load = vi.fn();
    let from = 100;
    const r = rig({ state: "ready", turns: turns(from, 101), older: older({ load }) });
    expect(load).toHaveBeenCalledTimes(1);
    // A tall pane, and each page brings one short turn: the conversation never scrolls.
    r.el.clientHeight = 20 * VIEW;
    for (let page = 1; page <= OLDER_RUN + 2; page++) {
      r.show({ state: "ready", turns: turns(from, 101), older: older({ load, loading: true }), head: 100 - from });
      from -= 1;
      r.show({ state: "ready", turns: turns(from, 101), older: older({ load }), head: 100 - from });
    }
    expect(load).toHaveBeenCalledTimes(OLDER_RUN);
    // The wheel turned up where nothing scrolls: the reader asks, a new run.
    r.wheel(-60);
    expect(load).toHaveBeenCalledTimes(OLDER_RUN + 1);
    // A wheel down asks nothing.
    r.wheel(60);
    expect(load).toHaveBeenCalledTimes(OLDER_RUN + 1);
  });

  it("stops filling once the conversation scrolls the top out of reach", () => {
    const load = vi.fn();
    const r = rig({ state: "ready", turns: turns(30, 32), older: older({ load }) });
    expect(load).toHaveBeenCalledTimes(1);
    r.show({ state: "ready", turns: turns(30, 32), older: older({ load, loading: true }) });
    // Thirty rows in front: the reader, at the latest, is far from the top.
    r.show({ state: "ready", turns: turns(0, 32), older: older({ load }), head: 30 });
    expect(r.el.scrollTop).toBe(32 * ROW + BUTTON);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not ask again after a failure; Retry asks, and the pages go on coming after it", () => {
    const load = vi.fn();
    const r = rig({ state: "ready", turns: turns(5, 40), older: older({ load }) });
    r.scroll(0);
    expect(load).toHaveBeenCalledTimes(1);
    r.show({ state: "ready", turns: turns(5, 40), older: older({ load, failed: true }) });
    r.scroll(10);
    r.scroll(0);
    r.wheel(-60);
    expect(load).toHaveBeenCalledTimes(1);
    expect(textOf(r.button())).toBe("Older messages could not be read. Try again");
    (r.button()!.props.onClick as () => void)();
    expect(load).toHaveBeenCalledTimes(2);
    r.show({ state: "ready", turns: turns(5, 40), older: older({ load, loading: true }) });
    r.show({ state: "ready", turns: turns(3, 40), older: older({ load }), head: 2 });
    // Two short rows in front: the top is still in reach, the next page is asked.
    expect(r.el.scrollTop).toBe(2 * ROW);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("starts anew for another session, whose own offer is the one asked", () => {
    const loadA = vi.fn();
    const loadB = vi.fn();
    const r = rig({ state: "ready", turns: turns(0, 1), older: older({ load: loadA }) }, "a");
    expect(loadA).toHaveBeenCalledTimes(1);
    r.show({ state: "loading" }, "b");
    r.show({ state: "ready", turns: turns(0, 1), older: older({ load: loadB }) }, "b");
    expect(loadB).toHaveBeenCalledTimes(1);
    expect(loadA).toHaveBeenCalledTimes(1);
  });

  it("hands the keys to the reading region when the button held them and the page read by itself was the last", () => {
    const load = vi.fn();
    const doc = { activeElement: null as unknown, body: {} };
    vi.stubGlobal("document", doc);
    const r = rig({ state: "ready", turns: turns(5, 40), older: older({ load }) });
    // Tabbed to: the button is the focus, and scrolled into view.
    doc.activeElement = r.mark;
    r.scroll(0);
    expect(load).toHaveBeenCalledTimes(1);
    r.show({ state: "ready", turns: turns(5, 40), older: older({ load, loading: true }) });
    doc.activeElement = null;
    r.show({ state: "ready", turns: turns(0, 40), head: 5 });
    expect(r.el.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe("older turns by themselves, with an IntersectionObserver", () => {
  interface Watch { fire: (on: boolean) => void; root: unknown; margin: string; watched: unknown[]; gone: boolean }
  let watches: Watch[] = [];
  const stubObserver = () => {
    watches = [];
    vi.stubGlobal("IntersectionObserver", class {
      w: Watch;
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void, opts: { root: unknown; rootMargin: string }) {
        this.w = { fire: on => cb([{ isIntersecting: on }]), root: opts.root, margin: opts.rootMargin, watched: [], gone: false };
        watches.push(this.w);
      }
      observe(target: unknown) { this.w.watched.push(target); }
      disconnect() { this.w.gone = true; }
    });
  };
  const live = () => watches.filter(w => !w.gone);

  it("watches the button with a view's height of margin above the region, and asks when it comes in", () => {
    stubObserver();
    const load = vi.fn();
    const r = rig({ state: "ready", turns: turns(10, 40), older: older({ load }) });
    expect(live()).toHaveLength(1);
    const [w] = live();
    expect(w.root).toBe(r.el);
    expect(w.margin).toBe(OLDER_MARGIN);
    expect(OLDER_MARGIN).toBe("100% 0px 0px 0px");
    expect(w.watched).toEqual([r.mark]);
    w.fire(false);
    r.scroll(1200);
    expect(load).not.toHaveBeenCalled();
    w.fire(true);
    expect(load).toHaveBeenCalledTimes(1);
    // The observer and the scroll both answering for one move: still one ask.
    w.fire(true);
    r.scroll(300);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("asks the observer again once a page is in, and goes on only while the top is still in reach", () => {
    stubObserver();
    const load = vi.fn();
    const r = rig({ state: "ready", turns: turns(10, 40), older: older({ load }) });
    live()[0].fire(true);
    expect(load).toHaveBeenCalledTimes(1);
    r.show({ state: "ready", turns: turns(10, 40), older: older({ load, loading: true }) });
    r.show({ state: "ready", turns: turns(8, 40), older: older({ load }), head: 2 });
    // A new watch, whose first answer says where the top is now; the scroll
    // that comes before it (the reader stuck to the bottom) asks nothing.
    expect(live()).toHaveLength(1);
    r.scroll(r.el.scrollTop + 1);
    expect(load).toHaveBeenCalledTimes(1);
    live()[0].fire(true);
    expect(load).toHaveBeenCalledTimes(2);
    r.show({ state: "ready", turns: turns(8, 40), older: older({ load, loading: true }), head: 2 });
    r.show({ state: "ready", turns: turns(0, 40), older: older({ load }), head: 10 });
    live()[0].fire(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("stops watching at the start, and while Chat loads another session", () => {
    stubObserver();
    const r = rig({ state: "ready", turns: turns(10, 40), older: older() });
    expect(live()).toHaveLength(1);
    r.show({ state: "ready", turns: turns(0, 40), head: 10 });
    expect(live()).toHaveLength(0);
    r.show({ state: "loading" }, "s2");
    expect(live()).toHaveLength(0);
  });
});
