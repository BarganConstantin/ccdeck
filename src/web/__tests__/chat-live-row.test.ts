// Chat's working row, live (ChatTurn.tsx, chat-progress.ts): it says what the
// agent's own screen says ("Pondering…") or "Working…", counts the turn's time
// on its own clock, and wears a mark whose frames are Claude Code's spinner.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLine, TurnClock, WORKING_FRAMES } from "../components/chat/ChatTurn";
import type { ChatActivity } from "../components/chat/chat-model";
import { chatShown, type ChatFacts } from "../chat-progress";
import { setLanguage } from "../i18n";
import { all, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => setLanguage("en"));
afterEach(() => { vi.useRealTimers(); setLanguage("en"); });

const part = (tree: unknown, name: string) => one(tree, el => el.props.className === name);

describe("the working row", () => {
  const draw = (activity: ChatActivity) => mount(ActivityLine, { activity });

  it("says the agent's own words while its screen shows them, and Working… while not", () => {
    expect(textOf(part(draw({ state: "working", status: "Pondering…" }).tree, "chat-progress-text"))).toBe("Pondering…");
    expect(textOf(part(draw({ state: "working" }).tree, "chat-progress-text"))).toBe("Working…");
    expect(textOf(part(draw({ state: "waiting", status: "Pondering…" }).tree, "chat-progress-text"))).toBe("Waiting for you");
  });

  it("wears Claude Code's spinner, six frames hidden from a screen reader", () => {
    expect([...WORKING_FRAMES]).toEqual(["·", "✢", "✳", "✶", "✻", "✽"]);
    const tree = draw({ state: "working" }).tree;
    const mark = part(tree, "chat-progress-mark")!;
    expect(mark.props["aria-hidden"]).toBe("true");
    expect((part(mark, "chat-progress-frames")!.props.children as Drawn[]).map(textOf)).toEqual([...WORKING_FRAMES]);
  });

  it("counts the turn's time from when it began, every second, and only while it works", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const tree = draw({ state: "working", since: 100_000 - 65_000, detail: "Bash · npm test" }).tree;
    const clock = one(tree, el => el.type === TurnClock)!;
    expect(clock.props.since).toBe(35_000);
    // The figure in order: words, clock, the header's tool.
    const names = all(tree, el => typeof el.props.className === "string" || el.type === TurnClock)
      .map(el => (el.type === TurnClock ? "clock" : el.props.className));
    expect(names.indexOf("clock")).toBe(names.indexOf("chat-progress-text") + 1);
    expect(names.indexOf("chat-progress-detail")).toBe(names.indexOf("clock") + 1);
    expect(one(draw({ state: "waiting", since: 35_000 }).tree, el => el.type === TurnClock)).toBeNull();
    expect(one(draw({ state: "working" }).tree, el => el.type === TurnClock)).toBeNull();
  });

  it("the clock ticks by itself, so a tick redraws the figure and nothing else", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const clock = mount(TurnClock, { since: 100_000 - 65_000 });
    expect(textOf(clock.tree)).toBe("1m 05s");
    expect((clock.tree as Drawn).props.className).toBe("chat-progress-time");
    vi.advanceTimersByTime(1000);
    expect(textOf(clock.tree)).toBe("1m 06s");
    clock.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gets the words and the turn's start from the stage only while the session works", () => {
    const facts = (more: Partial<ChatFacts>): ChatFacts => ({ turns: [], prompts: 1, state: "working", connected: true, asked: false, ...more });
    expect(chatShown(undefined, facts({ status: "Pondering…", since: 5 }), 10).activity).toEqual({ state: "working", status: "Pondering…", since: 5 });
    expect(chatShown(undefined, facts({ state: "waiting", status: "Pondering…", since: 5 }), 10).activity).toEqual({ state: "waiting" });
  });
});
