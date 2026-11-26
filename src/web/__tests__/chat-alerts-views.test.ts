// Interactive alerts, the way into Chat: a pane remembers which sessions were
// left in Chat (a small capped list in localStorage, through storage.ts), an
// alert asks every pane to show its session in Chat, the focused pane answers
// Ctrl+Shift+` by turning its Chat | Term switch, and the one-time offer of
// system alerts inside Chat goes once answered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_VIEWS_KEY, MAX_CHAT_VIEWS, nextChatViews, onChatViewRequest, onShownInChat, parseChatViews, rememberedView,
  rememberView, requestChatView, resetChatViews, setShownInChat, setViewToggle, shownInChatKey, hasViewToggle, toggleFocusedView,
} from "../chat-view-memory";
import { isChatViewChord, terminalKeyOutcome } from "../terminal-keys";
import { dismissNotifyOffer, NOTIFY_OFFER_KEY, offerWanted, publishNotifyOffer, resetNotifyOffer, type NotifyOfferState } from "../notify-offer";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, String(v)); },
    removeItem: (k: string) => { items.delete(k); },
  };
}

let store = memoryStorage();
beforeEach(() => {
  store = memoryStorage();
  vi.stubGlobal("window", { localStorage: store });
  resetChatViews();
});
afterEach(() => { vi.unstubAllGlobals(); resetChatViews(); });

describe("the remembered view", () => {
  it("opens a session the way it was left, and says nothing of one never shown", () => {
    expect(rememberedView("s1")).toBeNull();
    rememberView("s1", "chat");
    expect(rememberedView("s1")).toBe("chat");
    expect(JSON.parse(store.items.get(CHAT_VIEWS_KEY)!)).toEqual([["s1", "chat"]]);
    rememberView("s1", "term");
    expect(rememberedView("s1")).toBe("term");
    expect(rememberedView(null)).toBeNull();
  });

  it("keeps the newest sessions up to the cap", () => {
    let list = nextChatViews([], "s0", "chat");
    for (let i = 1; i < MAX_CHAT_VIEWS + 5; i++) list = nextChatViews(list, `s${i}`, i % 2 ? "term" : "chat");
    expect(list).toHaveLength(MAX_CHAT_VIEWS);
    expect(list[0]).toEqual(["s5", "term"]);
    expect(nextChatViews([["a", "chat"], ["b", "term"]], "a", "term")).toEqual([["b", "term"], ["a", "term"]]);
  });

  it("reads anything but a list of [id, view] as none", () => {
    expect(parseChatViews("{")).toEqual([]);
    expect(parseChatViews('{"a":1}')).toEqual([]);
    expect(parseChatViews('[["a","chat"], ["b","split"], ["", "term"], "c", ["d","term"]]')).toEqual([["a", "chat"], ["d", "term"]]);
  });

  it("writes nothing when nothing moved", () => {
    rememberView("s1", "term");
    const written = store.items.get(CHAT_VIEWS_KEY);
    rememberView("s1", "term");
    expect(store.items.get(CHAT_VIEWS_KEY)).toBe(written);
    const set = vi.spyOn(store, "setItem");
    rememberView("s1", "term");
    expect(set).not.toHaveBeenCalled();
  });

  it("goes through storage.ts, never localStorage directly", () => {
    const src = read("../chat-view-memory.ts");
    expect(src).not.toMatch(/localStorage/);
    expect(src).toMatch(/from "\.\/storage"/);
  });

  it("is taken up by the pane in the render that brings the session", () => {
    const stage = read("../components/terminal/TerminalStage.tsx");
    expect(stage).toMatch(/if \(viewFor !== chatSession\) \{ setViewFor\(chatSession\); const kept = rememberedView\(chatSession\); if \(kept\) setView\(kept\); \}/);
    expect(stage).toMatch(/useEffect\(\(\) => \{ rememberView\(chatSession, view\); \}, \[chatSession, view\]\);/);
  });
});

describe("Open in Chat", () => {
  it("tells every pane, and remembers Chat for a pane that opens the session after", () => {
    const heard: string[] = [];
    const off = onChatViewRequest(id => heard.push(id));
    requestChatView("s2");
    expect(heard).toEqual(["s2"]);
    expect(rememberedView("s2")).toBe("chat");
    off();
    requestChatView("s3");
    expect(heard).toEqual(["s2"]);
  });

  it("knows which sessions some pane shows in Chat", () => {
    const changed = vi.fn();
    onShownInChat(changed);
    const left = {}, right = {};
    setShownInChat(left, "b");
    setShownInChat(right, "a");
    expect(shownInChatKey()).toBe("a|b");
    setShownInChat(left, null);
    expect(shownInChatKey()).toBe("a");
    setShownInChat(right, "a");
    expect(changed).toHaveBeenCalledTimes(3);
  });
});

describe("the Chat | Term chord", () => {
  const key = (over: Partial<KeyboardEvent>) => ({ key: "`", code: "Backquote", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, ...over });

  it("is Ctrl+Shift+` and nothing near it", () => {
    expect(isChatViewChord(key({}))).toBe(true);
    expect(isChatViewChord(key({ key: "~" }))).toBe(true);
    expect(isChatViewChord(key({ shiftKey: false }))).toBe(false);
    expect(isChatViewChord(key({ altKey: true }))).toBe(false);
    expect(isChatViewChord(key({ metaKey: true }))).toBe(false);
    expect(isChatViewChord(key({ key: "1", code: "Digit1" }))).toBe(false);
  });

  it("is the deck's in the terminal pane, not a key for the session", () => {
    expect(terminalKeyOutcome({ ...key({}), type: "keydown" } as never, false)).toBe("view");
    expect(terminalKeyOutcome({ ...key({}), type: "keydown" } as never, true)).toBe("view");
  });

  it("turns the focused pane's switch, and none when no pane has one", () => {
    expect(hasViewToggle()).toBe(false);
    expect(toggleFocusedView()).toBe(false);
    const a = vi.fn(), b = vi.fn();
    const paneA = {}, paneB = {};
    setViewToggle(paneA, a);
    setViewToggle(paneB, b);
    expect(toggleFocusedView()).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    setViewToggle(paneB, null);
    toggleFocusedView();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("is listed in key help and taken by no other row", () => {
    const help = read("../key-help.ts");
    expect(help).toMatch(/cap: CHAT_VIEW_CAP, macCap: CHAT_VIEW_MAC_CAP/);
    expect(help).toMatch(/board\.chat\.alert\.keyToggle/);
    expect(read("../use-deck-shortcuts.ts")).toMatch(/isChatViewChord\(e\) && hasViewToggle\(\)/);
  });
});

describe("the offer of system alerts in Chat", () => {
  const base: NotifyOfferState = { supported: true, permission: "default", on: false, vetoed: false, desktop: false, turnOn: () => {} };
  afterEach(() => resetNotifyOffer());

  it("is made while alerts are off or not yet allowed", () => {
    expect(offerWanted(base, false)).toBe(true);
    expect(offerWanted({ ...base, on: true }, false)).toBe(true);
    expect(offerWanted({ ...base, on: true, permission: "granted" }, false)).toBe(false);
  });

  it("is not made where it cannot help, nor once answered", () => {
    expect(offerWanted(base, true)).toBe(false);
    expect(offerWanted({ ...base, supported: false }, false)).toBe(false);
    expect(offerWanted({ ...base, permission: "denied" }, false)).toBe(false);
    expect(offerWanted({ ...base, vetoed: true }, false)).toBe(false);
    expect(offerWanted({ ...base, desktop: true }, false)).toBe(false);
  });

  it("is dismissed for good, through storage.ts", () => {
    publishNotifyOffer(base);
    dismissNotifyOffer();
    expect(store.items.get(NOTIFY_OFFER_KEY)).toBe("1");
    expect(read("../notify-offer.ts")).not.toMatch(/localStorage/);
  });

  it("leaves the deck's default for notifications as it was", () => {
    expect(read("../../server/deck-prefs.mjs")).toMatch(/notifications:\s*false/);
  });
});
