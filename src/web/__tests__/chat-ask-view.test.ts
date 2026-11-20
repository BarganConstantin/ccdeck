// ChatView and a question Claude Code asked: only the last turn, while it still
// waits, is answered from Chat; any earlier card is the record of what it asked.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChatView, { liveAskAt, tailKey } from "../components/chat/ChatView";
import type { ChatAsk, ChatQuestion, ChatSource, ChatTurn } from "../components/chat/chat-model";

const DB: ChatQuestion = {
  header: "Database", question: "Which database?", multi: false,
  options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }],
};
const asked = (extra: Partial<Extract<ChatTurn, { kind: "ask" }>> = {}): ChatTurn => ({ kind: "ask", questions: [DB], ...extra });
const ready = (turns: ChatTurn[]): ChatSource => ({ state: "ready", turns } as ChatSource);
const ask: ChatAsk = { send: vi.fn(async () => "sent" as const), onShowTerm: vi.fn() };
const html = (source: ChatSource, live?: ChatAsk) => renderToStaticMarkup(createElement(ChatView, { source, ask: live }));
const forms = (markup: string) => markup.match(/<form class="chat-ask-form"/g)?.length ?? 0;

describe("which question Chat answers", () => {
  it("the last turn, only while it waits", () => {
    expect(liveAskAt([asked({ running: true })])).toBe(0);
    expect(liveAskAt([{ kind: "user", text: "go" } as ChatTurn, asked({ running: true })])).toBe(1);
    expect(liveAskAt([asked({ running: true }), { kind: "text", text: "ok" } as ChatTurn])).toBe(-1);
    expect(liveAskAt([asked({ answers: ["Postgres"] })])).toBe(-1);
    expect(liveAskAt([])).toBe(-1);
  });

  it("draws the form for the waiting card, and options to pick", () => {
    const markup = html(ready([{ kind: "user", text: "Set up the service" } as ChatTurn, asked({ running: true })]), ask);
    expect(forms(markup)).toBe(1);
    expect(markup.match(/type="radio"/g)).toHaveLength(3);
    expect(markup).toContain("Send answer");
    expect(markup).toContain("Waiting for your answer");
  });

  it("draws an earlier or answered card read only", () => {
    expect(forms(html(ready([asked({ answers: ["SQLite"] }), asked({ running: true })]), ask))).toBe(1);
    expect(forms(html(ready([asked({ running: true }), { kind: "text", text: "Never mind." } as ChatTurn]), ask))).toBe(0);
    expect(forms(html(ready([asked({ answers: ["SQLite"] })]), ask))).toBe(0);
  });

  it("draws no form without a stage that can answer", () => {
    const markup = html(ready([asked({ running: true })]));
    expect(forms(markup)).toBe(0);
    expect(markup).toContain("Which database?");
    expect(markup).not.toContain("type=\"radio\"");
  });

  it("a card that changes state, or gets its answer, counts as a new last turn", () => {
    expect(tailKey(asked({ running: true }))).not.toBe(tailKey(asked({ answers: ["SQLite"] })));
    expect(tailKey(asked({ answers: ["SQLite"] }))).not.toBe(tailKey(asked({ answers: ["Postgres"] })));
    expect(tailKey(asked({ answers: [""], reply: "no" }))).not.toBe(tailKey(asked({ answers: [""] })));
  });
});
