// "Since you looked" (use-session-transcript.ts): when the reader looks away
// from a conversation (Chat hidden for Term, another session shown, the page
// hidden), what they saw is kept; the first answer read once they look again
// puts the divider before the first turn that came since, with how many calls
// ran and what the session is doing now. Nothing new, nothing said.
//
// Run as a hook under the suite's stand-in React (fake-react.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSource, ChatTurn } from "../components/chat/chat-model";
import { sinceIn, useSessionTranscript, type SessionTranscriptInput } from "../use-session-transcript";
import { setLanguage, t } from "../i18n";
import { flush, mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const said = (text: string): ChatTurn => ({ kind: "assistant", text });
const you = (text: string): ChatTurn => ({ kind: "user", text });
const bash = (arg: string, running?: boolean): ChatTurn => ({ kind: "tool", name: "Bash", arg, ...(running ? { running } : {}) });

/** The deck's transcript route for two sessions, each a conversation that can grow. */
function deck() {
  const files: Record<string, ChatTurn[]> = { abc: [you("go"), said("on it")], xyz: [said("other")] };
  const fetchFn = vi.fn(async (url: string) => {
    const id = new URL(url, "http://deck").searchParams.get("session")!;
    return { status: 200, ok: true, json: async () => ({ ok: true, complete: true, turns: files[id] }) } as Response;
  });
  return { files, fetchFn };
}

function setup(first: SessionTranscriptInput) {
  const d = deck();
  let visible = true;
  let onVisible: () => void = () => {};
  let source: ChatSource = { state: "loading" };
  const Probe = (input: SessionTranscriptInput) => {
    source = useSessionTranscript(input, {
      fetchFn: d.fetchFn as never, visible: () => visible,
      watchVisible: change => { onVisible = change; return () => {}; },
    });
    return null;
  };
  const view = mount(Probe, first);
  return {
    view, files: d.files,
    get source() { return source; },
    get since() { return source.state === "ready" ? source.since : undefined; },
    /** The page hidden or shown again, as the document says it. */
    page(shown: boolean) { visible = shown; onVisible(); },
  };
}

beforeEach(() => { vi.useFakeTimers(); setLanguage("en"); });
afterEach(() => { vi.useRealTimers(); });

const on: SessionTranscriptInput = { session: "abc", shown: true, working: false, change: "0:idle" };

describe("since you looked", () => {
  it("says nothing on the first look", async () => {
    const h = setup(on);
    await flush();
    expect(h.source.state).toBe("ready");
    expect(h.since).toBeUndefined();
  });

  it("marks what came while Chat was hidden for Term, before the first new turn", async () => {
    const h = setup(on);
    await flush();
    h.view.rerender({ ...on, shown: false });
    h.files.abc = [...h.files.abc, bash("npm test"), bash("git push"), said("pushed")];
    h.view.rerender(on);
    await flush();
    expect(h.since).toEqual({ toolCalls: 2, label: "done", at: 2 });
    expect(h.source.state === "ready" && h.source.turns[2]).toMatchObject({ kind: "tool", arg: "npm test" });
  });

  it("keeps the divider while the reader stays, and moves on once they look away and back with nothing new", async () => {
    const h = setup(on);
    await flush();
    h.view.rerender({ ...on, shown: false });
    h.files.abc = [...h.files.abc, said("more")];
    h.view.rerender(on);
    await flush();
    expect(h.since?.at).toBe(2);
    h.files.abc = [...h.files.abc, said("still more")];
    h.view.rerender({ ...on, change: "1:idle" });
    await flush();
    expect(h.since?.at).toBe(2);
    h.view.rerender({ ...on, shown: false, change: "1:idle" });
    h.view.rerender({ ...on, change: "1:idle" });
    await flush();
    expect(h.since).toBeUndefined();
  });

  it("marks what came while another session was shown", async () => {
    const h = setup(on);
    await flush();
    h.view.rerender({ ...on, session: "xyz" });
    await flush();
    expect(h.since).toBeUndefined();
    h.files.abc = [...h.files.abc, you("and the docs"), said("done")];
    h.view.rerender(on);
    await flush();
    expect(h.since).toEqual({ toolCalls: 0, label: "done", at: 2 });
  });

  it("marks what came while the page was hidden, once it is looked at again", async () => {
    const h = setup({ ...on, working: true, change: "1:working" });
    await flush();
    h.page(false);
    h.files.abc = [...h.files.abc, bash("npm test", true)];
    await flush();
    expect(h.since).toBeUndefined();
    h.page(true);
    await flush();
    expect(h.since).toEqual({ toolCalls: 1, label: t("board.chat.live.since.working"), at: 2 });
    expect(h.since?.label).toBe("still working");
  });

  it("says nothing when nothing came", async () => {
    const h = setup(on);
    await flush();
    h.view.rerender({ ...on, shown: false });
    h.view.rerender(on);
    await flush();
    expect(h.since).toBeUndefined();
  });
});

describe("what the divider says", () => {
  const looked = (first: ChatTurn, seen?: ChatTurn) => ({ session: "abc", provider: "claude" as const, first, seen, toolCalls: 3 });

  it("now asking, still working or done", () => {
    const turns = [you("go"), said("a"), { kind: "ask", running: true, questions: [] } as ChatTurn];
    expect(sinceIn(looked(turns[1]), turns, false, t)).toEqual({ toolCalls: 3, label: "now asking", at: 1 });
    expect(sinceIn(looked(turns[1]), turns, true, t)?.label).toBe("still working");
    expect(sinceIn(looked(turns[1]), turns.slice(0, 2), false, t)?.label).toBe("done");
  });

  it("finds its place after the last turn seen when the first new one changed since, and none when both are gone", () => {
    const seen = you("go");
    const turns = [seen, said("now different")];
    expect(sinceIn(looked(said("was"), seen), turns, false, t)?.at).toBe(1);
    expect(sinceIn(looked(said("was"), said("gone")), turns, false, t)).toBeUndefined();
    expect(sinceIn(looked(said("was")), turns, false, t)).toBeUndefined();
  });
});
