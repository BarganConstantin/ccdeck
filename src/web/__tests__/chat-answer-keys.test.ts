// Answering a waiting question from the keyboard, from anywhere in its Chat
// pane: 1 to 9 pick the matching answer and Esc picks a permission prompt's
// No, from the conversation or from the reply box while it is EMPTY; never in
// the card's first ARM_MS, never with a word in the box, never from the
// terminal or another text field. The question card's digits answer it one
// question at a time. The keyboard sheet and the status bar name the keys
// only while a card is up, in the reader's language.
//
// Drawn under the suite's stand-in React (fake-react.ts). The pane is a stand-in
// element that keeps its listeners, so a key is the event the browser would
// hand the pane's own listener.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARM_MS, askDigitPicks, askTakesDigits, isTextField, paneKeyAllowed, REPLY_BOX, usePaneAnswerKeys } from "../components/chat/answer-keys";
import { AskCard } from "../components/chat/ChatTurn";
import type { ChatAsk, ChatQuestion, ChatTurn } from "../components/chat/chat-model";
import DecisionCard from "../components/decision/DecisionCard";
import DecisionOption from "../components/decision/DecisionOption";
import { cancelRow, initialState, step } from "../components/decision/decision-machine";
import { decisionKeyGroup, decisionStatusView, paneKeyEvent } from "../components/decision/decision-keys";
import type { DecisionAnswer, DecisionModel } from "../components/decision/decision-model";
import { setLanguage, t } from "../i18n";
import { AREA_FILES } from "../i18n/catalogs";
import { showScreenKeys, useScreenKeys } from "../screen-keys";
import { setSingleKeyShortcuts } from "../single-key-shortcuts";
import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";
import { PLAN } from "./screens-fixtures";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => {
  setLanguage("en");
  setSingleKeyShortcuts(true);
  vi.useFakeTimers({ now: 10_000 });
});
afterEach(() => {
  setLanguage("en");
  setSingleKeyShortcuts(true);
  vi.useRealTimers();
});

/** A permission prompt as prompt-decision.ts reads Claude Code's: its No is the cancel row. */
const ASK: DecisionModel = {
  kind: "permission",
  title: "Allow this command?",
  command: "npm test",
  caption: "Bash in ~/work/web-api",
  options: [
    { label: "Yes", sub: "Runs once. The next command asks again.", runs: true },
    { label: "Yes, and don't ask again for npm test here", sub: "", locked: true, lockNote: "Changes the session's rules" },
    { label: "No", sub: "The command doesn't run", cancel: true },
  ],
  origin: "launched",
  session: "web-api",
};

// THE PANE, and what a key can be pressed on in it.
type Target = Record<string, unknown>;
const inPane = (over: Target = {}): Target => ({ tagName: "DIV", closest: () => null, matches: () => false, ...over });
const replyBox = (value: string) => inPane({ tagName: "TEXTAREA", value, matches: (s: string) => s === REPLY_BOX });
const inTerm = () => inPane({ closest: (s: string) => (s === "[data-terminal-panel]" ? {} : null) });
const otherField = () => inPane({ tagName: "INPUT", type: "text", value: "" });
const onCard = () => inPane({ onCard: true });

function stage() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const pane = {
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
    removeEventListener: (type: string, fn: (e: unknown) => void) => { listeners.get(type)?.delete(fn); },
    contains: (node: unknown) => !!node && typeof node === "object",
    listening: (type: string) => listeners.get(type)?.size ?? 0,
  };
  const card = {
    closest: (s: string) => (s === ".ts-stage" ? pane : null),
    contains: (node: unknown) => (node as Target | null)?.onCard === true,
  };
  const fire = (type: string, event: unknown) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); };
  /** A key pressed on `target`, as the pane's listener hears it. */
  const key = (key: string, target: Target = inPane(), extra: Partial<KeyboardEvent> = {}) => {
    const event = {
      key, target, repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      preventDefault: vi.fn(() => { event.defaultPrevented = true; }), stopPropagation: vi.fn(),
      ...extra,
    };
    fire("keydown", event);
    return event;
  };
  return { pane, card, key, fire };
}

/** Attaches `card` to the ref of the element `match` finds, as the document would. */
const attach = (match: (el: Drawn) => boolean, card: unknown) => (tree: unknown) => {
  const el = one(tree, match);
  if (el) (el.ref as { current: unknown }).current = card;
};

describe("where a key counts (paneKeyAllowed)", () => {
  const card = { contains: (n: unknown) => (n as Target)?.onCard === true };

  it("the conversation, and the reply box while it is empty", () => {
    expect(paneKeyAllowed(inPane() as never, card)).toBe(true);
    expect(paneKeyAllowed(replyBox("") as never, card)).toBe(true);
  });

  it("never a box with a word in it, another field, the terminal, or the card itself", () => {
    expect(paneKeyAllowed(replyBox("1") as never, card)).toBe(false);
    expect(paneKeyAllowed(replyBox(" ") as never, card)).toBe(false);
    expect(paneKeyAllowed(otherField() as never, card)).toBe(false);
    expect(paneKeyAllowed(inTerm() as never, card)).toBe(false);
    expect(paneKeyAllowed(onCard() as never, card)).toBe(false);
    expect(paneKeyAllowed(null, card)).toBe(false);
  });

  it("knows a text field when it sees one", () => {
    expect(isTextField({ tagName: "textarea" })).toBe(true);
    expect(isTextField({ tagName: "INPUT" })).toBe(true);
    expect(isTextField({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTextField({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextField({ tagName: "INPUT", type: "radio" })).toBe(false);
    expect(isTextField({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTextField({ tagName: "DIV", getAttribute: (n: string) => (n === "role" ? "textbox" : null) })).toBe(true);
    expect(isTextField({ tagName: "BUTTON" })).toBe(false);
  });
});

describe("the pane's listener (usePaneAnswerKeys)", () => {
  function host(on = true) {
    const s = stage();
    const handle = vi.fn((e: KeyboardEvent) => /^[1-9]$/.test(e.key));
    // The card's ref: one object for the card's life, as useRef gives.
    const anchor = { current: s.card as unknown as HTMLElement };
    const Host = (p: { on: boolean }) => ({ inPane: usePaneAnswerKeys(anchor, p.on, handle) });
    const anchorProps = { on };
    const view = mount(Host, anchorProps);
    return { ...s, handle, view };
  }

  it("hears nothing in the first ARM_MS, then takes what its handler takes, and that key goes no further", () => {
    const h = host();
    expect(h.key("1").preventDefault).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ARM_MS - 1);
    expect(h.key("1").preventDefault).not.toHaveBeenCalled();
    expect(h.handle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    const taken = h.key("1");
    expect(h.handle).toHaveBeenCalledOnce();
    expect(taken.preventDefault).toHaveBeenCalledOnce();
    expect(taken.stopPropagation).toHaveBeenCalledOnce();
    const passed = h.key("x");
    expect(passed.preventDefault).not.toHaveBeenCalled();
    expect(passed.stopPropagation).not.toHaveBeenCalled();
    h.view.unmount();
  });

  it("leaves a held key, an IME, a key already taken, and a word in the box alone", () => {
    const h = host();
    vi.advanceTimersByTime(ARM_MS);
    h.key("1", inPane(), { repeat: true });
    h.key("1", inPane(), { isComposing: true });
    h.key("1", inPane(), { keyCode: 229 });
    h.key("1", inPane(), { defaultPrevented: true });
    h.key("1", replyBox("draft"));
    h.key("1", inTerm());
    expect(h.handle).not.toHaveBeenCalled();
    h.key("1", replyBox(""));
    expect(h.handle).toHaveBeenCalledOnce();
    h.view.unmount();
  });

  it("says whether the focus is in the pane, and lets go of the pane when it goes off", () => {
    const h = host();
    expect((h.view.tree as { inPane: boolean }).inPane).toBe(false);
    h.fire("focusin", {});
    expect((h.view.tree as { inPane: boolean }).inPane).toBe(true);
    h.fire("focusout", { relatedTarget: null });
    expect((h.view.tree as { inPane: boolean }).inPane).toBe(false);
    expect(h.pane.listening("keydown")).toBe(1);
    h.view.rerender({ on: false });
    expect(h.pane.listening("keydown")).toBe(0);
    expect(h.pane.listening("focusin")).toBe(0);
  });

  it("arms again from the moment it comes back on", () => {
    const h = host(false);
    vi.advanceTimersByTime(ARM_MS * 3);
    h.view.rerender({ on: true });
    h.key("2");
    expect(h.handle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ARM_MS);
    h.key("2");
    expect(h.handle).toHaveBeenCalledOnce();
    h.view.unmount();
  });
});

describe("the Decision card from the pane", () => {
  function card(model: DecisionModel = ASK, outcome: "ok" | "hold" = "ok") {
    const s = stage();
    const answered: DecisionAnswer[] = [];
    const recheck = vi.fn(async () => (outcome === "ok" ? "ok" as const : { kind: "held" as const }));
    const view = mount(DecisionCard, { model, recheck, onAnswer: (a: DecisionAnswer) => { answered.push(a); } }, {
      commit: attach(el => el.props.className === "dc-dock", s.card),
    });
    return { ...s, view, recheck, answered };
  }

  it("1 picks the first answer once armed, and it is sent after the prompt is read again", async () => {
    const c = card();
    expect(c.key("1").defaultPrevented, "too soon: the key was meant for what was there before").toBe(false);
    expect(c.recheck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ARM_MS);
    expect(c.key("1", replyBox("")).defaultPrevented).toBe(true);
    expect(c.recheck).toHaveBeenCalledWith({ kind: "option", index: 0 });
    await flush();
    expect(c.answered).toEqual([{ kind: "option", index: 0 }]);
    c.view.unmount();
  });

  it("Esc picks the prompt's No; a locked row's digit says why and sends nothing; past the last row is not the card's", async () => {
    const c = card();
    vi.advanceTimersByTime(ARM_MS);
    // As on the card: the locked row is read, never answered, and the reason is said.
    expect(c.key("2").defaultPrevented).toBe(true);
    expect(textOf(one(c.view.tree, el => el.props.role === "status" && el.props.className === "vis-hidden"))).toBe(t("board.decision.onlyTerm"));
    expect(c.key("4").defaultPrevented).toBe(false);
    expect(c.recheck).not.toHaveBeenCalled();
    expect(c.key("Escape").defaultPrevented).toBe(true);
    await flush();
    expect(c.answered).toEqual([{ kind: "option", index: 2 }]);
    c.view.unmount();
  });

  it("never fires with a word in the reply box, or from the terminal", () => {
    const c = card();
    vi.advanceTimersByTime(ARM_MS);
    for (const target of [replyBox("1"), replyBox("no thanks"), inTerm(), otherField()]) {
      expect(c.key("1", target).defaultPrevented).toBe(false);
      expect(c.key("Escape", target).defaultPrevented).toBe(false);
    }
    expect(c.recheck).not.toHaveBeenCalled();
    c.view.unmount();
  });

  it("a plan has no No for Esc: the pane's Esc stays the deck's", () => {
    const c = card(PLAN);
    vi.advanceTimersByTime(ARM_MS);
    expect(c.key("Escape").defaultPrevented).toBe(false);
    expect(c.key("2").defaultPrevented).toBe(true);
    expect(c.recheck).toHaveBeenCalledWith({ kind: "option", index: 1 });
    c.view.unmount();
  });

  it("one answer at a time: a key while the pick is checked is held, not sent again", async () => {
    const c = card();
    vi.advanceTimersByTime(ARM_MS);
    c.key("1");
    expect(c.key("3").defaultPrevented, "held, so it does not reach the deck either").toBe(true);
    expect(c.recheck).toHaveBeenCalledOnce();
    await flush();
    // Sent: the card's question is settled; later keys are not the card's.
    expect(c.key("1").defaultPrevented).toBe(false);
    expect(c.recheck).toHaveBeenCalledOnce();
    c.view.unmount();
  });

  it("with Settings › Keyboard's single keys off, the digits are text again; Esc still answers No", () => {
    setSingleKeyShortcuts(false);
    const c = card();
    vi.advanceTimersByTime(ARM_MS);
    expect(c.key("1").defaultPrevented).toBe(false);
    expect(c.key("Escape").defaultPrevented).toBe(true);
    c.view.unmount();
  });

  it("names the keys on its rows: the digit, and Esc at the No; a plan's rows say no Esc", () => {
    const c = card();
    const rows = all(c.view.tree, el => el.type === DecisionOption);
    expect(rows.map(r => r.props.escKey)).toEqual([false, false, true]);
    const drawn = (props: Record<string, unknown>) => mount(DecisionOption, props as never).tree;
    const no = drawn(rows[2].props);
    expect(one(no, el => el.props.role === "radio")!.props["aria-keyshortcuts"]).toBe("3 Escape");
    expect(one(no, el => el.props.className === "dc-esc")!.props["aria-hidden"]).toBe("true");
    expect(one(drawn(rows[0].props), el => el.props.className === "dc-esc")).toBeNull();
    expect(one(drawn({ ...rows[2].props, singleKeys: false }), el => el.props.role === "radio")!.props["aria-keyshortcuts"]).toBe("Escape");
    expect(one(drawn({ ...rows[2].props, readOnly: true }), el => el.props.className === "dc-esc")).toBeNull();
    c.view.unmount();
    const plan = card(PLAN);
    expect(all(plan.view.tree, el => el.type === DecisionOption).map(r => r.props.escKey)).toEqual([false, false, false]);
    plan.view.unmount();
  });
});

describe("the machine's Esc and the pane's keys", () => {
  const ctx = { model: ASK, canRecheck: true };

  it("cancelRow is the No that can be answered from here", () => {
    expect(cancelRow(ASK)).toBe(2);
    expect(cancelRow(PLAN)).toBe(-1);
    expect(cancelRow({ ...ASK, options: ASK.options.map(o => (o.cancel ? { ...o, locked: true } : o)) })).toBe(-1);
    expect(cancelRow({ ...ASK, options: ASK.options.map(o => (o.cancel ? { ...o, free: true } : o)) })).toBe(-1);
  });

  it("Esc on the card picks the No as a row press does; with none it closes, answering nothing", () => {
    const picked = step(initialState(ASK), { type: "escape" }, ctx);
    expect(picked.state.closed).toBeFalsy();
    expect(picked.effects).toContainEqual({ type: "recheck", answer: { kind: "option", index: 2 } });
    const closed = step(initialState(PLAN), { type: "escape" }, { model: PLAN, canRecheck: true });
    expect(closed.state.closed).toBe(true);
    expect(closed.effects).toEqual([{ type: "close" }]);
  });

  it("paneKeyEvent: digits and Esc only, never a chord", () => {
    expect(paneKeyEvent({ key: "1" }, true, ASK)).toEqual({ type: "pick", index: 0 });
    expect(paneKeyEvent({ key: "3" }, true, ASK)).toEqual({ type: "pick", index: 2 });
    expect(paneKeyEvent({ key: "4" }, true, ASK)).toBeNull();
    expect(paneKeyEvent({ key: "1" }, false, ASK)).toBeNull();
    expect(paneKeyEvent({ key: "1", ctrlKey: true }, true, ASK)).toBeNull();
    expect(paneKeyEvent({ key: "Escape" }, false, ASK)).toEqual({ type: "pick", index: 2 });
    expect(paneKeyEvent({ key: "Escape" }, true, PLAN)).toBeNull();
    expect(paneKeyEvent({ key: "Enter" }, true, ASK)).toBeNull();
    expect(paneKeyEvent({ key: "ArrowDown" }, true, ASK)).toBeNull();
  });
});

describe("the question card from the pane", () => {
  type AskTurn = Extract<ChatTurn, { kind: "ask" }>;
  const q = (question: string, labels: string[], extra: Partial<ChatQuestion> = {}): ChatQuestion => ({
    header: "", question, multi: false, options: labels.map(label => ({ label, description: "" })), ...extra,
  });
  const DB = q("Which database?", ["Postgres", "SQLite", "DynamoDB"]);
  const HOST = q("Where does it run?", ["Fly", "Render"]);

  function ask(...questions: ChatQuestion[]) {
    const s = stage();
    const send = vi.fn<ChatAsk["send"]>(async () => "sent");
    const turn: AskTurn = { kind: "ask", questions, running: true };
    const view = mount(AskCard, { turn, ask: { send } }, { commit: attach(el => el.type === "section", s.card) });
    return { ...s, view, send };
  }

  it("each digit answers the next question; the last one sends", async () => {
    const a = ask(DB, HOST);
    expect(all(a.view.tree, el => el.props.className === "chat-ask-n chat-ask-key").map(el => el.props.children)).toEqual([1, 2, 3, 1, 2]);
    vi.advanceTimersByTime(ARM_MS);
    expect(a.key("3").defaultPrevented).toBe(true);
    expect(a.send).not.toHaveBeenCalled();
    expect(a.key("3").defaultPrevented, "Render has no third option").toBe(false);
    expect(a.key("2", replyBox("")).defaultPrevented).toBe(true);
    await flush();
    expect(a.send).toHaveBeenCalledWith([DB, HOST], [{ options: [2] }, { options: [1] }]);
    // Sent: the card is answered, the digits are no longer its.
    expect(a.key("1").defaultPrevented).toBe(false);
    a.view.unmount();
  });

  it("not in its first ARM_MS, not with a word in the box, and Esc is never its", () => {
    const a = ask(DB);
    expect(a.key("1").defaultPrevented).toBe(false);
    vi.advanceTimersByTime(ARM_MS);
    expect(a.key("1", replyBox("1")).defaultPrevented).toBe(false);
    expect(a.key("Escape").defaultPrevented).toBe(false);
    expect(a.send).not.toHaveBeenCalled();
    a.view.unmount();
  });

  it("a card with a several-answers question is answered on the card", () => {
    const a = ask(DB, q("Which features?", ["Search", "Export"], { multi: true }));
    vi.advanceTimersByTime(ARM_MS);
    expect(a.key("1").defaultPrevented).toBe(false);
    expect(all(a.view.tree, el => el.props.className === "chat-ask-n chat-ask-key")).toHaveLength(0);
    a.view.unmount();
  });

  it("askTakesDigits and askDigitPicks", () => {
    expect(askTakesDigits([DB, HOST])).toBe(true);
    expect(askTakesDigits([])).toBe(false);
    expect(askTakesDigits([q("Name?", [])])).toBe(false);
    expect(askDigitPicks([DB, HOST], [{ options: [] }, { options: [] }], 1)).toEqual([{ options: [1] }, { options: [] }]);
    expect(askDigitPicks([DB, HOST], [{ options: [0] }, { options: [] }], 0)).toEqual([{ options: [0] }, { options: [0] }]);
    expect(askDigitPicks([DB, HOST], [{ options: [0] }, { options: [1] }], 0)).toBeNull();
    expect(askDigitPicks([DB], [{ options: [] }], 3)).toBeNull();
    // An answer typed in "Other" counts as an answer.
    expect(askDigitPicks([DB, HOST], [{ options: [], text: "MySQL" }, { options: [] }], 0)).toEqual([{ options: [], text: "MySQL" }, { options: [0] }]);
  });
});

describe("the keys the deck names while a card is up", () => {
  const Reader = () => ({ keys: useScreenKeys() });

  it("the sheet's group while a card is up; the status bar's layer only with the focus in its pane", () => {
    const view = mount(Reader, {});
    expect((view.tree as { keys: unknown }).keys).toBeNull();
    const owner = {};
    showScreenKeys(owner, { group: decisionKeyGroup(true) });
    expect((view.tree as { keys: { group: { id: string }; status?: unknown } }).keys.group.id).toBe("decision");
    expect((view.tree as { keys: { status?: unknown } }).keys.status).toBeUndefined();
    const other = {};
    showScreenKeys(other, { group: decisionKeyGroup(true), status: decisionStatusView(true) });
    showScreenKeys(owner, { group: decisionKeyGroup(false) });
    expect((view.tree as { keys: { status?: { layer: string } } }).keys.status?.layer, "the one with the focus wins").toBe("decision");
    showScreenKeys(other, null);
    showScreenKeys(owner, null);
    expect((view.tree as { keys: unknown }).keys).toBeNull();
    view.unmount();
  });

  it("drops the digits' row with the single keys off", () => {
    expect(decisionKeyGroup(true).rows.map(r => r.cap)).toEqual(["1 – 9", "Esc", "↑ ↓ Tab", "↵"]);
    expect(decisionKeyGroup(false).rows.map(r => r.cap)).toEqual(["Esc", "↑ ↓ Tab", "↵"]);
    expect(decisionStatusView(false).hints.map(h => h.word)).toEqual(["no", "move", "send"]);
  });

  it("speaks the reader's language", () => {
    setLanguage("ro");
    const group = decisionKeyGroup(true);
    expect(group.title).toBe("Întrebarea din Chat");
    expect(group.rows[1].action).toBe("Răspunde Nu la o cerere de permisiune, la fel");
    const status = decisionStatusView(true);
    expect(status.label).toBe("Taste pentru întrebare");
    expect(status.hints.map(h => h.word)).toEqual(["alege", "nu", "mută", "trimite"]);
    expect(status.hints[0].caps[0].spoken).toBe("1 până la 9");
  });
});

describe("every new word in all ten languages", () => {
  const boards = AREA_FILES.filter(a => a.area === "board");
  const en = boards.find(b => b.code === "en")!.catalog;
  const keys = Object.keys(en).filter(k => k.startsWith("board.chat.compose."));
  const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

  it("has the block, one contiguous run after board.chat.noTranscript", () => {
    // Other Chat blocks (rich content, live words) sit between it and
    // noTranscript; what holds is that this one is whole, in English's order.
    expect(keys.length).toBeGreaterThanOrEqual(33);
    for (const { code, catalog } of boards) {
      const order = Object.keys(catalog);
      const after = order.indexOf("board.chat.noTranscript");
      const at = order.indexOf(keys[0]);
      expect(after, code).toBeGreaterThan(-1);
      expect(at, code).toBeGreaterThan(after);
      expect(order.slice(at, at + keys.length), code).toEqual(keys);
    }
  });

  it("each key worded in each language, with the same slots", () => {
    for (const { code, catalog } of boards) {
      for (const key of keys) {
        const text = catalog[key];
        expect(typeof text === "string" && text.trim() !== "", `${code}: ${key}`).toBe(true);
        expect(slots(text), `${code}: ${key}`).toEqual(slots(en[key]));
      }
    }
  });
});
