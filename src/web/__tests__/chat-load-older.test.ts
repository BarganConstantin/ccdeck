// Chat's older turns (ChatView.tsx): the quiet button at the top only while the
// host has more, what it says while it reads and after a failure, the line
// being read kept in place when older turns arrive above it, and each turn
// keeping its row (its key) when they do.
//
// Run under the suite's stand-in React (fake-react.ts). It has no layout, so
// the scrolling region is a stand-in whose height `commit` sets from what was
// drawn: ROW per turn, and the button's row when there is one.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatOlder, ChatSource, ChatTurn } from "../components/chat/chat-model";
import ChatView from "../components/chat/ChatView";
import { YourMessage } from "../components/chat/ChatTurn";
import { all, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

afterEach(() => { vi.unstubAllGlobals(); });

const ROW = 100;
const BUTTON = 40;
const VIEW = 500;
const turns = (from: number, to: number): ChatTurn[] => Array.from({ length: to - from }, (_, i) => ({ kind: "user", text: `u${from + i}` }));
const older = (over: Partial<ChatOlder> = {}): ChatOlder => ({ load: vi.fn(), loading: false, failed: false, ...over });

function rig(first: ChatSource) {
  const el = { scrollTop: 0, scrollHeight: 0, clientHeight: VIEW, focus: vi.fn() };
  let source = first;
  const height = (s: ChatSource) => (s.state === "ready" ? s.turns.length * ROW + (s.older ? BUTTON : 0) : 0);
  const view = mount(ChatView, { source }, {
    commit(tree) {
      const body = one(tree, d => d.props.className === "chat-body");
      if (body) (body.ref as { current: unknown }).current = el;
      el.scrollHeight = height(source);
    },
  });
  const body = () => one(view.tree, d => d.props.className === "chat-body")!;
  return {
    el, view,
    show(next: ChatSource) { source = next; view.rerender({ source }); },
    /** The reader scrolls to `top`, as the region's own scroll event says. */
    scroll(top: number) { el.scrollTop = top; (body().props.onScroll as (e: unknown) => void)({ currentTarget: el }); },
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

  it("asks the host once per press, and not again while it reads", () => {
    const load = vi.fn();
    const r = rig({ state: "ready", turns: turns(0, 3), older: older({ load }) });
    (r.button()!.props.onClick as () => void)();
    expect(load).toHaveBeenCalledTimes(1);
    r.show({ state: "ready", turns: turns(0, 3), older: older({ load, loading: true }) });
    expect(textOf(r.button())).toBe("Loading older messages…");
    expect(r.button()!.props["aria-busy"]).toBe(true);
    (r.button()!.props.onClick as () => void)();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("says a failed read, and pressing it tries again", () => {
    const load = vi.fn();
    const r = rig({ state: "ready", turns: turns(0, 3), older: older({ load, failed: true }) });
    expect(textOf(r.button())).toBe("Older messages could not be read. Try again");
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
