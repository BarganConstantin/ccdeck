// AskCard: a question Claude Code asked, drawn in Chat. Read only once answered
// or when the stage cannot answer; while it waits and the stage can, its options
// are picked here and sent, and the card says what happened to the keys.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskCard, readAnswer } from "../components/chat/ChatTurn";
import type { ChatAsk, ChatQuestion, Turn } from "../components/chat/chat-model";
import { setLanguage } from "../i18n";
import type { AskSendResult } from "../use-terminal-session";
import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => setLanguage("en"));
afterEach(() => setLanguage("en"));

type AskTurn = Extract<Turn, { kind: "ask" }>;

const q = (question: string, labels: string[], extra: Partial<ChatQuestion> = {}): ChatQuestion => ({
  header: "", question, multi: false, options: labels.map(label => ({ label, description: "" })), ...extra,
});
const DB = q("Which database?", ["Postgres", "SQLite", "DynamoDB"], { header: "Database" });
const FEATURES = q("Which features first?", ["Search", "Export", "Sharing"], { multi: true });
const LAYOUT = q("Which layout?", ["Cards", "Table"], { preview: true });
const NAME = q("What is the service called?", []);

const waiting = (...questions: ChatQuestion[]): AskTurn => ({ kind: "ask", questions, running: true });

function rig(turn: AskTurn, ask?: Partial<ChatAsk>) {
  let settle: (result: AskSendResult) => void = () => {};
  const send = vi.fn<ChatAsk["send"]>(() => new Promise(resolve => { settle = resolve; }));
  const onShowTerm = vi.fn();
  const live: ChatAsk | undefined = ask && { send, onShowTerm, ...ask };
  const view = mount(AskCard, { turn, ask: live });
  const press = (el: Drawn, name: string, event: unknown = {}) => (el.props[name] as (e: unknown) => void)(event);
  const choices = (i: number) => all(view.tree, el => el.type === "input" && String(el.props.name).endsWith(`-q${i}`));
  return {
    view, send, onShowTerm,
    settle: async (result: AskSendResult) => { settle(result); await flush(); },
    choices,
    pick: (i: number, n: number) => press(choices(i)[n], "onChange"),
    other: (i: number) => press(choices(i).at(-1)!, "onChange"),
    textBox: () => one(view.tree, el => el.type === "input" && el.props.type === "text"),
    type: (value: string) => press(one(view.tree, el => el.props.type === "text")!, "onChange", { currentTarget: { value } }),
    submit: () => press(one(view.tree, el => el.type === "form")!, "onSubmit", { preventDefault: vi.fn() }),
    sendButton: () => one(view.tree, el => el.type === "button" && el.props.type === "submit")!,
    status: () => one(view.tree, el => el.props.role === "status"),
    term: () => one(view.tree, el => el.props.className === "chat-ask-term"),
    text: () => textOf(view.tree),
  };
}

describe("a card you cannot answer from here", () => {
  it("shows the question and its numbered options, with nothing to press", () => {
    const r = rig(waiting(DB));
    expect(r.text()).toContain("A question for you");
    expect(r.text()).toContain("Waiting for your answer");
    expect(r.text()).toContain("Database");
    expect(r.text()).toContain("Which database?");
    expect(all(r.view.tree, el => el.props.className === "chat-ask-n").map(textOf)).toEqual(["1", "2", "3"]);
    expect(all(r.view.tree, el => el.type === "input" || el.type === "button" || el.type === "form")).toEqual([]);
    expect(r.status()).toBeNull();
  });

  it("marks what was chosen once answered, and names several", () => {
    const r = rig({ kind: "ask", questions: [DB, FEATURES], answers: ["SQLite", "Search, Sharing"] }, {});
    expect(r.text()).toContain("2 questions for you");
    expect(r.text()).toContain("Answered");
    const chosen = all(r.view.tree, el => el.props["data-chosen"] === true).map(textOf);
    expect(chosen).toEqual(["2SQLiteChosen", "1SearchChosen", "3SharingChosen"]);
    expect(r.choices(0)).toEqual([]);
  });

  it("shows your own words as your answer, and what you wrote back as your reply", () => {
    const own = rig({ kind: "ask", questions: [DB], answers: ["MySQL, the old one"] });
    expect(one(own.view.tree, el => el.props.className === "chat-ask-answer")).not.toBeNull();
    expect(own.text()).toContain("Your answerMySQL, the old one");
    const reply = rig({ kind: "ask", questions: [DB], answers: [""], reply: "neither, use files" });
    expect(reply.text()).toContain("Answered");
    expect(reply.text()).toContain("Your replyneither, use files");
  });

  it("says when a question went without an answer", () => {
    const r = rig({ kind: "ask", questions: [DB], answers: [""] });
    expect(r.text()).toContain("Not answered");
    expect(all(r.view.tree, el => el.props["data-chosen"] === true)).toEqual([]);
  });
});

describe("reading an answer back", () => {
  it("a label with a comma is one choice, the rest is your own words", () => {
    const commas = q("Pick", ["Fast, cheap", "Slow"], { multi: true });
    expect(readAnswer(commas, "Fast, cheap")).toEqual({ chosen: new Set([0]), other: "" });
    expect(readAnswer(commas, "Slow, Billing")).toEqual({ chosen: new Set([1]), other: "Billing" });
    expect(readAnswer(DB, "Oracle")).toEqual({ chosen: new Set(), other: "Oracle" });
  });
});

describe("answering from the card", () => {
  it("one choice: Send waits for a pick, then sends it and says so", async () => {
    const r = rig(waiting(DB), {});
    expect(r.choices(0).map(el => el.props.type)).toEqual(["radio", "radio", "radio", "radio"]);
    expect(r.sendButton().props.disabled).toBe(true);
    r.pick(0, 0);
    r.pick(0, 1);
    expect(r.choices(0).map(el => el.props.checked)).toEqual([false, true, false, false]);
    expect(r.sendButton().props.disabled).toBe(false);
    r.submit();
    expect(r.send).toHaveBeenCalledWith([DB], [{ options: [1] }]);
    expect(textOf(r.status())).toBe("Sending the answer…");
    expect(r.choices(0).every(el => el.props.disabled)).toBe(true);
    const marks = () => all(r.view.tree, el => el.props.className === "chat-ask-chosen");
    expect(marks(), "no mark while it is only picked").toEqual([]);
    await r.settle("sent");
    expect(textOf(r.status())).toBe("Answer sent. The conversation updates when Claude Code continues.");
    expect(r.status()!.props["data-result"]).toBe("sent");
    expect(r.sendButton().props.disabled, "the same answer is never sent twice").toBe(true);
    expect(r.choices(0).every(el => el.props.disabled)).toBe(true);
    expect(r.term()).toBeNull();
    // A disabled control alone goes grey: the sent pick keeps a mark.
    expect(marks().map(textOf)).toEqual(["Chosen"]);
  });

  it("several choices: each box toggles, and they go in order", async () => {
    const r = rig(waiting(FEATURES), {});
    expect(r.choices(0).map(el => el.props.type)).toEqual(["checkbox", "checkbox", "checkbox"]);
    expect(r.text()).toContain("Choose any");
    expect(r.textBox(), "Claude Code has no box for your words beside several choices").toBeNull();
    r.pick(0, 2);
    r.pick(0, 0);
    r.pick(0, 1);
    r.pick(0, 1);
    r.submit();
    expect(r.send).toHaveBeenCalledWith([FEATURES], [{ options: [0, 2] }]);
    await r.settle("sent");
  });

  it("your own words: the box counts only once it holds something, and keeps it while you try an option", async () => {
    const r = rig(waiting(DB), {});
    r.other(0);
    expect(r.sendButton().props.disabled).toBe(true);
    r.type("MySQL");
    expect(r.choices(0).at(-1)!.props.checked).toBe(true);
    r.pick(0, 0);
    expect(r.textBox()!.props.value).toBe("MySQL");
    expect(r.choices(0).at(-1)!.props.checked).toBe(false);
    r.other(0);
    r.submit();
    expect(r.send).toHaveBeenCalledWith([DB], [{ options: [], text: "MySQL" }]);
    await r.settle("sent");
  });

  it("no box for your words beside options that carry a preview", () => {
    const r = rig(waiting(LAYOUT), {});
    expect(r.choices(0)).toHaveLength(2);
    expect(r.textBox()).toBeNull();
  });

  it("two questions are sent together, once both have a pick", () => {
    const r = rig(waiting(DB, FEATURES), {});
    r.pick(0, 2);
    expect(r.sendButton().props.disabled).toBe(true);
    r.pick(1, 1);
    r.submit();
    expect(r.send).toHaveBeenCalledWith([DB, FEATURES], [{ options: [2] }, { options: [1] }]);
  });
});

describe("when the card cannot send, or the keys did not all go", () => {
  // CHANGED ON PURPOSE (browser QA): the card said why and offered Term, and the
  // reply box under it, handed the same reason, said it again with its own
  // Show Term. The card now only locks its options; the reply box says why.
  it("a stage that cannot write says why on the card, offers Term, and draws no choices to press", () => {
    const r = rig(waiting(DB), { blocked: "This session is read-only." });
    // Read-only rows, as the card draws them when it cannot answer: never
    // radios that look ready and do nothing when clicked.
    expect(r.choices(0)).toEqual([]);
    expect(all(r.view.tree, el => el.props.className === "chat-ask-n").map(textOf)).toEqual(["1", "2", "3"]);
    expect(all(r.view.tree, el => el.type === "button" && el.props.type === "submit")).toEqual([]);
    expect(textOf(r.status())).toBe("This session is read-only.");
    expect(r.term()).not.toBeNull();
    r.submit();
    expect(r.send).not.toHaveBeenCalled();
  });

  it("the same while it connects: the reason beside the card, nothing sent", () => {
    const r = rig(waiting(DB), { blocked: "Connecting to the session…" });
    expect(r.choices(0)).toEqual([]);
    expect(textOf(r.status())).toBe("Connecting to the session…");
    r.submit();
    expect(r.send).not.toHaveBeenCalled();
  });

  it("a question left open by a session that ended waits for nobody: Not answered, nothing to press", () => {
    const r = rig(waiting(DB), { gone: true });
    expect(r.text()).toContain("Not answered");
    expect(r.text()).not.toContain("Waiting for your answer");
    expect(all(r.view.tree, el => el.type === "input" || el.type === "form")).toEqual([]);
  });

  it("a question that asks for typed text is answered in Term", () => {
    const r = rig(waiting(DB, NAME), {});
    expect(textOf(r.status())).toBe("This question asks for typed text. Answer it in Term.");
    expect(r.choices(0)).toEqual([]);
    expect(all(r.view.tree, el => el.type === "button" && el.props.type === "submit")).toEqual([]);
    expect(r.term()).not.toBeNull();
    r.submit();
    expect(r.send).not.toHaveBeenCalled();
  });

  it("Term showing something else: nothing went, so you can pick again and retry", async () => {
    const r = rig(waiting(DB), {});
    r.pick(0, 0);
    r.submit();
    await r.settle("changed");
    expect(textOf(r.status())).toBe("Term doesn't show this question as asked, so nothing was sent. Check Term.");
    expect(r.term()).not.toBeNull();
    expect(r.choices(0).some(el => el.props.disabled)).toBe(false);
    r.pick(0, 2);
    expect(textOf(r.status()), "a new pick clears the old outcome").toBe("");
    r.submit();
    expect(r.send).toHaveBeenLastCalledWith([DB], [{ options: [2] }]);
    expect(r.send).toHaveBeenCalledTimes(2);
  });

  it("part of the keys went: locked, finish in Term", async () => {
    const r = rig(waiting(DB, FEATURES), {});
    r.pick(0, 0);
    r.pick(1, 0);
    r.submit();
    await r.settle("partial");
    expect(textOf(r.status())).toBe("Only part of the answer was sent. Finish it in Term.");
    expect(r.sendButton().props.disabled).toBe(true);
    expect(r.term()).not.toBeNull();
  });

  it("a send that fails says the answer could not go", async () => {
    const r = rig(waiting(DB), { send: vi.fn(() => Promise.reject(new Error("socket closed"))) });
    r.pick(0, 1);
    r.submit();
    await flush();
    expect(textOf(r.status())).toBe("The answer could not be sent. Answer in Term.");
    expect(r.status()!.props["data-result"]).toBe("unavailable");
    expect(r.term()).not.toBeNull();
  });

  it("an answered card drops the form even with a live stage", () => {
    const r = rig({ kind: "ask", questions: [DB], answers: ["Postgres"] }, {});
    expect(one(r.view.tree, el => el.type === "form")).toBeNull();
    expect(r.choices(0)).toEqual([]);
  });
});

// Claude Code's prompt ends with "Chat about this", set apart from the
// answers. The card offers it as a quiet link at the end of Send answer's row,
// sends it through the stage like an answer, and says the questions were set
// aside rather than answered.
describe("Chat about this", () => {
  function chatRig(turn: AskTurn, ask: Partial<ChatAsk> = {}) {
    let settle: (result: AskSendResult) => void = () => {};
    const chat = vi.fn<NonNullable<ChatAsk["chat"]>>(() => new Promise(resolve => { settle = resolve; }));
    const r = rig(turn, { chat, ...ask });
    return {
      ...r, chat,
      settleChat: async (result: AskSendResult) => { settle(result); await flush(); },
      link: () => one(r.view.tree, el => el.type === "button" && el.props.className === "chat-ask-term chat-ask-chat"),
    };
  }
  const click = (el: Drawn | null) => (el!.props.onClick as () => void)();

  it("is offered last, after Send answer, as a quiet link and not as an answer", () => {
    const r = chatRig(waiting(DB));
    const actions = one(r.view.tree, el => el.props.className === "chat-ask-actions")!;
    const buttons = all(actions, el => el.type === "button");
    expect(buttons.map(textOf)).toEqual(["Send answer", "Chat about this"]);
    expect(buttons.at(-1)!.props.type).toBe("button");
    expect(r.choices(0), "not one of the options").toHaveLength(4);
  });

  it("is not offered by a stage that cannot pick it, a read-only card, or a blocked stage", () => {
    expect(rig(waiting(DB), {}).text()).not.toContain("Chat about this");
    expect(chatRig({ kind: "ask", questions: [DB], answers: ["Postgres"] }).link()).toBeNull();
    expect(chatRig(waiting(DB), { blocked: "This session is read-only." }).link()).toBeNull();
    expect(rig(waiting(DB)).text(), "no stage at all").not.toContain("Chat about this");
  });

  it("is offered with several questions and several choices, and sends them all", async () => {
    const r = chatRig(waiting(DB, FEATURES));
    r.pick(0, 1);
    click(r.link());
    expect(r.chat).toHaveBeenCalledWith([DB, FEATURES]);
    expect(r.send).not.toHaveBeenCalled();
    expect(chatRig(waiting(FEATURES)).link()).not.toBeNull();
    expect(chatRig(waiting(LAYOUT)).link(), "beside a preview too").not.toBeNull();
  });

  it("pressed: says it is setting the question aside, then that it was, and locks the card", async () => {
    const r = chatRig(waiting(DB));
    r.pick(0, 2);
    click(r.link());
    expect(textOf(r.status())).toBe("Setting it aside to chat…");
    expect(r.link(), "gone while it goes").toBeNull();
    expect(r.sendButton().props.disabled).toBe(true);
    await r.settleChat("sent");
    expect(textOf(r.status())).toBe("Set aside to chat. Claude Code will ask what you want to clarify; reply below.");
    expect(r.status()!.props["data-result"]).toBe("sent");
    expect(r.link(), "never sent twice").toBeNull();
    expect(r.sendButton().props.disabled).toBe(true);
    expect(r.choices(0).every(el => el.props.disabled)).toBe(true);
    expect(all(r.view.tree, el => el.props.className === "chat-ask-chosen"), "the pick made before was not chosen").toEqual([]);
    expect(r.term()).toBeNull();
  });

  it("Term without the row: nothing went, the link goes, the status says to answer in Term, and an answer can still go", async () => {
    const r = chatRig(waiting(DB));
    click(r.link());
    await r.settleChat("changed");
    expect(textOf(r.status())).toBe("Term has no Chat about this row for this question, so nothing was sent. Answer it in Term.");
    expect(r.status()!.props["data-result"]).toBe("changed");
    expect(r.term()).not.toBeNull();
    expect(r.link(), "not offered again: Term has no such row").toBeNull();
    r.pick(0, 0);
    r.submit();
    expect(textOf(r.status()), "an answer says it is an answer").toBe("Sending the answer…");
    await r.settle("sent");
    expect(textOf(r.status())).toBe("Answer sent. The conversation updates when Claude Code continues.");
    expect(all(r.view.tree, el => el.props.className === "chat-ask-chosen").map(textOf)).toEqual(["Chosen"]);
    expect(r.link(), "the question was answered").toBeNull();
  });

  it("a chat that fails says so as an answer that fails does, and stays on offer", async () => {
    const r = chatRig(waiting(DB), { chat: vi.fn(() => Promise.reject(new Error("socket closed"))) });
    click(r.link());
    await flush();
    expect(textOf(r.status())).toBe("The answer could not be sent. Answer in Term.");
    expect(r.term()).not.toBeNull();
    expect(r.link(), "a dropped socket is not a missing row").not.toBeNull();
  });

  it("the status line can take focus, so the press does not drop it to the page when the link goes", () => {
    const r = chatRig(waiting(DB));
    expect(r.status()!.props.tabIndex).toBe(-1);
    expect(r.status()!.props.role).toBe("status");
  });

  it("says the missing row in every language", async () => {
    setLanguage("ro");
    const r = chatRig(waiting(DB));
    click(r.link());
    await r.settleChat("changed");
    expect(textOf(r.status())).toBe("În Term întrebarea asta nu are opțiunea de discuție, așa că nu s-a trimis nimic. Răspunde în Term.");
  });

  it("an answer sent from the card takes the offer away, and answers go as before", async () => {
    const r = chatRig(waiting(DB));
    r.other(0);
    r.type("MySQL");
    r.submit();
    expect(r.send).toHaveBeenCalledWith([DB], [{ options: [], text: "MySQL" }]);
    expect(r.link()).toBeNull();
    await r.settle("sent");
    expect(r.chat).not.toHaveBeenCalled();
  });

  it("set aside in the transcript, the card says so instead of Not answered", () => {
    const r = chatRig({ kind: "ask", questions: [DB, FEATURES], answers: ["", ""], chat: true });
    expect(r.text()).toContain("Set aside to chat");
    expect(r.text()).not.toContain("Not answered");
    expect(one(r.view.tree, el => el.type === "section")!.props["data-state"]).toBe("chatted");
    expect(r.link()).toBeNull();
    setLanguage("ro");
    expect(rig({ kind: "ask", questions: [DB], answers: [""], chat: true }).text()).toContain("Lăsată deoparte pentru discuție");
  });
});
