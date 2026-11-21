// Chat draws a plan Claude asks you to approve (ExitPlanMode) as a card with
// the plan's prose, so it is read here; the answer is the docked Decision card's.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChatView, { tailKey } from "../components/chat/ChatView";
import type { ChatSource, ChatTurn } from "../components/chat/chat-model";
import { words } from "./screens-fixtures";

const PLAN = "## Rate limits\n\n1. A token bucket on the public routes\n2. Tests for burst and refill";
const html = (turns: ChatTurn[]) => renderToStaticMarkup(createElement(ChatView, { source: { state: "ready", turns } satisfies ChatSource }));
const card = (markup: string) => /<section class="chat-ask chat-plan"[^>]*>[\s\S]*?<\/section>/.exec(markup)?.[0] ?? "";

describe("a plan card", () => {
  it("waits in --warn with the plan as prose", () => {
    const markup = card(html([{ kind: "user", text: "Plan the rate limits" }, { kind: "plan", text: PLAN, running: true }]));
    expect(markup).toContain('data-state="waiting"');
    expect(markup).toContain('aria-label="Plan"');
    expect(words(markup)).toContain("Plan Waiting for your approval");
    expect(markup).toContain("<h2");
    expect(markup).toContain("<ol");
    expect(words(markup)).toContain("A token bucket on the public routes");
  });

  it("says Approved, or Not approved, once answered", () => {
    expect(words(card(html([{ kind: "plan", text: PLAN, approved: true }])))).toContain("Plan Approved");
    expect(card(html([{ kind: "plan", text: PLAN, approved: true }]))).toContain('data-state="answered"');
    expect(words(card(html([{ kind: "plan", text: PLAN, approved: false }])))).toContain("Plan Not approved");
    expect(card(html([{ kind: "plan", text: PLAN, approved: false }]))).toContain('data-state="unanswered"');
  });

  it("says the rest is in Term when the plan was cut, and draws only its head with no plan", () => {
    expect(words(card(html([{ kind: "plan", text: PLAN, cut: true, running: true }])))).toContain("The plan goes on in Term.");
    expect(words(card(html([{ kind: "plan", text: PLAN, running: true }])))).not.toContain("goes on in Term");
    const empty = card(html([{ kind: "plan", text: "", running: true }]));
    expect(empty).not.toContain("chat-plan-text");
    expect(words(empty)).toContain("Plan Waiting for your approval");
  });

  it("changes the tail key when it is answered, so the view follows it", () => {
    const waiting = tailKey({ kind: "plan", text: PLAN, running: true });
    expect(waiting).not.toBe(tailKey({ kind: "plan", text: PLAN, approved: true }));
    expect(tailKey({ kind: "plan", text: PLAN, approved: true })).not.toBe(tailKey({ kind: "plan", text: PLAN, approved: false }));
  });
});
