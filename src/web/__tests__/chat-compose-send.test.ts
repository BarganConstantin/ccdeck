// A message sent from the composer, until the session takes it: drawn at the
// end of the conversation as an outline bubble that says "Sending…", or that
// it is queued behind the turn at work; one the session did not take goes
// back into an empty box with the reason, once; taken after all, it leaves
// the box. And the box itself: one line to ten, eased, never with reduced
// motion; Send is Stop while nothing is typed and Claude Code works.
//
// The stage's half (TerminalStage holding it all) is in chat-stage-reply.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatComposer, { type ChatComposerProps } from "../components/chat/ChatComposer";
import { OutgoingMessage } from "../components/chat/ChatTurn";
import type { ChatOutgoing } from "../components/chat/chat-model";
import { CONFIRM_MS, chatShown, pendingFor, settlePending, type ChatFacts } from "../chat-progress";
import { setLanguage } from "../i18n";
import { AREA_FILES } from "../i18n/catalogs";
import { useChatReturned } from "../use-chat-returned";
import type { AskSendResult } from "../use-terminal-session";
import { flush, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => setLanguage("en"));
afterEach(() => { setLanguage("en"); vi.unstubAllGlobals(); });

const facts = (over: Partial<ChatFacts> = {}): ChatFacts => ({ turns: [], prompts: 3, state: "idle", connected: true, asked: false, ...over });

describe("the bubble's life (chat-progress)", () => {
  it("sent while the session works: queued, with no clock on it until that turn ends", () => {
    const at = 1_000;
    const pending = pendingFor("next one", facts({ state: "working" }), at);
    expect(pending.behind).toBe(true);
    const working = chatShown(pending, facts({ state: "working" }), at + CONFIRM_MS * 3);
    expect(working.outgoing).toEqual({ text: "next one", state: "sending", queued: true });
    // The turn ends: from now it is the session's to take, and no longer queued.
    const free = settlePending(pending, facts({ state: "idle" }), at + 50_000)!;
    expect(free).toMatchObject({ behind: false, since: at + 50_000 });
    const shown = chatShown(free, facts(), at + 50_000);
    expect(shown.outgoing).toEqual({ text: "next one", state: "sending" });
    expect(shown.next).toBe(at + 50_000 + CONFIRM_MS);
    expect(chatShown(free, facts(), at + 50_000 + CONFIRM_MS).outgoing).toEqual({ text: "next one", state: "unconfirmed" });
  });

  it("is never queued once it is late or the pane is gone, nor once taken", () => {
    const pending = pendingFor("x", facts({ state: "working" }), 0);
    expect(chatShown(pending, facts({ state: "working", connected: false }), 1).outgoing).toEqual({ text: "x", state: "unconfirmed" });
    expect(chatShown(pending, facts({ state: "working", prompts: 4 }), 1).outgoing).toEqual({ text: "x", state: "taken" });
  });

  it("sent to a free session: Sending…, not queued", () => {
    const pending = pendingFor("now", facts(), 0);
    expect(chatShown(pending, facts(), 1).outgoing).toEqual({ text: "now", state: "sending" });
  });
});

describe("the bubble", () => {
  const draw = (outgoing: ChatOutgoing, provider?: "claude" | "codex") => mount(OutgoingMessage, { outgoing, provider, onShowTerm: vi.fn() }).tree;
  const state = (tree: unknown) => one(tree, el => el.props.className === "chat-you-state");

  it("says Sending…, or queued behind the turn with the agent named, under your words", () => {
    const sending = draw({ text: "hi", state: "sending" });
    expect((sending as Drawn).props["data-outgoing"]).toBe("sending");
    expect(textOf(state(sending))).toBe("Sending…");
    expect(textOf(state(draw({ text: "hi", state: "sending", queued: true })))).toBe("Queued. Claude Code takes it when this turn ends.");
    expect(textOf(state(draw({ text: "hi", state: "sending", queued: true }, "codex")))).toBe("Queued. Codex takes it when this turn ends.");
  });

  it("says nothing more once taken", () => {
    const taken = draw({ text: "hi", state: "taken" });
    expect((taken as Drawn).props["data-outgoing"]).toBe("taken");
    expect(state(taken)).toBeNull();
  });

  it("is an outline until the session takes it (chat-composer.css)", () => {
    const css = readFileSync(join(__dirname, "../components/chat/chat-composer.css"), "utf8");
    expect(css).toMatch(/\.chat-you:is\(\[data-outgoing="sending"\], \[data-outgoing="unconfirmed"\]\) \.chat-you-text \{[^}]*outline: 1px dashed var\(--ctl-edge\)/);
  });
});

describe("words the session did not take (useChatReturned)", () => {
  type HostProps = { session: string; outgoing?: ChatOutgoing; draft: string; setDraft: (text: string) => void };
  const Host = (p: HostProps) => useChatReturned(p.session, p.outgoing, p.draft, p.setDraft);
  // The stage's draft, as the stage holds it: what setDraft writes is the
  // draft the next render reads, rendered again until it settles.
  function host(start: Omit<HostProps, "setDraft">) {
    let props: HostProps = { ...start, setDraft: vi.fn((text: string) => { props = { ...props, draft: text }; }) };
    const view = mount(Host, props);
    const settle = () => {
      for (let i = 0; i < 5; i++) {
        const before = props;
        view.rerender(props);
        if (props === before) return;
      }
      throw new Error("the draft never settled");
    };
    settle();
    return {
      get shown() { return view.tree as ReturnType<typeof useChatReturned>; },
      get props() { return props; },
      set(over: Partial<HostProps>) { props = { ...props, ...over }; settle(); },
    };
  }

  it("leaves a message on its way alone", () => {
    const h = host({ session: "claude:a", outgoing: { text: "hi", state: "sending" }, draft: "" });
    expect(h.shown).toEqual({ outgoing: { text: "hi", state: "sending" }, text: undefined });
    expect(h.props.setDraft).not.toHaveBeenCalled();
  });

  it("late with the box empty: back in the box, and no longer drawn under the conversation", () => {
    const h = host({ session: "claude:a", outgoing: { text: "hi", state: "sending" }, draft: " " });
    h.set({ outgoing: { text: "hi", state: "unconfirmed" } });
    expect(h.props.setDraft).toHaveBeenCalledOnce();
    expect(h.props.draft).toBe("hi");
    expect(h.shown).toEqual({ outgoing: undefined, text: "hi" });
  });

  it("late with a draft written since: the draft stays, the message stays drawn", () => {
    const h = host({ session: "claude:a", outgoing: { text: "hi", state: "unconfirmed" }, draft: "something new" });
    expect(h.props.setDraft).not.toHaveBeenCalled();
    expect(h.shown).toEqual({ outgoing: { text: "hi", state: "unconfirmed" }, text: undefined });
  });

  it("taken after all: the words leave the box, if they are still the box's", () => {
    const h = host({ session: "claude:a", outgoing: { text: "hi", state: "unconfirmed" }, draft: "" });
    expect(h.props.draft).toBe("hi");
    h.set({ outgoing: { text: "hi", state: "taken" } });
    expect(h.props.draft).toBe("");
    expect(h.shown).toEqual({ outgoing: { text: "hi", state: "taken" }, text: undefined });

    const edited = host({ session: "claude:a", outgoing: { text: "hi", state: "unconfirmed" }, draft: "" });
    edited.set({ draft: "hi, and more" });
    edited.set({ outgoing: { text: "hi", state: "taken" } });
    expect(edited.props.draft).toBe("hi, and more");
  });

  it("sent again from the box: the new send is drawn, the box is not touched", () => {
    const h = host({ session: "claude:a", outgoing: { text: "hi", state: "unconfirmed" }, draft: "" });
    const calls = (h.props.setDraft as ReturnType<typeof vi.fn>).mock.calls.length;
    h.set({ draft: "", outgoing: { text: "hi", state: "sending" } });
    expect((h.props.setDraft as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    expect(h.shown).toEqual({ outgoing: { text: "hi", state: "sending" }, text: undefined });
  });

  it("is each session's own", () => {
    const h = host({ session: "claude:a", outgoing: { text: "hi", state: "unconfirmed" }, draft: "" });
    expect(h.shown.text).toBe("hi");
    h.set({ session: "claude:b", outgoing: undefined, draft: "" });
    expect(h.shown).toEqual({ outgoing: undefined, text: undefined });
  });
});

describe("the composer says why the words are back", () => {
  function rig(initial: Partial<ChatComposerProps> = {}) {
    let props: ChatComposerProps = {
      value: "hi", notTaken: "hi", onShowTerm: vi.fn(),
      onSend: vi.fn<ChatComposerProps["onSend"]>(() => "sent"),
      onChange: vi.fn((value: string) => { props = { ...props, value }; view.rerender(props); }),
      ...initial,
    };
    const view = mount(ChatComposer, props);
    return {
      view, get props() { return props; },
      status: () => one(view.tree, el => el.props.role === "status")!,
      term: () => one(view.tree, el => el.props.className === "chat-composer-term"),
    };
  }

  it("once, under the box, with Show Term, while the box holds those words", () => {
    const r = rig();
    expect(textOf(r.status())).toBe("Claude Code didn’t take this message, so it’s back here. Check Term before you send it again.");
    expect(r.status().props["data-result"]).toBe("not-taken");
    expect(textOf(r.term())).toBe("Show Term");
    (r.term()!.props.onClick as () => void)();
    expect(r.props.onShowTerm).toHaveBeenCalledOnce();
    r.props.onChange("hi!");
    expect(textOf(r.status())).toBe("");
    expect(r.term()).toBeNull();
    r.view.unmount();
  });

  it("names the agent, and says nothing for other words in the box", () => {
    expect(textOf(rig({ provider: "codex" }).status())).toContain("Codex didn’t take this message");
    expect(textOf(rig({ value: "other" }).status())).toBe("");
    expect(textOf(rig({ notTaken: undefined }).status())).toBe("");
  });

  it("is said in every board language", () => {
    for (const { code, catalog } of AREA_FILES.filter(a => a.area === "board")) {
      for (const key of ["board.chat.compose.returned", "board.chat.compose.queued"]) {
        expect(catalog[key], `${code}: ${key}`).toContain("{agent}");
      }
    }
  });
});

describe("Send and Stop share one place", () => {
  it("a stop in flight keeps Stop drawn while a word is typed, then Send comes back", async () => {
    let finish: (r: AskSendResult) => void = () => {};
    const onStop = vi.fn(() => new Promise<AskSendResult>(resolve => { finish = resolve; }));
    let props: ChatComposerProps = {
      value: "", canStop: true, onStop, onSend: () => "sent",
      onChange: value => { props = { ...props, value }; view.rerender(props); },
    };
    const view = mount(ChatComposer, props);
    const stop = () => one(view.tree, el => el.props.className === "btn chat-composer-stop");
    const send = () => one(view.tree, el => el.props.type === "submit");
    expect(send()).toBeNull();
    (stop()!.props.onClick as () => void)();
    props.onChange("typed meanwhile");
    expect(stop()!.props.disabled).toBe(true);
    expect(send()).toBeNull();
    finish("sent");
    await flush();
    expect(stop()).toBeNull();
    expect(send()!.props.disabled).toBe(false);
    expect(onStop).toHaveBeenCalledOnce();
    view.unmount();
  });
});

describe("the box grows, one line to ten", () => {
  const css = readFileSync(join(__dirname, "../components/chat/chat-composer.css"), "utf8");

  it("up to ten lines, eased with the motion tokens, at once with reduced motion", () => {
    const draft = css.match(/\.chat-composer-draft \{[^}]*\}/)![0];
    expect(draft).toContain("max-height: calc(10lh + 22px);");
    expect(draft).toContain("transition: height var(--dur-fast) var(--ease);");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.chat-composer-draft \{ transition: none; \}/);
  });

  it("measures with the easing off, then eases from the height drawn to the new one", () => {
    const seen: string[] = [];
    const style = { height: "44px", transition: "height 120ms ease" };
    const el = {
      style, parentElement: { getBoundingClientRect: () => ({ width: 320 }) },
      get scrollHeight() { seen.push(`measure:${style.transition}:${style.height}`); return 66; },
      get offsetHeight() { seen.push(`flush:${style.transition}:${style.height}`); return 44; },
      setSelectionRange: vi.fn(),
    };
    const view = mount(ChatComposer, { value: "one\ntwo", onChange: vi.fn(), onSend: () => "sent" as const }, { commit: tree => {
      ((one(tree, node => node.type === "textarea")!.ref) as { current: unknown }).current = el;
    } });
    expect(seen).toEqual(["measure:none:auto", "flush:none:44px"]);
    expect(style).toEqual({ height: "66px", transition: "height 120ms ease" });
    view.unmount();
  });

  it("does not measure again on the observer's first report, which would cut the easing short", () => {
    const observers: Array<(entries: unknown[]) => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn(); disconnect = vi.fn();
      constructor(notify: (entries: unknown[]) => void) { observers.push(notify); }
    });
    const measure = vi.fn(() => 66);
    const el = { style: { height: "", transition: "" }, parentElement: { getBoundingClientRect: () => ({ width: 340 }) }, get scrollHeight() { return measure(); } };
    const view = mount(ChatComposer, { value: "one", onChange: vi.fn(), onSend: () => "sent" as const }, { commit: tree => {
      ((one(tree, node => node.type === "textarea")!.ref) as { current: unknown }).current = el;
    } });
    expect(measure).toHaveBeenCalledOnce();
    // The content box the observer reports is narrower than the border box measured at.
    observers[0]([{ contentRect: { width: 320, height: 40 } }]);
    expect(measure).toHaveBeenCalledOnce();
    observers[0]([{ contentRect: { width: 280, height: 40 } }]);
    expect(measure).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});
