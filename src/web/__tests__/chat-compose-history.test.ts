// The composer's history: Up on the first line brings back what was sent to
// this session, newest first, and Down walks back to the draft that was being
// written. The caret decides, so an arrow in the middle of the text still
// moves it. Kept per session in the store (storage.ts), capped.
//
// Drawn under the suite's stand-in React (fake-react.ts): the component runs
// itself, and a key is its handler called with what the browser would hand it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatComposer, { type ChatComposerProps } from "../components/chat/ChatComposer";
import {
  CHAT_HISTORY_KEY, HISTORY_CAP, HISTORY_SESSIONS, HISTORY_TEXT_CAP, historyMove, readHistory, rememberSent, withSent,
} from "../components/chat/chat-compose";
import { setLanguage } from "../i18n";
import { mount, one, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

/** A browser store the tests can read back. */
function stubStore() {
  const data = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v); },
      removeItem: (k: string) => { data.delete(k); },
    },
    dispatchEvent: () => true,
  });
  return data;
}

beforeEach(() => { setLanguage("en"); stubStore(); });
afterEach(() => { vi.unstubAllGlobals(); });

function rig(initial: Partial<ChatComposerProps> = {}) {
  let props: ChatComposerProps = {
    value: "", session: "claude:one",
    onSend: vi.fn<ChatComposerProps["onSend"]>(() => "sent"),
    onChange: vi.fn((value: string) => { props = { ...props, value }; view.rerender(props); }),
    ...initial,
  };
  const view = mount(ChatComposer, props);
  const area = () => one(view.tree, el => el.type === "textarea")! as Drawn;
  return {
    view,
    get props() { return props; },
    value: () => area().props.value as string,
    type(value: string) { (area().props.onChange as (e: unknown) => void)({ currentTarget: { value } }); },
    /** A key on the textarea, the caret at `start` (and `end`), the end of the text by default. */
    key(key: string, at?: { start?: number; end?: number }) {
      const value = area().props.value as string;
      const start = at?.start ?? value.length;
      const event = {
        key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
        nativeEvent: { isComposing: false, keyCode: 0 }, preventDefault: vi.fn(), stopPropagation: vi.fn(),
        currentTarget: { value, selectionStart: start, selectionEnd: at?.end ?? start },
      };
      (area().props.onKeyDown as (e: unknown) => void)(event);
      return event;
    },
    send() { this.key("Enter"); },
  };
}

describe("historyMove: the caret decides", () => {
  it("Up recalls from an empty box, or with the caret at either end of the first line", () => {
    expect(historyMove("ArrowUp", { value: "", start: 0, end: 0 }, false)).toBe("older");
    expect(historyMove("ArrowUp", { value: "one line", start: 8, end: 8 }, false)).toBe("older");
    expect(historyMove("ArrowUp", { value: "one line", start: 0, end: 0 }, false)).toBe("older");
    expect(historyMove("ArrowUp", { value: "two\nlines", start: 0, end: 0 }, false)).toBe("older");
  });

  it("never steals an arrow from the middle of the text, a later line, or a selection", () => {
    expect(historyMove("ArrowUp", { value: "one line", start: 3, end: 3 }, true)).toBeNull();
    expect(historyMove("ArrowUp", { value: "two\nlines", start: 9, end: 9 }, true)).toBeNull();
    expect(historyMove("ArrowUp", { value: "one line", start: 0, end: 8 }, true)).toBeNull();
    expect(historyMove("ArrowDown", { value: "two\nlines", start: 0, end: 0 }, true)).toBeNull();
    expect(historyMove("ArrowDown", { value: "one line", start: 4, end: 4 }, true)).toBeNull();
  });

  it("Down walks back only while browsing, from the last line", () => {
    expect(historyMove("ArrowDown", { value: "", start: 0, end: 0 }, false)).toBeNull();
    expect(historyMove("ArrowDown", { value: "recalled", start: 8, end: 8 }, true)).toBe("newer");
    expect(historyMove("ArrowDown", { value: "two\nlines", start: 9, end: 9 }, true)).toBe("newer");
    expect(historyMove("Enter", { value: "", start: 0, end: 0 }, true)).toBeNull();
  });
});

describe("the composer's Up and Down", () => {
  it("recalls this session's messages newest first, and Down brings the draft back", () => {
    const r = rig();
    r.type("first"); r.send();
    r.type("second"); r.send();
    r.type("a draft in progress");
    // The caret mid-text: the arrow is the textarea's.
    expect(r.key("ArrowUp", { start: 4 }).preventDefault).not.toHaveBeenCalled();
    expect(r.value()).toBe("a draft in progress");
    expect(r.key("ArrowUp", { start: 0 }).preventDefault).toHaveBeenCalledOnce();
    expect(r.value()).toBe("second");
    r.key("ArrowUp");
    expect(r.value()).toBe("first");
    // Nothing older: the key is the textarea's again.
    expect(r.key("ArrowUp").preventDefault).not.toHaveBeenCalled();
    expect(r.value()).toBe("first");
    r.key("ArrowDown");
    expect(r.value()).toBe("second");
    r.key("ArrowDown");
    expect(r.value()).toBe("a draft in progress");
    expect(r.key("ArrowDown").preventDefault, "back at the draft, Down is the textarea's").not.toHaveBeenCalled();
    r.view.unmount();
  });

  it("an edit to a recalled message makes it the draft", () => {
    const r = rig();
    r.type("sent once"); r.send();
    r.key("ArrowUp");
    r.type("sent once, edited");
    expect(r.key("ArrowDown").preventDefault).not.toHaveBeenCalled();
    expect(r.value()).toBe("sent once, edited");
    r.key("ArrowUp");
    expect(r.value()).toBe("sent once");
    r.key("ArrowDown");
    expect(r.value()).toBe("sent once, edited");
    r.view.unmount();
  });

  it("does not remember a message the terminal did not take", () => {
    const r = rig();
    (r.props.onSend as ReturnType<typeof vi.fn>).mockReturnValue("unavailable");
    r.type("kept as the draft"); r.send();
    expect(r.value()).toBe("kept as the draft");
    r.type("");
    expect(r.key("ArrowUp").preventDefault).not.toHaveBeenCalled();
    r.view.unmount();
  });

  it("is each session's own, and survives the composer going away", () => {
    const a = rig({ session: "claude:a" });
    a.type("for a"); a.send();
    a.view.unmount();
    const b = rig({ session: "claude:b" });
    expect(b.key("ArrowUp").preventDefault).not.toHaveBeenCalled();
    b.view.unmount();
    const again = rig({ session: "claude:a" });
    again.key("ArrowUp");
    expect(again.value()).toBe("for a");
    again.view.unmount();
  });

  it("leaves an IME composition's arrows alone", () => {
    const r = rig();
    r.type("x"); r.send();
    const area = one(r.view.tree, el => el.type === "textarea")! as Drawn;
    (area.props.onCompositionStart as () => void)();
    expect(r.key("ArrowUp").preventDefault).not.toHaveBeenCalled();
    r.view.unmount();
  });
});

describe("the history store", () => {
  it("keeps the last HISTORY_CAP messages of a session, no repeat of the last, oldest first", () => {
    let h: string[] = [];
    for (let i = 0; i < HISTORY_CAP + 5; i++) h = withSent(h, `m${i}`);
    expect(h).toHaveLength(HISTORY_CAP);
    expect(h[0]).toBe("m5");
    expect(withSent(h, h[h.length - 1])).toEqual(h);
    expect(withSent(h, "   ")).toEqual(h);
  });

  it("keeps HISTORY_SESSIONS sessions, the one written to last kept longest", () => {
    const data = stubStore();
    for (let i = 0; i < HISTORY_SESSIONS + 3; i++) rememberSent(`claude:s${i}`, `hello ${i}`);
    rememberSent("claude:s3", "again");
    const stored = JSON.parse(data.get(CHAT_HISTORY_KEY)!) as { sessions: [string, string[]][] };
    expect(stored.sessions).toHaveLength(HISTORY_SESSIONS);
    expect(stored.sessions.at(-1)).toEqual(["claude:s3", ["hello 3", "again"]]);
    expect(readHistory("claude:s0")).toEqual([]);
    expect(readHistory("claude:s4")).toEqual(["hello 4"]);
  });

  it("keeps a long paste in the tab, not in the store", () => {
    const data = stubStore();
    const long = "x".repeat(HISTORY_TEXT_CAP + 1);
    expect(rememberSent("claude:a", long)).toEqual([long]);
    expect(readHistory("claude:a")).toEqual([]);
    expect(data.get(CHAT_HISTORY_KEY)!.length).toBeLessThan(200);
  });

  it("reads a broken or foreign value as nothing, and a blocked store costs only the history", () => {
    const data = stubStore();
    data.set(CHAT_HISTORY_KEY, "{not json");
    expect(readHistory("claude:a")).toEqual([]);
    data.set(CHAT_HISTORY_KEY, JSON.stringify({ sessions: [["claude:a", [1, 2]], "x"] }));
    expect(readHistory("claude:a")).toEqual([]);
    vi.stubGlobal("window", Object.defineProperty({}, "localStorage", { get() { throw new Error("SecurityError"); } }));
    expect(() => rememberSent("claude:a", "fine")).not.toThrow();
    expect(readHistory("claude:a")).toEqual([]);
  });
});
