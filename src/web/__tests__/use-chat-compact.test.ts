// A Compact held per session (use-chat-compact.ts), and what Chat says of the
// /compact message it sent (chat-progress.ts, use-chat-returned.ts): one run
// however fast it is pressed, an end handed over once, nothing judged while
// Chat does not look, the screen's compaction line as the session taking the
// message, no working row for it, and a menu's message never put in the box.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPACT_COMMAND, COMPACT_SETTLE_MS, COMPACT_START_MS, type CompactEnd } from "../chat-actions";
import { useCompactRun, type CompactRunOptions, type CompactRunView } from "../use-chat-compact";
import { CONFIRM_MS, chatShown, pendingFor, settlePending, wasTaken, type ChatFacts } from "../chat-progress";
import { useChatReturned } from "../use-chat-returned";
import type { ChatOutgoing, ChatTurn } from "../components/chat/chat-model";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const T0 = 1_700_000_000_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); });

const BEFORE: ChatTurn[] = [
  { kind: "user", text: "fix the test" },
  { kind: "assistant", text: "Fixed." },
];
const AFTER: ChatTurn[] = [...BEFORE, { kind: "command", name: COMPACT_COMMAND, output: "Compacted", at: T0 + 20_000 }];

type Opts = Omit<CompactRunOptions, "onEnd">;

function rig(first: Partial<Opts> = {}) {
  const ends: Array<[CompactEnd, string]> = [];
  let view: CompactRunView | null = null;
  let props: Opts = { session: "claude:a", watching: true, turns: BEFORE, compacting: false, untaken: false, ...first };
  const Probe = (o: Opts) => { view = useCompactRun({ ...o, onEnd: (end, session) => ends.push([end, session]) }); return null; };
  const mounted = mount(Probe, props);
  return {
    ends,
    get view() { return view!; },
    set(next: Partial<Opts>) { props = { ...props, ...next }; mounted.rerender(props); },
  };
}

describe("a Compact run", () => {
  it("begins once however fast it is pressed, and ends done on the conversation's /compact line", () => {
    const r = rig();
    expect(r.view.start()).toBe(true);
    expect(r.view.start()).toBe(false);
    r.set({});
    expect(r.view.running).toBe(true);
    r.set({ compacting: true });
    expect(r.ends).toEqual([]);
    r.set({ compacting: false, turns: AFTER });
    expect(r.ends).toEqual([["done", "claude:a"]]);
    expect(r.view.running).toBe(false);
    // Read again, the same record ends nothing more.
    r.set({ turns: [...AFTER] });
    expect(r.ends).toHaveLength(1);
  });

  it("says it could not tell once the line has been gone COMPACT_SETTLE_MS with no record", async () => {
    const r = rig();
    r.view.start();
    r.set({ compacting: true });
    r.set({ compacting: false });
    await vi.advanceTimersByTimeAsync(COMPACT_SETTLE_MS - 1_000);
    expect(r.ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.ends).toEqual([["unknown", "claude:a"]]);
  });

  it("judges nothing while Chat does not look, and starts the wait again when it is back", async () => {
    const r = rig();
    r.view.start();
    r.set({ compacting: true });
    r.set({ compacting: false });
    r.set({ watching: false });
    await vi.advanceTimersByTimeAsync(COMPACT_SETTLE_MS * 3);
    expect(r.ends).toEqual([]);
    expect(r.view.running).toBe(true);
    r.set({ watching: true });
    await vi.advanceTimersByTimeAsync(COMPACT_SETTLE_MS - 1_000);
    expect(r.ends).toEqual([]);
    // The record read on the way back ends it as it is.
    r.set({ turns: AFTER });
    expect(r.ends).toEqual([["done", "claude:a"]]);
  });

  it("ends unseen when the line never shows, and untaken at once when Chat says the message was not taken", async () => {
    const r = rig();
    r.view.start();
    r.set({});
    await vi.advanceTimersByTimeAsync(COMPACT_START_MS + 100);
    expect(r.ends).toEqual([["unseen", "claude:a"]]);
    const s = rig();
    s.view.start();
    s.set({ untaken: true });
    expect(s.ends).toEqual([["untaken", "claude:a"]]);
  });

  it("is one run per session: another session's pane neither sees nor ends it", () => {
    const r = rig();
    r.view.start();
    r.set({ session: "claude:b" });
    expect(r.view.running).toBe(false);
    r.set({ turns: AFTER });
    expect(r.ends).toEqual([]);
    // Back on its own session, still running, until its conversation says it is over.
    r.set({ session: "claude:a", turns: BEFORE });
    expect(r.view.running).toBe(true);
    r.set({ turns: AFTER });
    expect(r.ends).toEqual([["done", "claude:a"]]);
  });
});

describe("the /compact message, under the conversation", () => {
  const facts = (over: Partial<ChatFacts> = {}): ChatFacts =>
    ({ turns: BEFORE, prompts: 1, state: "idle", connected: true, asked: false, ...over });

  it("is taken when the screen shows the compaction, which no prompt says", () => {
    const p = pendingFor(COMPACT_COMMAND, facts(), T0, { action: true });
    expect(wasTaken(p, facts())).toBe(false);
    expect(wasTaken(p, facts({ compacting: true }))).toBe(true);
    expect(wasTaken(pendingFor("hello", facts(), T0), facts({ compacting: true }))).toBe(false);
    const taken = settlePending(p, facts({ compacting: true }), T0 + 1_000);
    expect(taken?.takenAt).toBe(T0 + 1_000);
  });

  it("draws no working row once taken: the live row speaks for a compaction", () => {
    const p = { ...pendingFor(COMPACT_COMMAND, facts(), T0, { action: true }), takenAt: T0 + 1_000 };
    const shown = chatShown(p, facts({ compacting: true }), T0 + 2_000);
    expect(shown.activity).toBeUndefined();
    expect(shown.outgoing).toEqual({ text: COMPACT_COMMAND, state: "taken", action: true });
    const typed = { ...pendingFor("hello", facts(), T0), takenAt: T0 + 1_000 };
    expect(chatShown(typed, facts(), T0 + 2_000).activity?.state).toBe("working");
  });

  it("marks a message the menu sent, not one typed", () => {
    expect(pendingFor(COMPACT_COMMAND, facts(), T0, { action: true }).action).toBe(true);
    expect("action" in pendingFor(COMPACT_COMMAND, facts(), T0)).toBe(false);
    const late = chatShown(pendingFor(COMPACT_COMMAND, facts(), T0, { action: true }), facts(), T0 + CONFIRM_MS);
    expect(late.outgoing).toEqual({ text: COMPACT_COMMAND, state: "unconfirmed", action: true });
  });
});

describe("a /compact not taken", () => {
  function returned(outgoing: ChatOutgoing, draft = "") {
    const put: string[] = [];
    const Probe = (o: { outgoing: ChatOutgoing; draft: string }) => {
      useChatReturned("claude:a", o.outgoing, o.draft, text => put.push(text));
      return null;
    };
    mount(Probe, { outgoing, draft });
    return put;
  }

  it("stays out of the box when the menu sent it: the box is the person's", () => {
    expect(returned({ text: COMPACT_COMMAND, state: "unconfirmed", action: true })).toEqual([]);
  });

  it("goes back into an empty box when it was typed, as any message does", () => {
    expect(returned({ text: COMPACT_COMMAND, state: "unconfirmed" })).toEqual([COMPACT_COMMAND]);
  });
});
