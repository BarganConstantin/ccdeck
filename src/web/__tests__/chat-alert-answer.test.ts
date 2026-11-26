// An answer chosen on an alert, the last steps of its way: the pane's ask
// handed down through Chat to the question card, the card sending it once, and
// the alert stack drawn beside the session's row.
import { describe, expect, it, vi } from "vitest";
import { AskCard } from "../components/chat/ChatTurn";
import { useSteadyAsk } from "../components/chat/ChatView";
import type { ChatAsk, ChatQuestion, Turn } from "../components/chat/chat-model";
import { ANCHOR_EDGE, ANCHOR_GAP, ANCHOR_MIN_WIDTH, ANCHOR_WIDTH, placeBeside } from "../components/alerts/AlertStack";
import type { AskSendResult } from "../use-terminal-session";
import { all, flush, mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

type AskTurn = Extract<Turn, { kind: "ask" }>;
const DB: ChatQuestion = { header: "Database", question: "Which database?", multi: false,
  options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }] };
const waiting: AskTurn = { kind: "ask", questions: [DB], running: true };
const press = (id: number, index: number, forQuestions = DB.question) => ({ id, index, for: forQuestions });

describe("Chat hands the alert's press down to the card", () => {
  function probe(ask: ChatAsk | undefined) {
    let seen: ChatAsk | undefined;
    const Probe = (p: { ask: ChatAsk | undefined }) => { seen = useSteadyAsk(p.ask); return null; };
    const view = mount(Probe, { ask });
    return { view, seen: () => seen, rerender: (next: ChatAsk | undefined) => view.rerender({ ask: next }) };
  }
  const send = () => Promise.resolve<AskSendResult>("sent");

  it("carries the press, which once stopped here and left the alert's answer unsent", () => {
    const first = press(1, 1);
    const r = probe({ send, press: first });
    expect(r.seen()?.press).toBe(first);
  });

  it("stays the same object while nothing it carries changes, and changes with a new press", () => {
    const first = press(1, 1);
    const r = probe({ send, press: first });
    const before = r.seen();
    r.rerender({ send, press: first });
    expect(r.seen()).toBe(before);
    const second = press(2, 0);
    r.rerender({ send, press: second });
    expect(r.seen()).not.toBe(before);
    expect(r.seen()?.press).toBe(second);
  });

  it("carries an ended session, and why the card cannot send", () => {
    const r = probe({ send, gone: true, blocked: "Connecting to the session…" });
    expect(r.seen()?.gone).toBe(true);
    expect(r.seen()?.blocked).toBe("Connecting to the session…");
  });
});

describe("the card sends an alert's answer once", () => {
  function rig(ask: Partial<ChatAsk>) {
    const send = vi.fn<ChatAsk["send"]>(() => Promise.resolve("sent"));
    const make = (over: Partial<ChatAsk>): ChatAsk => ({ send, onShowTerm: vi.fn(), ...over });
    const view = mount(AskCard, { turn: waiting, ask: make(ask) });
    return { send, view, rerender: (over: Partial<ChatAsk>) => view.rerender({ turn: waiting, ask: make(over) }) };
  }

  it("picks the option and sends it, and the same press never sends twice", async () => {
    const p = press(7, 1);
    const r = rig({ press: p });
    await flush();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.send).toHaveBeenCalledWith([DB], [{ options: [1] }]);
    r.rerender({ press: p });
    await flush();
    expect(r.send).toHaveBeenCalledTimes(1);
  });

  it("a press for another question is not this card's", async () => {
    const r = rig({ press: press(7, 1, "Which cache?") });
    await flush();
    expect(r.send).not.toHaveBeenCalled();
  });

  it("a press that comes while the card cannot send waits for it, then goes once", async () => {
    const p = press(9, 0);
    const r = rig({ press: p, blocked: "Connecting to the session…" });
    await flush();
    expect(r.send).not.toHaveBeenCalled();
    r.rerender({ press: p });
    await flush();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.send).toHaveBeenCalledWith([DB], [{ options: [0] }]);
  });

  it("an ended session's question takes no press", async () => {
    const r = rig({ press: press(3, 0), gone: true });
    await flush();
    expect(r.send).not.toHaveBeenCalled();
    expect(all(r.view.tree, el => el.type === "input")).toEqual([]);
  });
});

describe("the alert stack beside its row", () => {
  const view = { right: 1400, height: 860 };
  const row = { left: 44, top: 108, right: 299, bottom: 159 };
  const stack = { height: 104, cardTop: 0, cardHeight: 104 };

  it("sits just right of the row, level with it, and points at its middle", () => {
    expect(placeBeside(row, stack, view)).toEqual({ left: 299 + ANCHOR_GAP, top: 108, width: ANCHOR_WIDTH, notch: 26 });
  });

  it("keeps the row's own card level with it when a leaving card is drawn above", () => {
    const p = placeBeside(row, { height: 216, cardTop: 112, cardHeight: 104 }, view);
    expect(p).toMatchObject({ top: Math.max(ANCHOR_EDGE, 108 - 112), notch: null });
    const lower = placeBeside({ ...row, top: 300, bottom: 351 }, { height: 216, cardTop: 112, cardHeight: 104 }, view);
    expect(lower).toMatchObject({ top: 300 - 112, notch: 26 });
  });

  it("narrows to keep clear of the right stripe, and keeps to the corner when even that does not fit", () => {
    const tight = placeBeside(row, stack, { right: 601, height: 860 });
    expect(tight?.width).toBe(601 - ANCHOR_EDGE - (299 + ANCHOR_GAP));
    expect(placeBeside(row, stack, { right: 299 + ANCHOR_GAP + ANCHOR_MIN_WIDTH + ANCHOR_EDGE - 1, height: 860 })).toBeNull();
  });

  it("moves up only as far as the window's bottom needs, and draws no point off its card", () => {
    const low = { left: 44, top: 820, right: 299, bottom: 852 };
    const p = placeBeside(low, stack, view);
    expect(p?.top).toBe(860 - 104 - ANCHOR_EDGE);
    expect(p?.notch).toBeNull();
  });
});
