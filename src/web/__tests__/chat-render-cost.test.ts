// Chat's cost while it lives: the stage above it draws again on every clock
// tick, every key typed in the composer and every read of the transcript, and
// none of that may draw again a turn that did not change. ChatView's blocks are
// memoised (chat-blocks.ts); this counts, from one render to the next, the
// blocks React would draw again: a key that is new, or a memo compare that
// says the props moved (fake-react's memoCompare is the compare React runs).
import { describe, expect, it, vi } from "vitest";
import ChatView, { type ChatViewProps } from "../components/chat/ChatView";
import type { ChatAsk, ChatSource, ChatTurn } from "../components/chat/chat-model";
import { all, memoCompare, mount, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const said = (text: string): ChatTurn => ({ kind: "assistant", text });
const you = (text: string): ChatTurn => ({ kind: "user", text });
const bash = (arg: string, running?: boolean): ChatTurn => ({ kind: "tool", name: "Bash", arg, ...(running ? { running } : {}) });
const asking = (): ChatTurn => ({ kind: "ask", running: true, questions: [{ question: "Ship it?", header: "Ship", multi: false, options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] }] });
/** A read as the server hands it over: every turn a new object. */
const ready = (...turns: ChatTurn[]): Extract<ChatSource, { state: "ready" }> => ({ state: "ready", turns: turns.map(turn => structuredClone(turn)) });

/** The conversation's blocks as drawn: every memoised element, by key. */
function blocksOf(tree: unknown): Map<string, Drawn> {
  const found = all(tree, el => memoCompare(el.type) !== null);
  return new Map(found.map(el => [String((el as unknown as { key: unknown }).key), el]));
}

function rig(first: ChatViewProps) {
  const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400, focus: vi.fn() };
  const m = mount(ChatView, first, {
    commit: tree => {
      const region = all(tree, e => e.props.role === "region")[0];
      ((region.ref ?? region.props.ref) as { current: unknown }).current = el;
    },
  });
  let before = blocksOf(m.tree);
  /** Renders again with `props`; the keys of the blocks React would draw again. */
  const render = (props: ChatViewProps) => {
    m.rerender(props);
    const after = blocksOf(m.tree);
    const redrawn = [...after].filter(([key, el]) => {
      const was = before.get(key);
      return !was || was.type !== el.type || !memoCompare(el.type)!(was.props, el.props);
    }).map(([key]) => key);
    before = after;
    return redrawn;
  };
  return { m, render, get blocks() { return before; } };
}

const talk = [you("run the tests"), said("Running them."), bash("npm test"), said("All pass."), you("ship it"), said("On it.")];

describe("what draws no turn again", () => {
  it("a clock tick or a new state under the last line", () => {
    const source = ready(...talk);
    const r = rig({ source, activity: { state: "working", detail: "Bash · npm test · 12s" } });
    expect(r.blocks.size).toBe(4);
    expect(r.render({ source, activity: { state: "working", detail: "Bash · npm test · 13s" } })).toEqual([]);
    expect(r.render({ source, activity: { state: "waiting" } })).toEqual([]);
    expect(r.render({ source, outgoing: { text: "and the docs", state: "sending" } })).toEqual([]);
  });

  it("a read of the transcript that found the same turns, every one a new object", () => {
    const r = rig({ source: ready(...talk) });
    expect(r.render({ source: ready(...talk) })).toEqual([]);
    expect(r.render({ source: ready(...talk) })).toEqual([]);
  });

  it("a key typed in the composer: the stage hands a new way to answer the waiting question", () => {
    const answer = (): ChatAsk => ({ send: async () => "sent", chat: async () => "sent", onShowTerm: () => {} });
    const turns = [...talk, asking()];
    const r = rig({ source: ready(...turns), ask: answer() });
    expect(r.render({ source: ready(...turns), ask: answer() })).toEqual([]);
    // But a question that cannot be answered now is drawn again, to say so.
    expect(r.render({ source: ready(...turns), ask: { ...answer(), blocked: "busy" } })).toHaveLength(1);
  });
});

describe("what draws only the turns that changed", () => {
  it("a line added to the reply at work", () => {
    const r = rig({ source: ready(...talk) });
    const keys = [...r.blocks.keys()];
    expect(r.render({ source: ready(...talk, bash("git push", true)) })).toEqual([keys.at(-1)]);
  });

  it("a call that finished in place", () => {
    const r = rig({ source: ready(...talk, bash("git push", true)) });
    const keys = [...r.blocks.keys()];
    expect(r.render({ source: ready(...talk, bash("git push")) })).toEqual([keys.at(-1)]);
  });

  it("a message of yours: only its own new row", () => {
    const r = rig({ source: ready(...talk) });
    const redrawn = r.render({ source: ready(...talk, you("thanks")) });
    expect(redrawn).toHaveLength(1);
    expect([...r.blocks.keys()].at(-1)).toBe(redrawn[0]);
  });

  it("the live window sliding: every turn moves up one, and only the new one is drawn", () => {
    const r = rig({ source: ready(...talk) });
    const redrawn = r.render({ source: ready(...talk.slice(1), you("thanks")) });
    expect(redrawn).toHaveLength(1);
    expect([...r.blocks.keys()].at(-1)).toBe(redrawn[0]);
  });

  it("older turns put in front: the turns held keep their rows", () => {
    const r = rig({ source: { ...ready(...talk.slice(4)), head: 4 } });
    const redrawn = r.render({ source: { ...ready(...talk), head: 0 } });
    expect(redrawn).toHaveLength(2);
    const keys = [...r.blocks.keys()];
    expect(redrawn).toEqual(keys.slice(0, 2));
  });
});
