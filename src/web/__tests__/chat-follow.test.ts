// Chat follows the end of the conversation: it scrolls to the bottom when the
// LAST turn changes, not only when the number of turns does. A host's cap slides
// the window, so a new line pushes an old one out and the count stays put.
import { describe, expect, it, vi } from "vitest";
import ChatView, { tailKey } from "../components/chat/ChatView";
import type { ChatSource, ChatTurn } from "../components/chat/chat-model";
import { all, mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const ready = (...turns: ChatTurn[]): ChatSource => ({ state: "ready", turns });
const said = (text: string): ChatTurn => ({ kind: "assistant", text });

function view(first: ChatSource) {
  // What the document would do: a layout the fake does not have, a scroller it can scroll.
  const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
  const scrolls: number[] = [];
  Object.defineProperty(el, "scrollTop", { get: () => 0, set: (v: number) => { scrolls.push(v); }, configurable: true });
  const m = mount(ChatView, { source: first }, {
    commit: tree => {
      const region = all(tree, e => e.props.role === "region")[0];
      const ref = (region.ref ?? region.props.ref) as { current: unknown };
      ref.current = el;
    },
  });
  scrolls.length = 0;
  return { m, scrolls };
}

describe("following the end", () => {
  it("scrolls when a turn is added", () => {
    const { m, scrolls } = view(ready(said("a")));
    m.rerender({ source: ready(said("a"), said("b")) });
    expect(scrolls).toEqual([1000]);
  });

  it("scrolls when the window slid: same count, a different last turn", () => {
    const { m, scrolls } = view(ready(said("a"), said("b")));
    m.rerender({ source: ready(said("b"), said("c")) });
    expect(scrolls).toEqual([1000]);
  });

  it("scrolls when the last turn's text grew or a running tool call finished", () => {
    const { m, scrolls } = view(ready({ kind: "tool", name: "Bash", arg: "npm test", running: true }));
    m.rerender({ source: ready({ kind: "tool", name: "Bash", arg: "npm test" }) });
    expect(scrolls).toEqual([1000]);
  });

  it("does not scroll again for the same turns", () => {
    const { m, scrolls } = view(ready(said("a"), said("b")));
    m.rerender({ source: ready(said("a"), said("b")) });
    expect(scrolls).toEqual([]);
  });

  it("names a turn by what it is and says", () => {
    expect(tailKey(undefined)).toBe("");
    expect(tailKey(said("x"))).not.toBe(tailKey(said("y")));
    expect(tailKey({ kind: "tool", name: "A", arg: "b", running: true })).not.toBe(tailKey({ kind: "tool", name: "A", arg: "b" }));
  });
});
