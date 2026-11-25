// Chat at the bottom while it lives (ChatView.tsx): it sticks within
// BOTTOM_SLACK of the end, holds there when anything changes size under it,
// counts the turns that came while the reader was up ("3 new"), goes back
// smoothly unless motion is reduced, and lets only lines that arrive while you
// watch rise in (data-arrive), never a first read, older turns or a switch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatView, { BOTTOM_SLACK, type ChatViewProps } from "../components/chat/ChatView";
import type { ChatSource, ChatTurn } from "../components/chat/chat-model";
import { resetLanguageForTest, setLanguage } from "../i18n";
import { all, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const said = (text: string): ChatTurn => ({ kind: "assistant", text });
const you = (text: string): ChatTurn => ({ kind: "user", text });
const bash = (arg: string, running?: boolean): ChatTurn => ({ kind: "tool", name: "Bash", arg, ...(running ? { running } : {}) });
const ready = (turns: ChatTurn[], more: Partial<Extract<ChatSource, { state: "ready" }>> = {}): ChatSource =>
  ({ state: "ready", turns: turns.map(turn => structuredClone(turn)), ...more });

/** The ResizeObservers ChatView made, to call as the browser would. */
let observers: Array<{ fire: () => void; watched: unknown[]; gone: boolean }> = [];
let reduced = false;

beforeEach(() => {
  observers = [];
  reduced = false;
  resetLanguageForTest();
  vi.stubGlobal("ResizeObserver", class {
    entry: { fire: () => void; watched: unknown[]; gone: boolean };
    constructor(cb: () => void) { this.entry = { fire: cb, watched: [], gone: false }; observers.push(this.entry); }
    observe(target: unknown) { this.entry.watched.push(target); }
    disconnect() { this.entry.gone = true; }
  });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") && reduced }));
});
afterEach(() => { vi.unstubAllGlobals(); setLanguage("en"); });

function rig(first: ChatViewProps) {
  // The scroller as the page would lay it out: 1000px of conversation in 400px.
  const el = {
    scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
    focus: vi.fn(), scrollTo: vi.fn((o: { top: number }) => { el.scrollTop = o.top; }),
  };
  const col = { column: true };
  const m = mount(ChatView, first, {
    commit: tree => {
      const region = all(tree, e => e.props.role === "region")[0];
      ((region.ref ?? region.props.ref) as { current: unknown }).current = el;
      const column = all(tree, e => e.props.className === "chat-col")[0];
      ((column.ref ?? column.props.ref) as { current: unknown }).current = col;
    },
  });
  const region = () => all(m.tree, e => e.props.role === "region")[0];
  /** The reader puts the scroll `fromEnd` px above the end. */
  const scrollTo = (fromEnd: number) => {
    el.scrollTop = el.scrollHeight - el.clientHeight - fromEnd;
    (region().props.onScroll as (e: unknown) => void)({ currentTarget: el });
  };
  const pill = () => one(m.tree, e => e.props.className === "chat-latest btn");
  const arrive = () => one(m.tree, e => e.props.className === "chat")!.props["data-arrive"];
  return { m, el, col, region, scrollTo, pill, arrive };
}

const talk = [you("run the tests"), said("Running them."), bash("npm test")];

describe("the stick to the bottom", () => {
  it("holds within BOTTOM_SLACK of the end, and lets go past it", () => {
    expect(BOTTOM_SLACK).toBe(48);
    const r = rig({ source: ready(talk) });
    r.scrollTo(BOTTOM_SLACK);
    expect(r.pill()).toBeNull();
    r.m.rerender({ source: ready([...talk, said("b")]) });
    expect(r.el.scrollTop).toBe(r.el.scrollHeight);
    r.scrollTo(BOTTOM_SLACK + 1);
    expect(r.pill()).not.toBeNull();
    const at = r.el.scrollTop;
    r.m.rerender({ source: ready([...talk, said("b"), said("c")]) });
    expect(r.el.scrollTop).toBe(at);
  });

  it("holds when the region or the column changes size under a reader at the bottom", () => {
    const r = rig({ source: ready(talk) });
    expect(observers).toHaveLength(1);
    expect(observers[0].watched).toEqual([r.el, r.col]);
    r.scrollTo(0);
    // A Decision card docks: the region is shorter; a disclosure opens: the column is taller.
    r.el.clientHeight = 260;
    r.el.scrollHeight = 1300;
    observers[0].fire();
    expect(r.el.scrollTop).toBe(1300);
  });

  it("but leaves a reader who scrolled up where they are, and stops watching when it goes", () => {
    const r = rig({ source: ready(talk) });
    r.scrollTo(300);
    const at = r.el.scrollTop;
    r.el.scrollHeight = 1300;
    observers[0].fire();
    expect(r.el.scrollTop).toBe(at);
    r.m.unmount();
    expect(observers[0].gone).toBe(true);
  });
});

describe("the way back", () => {
  it("counts the turns that came while the reader was up", () => {
    const r = rig({ source: ready(talk) });
    r.scrollTo(300);
    expect(textOf(r.pill())).toBe("Latest messages");
    expect(r.pill()!.props["aria-label"]).toBeUndefined();
    expect(r.pill()!.props.type).toBe("button");
    r.m.rerender({ source: ready([...talk, said("b")]) });
    expect(textOf(r.pill())).toBe("1 new");
    r.m.rerender({ source: ready([...talk, said("b"), you("c"), said("d")]) });
    expect(textOf(r.pill())).toBe("3 new");
    expect(r.pill()!.props["aria-label"]).toBe("Latest messages, 3 new");
  });

  it("counts a slid window's new turn, never a turn that changed in place or the same read again", () => {
    const r = rig({ source: ready([...talk, bash("git push", true)]) });
    r.scrollTo(300);
    r.m.rerender({ source: ready([...talk, bash("git push")]) });
    r.m.rerender({ source: ready([...talk, bash("git push")]) });
    expect(textOf(r.pill())).toBe("Latest messages");
    r.m.rerender({ source: ready([...talk.slice(1), bash("git push"), said("pushed")]) });
    expect(textOf(r.pill())).toBe("1 new");
  });

  it("forgets the count at the bottom, and for another session", () => {
    const r = rig({ source: ready(talk), session: "a" });
    r.scrollTo(300);
    r.m.rerender({ source: ready([...talk, said("b")]), session: "a" });
    r.scrollTo(0);
    expect(r.pill()).toBeNull();
    r.scrollTo(300);
    expect(textOf(r.pill())).toBe("Latest messages");
    r.m.rerender({ source: ready([...talk, said("b"), said("c")]), session: "a" });
    expect(textOf(r.pill())).toBe("1 new");
    r.m.rerender({ source: ready([said("other")]), session: "b" });
    expect(textOf(r.pill())).toBe("Latest messages");
  });

  it("says how many in the reader's language, plural and all", () => {
    setLanguage("ro");
    const r = rig({ source: ready(talk) });
    r.scrollTo(300);
    r.m.rerender({ source: ready([...talk, said("b")]) });
    expect(textOf(r.pill())).toBe("1 nou");
    r.m.rerender({ source: ready([...talk, said("b"), said("c"), said("d")]) });
    expect(textOf(r.pill())).toBe("3 noi");
  });

  it("goes back smoothly, following at once, and the scroll on the way down does not stop it", () => {
    const r = rig({ source: ready(talk) });
    r.scrollTo(300);
    r.m.rerender({ source: ready([...talk, said("b")]) });
    (r.pill()!.props.onClick as () => void)();
    expect(r.el.scrollTo).toHaveBeenCalledWith({ top: r.el.scrollHeight, behavior: "smooth" });
    expect(r.el.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(r.pill()).toBeNull();
    // The smooth scroll's own steps, still above the end.
    r.scrollTo(200);
    r.scrollTo(80);
    expect(r.pill()).toBeNull();
    r.m.rerender({ source: ready([...talk, said("b"), said("c")]) });
    expect(r.el.scrollTop).toBe(r.el.scrollHeight);
  });

  it("lets a hand on the wheel take the scroll back from the way down", () => {
    const r = rig({ source: ready(talk) });
    r.scrollTo(300);
    (r.pill()!.props.onClick as () => void)();
    (r.region().props.onWheel as () => void)();
    r.scrollTo(200);
    expect(r.pill()).not.toBeNull();
  });

  it("hands its focus to the conversation when the reader scrolls to the bottom with it focused", () => {
    const button = { pill: true };
    vi.stubGlobal("document", { activeElement: button });
    const r = rig({ source: ready(talk) });
    r.scrollTo(300);
    const pillNow = r.pill()!;
    ((pillNow.ref ?? pillNow.props.ref) as { current: unknown }).current = button;
    r.scrollTo(0);
    expect(r.el.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(r.pill()).toBeNull();
  });

  it("goes at once under reduced motion", () => {
    reduced = true;
    const r = rig({ source: ready(talk) });
    r.scrollTo(300);
    (r.pill()!.props.onClick as () => void)();
    expect(r.el.scrollTo).not.toHaveBeenCalled();
    expect(r.el.scrollTop).toBe(r.el.scrollHeight);
    expect(r.pill()).toBeNull();
  });
});

describe("lines that arrive while you watch", () => {
  it("rise in only once a first read of this conversation is drawn", () => {
    const r = rig({ source: { state: "loading" }, session: "a" });
    expect(r.arrive()).toBeUndefined();
    r.m.rerender({ source: ready(talk), session: "a" });
    expect(r.arrive()).toBeUndefined();
    r.m.rerender({ source: ready([...talk, said("b")]), session: "a" });
    expect(r.arrive()).toBe("");
  });

  it("not on the render that puts older turns in front, and again after it", () => {
    const r = rig({ source: ready(talk, { head: 10 }) });
    r.m.rerender({ source: ready(talk, { head: 10 }) });
    expect(r.arrive()).toBe("");
    r.m.rerender({ source: ready([said("older"), ...talk], { head: 9 }) });
    expect(r.arrive()).toBeUndefined();
    r.m.rerender({ source: ready([said("older"), ...talk, said("b")], { head: 9 }) });
    expect(r.arrive()).toBe("");
  });

  it("not on a switch to another session, nor a conversation replaced under it", () => {
    const r = rig({ source: ready(talk), session: "a" });
    r.m.rerender({ source: ready(talk), session: "a" });
    expect(r.arrive()).toBe("");
    r.m.rerender({ source: ready([said("x")]), session: "b" });
    expect(r.arrive()).toBeUndefined();
    r.m.rerender({ source: ready([said("x")]), session: "b" });
    expect(r.arrive()).toBe("");
    r.m.rerender({ source: ready([you("a new file")]), session: "b" });
    expect(r.arrive()).toBeUndefined();
  });

  it("keep each turn's row while the window slides, and a new conversation's rows are new", () => {
    const r = rig({ source: ready(talk), session: "a" });
    const keys = () => {
      const era = all(r.m.tree, e => e.type === Symbol.for("react.fragment") && (e as unknown as { key: unknown }).key !== null)[0];
      return { era: (era as unknown as { key: string }).key, rows: all(era.props.children, e => e.props.turns !== undefined || e.props.text !== undefined).map(e => (e as unknown as { key: string }).key) };
    };
    const first = keys();
    r.m.rerender({ source: ready([...talk.slice(1), you("more")]), session: "a" });
    const slid = keys();
    expect(slid.era).toBe(first.era);
    expect(slid.rows.slice(0, -1)).toEqual(first.rows.slice(1));
    r.m.rerender({ source: ready(talk), session: "b" });
    expect(keys().era).not.toBe(first.era);
  });
});

describe("since you looked", () => {
  const since = (at?: number) => ({ toolCalls: 2, label: "done", ...(at === undefined ? {} : { at }) });
  const order = (tree: unknown) => all(tree, (e: Drawn) => typeof e.type === "function" && ["SinceDivider", "YourMessage", "AssistantBlock"].includes((e.type as { name: string }).name))
    .map(e => (e.type as { name: string }).name);

  it("goes right before the first turn that came since: a reply it falls in is drawn as two", () => {
    const talk5 = [you("a"), said("b"), you("c"), said("d"), bash("e")];
    const r = rig({ source: ready(talk5, { since: since(4) }) });
    expect(order(r.m.tree)).toEqual(["YourMessage", "AssistantBlock", "YourMessage", "AssistantBlock", "SinceDivider", "AssistantBlock"]);
    const replies = all(r.m.tree, e => (e.type as { name?: string }).name === "AssistantBlock").map(e => (e.props.turns as ChatTurn[]).length);
    expect(replies).toEqual([1, 1, 1]);
    r.m.rerender({ source: ready(talk5, { since: since(2) }) });
    expect(order(r.m.tree)).toEqual(["YourMessage", "AssistantBlock", "SinceDivider", "YourMessage", "AssistantBlock"]);
    r.m.rerender({ source: ready(talk5, { since: since(3) }) });
    expect(order(r.m.tree)).toEqual(["YourMessage", "AssistantBlock", "YourMessage", "SinceDivider", "AssistantBlock"]);
  });

  it("is there, not arriving: no rise on the render that puts it in or takes it out", () => {
    const talk5 = [you("a"), said("b"), you("c"), said("d"), bash("e")];
    const r = rig({ source: ready(talk5.slice(0, 3)) });
    r.m.rerender({ source: ready(talk5.slice(0, 3)) });
    expect(r.arrive()).toBe("");
    r.m.rerender({ source: ready(talk5, { since: since(3) }) });
    expect(r.arrive()).toBeUndefined();
    r.m.rerender({ source: ready(talk5, { since: since(3) }) });
    expect(r.arrive()).toBe("");
    r.m.rerender({ source: ready(talk5) });
    expect(r.arrive()).toBeUndefined();
  });

  it("over the whole conversation when it does not say where", () => {
    const r = rig({ source: ready([you("a"), said("b")], { since: since() }) });
    expect(order(r.m.tree)).toEqual(["SinceDivider", "YourMessage", "AssistantBlock"]);
  });
});
