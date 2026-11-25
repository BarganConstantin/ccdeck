// Interactive alerts, the seen half: which sessions get a card, what each card
// offers, and what its buttons, Esc and "+N more" do. Then the deck's side of
// a press from outside the page (a notification's button, the desktop app, a
// deck opened on #chat=<id>), which ends in the same intent and the same Open
// in Chat as a card's button.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";
import AlertStack, { ALERT_EXIT_MS, MAX_ALERT_CARDS, nextDrawn, type AlertStackProps } from "../components/alerts/AlertStack";
import { alertFor, alertQuestion, pendingCall, type AlertModel } from "../alert-model";
import { alertSessions, allowable, useChatAlerts, type ChatAlertsDeps } from "../use-chat-alerts";
import { answerIntents } from "../answer-intent";
import { hasViewToggle, requestChatView, resetChatViews, setShownInChat, shownInChatKey, toggleFocusedView } from "../chat-view-memory";
import { useChatPaneLinks, type ChatPaneLinks } from "../use-chat-pane-links";
import type { BlockedSession } from "../ambient-counts";
import type { GraphState } from "../graph-state";
import type { ToolCall } from "../types";
import { t } from "../i18n";

const T0 = 1_700_000_000_000;

function blocked(id: string, over: Partial<BlockedSession["waiting"]> = {}, name?: string): BlockedSession {
  return {
    id, label: id, ...(name ? { name } : null),
    waiting: { kind: "permission", message: "Claude needs your permission to use Bash", since: T0, tool: { name: "Bash", preview: "npm test" }, ...over },
  } as BlockedSession;
}

const call = (over: Partial<ToolCall>): ToolCall => ({ id: "c", name: "Bash", inputPreview: "", startedAt: T0 - 100, agentId: "s1", ...over });

describe("what an alert offers", () => {
  it("a permission prompt: Allow once (the Yes row) and Deny (the No row), for Claude", () => {
    const a = alertFor(blocked("s1"), { provider: "claude" });
    expect(a).toMatchObject({ kind: "permission", what: "Bash: npm test", detail: "npm test" });
    expect(a.choices.map(c => [c.text, c.label, c.index])).toEqual([
      [t("board.chat.alert.allowOnce"), "Yes", 0],
      [t("board.chat.alert.deny"), "No", null],
    ]);
  });

  it("nothing to answer for a provider whose prompt Chat does not read", () => {
    expect(alertFor(blocked("s1"), { provider: "codex" }).choices).toEqual([]);
  });

  it("a one-question single-choice question: one button per option", () => {
    const pending = call({ name: "AskUserQuestion", input: { questions: [{ question: "Which port?", multiSelect: false, options: [{ label: "4881" }, { label: "4882" }] }] } });
    const a = alertFor(blocked("s1", { kind: "asked", tool: { name: "AskUserQuestion", preview: "" } }), { provider: "claude", pending });
    expect(a).toMatchObject({ kind: "question", what: "Which port?" });
    expect(a.choices.map(c => [c.label, c.index, c.intent])).toEqual([["4881", 0, "question"], ["4882", 1, "question"]]);
  });

  it("several picks, several questions or too many options: Open in Chat alone", () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `o${i}` }));
    expect(alertQuestion({ questions: [{ question: "Q", multiSelect: true, options: opts(2) }] })?.options).toBeNull();
    expect(alertQuestion({ questions: [{ question: "Q", options: opts(2) }, { question: "R", options: opts(2) }] })?.options).toBeNull();
    expect(alertQuestion({ questions: [{ question: "Q", options: opts(5) }] })?.options).toBeNull();
    expect(alertQuestion({ questions: [{ question: "Q", options: opts(4) }] })?.options).toHaveLength(4);
    expect(alertQuestion({})).toBeNull();
  });

  it("a plan and anything else: Open in Chat alone", () => {
    const plan = alertFor(blocked("s1", { tool: { name: "ExitPlanMode", preview: "" } }), { provider: "claude" });
    expect(plan).toMatchObject({ kind: "plan", what: t("board.chat.alert.plan"), choices: [] });
    const idle = alertFor(blocked("s1", { kind: "idle", tool: undefined, message: "Waiting" }));
    expect(idle).toMatchObject({ kind: "other", what: "Waiting", choices: [] });
  });

  it("the call a prompt is about: the session's newest still in flight, not one started after it", () => {
    const owner = (id: string | undefined) => id;
    const calls = [
      call({ id: "old", startedAt: T0 - 500 }),
      call({ id: "new", startedAt: T0 - 50 }),
      call({ id: "ended", startedAt: T0 - 10, endedAt: T0 }),
      call({ id: "later", startedAt: T0 + 5000 }),
      call({ id: "other", agentId: "s2", startedAt: T0 - 1 }),
    ];
    expect(pendingCall(calls, owner, "s1", T0)?.id).toBe("new");
  });
});

describe("which sessions get a card", () => {
  it("blocks raised since the deck went live, not dismissed and not shown in Chat", () => {
    const waiting = [blocked("a"), blocked("b"), blocked("c"), blocked("d")];
    const seen = new Set(["a@" + T0]);
    const dismissed = new Set(["b@" + T0]);
    expect(alertSessions(waiting, seen, dismissed, new Set(["c"])).map(b => b.id)).toEqual(["d"]);
    expect(alertSessions(waiting, null, new Set(), new Set())).toEqual([]);
  });

  it("an Allow once from outside is only for the permission prompt still standing", () => {
    const waiting = [blocked("s1"), blocked("s2", { kind: "asked" })];
    expect(allowable({ sessionId: "s1", action: "allow" }, waiting)?.id).toBe("s1");
    expect(allowable({ sessionId: "s1", action: "allow", since: T0 }, waiting)?.id).toBe("s1");
    expect(allowable({ sessionId: "s1", action: "allow", since: T0 - 1 }, waiting)).toBeNull();
    expect(allowable({ sessionId: "s1", action: "open" }, waiting)).toBeNull();
    expect(allowable({ sessionId: "s2", action: "allow" }, waiting)).toBeNull();
    expect(allowable({ sessionId: "gone", action: "allow" }, waiting)).toBeNull();
  });
});

describe("the alert stack", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", globalThis); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const permission = alertFor(blocked("s1", {}, "api"), { provider: "claude" });
  const question = alertFor(blocked("s2", { kind: "asked", tool: { name: "AskUserQuestion", preview: "" } }, "web"), {
    provider: "claude",
    pending: call({ name: "AskUserQuestion", agentId: "s2", input: { questions: [{ question: "Which port?", options: [{ label: "4881" }, { label: "4882" }] }] } }),
  });
  const plan = alertFor(blocked("s3", { tool: { name: "ExitPlanMode", preview: "" } }, "docs"), { provider: "claude" });

  function stack(over: Partial<AlertStackProps> = {}) {
    const props: AlertStackProps = {
      alerts: [permission, question, plan], canChat: true, said: "",
      onAnswer: vi.fn(), onOpen: vi.fn(), onDismiss: vi.fn(), onMore: vi.fn(), ...over,
    };
    return { m: mount(AlertStack, props), props };
  }
  const cls = (name: string) => (el: Drawn) => typeof el.props.className === "string" && el.props.className.split(" ").includes(name);
  const cards = (tree: unknown) => all(tree, cls("ca-card"));
  const buttons = (card: Drawn) => all(card, el => el.type === "button").map(b => textOf(b));

  it("draws a card per session with its answers and Open", () => {
    const { m } = stack();
    const [p, q, pl] = cards(m.tree);
    expect(textOf(one(p, cls("ca-name")))).toBe("api");
    expect(textOf(one(p, cls("ca-what")))).toBe("Bash: npm test");
    expect(buttons(p).slice(1)).toEqual([t("board.chat.alert.allowOnce"), t("board.chat.alert.deny"), t("board.chat.alert.open")]);
    expect(one(p, cls("primary"))).not.toBeNull();
    expect(buttons(q).slice(1)).toEqual(["4881", "4882", t("board.chat.alert.open")]);
    expect(buttons(pl).slice(1)).toEqual([t("board.chat.alert.openInChat")]);
  });

  it("presses go to the card's alert and choice", () => {
    const { m, props } = stack();
    const [p, q] = cards(m.tree);
    (all(p, cls("ca-answer"))[0].props.onClick as () => void)();
    expect(props.onAnswer).toHaveBeenCalledWith(permission, permission.choices[0]);
    (all(q, cls("ca-answer"))[1].props.onClick as () => void)();
    expect(props.onAnswer).toHaveBeenLastCalledWith(question, question.choices[1]);
    (one(q, cls("ca-open"))!.props.onClick as () => void)();
    expect(props.onOpen).toHaveBeenCalledWith(question);
    (one(p, cls("ca-close"))!.props.onClick as () => void)();
    expect(props.onDismiss).toHaveBeenCalledWith(permission);
  });

  it("without Chat to open, only Open, which goes to the session", () => {
    const { m } = stack({ canChat: false });
    for (const c of cards(m.tree)) expect(all(c, cls("ca-answer"))).toEqual([]);
    expect(buttons(cards(m.tree)[0]).slice(1)).toEqual([t("board.chat.alert.open")]);
  });

  it("Esc inside a card dismisses that card and goes no further", () => {
    const { m, props } = stack();
    const card = cards(m.tree)[1];
    const e = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { nextElementSibling: null, previousElementSibling: null } };
    (card.props.onKeyDown as (e: unknown) => void)(e);
    expect(props.onDismiss).toHaveBeenCalledWith(question);
    expect(e.stopPropagation).toHaveBeenCalled();
    (card.props.onKeyDown as (e: unknown) => void)({ ...e, key: "Enter" });
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("three cards at most, then +N more, which opens the waiting queue", () => {
    const extra = [blocked("s4"), blocked("s5")].map(b => alertFor(b));
    const { m, props } = stack({ alerts: [permission, question, plan, ...extra] });
    expect(cards(m.tree)).toHaveLength(MAX_ALERT_CARDS);
    const more = one(m.tree, cls("ca-more"))!;
    expect(textOf(more)).toBe(t("board.chat.alert.more", { n: 2 }));
    (more.props.onClick as () => void)();
    expect(props.onMore).toHaveBeenCalled();
  });

  it("a card whose wait ended leaves: marked, hidden from the reader, then gone", () => {
    const { m, props } = stack();
    m.rerender({ ...props, alerts: [question, plan] });
    const leaving = cards(m.tree)[0];
    expect(leaving.props["data-leaving"]).toBe(true);
    expect(leaving.props["aria-hidden"]).toBe(true);
    expect(leaving.props.onKeyDown).toBeUndefined();
    vi.advanceTimersByTime(ALERT_EXIT_MS);
    expect(cards(m.tree).map(c => textOf(one(c, cls("ca-name"))))).toEqual(["web", "docs"]);
  });

  it("says who needs you in a polite live region, and names the region", () => {
    const { m } = stack({ said: "api needs you: Bash: npm test" });
    const live = one(m.tree, el => el.props.role === "status")!;
    expect(live.props["aria-live"]).toBe("polite");
    expect(textOf(live)).toBe("api needs you: Bash: npm test");
    expect(one(m.tree, cls("ca-stack"))!.props["aria-label"]).toBe(t("board.chat.alert.region"));
    expect(one(cards(m.tree)[0], cls("ca-close"))!.props["aria-label"]).toBe(t("board.chat.alert.dismiss", { name: "api" }));
  });

  it("keeps a card in its place when the list moves", () => {
    const drawn = nextDrawn([], [permission, question]);
    expect(nextDrawn(drawn, [question, plan]).map(d => [d.alert.sessionId, d.leaving])).toEqual([["s1", true], ["s2", false], ["s3", false]]);
  });
});

describe("the deck's side: cards, and presses from outside the page", () => {
  type Listener = (e: { data: unknown }) => void;
  let swListener: Listener | null = null;
  let deskPoke: (() => void) | null = null;
  let deskHeld: unknown[] = [];
  const replaceState = vi.fn();

  function state(ids: string[]): GraphState {
    return { agents: new Map(ids.map(id => [id, { sessionId: id, provider: "claude" }])), toolIndex: new Map() } as unknown as GraphState;
  }

  beforeEach(() => {
    resetChatViews();
    for (const id of ["s1", "s2", "s3"]) answerIntents.drop(id);
    swListener = null;
    deskPoke = null;
    deskHeld = [];
    replaceState.mockReset();
    vi.stubGlobal("window", {
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState },
      ccdeckSession: { take: () => Promise.resolve(deskHeld.shift() ?? null) },
      addEventListener: (type: string, fn: () => void) => { if (type === "ccdeck:session-held") deskPoke = fn; },
      removeEventListener: (type: string) => { if (type === "ccdeck:session-held") deskPoke = null; },
      setTimeout, clearTimeout,
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        addEventListener: (_: string, l: Listener) => { swListener = l; },
        removeEventListener: () => { swListener = null; },
      },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); resetChatViews(); });

  function deck(over: Partial<ChatAlertsDeps> = {}) {
    const props: ChatAlertsDeps = {
      waitingSessions: [], stateRef: { current: state(["s1", "s2"]) }, liveSince: T0,
      openInChat: vi.fn(), focusSession: vi.fn(), ...over,
    };
    const m = mount((p: ChatAlertsDeps) => useChatAlerts(p), props);
    const api = () => m.tree as ReturnType<typeof useChatAlerts>;
    return { m, props, api };
  }

  it("cards only what began waiting after the deck went live, and not what Chat shows", () => {
    const standing = blocked("s1");
    const { m, props, api } = deck({ waitingSessions: [standing] });
    expect(api().alerts).toEqual([]);
    m.rerender({ ...props, waitingSessions: [standing, blocked("s2", { since: T0 + 5 })] });
    expect(api().alerts.map(a => a.sessionId)).toEqual(["s2"]);
    expect(api().said).toContain("s2");
    setShownInChat({}, "s2");
    m.rerender();
    expect(api().alerts).toEqual([]);
  });

  it("a card's answer holds an intent and opens the session in Chat; Open answers nothing", () => {
    const { m, props, api } = deck();
    m.rerender({ ...props, waitingSessions: [blocked("s1", { since: T0 + 1 })] });
    const alert = api().alerts[0] as AlertModel;
    api().answer(alert, alert.choices[0]);
    expect(answerIntents.peek("s1")).toMatchObject({ choiceLabel: "Yes", choiceIndex: 0, since: T0 + 1, detail: "npm test" });
    expect(props.openInChat).toHaveBeenCalledWith("s1");
    answerIntents.drop("s1");
    api().open(alert);
    expect(answerIntents.peek("s1")).toBeNull();
    expect(props.openInChat).toHaveBeenCalledTimes(2);
  });

  it("dismissing hides the card until that block ends", () => {
    const { m, props, api } = deck();
    m.rerender({ ...props, waitingSessions: [blocked("s1", { since: T0 + 1 })] });
    api().dismiss(api().alerts[0]);
    expect(api().alerts).toEqual([]);
  });

  it("a notification's Allow once becomes the same intent; its body only opens", () => {
    const { m, props } = deck({ waitingSessions: [blocked("s1", { since: T0 + 1 })] });
    swListener!({ data: { type: "ccdeck:notification", sessionId: "s1", action: "allow", since: T0 + 1 } });
    expect(answerIntents.peek("s1")).toMatchObject({ kind: "permission", choiceLabel: "Yes", choiceIndex: 0, detail: "npm test" });
    expect(props.openInChat).toHaveBeenCalledWith("s1");
    answerIntents.drop("s1");
    // Another block than the notification named: opened, not answered.
    swListener!({ data: { type: "ccdeck:notification", sessionId: "s1", action: "allow", since: T0 - 99 } });
    expect(answerIntents.peek("s1")).toBeNull();
    // Not ours, or not a session id: nothing.
    swListener!({ data: { type: "other", sessionId: "s1" } });
    swListener!({ data: { type: "ccdeck:notification", sessionId: "../x", action: "allow" } });
    expect(props.openInChat).toHaveBeenCalledTimes(2);
    m.unmount();
    expect(swListener).toBeNull();
  });

  it("a finished turn's press goes to the session, not to Chat", () => {
    const { props } = deck();
    swListener!({ data: { type: "ccdeck:notification", sessionId: "s2", kind: "finished", action: "open" } });
    expect(props.focusSession).toHaveBeenCalledWith("s2");
    expect(props.openInChat).not.toHaveBeenCalled();
  });

  it("a deck opened on #chat=<id> opens it once the session is known, and clears the link", () => {
    (window as unknown as { location: { hash: string } }).location.hash = "#chat=s3";
    const { m, props } = deck();
    expect(replaceState).toHaveBeenCalled();
    expect(props.openInChat).not.toHaveBeenCalled();
    props.stateRef.current = state(["s1", "s2", "s3"]);
    m.rerender();
    expect(props.openInChat).toHaveBeenCalledWith("s3");
  });

  it("the desktop app's notification and tray rows open the session in Chat", async () => {
    deskHeld = ["s1"];
    const { m, props } = deck();
    await flush();
    expect(props.openInChat).toHaveBeenCalledWith("s1");
    deskHeld = ["s2"];
    deskPoke!();
    await flush();
    expect(props.openInChat).toHaveBeenLastCalledWith("s2");
    deskHeld = ["not a session id"];
    deskPoke!();
    await flush();
    expect(props.openInChat).toHaveBeenCalledTimes(2);
    m.unmount();
    expect(deskPoke).toBeNull();
  });
});

describe("a pane, asked to show its session in Chat", () => {
  beforeEach(() => { resetChatViews(); vi.stubGlobal("window", {}); });
  afterEach(() => { resetChatViews(); vi.unstubAllGlobals(); });

  function pane(over: Partial<ChatPaneLinks> = {}) {
    const props: ChatPaneLinks = { chatSession: "s1", chatOn: false, focused: true, showChat: vi.fn(), toggle: vi.fn(), ...over };
    return { m: mount((p: ChatPaneLinks) => useChatPaneLinks(p), props), props };
  }

  it("switches to Chat for its own session only", () => {
    const { props } = pane();
    requestChatView("s2");
    expect(props.showChat).not.toHaveBeenCalled();
    requestChatView("s1");
    expect(props.showChat).toHaveBeenCalledTimes(1);
  });

  it("takes the chord while focused, and says when it shows its session in Chat", () => {
    const { m, props } = pane();
    expect(toggleFocusedView()).toBe(true);
    expect(props.toggle).toHaveBeenCalledTimes(1);
    expect(shownInChatKey()).toBe("");
    m.rerender({ ...props, chatOn: true });
    expect(shownInChatKey()).toBe("s1");
    m.rerender({ ...props, chatOn: true, focused: false });
    expect(hasViewToggle()).toBe(false);
    m.unmount();
    expect(shownInChatKey()).toBe("");
  });
});
