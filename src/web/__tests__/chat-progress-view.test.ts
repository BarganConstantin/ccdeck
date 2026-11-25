// What Chat draws for where a sent message stands and what the session is
// doing (ChatView's last lines, ChatTurn's OutgoingMessage and ActivityLine),
// and what a screen reader hears of it. chat-progress.test.ts pins the rules
// that choose them; this pins the drawing.
//
// Before: a message the conversation did not show yet was drawn nowhere, and
// a turn at work drew nothing under the last line, so a reply sent after a
// finished turn read as a message followed by empty space.
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatView, { progressCue, progressSaid, type ChatViewProps } from "../components/chat/ChatView";
import { ActivityLine, AssistantBlock, OutgoingMessage, YourMessage } from "../components/chat/ChatTurn";
import type { ChatActivity, ChatOutgoing, ChatSource, ChatTurn } from "../components/chat/chat-model";
import { setLanguage, t } from "../i18n";
import { AREA_FILES } from "../i18n/catalogs";
import { all, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

afterEach(() => setLanguage("en"));

const DONE: ChatTurn[] = [
  { kind: "user", text: "list the folder please" },
  { kind: "tool", name: "exec_command", arg: "ls -la", mark: "terminal" },
  { kind: "assistant", text: "I listed the folder." },
];
const ready = (turns: ChatTurn[] = DONE): ChatSource => ({ state: "ready", turns });
const sending: ChatOutgoing = { text: "este gata?", state: "sending" };
const working: ChatActivity = { state: "working" };

/** The kinds of line in the conversation column, in order. */
function lines(props: ChatViewProps): string[] {
  const tree = mount(ChatView, props).tree;
  const col = one(tree, el => el.props.className === "chat-col")!;
  const names = new Map<unknown, string>([[YourMessage, "you"], [AssistantBlock, "agent"], [OutgoingMessage, "outgoing"], [ActivityLine, "activity"]]);
  return all(col, el => names.has(el.type)).map(el => names.get(el.type)!);
}

const button = (tree: unknown) => all(tree, el => el.type === "button");

describe("the last lines of the conversation", () => {
  it("draw the message on its way under the finished turn, with nothing in between", () => {
    expect(lines({ source: ready(), provider: "codex", outgoing: sending })).toEqual(["you", "agent", "outgoing"]);
  });

  it("put the turn still at work before a message waiting behind it, and after one it took", () => {
    expect(lines({ source: ready(), outgoing: sending, activity: working })).toEqual(["you", "agent", "activity", "outgoing"]);
    expect(lines({ source: ready(), outgoing: { ...sending, state: "taken" }, activity: working })).toEqual(["you", "agent", "outgoing", "activity"]);
    expect(lines({ source: ready(), activity: working })).toEqual(["you", "agent", "activity"]);
  });

  it("keep the message where the conversation could not be read, and draw nothing while it loads", () => {
    expect(lines({ source: { state: "error", message: "x" }, outgoing: sending })).toEqual(["outgoing"]);
    expect(lines({ source: { state: "loading" }, outgoing: sending, activity: working })).toEqual([]);
  });
});

describe("a message on its way", () => {
  const draw = (outgoing: ChatOutgoing, onShowTerm = vi.fn()) => ({ tree: mount(OutgoingMessage, { outgoing, provider: "codex", onShowTerm }).tree, onShowTerm });

  it("is your message, a step quieter, with Sending… under it and nothing to press", () => {
    const { tree } = draw(sending);
    expect((tree as Drawn).props["data-outgoing"]).toBe("sending");
    expect(textOf(one(tree, el => el.props.className === "chat-you-text"))).toBe("este gata?");
    expect(textOf(one(tree, el => el.props.className === "chat-you-state"))).toBe("Sending…");
    expect(button(tree)).toEqual([]);
  });

  // The confirmed failure path, drawn: the message the agent never took is
  // there, says so, and the way out is Term, never a second send.
  it("not taken, says so in the agent's name and offers Term, never a resend", () => {
    const { tree, onShowTerm } = draw({ text: "stuck: please check", state: "unconfirmed" });
    expect(textOf(one(tree, el => el.props.className === "chat-you-state")))
      .toBe("Codex hasn't taken this message. Check Term before you send it again.Show Term");
    expect(button(tree).map(textOf)).toEqual(["Show Term"]);
    (button(tree)[0].props.onClick as () => void)();
    expect(onShowTerm).toHaveBeenCalledOnce();
  });

  it("taken, reads as any message of yours", () => {
    const { tree } = draw({ ...sending, state: "taken" });
    expect(one(tree, el => el.props.className === "chat-you-state")).toBeNull();
    expect(textOf(tree)).toBe("Youeste gata?");
  });
});

describe("what the session is doing", () => {
  const draw = (activity: ChatActivity, provider: ChatViewProps["provider"] = "claude", onShowTerm = vi.fn()) =>
    ({ tree: mount(ActivityLine, { activity, provider, onShowTerm }).tree, onShowTerm });
  const part = (tree: unknown, name: string) => textOf(one(tree, el => el.props.className === name));

  // CHANGED ON PURPOSE (Chat live): the row says "Working…" (or the agent's own
  // screen words) rather than "Claude Code is working…" — the reply above it
  // already names the agent — and the header's tool comes after the turn's clock.
  it("at work: Working… and the header's tool, under a mark hidden from a screen reader", () => {
    const { tree } = draw({ state: "working", detail: "Bash · npm test" });
    expect((tree as Drawn).props["data-state"]).toBe("working");
    expect(part(tree, "chat-progress-text")).toBe("Working…");
    expect(part(tree, "chat-progress-detail")).toBe("Bash · npm test");
    expect(one(tree, el => el.props.className === "chat-progress-mark")!.props["aria-hidden"]).toBe("true");
    expect(button(tree)).toEqual([]);
  });

  it("silent for long: says for how long instead, and offers Term", () => {
    const { tree, onShowTerm } = draw({ state: "working", detail: "thinking", quiet: "4m" }, "codex");
    expect((tree as Drawn).props["data-quiet"]).toBe("");
    expect(part(tree, "chat-progress-text")).toBe("Working…");
    expect(part(tree, "chat-progress-detail")).toBe("no update for 4m");
    (button(tree)[0].props.onClick as () => void)();
    expect(onShowTerm).toHaveBeenCalledOnce();
  });

  // CHANGED ON PURPOSE (Chat live): "Waiting for you", the row's own words.
  it("waiting on you: says so, with nothing after it", () => {
    const { tree } = draw({ state: "waiting" });
    expect(part(tree, "chat-progress-text")).toBe(t("board.chat.live.waiting"));
    expect(part(tree, "chat-progress-text")).toBe("Waiting for you");
    expect(one(tree, el => el.props.className === "chat-progress-detail")).toBeNull();
    expect(one(tree, el => el.props.className === "chat-progress-time")).toBeNull();
  });
});

describe("what a screen reader hears", () => {
  const status = (tree: unknown) => textOf(one(tree, el => el.props.role === "status"));

  it("each change of state once, in words; never the tool or the clock; that it finished", () => {
    let props: ChatViewProps = { source: ready(), provider: "codex", session: "codex:a" };
    const view = mount(ChatView, props);
    const move = (next: Partial<ChatViewProps>) => { props = { ...props, ...next }; view.rerender(props); return status(view.tree); };
    expect(status(view.tree)).toBe("");
    expect(move({ outgoing: sending })).toBe("Sending…");
    expect(move({ outgoing: { ...sending, state: "taken" }, activity: working })).toBe("Codex is working…");
    expect(move({ activity: { state: "working", detail: "exec_command · ls · 3s" } })).toBe("Codex is working…");
    expect(move({ outgoing: undefined, activity: { state: "working", detail: "exec_command · ls · 9s" } })).toBe("Codex is working…");
    expect(move({ activity: { state: "working", quiet: "2m" } })).toBe("no update for 2m");
    expect(move({ activity: { state: "working", quiet: "3m" } }), "the clock is not news").toBe("no update for 2m");
    expect(move({ activity: undefined })).toBe("Codex finished.");
    view.unmount();
  });

  it("nothing when another session is shown, whatever that one is doing", () => {
    let props: ChatViewProps = { source: ready(), provider: "codex", session: "codex:a", activity: working };
    const view = mount(ChatView, props);
    const move = (next: Partial<ChatViewProps>) => { props = { ...props, ...next }; view.rerender(props); return status(view.tree); };
    expect(move({ activity: undefined })).toBe("Codex finished.");
    expect(move({ session: "claude:b", provider: "claude", activity: working })).toBe("");
    expect(move({ session: "codex:a", provider: "codex", activity: undefined, outgoing: { ...sending, state: "unconfirmed" } })).toBe("");
    expect(move({ outgoing: undefined, activity: working }), "a change in the session shown is news again").toBe("Codex is working…");
    view.unmount();
  });

  it("that the turn was stopped, when the conversation ends on that", () => {
    let props: ChatViewProps = { source: ready(), provider: "claude", session: "claude:a", activity: working };
    const view = mount(ChatView, props);
    props = { ...props, source: ready([...DONE, { kind: "user", text: "slow" }, { kind: "notice", what: "interrupted" }]), activity: undefined };
    view.rerender(props);
    expect(status(view.tree)).toBe("Interrupted");
    view.unmount();
  });

  it("in the reader's language", () => {
    setLanguage("ro");
    expect(progressSaid("unconfirmed", "sending", t, "Codex")).toBe("Codex nu a preluat mesajul. Verifică Term înainte să-l trimiți din nou.");
    expect(progressSaid("", "working", t, "Codex")).toBe("Codex a terminat.");
    expect(progressSaid("", "sending", t, "Codex"), "a message taken back is not a finished turn").toBe("");
    expect(progressCue({ ...sending, state: "taken" }, undefined)).toBe("");
    expect(progressCue(undefined, { state: "waiting" })).toBe("waiting");
  });

  it("has its words in all ten board catalogs", () => {
    const catalogs = AREA_FILES.filter(area => area.area === "board");
    expect(catalogs).toHaveLength(10);
    for (const { code, catalog } of catalogs) {
      for (const key of ["sending", "unconfirmed", "working", "quiet", "done"]) {
        expect(catalog[`board.chat.progress.${key}`], `${code}: ${key}`).toBeTruthy();
      }
    }
  });
});

describe("following the end", () => {
  // The message on its way and the state line are the last lines: they keep a
  // reader at the bottom in view, and leave one who scrolled up where they are.
  function view(first: ChatViewProps) {
    const scrolls: number[] = [];
    const el = { scrollHeight: 1000, clientHeight: 400, focus: vi.fn() };
    Object.defineProperty(el, "scrollTop", { get: () => 0, set: (v: number) => { scrolls.push(v); }, configurable: true });
    const m = mount(ChatView, first, {
      commit: tree => { ((all(tree, e => e.props.role === "region")[0].ref) as { current: unknown }).current = el; },
    });
    scrolls.length = 0;
    return { m, scrolls, el };
  }

  it("follows the message on its way and the state under it", () => {
    const { m, scrolls } = view({ source: ready() });
    m.rerender({ source: ready(), outgoing: sending });
    m.rerender({ source: ready(), outgoing: { ...sending, state: "taken" }, activity: working });
    expect(scrolls).toEqual([1000, 1000]);
  });

  it("not once the reader scrolled up to read", () => {
    const { m, scrolls } = view({ source: ready() });
    const region = all(m.tree, e => e.props.role === "region")[0];
    // 600px above the bottom.
    (region.props.onScroll as (event: unknown) => void)({ currentTarget: { scrollHeight: 1000, scrollTop: 0, clientHeight: 400 } });
    m.rerender({ source: ready(), outgoing: sending, activity: working });
    expect(scrolls).toEqual([]);
  });
});
