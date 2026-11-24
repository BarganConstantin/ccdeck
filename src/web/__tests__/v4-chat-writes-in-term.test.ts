// Internal #99: "How do I write here?" Chat drew the conversation and no way to
// write. V4's design reads the conversation in Chat and types into Term (there
// is no input under Chat; the status bar's "↵ open and type"), but "↵ type
// here" in Chat focused the terminal hidden under it: a hidden textarea takes
// no focus, so nothing happened, and keys held for the pane went to a session
// nobody could see.
//
// Pinned here: the Chat footer offers "Continue in Term"; a session that
// cannot take keys says so in Chat with the way to its card; and in the stage
// every way into the pane (the bar, the header's keys button, a focus request
// from Enter or the asks run) shows Term first and focuses once it is drawn.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { one, textOf } from "./fake-react";
import { withoutComments } from "./tsx-scan";
import KeysBar, { AsksTrack, ArrivalNote, HostsNote, type KeysBarProps } from "../components/terminal/KeysBar";
import { en } from "../i18n/en";
import ro from "../i18n/areas/board/ro";
import { translate } from "../i18n/translate";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const LANGS = ["en", "ro", "de", "es", "fr", "ja", "ko", "pt-BR", "zh-CN", "zh-TW"] as const;
const WORDS = [
  "board.chat.continueInTerm", "board.chat.replyInTerm", "board.chat.showTerm",
  "board.chat.you", "board.chat.tools.one", "board.chat.tools.other",
  "board.chat.running", "board.chat.latest", "board.chat.empty",
] as const;

function barProps(over: Partial<KeysBarProps> = {}): KeysBarProps {
  return {
    owner: "board", name: "paycore", chordLabel: "Ctrl+Shift+X", canType: true, asksWaiting: false,
    firstRun: false, onFirstRunDone: vi.fn(), onTypeHere: vi.fn(), ...over,
  };
}
const button = (tree: unknown, name: string) => one(tree, el => el.type === "button" && textOf(el).trim() === name);

describe("internal #99: Chat says where writing goes", () => {
  it("Chat offers a primary Continue in Term action wired to the stage, without an input", () => {
    const props = barProps({ chat: true });
    const out = renderToStaticMarkup(createElement(KeysBar, props));
    expect(out).toContain(en["board.chat.continueInTerm"]);
    expect(out).not.toContain(`>${en["board.keys.typeHere"]}<`);
    const press = button(KeysBar(props), en["board.chat.continueInTerm"]);
    expect(press, "Continue in Term is a button").not.toBeNull();
    (press!.props.onClick as () => void)();
    expect(props.onTypeHere).toHaveBeenCalledTimes(1);
    expect(press!.props.className).toBe("btn primary");
    expect(out).toContain(en["board.chat.replyInTerm"]);
    expect(out).not.toMatch(/<(input|textarea)\b/);
  });

  it("on Chat the first-run line gives way to Continue in Term; on Term it stays until Got it", () => {
    // Found in the browser pass through the engine: right after a launch, Chat
    // showed "Typing goes to the session, Esc included" while the keys were the
    // deck's, so nothing said Term was where to write.
    const chat = renderToStaticMarkup(createElement(KeysBar, barProps({ chat: true, firstRun: true })));
    expect(chat).toContain(en["board.chat.continueInTerm"]);
    expect(chat).not.toContain(en["board.keys.typingGoes"]);
    expect(chat).not.toContain(`>${en["board.keys.gotIt"]}<`);
    const term = renderToStaticMarkup(createElement(KeysBar, barProps({ firstRun: true })));
    expect(term).toContain(en["board.keys.typingGoes"]);
    expect(term).toContain(`>${en["board.keys.gotIt"]}<`);
  });

  it("with Term on, the bar still says type here", () => {
    const out = renderToStaticMarkup(createElement(KeysBar, barProps()));
    expect(out).toContain(en["board.keys.typeHere"]);
    expect(out).not.toContain(en["board.chat.continueInTerm"]);
  });

  it("a session that cannot take keys explains where replies go and shows Term without taking keys", () => {
    const onShowTerm = vi.fn();
    const props = barProps({ chat: true, chatCannotType: true, canType: false, paneless: true, onShowTerm });
    const out = renderToStaticMarkup(createElement(KeysBar, props));
    expect(out).not.toMatch(/<footer[^>]*hidden/);
    expect(out).toContain(en["board.chat.replyInTerm"]);
    expect(out).not.toContain(en["board.chat.continueInTerm"]);
    const show = button(KeysBar(props), en["board.chat.showTerm"]);
    expect(show, "Show Term is a button").not.toBeNull();
    (show!.props.onClick as () => void)();
    expect(onShowTerm).toHaveBeenCalledTimes(1);
    expect(props.onTypeHere).not.toHaveBeenCalled();
    expect(out).not.toMatch(/<(input|textarea)\b/);
  });

  it("in Term, a card's pane keeps its bar hidden, as before", () => {
    const out = renderToStaticMarkup(createElement(KeysBar, barProps({ canType: false, paneless: true })));
    expect(out).toMatch(/<footer[^>]*hidden/);
  });

  it("end and notice retain precedence over both Chat handoff states", () => {
    const onAction = vi.fn();
    for (const chatCannotType of [false, true]) {
      const props = barProps({
        chat: true, chatCannotType, canType: !chatCannotType,
        notice: "That paste is over 1 MB.",
        end: { sentence: "The session ended. This is its last frame.", action: "Reopen here", busy: true, onAction },
      });
      const out = renderToStaticMarkup(createElement(KeysBar, props));
      expect(out).toContain("Reopen here");
      expect(out).not.toContain(props.notice);
      expect(out).not.toContain(en["board.chat.replyInTerm"]);
      const reopen = button(KeysBar(props), "Reopen here");
      expect(reopen!.props["aria-busy"]).toBe(true);
      (reopen!.props.onClick as () => void)();
      const notice = renderToStaticMarkup(createElement(KeysBar, { ...props, end: null }));
      expect(notice).toContain(props.notice);
      expect(notice).not.toContain(en["board.chat.replyInTerm"]);
    }
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it("asks, arrival and host actions keep priority over Continue in Term and their callbacks", () => {
    const onNextAsk = vi.fn();
    const onAnswerArrival = vi.fn();
    const onReview = vi.fn();
    const props = barProps({
      chat: true, onNextAsk, onAnswerArrival,
      asks: { next: { name: "next-session", waited: "2m", tool: "Bash" } },
      arrival: { name: "arriving-session", tool: "Edit" },
      hosts: { said: "Older session host", onReview },
    });
    const askTree = KeysBar(props);
    const ask = one(askTree, el => el.type === AsksTrack);
    expect(ask!.props.onNextAsk).toBe(onNextAsk);
    const next = one(AsksTrack({ asks: props.asks!, onNextAsk: ask!.props.onNextAsk as () => void }), el => el.type === "button");
    (next!.props.onClick as () => void)();
    expect(onNextAsk).toHaveBeenCalledTimes(1);
    expect(one(askTree, el => el.type === ArrivalNote || el.type === HostsNote)).toBeNull();

    const arrivalTree = KeysBar({ ...props, asks: null });
    const arrival = one(arrivalTree, el => el.type === ArrivalNote);
    expect(arrival!.props.onAnswer).toBe(onAnswerArrival);
    const answer = one(ArrivalNote({ arrival: props.arrival!, onAnswer: arrival!.props.onAnswer as () => void }), el => el.type === "button");
    (answer!.props.onClick as () => void)();
    expect(onAnswerArrival).toHaveBeenCalledTimes(1);
    expect(one(arrivalTree, el => el.type === HostsNote)).toBeNull();

    const hostsTree = KeysBar({ ...props, asks: null, arrival: null });
    expect(one(hostsTree, el => el.type === HostsNote)!.props.hosts).toBe(props.hosts);
    const review = button(HostsNote({ hosts: props.hosts! }), en["board.keys.review"]);
    (review!.props.onClick as () => void)();
    expect(onReview).toHaveBeenCalledTimes(1);

    for (const state of [props, { ...props, asks: { position: { index: 0, total: 2 } } },
      { ...props, asks: { clear: true } }, { ...props, asks: null }, { ...props, asks: null, arrival: null }]) {
      const out = renderToStaticMarkup(createElement(KeysBar, state));
      expect(out).not.toContain(en["board.chat.continueInTerm"]);
      expect(out).not.toMatch(/<(input|textarea)\b/);
    }
    expect(props.onTypeHere).not.toHaveBeenCalled();
  });

  it("Show Term stays available alongside asks for a pane that cannot take keys", () => {
    const props = barProps({ chat: true, chatCannotType: true, canType: false, paneless: true,
      asks: { position: { index: 0, total: 2 } }, onShowTerm: vi.fn() });
    const out = renderToStaticMarkup(createElement(KeysBar, props));
    expect(out).toContain(en["board.keys.asks"]);
    expect(out).toContain(en["board.chat.showTerm"]);
    (button(KeysBar(props), en["board.chat.showTerm"])!.props.onClick as () => void)();
    expect(props.onShowTerm).toHaveBeenCalledTimes(1);
    expect(props.onTypeHere).not.toHaveBeenCalled();
  });

  it("Romanian tool counts follow one, few and other", () => {
    expect(translate("ro", ro, "board.chat.tools", { count: 1 })).toBe("1 apel de instrument");
    expect(translate("ro", ro, "board.chat.tools", { count: 2 })).toBe("2 apeluri de instrument");
    expect(translate("ro", ro, "board.chat.tools", { count: 20 })).toBe("20 de apeluri de instrument");
  });

  it("all footer and parent Chat labels are translated in all ten catalogs", async () => {
    for (const lang of LANGS) {
      const src = read(`i18n/areas/board/${lang}.ts`);
      for (const key of WORDS) {
        const line = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]+)"`).exec(src);
        expect(line, `${lang} ${key}`).not.toBeNull();
        if (lang !== "en") {
          expect(line![1], `${lang} ${key} is translated`).not.toBe(en[key]);
        }
      }
    }
  });
});

describe("internal #99: the stage shows Term before it gives the pane the keys", () => {
  const ts = withoutComments(read("components/terminal/TerminalStage.tsx"));

  it("one way into the pane: with Chat on it switches to Term and gives the keys after the switch", () => {
    const into = /const intoPane = \(request\?: FocusRequest\["request"\]\) => \{([\s\S]*?)\n  \};/.exec(ts)?.[1] ?? "";
    expect(into).toMatch(/if \(chatOn\) \{ keysAfterTerm\.current = \{ key, request \}; setView\("term"\); return; \}/);
    expect(into).toContain("givePane(request)");
    const after = /useLayoutEffect\(\(\) => \{\s*const want = keysAfterTerm\.current;\s*if \(chatOn \|\| !want\) return;([\s\S]*?)\n  \}\);/.exec(ts)?.[1] ?? "";
    expect(after).toContain("keysAfterTerm.current = null;");
    expect(after).toContain("if (want.key === key) givePane(want.request);");
  });

  it("the keys bar, the header's keys button and a focus request all go through it", () => {
    const bar = /<KeysBar[\s\S]*?\/>/.exec(ts)?.[0] ?? "";
    // A click's event is not a request: the bar's press asks for the keys alone.
    expect(bar).toContain("onTypeHere={() => intoPane()}");
    expect(bar).toContain("chat={chatOn}");
    expect(bar).toContain("chatCannotType={chatCannotType}");
    expect(bar).toMatch(/onShowTerm=\{\(\) => showView\("term"\)\}/);
    const header = /<StageHeader[\s\S]*?\/>/.exec(ts)?.[0] ?? "";
    expect(header).toMatch(/else intoPane\(\);/);
    expect(header).toContain("onChange: showView");
    const request = /useFocusRequest\(\{([\s\S]*?)\n  \}\);/.exec(ts)?.[1] ?? "";
    expect(request).toMatch(/focus: request => \{ intoPane\(request\); \}/);
    // Nothing else focuses the pane behind Chat's back: givePane is the one place.
    expect(ts.match(/session\.focus\(\)/g)?.length).toBe(1);
    expect(ts).not.toContain("onTypeHere={session.focus}");
  });

  it("going back to Chat takes the keys out of the pane, and a card's phase is the bar's to say", () => {
    const show = /const showView = \(next: "chat" \| "term"\) => \{([\s\S]*?)\n  \};/.exec(ts)?.[1] ?? "";
    expect(show).toMatch(/if \(next === "chat" && session\.keysOwner === "pane"\) session\.release\(\);/);
    // CHANGED ON PURPOSE (opencode and Copilot): not for a session the deck
    // only hears events from. Its Term card says it cannot be opened here, so
    // "reply in Term" would send the reader to a pane that takes no keys.
    // CHANGED ON PURPOSE (missing folder): a card is `paneless(phase)` now,
    // which is the same cards, and a folder-gone pane only without its frame.
    expect(ts).toMatch(/const chatCannotType = chatOn && !chatReadOnly && p\.show\.kind === "session" && paneless\(phase\);/);
  });
});
