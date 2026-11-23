import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatComposer, { type ChatComposerProps } from "../components/chat/ChatComposer";
import { setLanguage } from "../i18n";
import { AREA_FILES } from "../i18n/catalogs";
import type { PromptSendResult } from "../use-terminal-session";
import { all, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => setLanguage("en"));
afterEach(() => { setLanguage("en"); vi.unstubAllGlobals(); });

function rig(initial: Partial<ChatComposerProps> = {}) {
  const onSend = vi.fn<ChatComposerProps["onSend"]>(() => "sent");
  const onChange = vi.fn((value: string) => { props = { ...props, value }; view.rerender(props); });
  let props: ChatComposerProps = { value: "hello", onSend, onChange, ...initial };
  const view = mount(ChatComposer, props);
  const element = (type: string) => one(view.tree, el => el.type === type)!;
  const invoke = (el: Drawn, name: string, event = {}) => (el.props[name] as (event: unknown) => void)(event);
  return {
    view, onSend, onChange, element,
    edit(value: string) { invoke(element("textarea"), "onChange", { currentTarget: { value } }); },
    rerender(next: Partial<ChatComposerProps>) { props = { ...props, ...next }; view.rerender(props); },
    submit() { const preventDefault = vi.fn(); invoke(element("form"), "onSubmit", { preventDefault }); return preventDefault; },
    key(extra = {}) {
      const event = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
        nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault: vi.fn(), ...extra };
      invoke(element("textarea"), "onKeyDown", event);
      return event;
    },
    composition(active: boolean) { invoke(element("textarea"), active ? "onCompositionStart" : "onCompositionEnd"); },
    status: () => one(view.tree, el => el.props.role === "status")!,
    send: () => one(view.tree, el => el.props.type === "submit")!,
    term: () => one(view.tree, el => el.props.className === "chat-composer-term"),
  };
}

describe("ChatComposer controlled drafts", () => {
  it("reports edits to its owner and follows externally restored drafts", () => {
    const r = rig();
    r.edit("a reply\nwith a second line");
    expect(r.onChange).toHaveBeenLastCalledWith("a reply\nwith a second line");
    expect(r.element("textarea").props.value).toBe("a reply\nwith a second line");
    r.rerender({ value: "restored draft" });
    expect(r.element("textarea").props.value).toBe("restored draft");
    expect(r.onSend).not.toHaveBeenCalled();
    r.view.unmount();
  });

  // CHANGED ON PURPOSE (Chat says where a sent message stands): "sent" is the
  // terminal taking the keys, not the agent taking the message, and it stayed
  // under the input after the reply. The composer now says nothing for it;
  // the message shows under the conversation as "Sending…" until the session
  // takes it (chat-progress.test.ts, chat-progress-view.test.ts).
  it("sends the exact draft synchronously and clears it only after sent", () => {
    const r = rig({ value: "  preserve spacing\nand lines  " });
    expect(r.submit()).toHaveBeenCalledOnce();
    expect(r.onSend).toHaveBeenCalledOnce();
    expect(r.onSend).toHaveBeenCalledWith("  preserve spacing\nand lines  ");
    expect(r.onChange).toHaveBeenCalledOnce();
    expect(r.onChange).toHaveBeenCalledWith("");
    expect(r.element("textarea").props.value).toBe("");
    expect(r.status().props["data-result"]).toBe("sent");
    expect(textOf(r.status()), "a send is not a delivery: the composer claims nothing").toBe("");
    expect(r.status().props["aria-live"]).toBe("polite");
    r.edit("next message");
    expect(textOf(r.status())).toBe("");
    r.view.unmount();
  });

  it.each<PromptSendResult>(["unavailable", "too-large", "partial", "empty"])("preserves the draft on %s, and clears feedback on draft changes", outcome => {
    const r = rig();
    r.onSend.mockReturnValue(outcome);
    r.submit();
    expect(r.onChange).not.toHaveBeenCalled();
    expect(r.element("textarea").props.value).toBe("hello");
    expect(r.status().props["data-result"]).toBe(outcome);
    expect(textOf(r.status())).not.toBe("");
    r.rerender({ value: "updated elsewhere" });
    expect(textOf(r.status())).toBe("");
    r.rerender({ value: "hello" });
    expect(textOf(r.status()), "old feedback must not return with an old draft").toBe("");
    r.view.unmount();
  });

  it("warns about a partial paste and offers a separate Show Term action", () => {
    const onShowTerm = vi.fn();
    const r = rig({ onShowTerm });
    r.onSend.mockReturnValue("partial");
    r.submit();
    expect(textOf(r.status())).toMatch(/may be pasted.*not been submitted.*Check Term before sending again/);
    expect(textOf(r.term())).toBe("Show Term");
    (r.term()!.props.onClick as () => void)();
    expect(onShowTerm).toHaveBeenCalledOnce();
    expect(r.onSend).toHaveBeenCalledOnce();
    expect(r.onChange).not.toHaveBeenCalled();
    r.edit("revised message");
    expect(r.term()).toBeNull();
    r.view.unmount();
  });

  it("preserves the draft and gives recovery feedback if the transport throws", () => {
    const r = rig({ onShowTerm: vi.fn() });
    r.onSend.mockImplementation(() => { throw new Error("socket closed"); });
    expect(() => r.submit()).not.toThrow();
    expect(r.onChange).not.toHaveBeenCalled();
    expect(r.element("textarea").props.value).toBe("hello");
    expect(textOf(r.status())).toContain("Your draft is kept; check Term");
    expect(textOf(r.term())).toBe("Show Term");
    r.view.unmount();
  });
});

describe("ChatComposer resizing", () => {
  it("resizes for draft changes and width changes, ignores height notifications, and disconnects", () => {
    const observations: Array<{ notify: (entries: unknown[]) => void; disconnect: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal("ResizeObserver", class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(notify: (entries: unknown[]) => void) { observations.push({ notify, disconnect: this.disconnect }); }
    });
    const measure = vi.fn(() => 100);
    const parentElement = { getBoundingClientRect: () => ({ width: 320 }) };
    const el = { style: { height: "" }, parentElement, get scrollHeight() { return measure(); } };
    const props = { value: "hello", onChange: vi.fn(), onSend: () => "sent" as const };
    const view = mount(ChatComposer, props, { commit: tree => {
      const input = one(tree, node => node.type === "textarea")!;
      (input.ref as { current: unknown }).current = el;
    } });
    expect(measure).toHaveBeenCalledOnce();
    observations[0].notify([{ contentRect: { width: 320, height: 300 } }]);
    expect(measure).toHaveBeenCalledOnce();
    observations[0].notify([{ contentRect: { width: 250, height: 300 } }]);
    expect(measure).toHaveBeenCalledTimes(2);
    observations[0].notify([{ contentRect: { width: 250, height: 400 } }]);
    expect(measure).toHaveBeenCalledTimes(2);
    view.rerender({ ...props, value: "new draft" });
    expect(measure).toHaveBeenCalledTimes(3);
    expect(observations[0].disconnect).toHaveBeenCalledOnce();
    view.unmount();
    expect(observations[1].disconnect).toHaveBeenCalledOnce();
  });
});

describe("ChatComposer keyboard and availability", () => {
  it("Enter sends; Shift+Enter keeps the native newline behavior", () => {
    const r = rig();
    expect(r.key({ shiftKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(r.onSend).not.toHaveBeenCalled();
    expect(r.key().preventDefault).toHaveBeenCalledOnce();
    expect(r.onSend).toHaveBeenCalledOnce();
    expect(r.onSend).toHaveBeenCalledWith("hello");
    r.view.unmount();
  });

  it("never sends during composition, including native IME and legacy 229 signals", () => {
    const r = rig();
    r.composition(true);
    expect(r.key().preventDefault).not.toHaveBeenCalled();
    r.submit();
    expect(r.onSend).not.toHaveBeenCalled();
    r.composition(false);
    r.key({ nativeEvent: { isComposing: true, keyCode: 13 } });
    r.key({ nativeEvent: { isComposing: false, keyCode: 229 } });
    expect(r.onSend).not.toHaveBeenCalled();
    r.key();
    expect(r.onSend).toHaveBeenCalledOnce();
    r.view.unmount();
  });

  it("does not resubmit partial text when Enter repeats", () => {
    const r = rig();
    r.onSend.mockReturnValue("partial");
    r.key();
    r.key({ repeat: true });
    expect(r.onSend).toHaveBeenCalledOnce();
    expect(r.element("textarea").props.value).toBe("hello");
    r.view.unmount();
  });

  it.each(["", "  \n\t"])("disables Send for an empty draft (%j), guarding Enter and submission too", value => {
    const r = rig({ value });
    expect(r.send().props.disabled).toBe(true);
    r.key(); r.submit();
    expect(r.onSend).not.toHaveBeenCalled();
    r.view.unmount();
  });

  it("keeps unavailable drafts editable and describes why Send is disabled", () => {
    const r = rig({ unavailable: "This session is read-only.", onShowTerm: vi.fn() });
    expect(r.send().props.disabled).toBe(true);
    expect(r.element("textarea").props.disabled).toBeUndefined();
    expect(r.element("textarea").props.readOnly).toBeUndefined();
    expect(textOf(r.status())).toBe("This session is read-only.");
    r.edit("save for later");
    r.key(); r.submit();
    expect(r.onSend).not.toHaveBeenCalled();
    expect(r.onChange).toHaveBeenCalledOnce();
    expect(r.onChange).toHaveBeenCalledWith("save for later");
    r.rerender({ unavailable: undefined });
    expect(r.send().props.disabled).toBe(false);
    expect(r.element("textarea").props.value).toBe("save for later");
    expect(textOf(r.status())).toBe("");
    r.view.unmount();
  });
});

describe("ChatComposer localization and accessible descriptions", () => {
  it("labels the textarea and links its keyboard hint and live feedback", () => {
    const r = rig();
    const input = r.element("textarea");
    expect(r.element("label").props.htmlFor).toBe(input.props.id);
    const descriptions = (input.props["aria-describedby"] as string).split(" ");
    expect(descriptions).toHaveLength(2);
    for (const id of descriptions) expect(all(r.view.tree, el => el.props.id === id)).toHaveLength(1);
    r.view.unmount();
  });

  it("uses clear Romanian labels and partial-send feedback", () => {
    setLanguage("ro");
    const r = rig({ onShowTerm: vi.fn() });
    expect(textOf(r.send())).toBe("Trimite");
    expect(r.element("textarea").props.placeholder).toBe("Scrie un mesaj…");
    r.onSend.mockReturnValue("partial");
    r.submit();
    expect(textOf(r.status())).toContain("Verifică Term înainte să trimiți din nou.");
    r.view.unmount();
  });

  it("has every composer and availability key in all ten board catalogs", () => {
    const catalogs = AREA_FILES.filter(area => area.area === "board");
    expect(catalogs).toHaveLength(10);
    const keys = ["composer.reply", "composer.placeholder", "composer.send", "composer.hint", "composer.sent", "composer.partial",
      "composer.tooLarge", "composer.empty", "composer.unavailable", "connecting", "offline", "readOnly", "waiting"];
    for (const { code, catalog } of catalogs) {
      for (const key of keys) expect(catalog[`board.chat.${key}`], `${code}: ${key}`).toBeTruthy();
    }
  });
});
