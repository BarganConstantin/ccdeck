// Chat draws what you put in besides words: a slash command you ran, as you
// typed it, with what it printed under it, and a chip counting the images you
// sent. And the composer's Stop: Esc, sent only through the guarded path while
// Claude Code works (chat-stop.ts), with what came of it in the status line.
//
// Drawn under the suite's stand-in React (fake-react.ts), which runs the
// component itself, so a press and what follows it can be read off the tree.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatView, { tailKey } from "../components/chat/ChatView";
import { YourCommand, YourMessage } from "../components/chat/ChatTurn";
import { ImageGlyph } from "../components/chat/chat-icons";
import ChatComposer, { STOP_SENT_MS, type ChatComposerProps } from "../components/chat/ChatComposer";
import { conversationBlocks, type ChatSource, type ChatTurn } from "../components/chat/chat-model";
import { STOP_WORDS, stopSteps } from "../chat-stop";
import { setLanguage } from "../i18n";
import { AREA_FILES } from "../i18n/catalogs";
import type { AskSendResult } from "../use-terminal-session";
import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => setLanguage("en"));
afterEach(() => { setLanguage("en"); vi.useRealTimers(); vi.unstubAllGlobals(); });

type Command = Extract<ChatTurn, { kind: "command" }>;

const byClass = (tree: unknown, className: string) => one(tree, el => el.props.className === className);
const command = (turn: Omit<Command, "kind">) => mount(YourCommand, { turn: { kind: "command", ...turn } }).tree;

describe("a slash command you ran", () => {
  it("is drawn under You as typed: the name, a space, the args", () => {
    const tree = command({ name: "/model", args: "opus" });
    expect(textOf(byClass(tree, "chat-author"))).toBe("You");
    const typed = byClass(tree, "chat-command-line")!;
    expect(typed.type).toBe("p");
    expect(textOf(typed)).toBe("/model opus");
    expect(one(typed, el => el.type === "code")).not.toBeNull();
    expect(byClass(tree, "chat-command-output")).toBeNull();
  });

  it("is the name alone when it took no args", () => {
    expect(textOf(byClass(command({ name: "/clear" }), "chat-command-line"))).toBe("/clear");
  });

  it("shows what it printed below it, in its own block", () => {
    const tree = command({ name: "/model", args: "opus", output: "Set model to opus\nUsing claude-opus" });
    const output = byClass(tree, "chat-command-output")!;
    expect(output.type).toBe("pre");
    expect(textOf(output)).toBe("Set model to opus\nUsing claude-opus");
    expect(output.props["data-failed"]).toBeUndefined();
  });

  it("marks output that came on stderr as failed, for the error colour", () => {
    const tree = command({ name: "/model", args: "nope", output: "Unknown model: nope", failed: true });
    expect(byClass(tree, "chat-command-output")!.props["data-failed"]).toBe(true);
  });
});

describe("images you sent", () => {
  const chip = (tree: unknown) => byClass(tree, "chat-you-images");

  it("are counted on a chip under your words, with the image glyph", () => {
    const tree = mount(YourMessage, { text: "[Image #1] what is this?", images: 1 }).tree;
    expect(textOf(byClass(tree, "chat-you-text"))).toBe("[Image #1] what is this?");
    expect(textOf(chip(tree))).toBe("1 image");
    expect(all(chip(tree), el => el.type === ImageGlyph)).toHaveLength(1);
  });

  it("say how many in the plural", () => {
    expect(textOf(chip(mount(YourMessage, { text: "two", images: 2 }).tree))).toBe("2 images");
  });

  it("stand alone when you sent only images", () => {
    const tree = mount(YourMessage, { text: "", images: 3 }).tree;
    expect(byClass(tree, "chat-you-text")).toBeNull();
    expect(textOf(byClass(tree, "chat-author"))).toBe("You");
    expect(textOf(chip(tree))).toBe("3 images");
  });

  it("leave a message without any as it was", () => {
    const tree = mount(YourMessage, { text: "just words" }).tree;
    expect(chip(tree)).toBeNull();
    expect(textOf(byClass(tree, "chat-you-text"))).toBe("just words");
  });

  it("are counted in the language's own plural forms", () => {
    setLanguage("ro");
    const count = (images: number) => textOf(chip(mount(YourMessage, { text: "", images }).tree));
    expect(count(1)).toBe("1 imagine");
    expect(count(3)).toBe("3 imagini");
    expect(count(20)).toBe("20 de imagini");
  });
});

describe("the conversation", () => {
  const turns: ChatTurn[] = [
    { kind: "user", text: "", images: 2 },
    { kind: "command", name: "/model", args: "opus", output: "Set model to opus" },
    { kind: "assistant", text: "Model set." },
  ];

  it("keeps a command as its own block on your side, and carries the images", () => {
    expect(conversationBlocks(turns)).toEqual([
      { kind: "user", text: "", images: 2, index: 0 },
      { kind: "command", name: "/model", args: "opus", output: "Set model to opus", index: 1 },
      { kind: "assistant", turns: [turns[2]], index: 2 },
    ]);
    // Two commands in a row are two blocks, never one.
    const two = conversationBlocks([turns[1], { kind: "command", name: "/clear" }]);
    expect(two.map(b => b.kind)).toEqual(["command", "command"]);
  });

  it("draws the command row and the image chip in ChatView", () => {
    const tree = mount(ChatView, { source: { state: "ready", turns } satisfies ChatSource }).tree;
    const [message] = all(tree, el => el.type === YourMessage);
    expect(message.props).toMatchObject({ text: "", images: 2 });
    const [row] = all(tree, el => el.type === YourCommand);
    expect(row.props.turn).toMatchObject({ kind: "command", name: "/model", args: "opus", output: "Set model to opus" });
  });

  it("skips a kind this build does not know, without moving the turns after it", () => {
    const future = { kind: "future", text: "x" } as unknown as ChatTurn;
    expect(conversationBlocks([{ kind: "user", text: "hi" }, future, { kind: "assistant", text: "ok" }]))
      .toEqual([{ kind: "user", text: "hi", index: 0 }, { kind: "assistant", turns: [{ kind: "assistant", text: "ok" }], index: 2 }]);
    // Inside a response it keeps its place, so a question after it is still found at its index.
    const ask: ChatTurn = { kind: "ask", questions: [{ header: "", question: "Which?", multi: false, options: [{ label: "A", description: "" }] }], running: true };
    const [block] = conversationBlocks([{ kind: "assistant", text: "Let me ask." }, future, ask]);
    expect(block.kind === "assistant" && block.turns).toEqual([{ kind: "assistant", text: "Let me ask." }, future, ask]);
  });

  it("follows a command's output as it arrives and grows, and a change of images", () => {
    const ran: ChatTurn = { kind: "command", name: "/model", args: "opus" };
    expect(tailKey(ran)).not.toBe(tailKey({ ...ran, output: "Set model" }));
    expect(tailKey({ ...ran, output: "Set model" })).not.toBe(tailKey({ ...ran, output: "Set model\nto opus" }));
    expect(tailKey({ ...ran, output: "x" })).not.toBe(tailKey({ ...ran, output: "x", failed: true }));
    expect(tailKey({ kind: "user", text: "look" })).not.toBe(tailKey({ kind: "user", text: "look", images: 1 }));
    expect(tailKey({ kind: "user", text: "", images: 1 })).not.toBe(tailKey({ kind: "user", text: "", images: 2 }));
  });
});

describe("the Stop step", () => {
  it("is Esc, sent only once the screen shows Claude Code's own words for it", () => {
    expect(STOP_WORDS).toBe("esc to interrupt");
    expect(stopSteps()).toEqual([{ expect: ["esc to interrupt"], keys: [{ input: "\x1b" }] }]);
    // A fresh plan each time, so a caller cannot change the next one.
    expect(stopSteps()).not.toBe(stopSteps());
  });
});

function deferred() {
  let resolve!: (result: AskSendResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<AskSendResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function rig(initial: Partial<ChatComposerProps> = {}) {
  const pending = { current: deferred() };
  const onStop = vi.fn(() => pending.current.promise);
  const onSend = vi.fn<ChatComposerProps["onSend"]>(() => "sent");
  const onChange = vi.fn();
  // CHANGED ON PURPOSE (the composer's one button): Stop is drawn in Send's
  // place while nothing is typed, so these drive it with an empty box.
  const props: ChatComposerProps = { value: "", onChange, onSend, canStop: true, onStop, ...initial };
  const view = mount(ChatComposer, props);
  const stop = () => one(view.tree, el => el.props.className === "btn chat-composer-stop");
  return {
    view, onStop, onSend, onChange, pending, stop,
    press() { (stop()!.props.onClick as () => void)(); },
    async settle(result: AskSendResult) { pending.current.resolve(result); await flush(); },
    status: () => one(view.tree, el => el.props.role === "status")!,
    term: () => one(view.tree, el => el.props.className === "chat-composer-term"),
  };
}

describe("the composer's Stop", () => {
  it("is not there unless the stage says Claude Code can be stopped", () => {
    expect(rig({ canStop: undefined }).stop()).toBeNull();
    expect(rig({ canStop: false }).stop()).toBeNull();
    expect(rig({ onStop: undefined }).stop()).toBeNull();
  });

  // CHANGED ON PURPOSE (herdr's composer, the owner's ask): one button. With
  // nothing typed while Claude Code works it is Stop; a word typed makes it
  // Send, which queues the message behind the turn.
  it("takes Send's place while nothing is typed: a quiet button, named for what it does", () => {
    const r = rig();
    const button = r.stop()!;
    expect(button.type).toBe("button");
    expect(button.props.type).toBe("button");
    expect(textOf(button)).toBe("Stop");
    expect(button.props.title).toBe("Stop Claude Code (sends Esc)");
    expect(button.props["aria-label"]).toBe("Stop Claude Code (sends Esc)");
    expect(button.props.disabled).toBe(false);
    const row = one(r.view.tree, el => el.props.className === "chat-composer-input")!;
    const buttons = all(row, el => el.type === "button");
    expect(buttons.map(el => el.props.className)).toEqual(["btn chat-composer-stop"]);
  });

  it("is Send again once a word is typed, and Stop again once the box is empty", () => {
    const r = rig({ value: "queue this" });
    expect(r.stop()).toBeNull();
    const row = one(r.view.tree, el => el.props.className === "chat-composer-input")!;
    expect(all(row, el => el.type === "button").map(el => el.props.className)).toEqual(["btn primary chat-composer-send"]);
    expect(one(row, el => el.props.type === "submit")!.props.disabled).toBe(false);
    r.view.rerender({ value: "  \n", onChange: r.onChange, onSend: r.onSend, canStop: true, onStop: r.onStop });
    expect(r.stop()).not.toBeNull();
    r.view.rerender({ value: "", onChange: r.onChange, onSend: r.onSend, canStop: false, onStop: r.onStop });
    expect(r.stop(), "not working: the empty box has Send, disabled").toBeNull();
    expect(one(r.view.tree, el => el.props.type === "submit")!.props.disabled).toBe(true);
  });

  it("calls onStop once, and is disabled while the stop is pending", async () => {
    const r = rig();
    r.press();
    expect(r.onStop).toHaveBeenCalledOnce();
    expect(r.stop()!.props.disabled).toBe(true);
    r.press();
    expect(r.onStop).toHaveBeenCalledOnce();
    await r.settle("sent");
    expect(r.stop()!.props.disabled).toBe(false);
    // The draft is the person's: a stop neither sends nor clears it.
    expect(r.onSend).not.toHaveBeenCalled();
    expect(r.onChange).not.toHaveBeenCalled();
  });

  it("says Stop sent. politely, and clears it after a moment", async () => {
    vi.useFakeTimers();
    const r = rig();
    r.press();
    await r.settle("sent");
    expect(textOf(r.status())).toBe("Stop sent.");
    expect(r.status().props["aria-live"]).toBe("polite");
    expect(r.status().props["data-result"]).toBe("stop-sent");
    expect(r.term()).toBeNull();
    vi.advanceTimersByTime(STOP_SENT_MS - 1);
    expect(textOf(r.status())).toBe("Stop sent.");
    vi.advanceTimersByTime(1);
    expect(STOP_SENT_MS).toBe(2500);
    expect(textOf(r.status())).toBe("");
  });

  it("says there was nothing to stop when the screen never showed it working", async () => {
    const r = rig({ onShowTerm: vi.fn() });
    r.press();
    await r.settle("changed");
    expect(textOf(r.status())).toBe("Claude Code isn't working on anything to stop.");
    expect(r.term()).toBeNull();
  });

  it.each<AskSendResult>(["unavailable", "partial"])("on %s, says to press Esc in Term and offers Show Term", async outcome => {
    const onShowTerm = vi.fn();
    const r = rig({ onShowTerm });
    r.press();
    await r.settle(outcome);
    expect(textOf(r.status())).toBe("Could not send Stop. Press Esc in Term.");
    expect(r.status().props["data-result"]).toBe(`stop-${outcome}`);
    expect(textOf(r.term())).toBe("Show Term");
    (r.term()!.props.onClick as () => void)();
    expect(onShowTerm).toHaveBeenCalledOnce();
  });

  it("treats a transport that throws as unavailable", async () => {
    const r = rig({ onShowTerm: vi.fn() });
    r.press();
    r.pending.current.reject(new Error("socket closed"));
    await flush();
    expect(r.status().props["data-result"]).toBe("stop-unavailable");
    expect(textOf(r.term())).toBe("Show Term");
    expect(r.stop()!.props.disabled).toBe(false);
  });

  it("lets go of the result once the person edits the draft", async () => {
    const r = rig({ onShowTerm: vi.fn() });
    r.press();
    await r.settle("changed");
    const textarea = one(r.view.tree, el => el.type === "textarea")!;
    (textarea.props.onChange as (event: unknown) => void)({ currentTarget: { value: "a new draft" } });
    expect(textOf(r.status())).toBe("");
  });

  it("gives the focus back to the draft when the pressed Stop let go of it, and only then", async () => {
    const body = {};
    const page = { body, activeElement: body as unknown };
    vi.stubGlobal("document", page);
    const focus = vi.fn();
    const el = { style: { height: "" }, scrollHeight: 40, focus, parentElement: { getBoundingClientRect: () => ({ width: 320 }) } };
    const pending = { current: deferred() };
    const view = mount(ChatComposer, { value: "", onChange: vi.fn(), onSend: () => "sent", canStop: true, onStop: () => pending.current.promise },
      { commit: tree => { (one(tree, node => node.type === "textarea")!.ref as { current: unknown }).current = el; } });
    const press = () => (one(view.tree, node => node.props.className === "btn chat-composer-stop")!.props.onClick as () => void)();
    press();
    pending.current.resolve("sent");
    await flush();
    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    // Moved on while the stop waited for the screen: the focus stays where it went.
    pending.current = deferred();
    press();
    page.activeElement = { other: true };
    pending.current.resolve("changed");
    await flush();
    expect(focus).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("binds no key: Escape in the textarea is the deck's, never a stop", () => {
    const r = rig();
    const textarea = one(r.view.tree, el => el.type === "textarea")! as Drawn;
    const event = { key: "Escape", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
      nativeEvent: { isComposing: false, keyCode: 27 }, preventDefault: vi.fn() };
    (textarea.props.onKeyDown as (event: unknown) => void)(event);
    expect(r.onStop).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("has every new key in all ten board catalogs", () => {
    const catalogs = AREA_FILES.filter(area => area.area === "board");
    expect(catalogs).toHaveLength(10);
    const keys = ["images.one", "images.other", "stop", "stop.title", "stop.sent", "stop.nothing"];
    for (const { code, catalog } of catalogs) {
      for (const key of keys) expect(catalog[`board.chat.${key}`], `${code}: ${key}`).toBeTruthy();
    }
    expect(AREA_FILES.find(area => area.area === "board" && area.code === "ro")!.catalog["board.chat.images.few"]).toBeTruthy();
  });
});
