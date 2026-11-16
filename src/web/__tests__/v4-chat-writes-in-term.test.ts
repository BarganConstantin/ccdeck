// Internal #99: "How do I write here?" Chat drew the conversation and no way to
// write. V4's design reads the conversation in Chat and types into Term (there
// is no input under Chat; the status bar's "↵ open and type"), but "↵ type
// here" in Chat focused the terminal hidden under it: a hidden textarea takes
// no focus, so nothing happened, and keys held for the pane went to a session
// nobody could see.
//
// Pinned here: the keys bar says "type in Term" with Chat on; a session that
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
import KeysBar, { type KeysBarProps } from "../components/terminal/KeysBar";
import { en } from "../i18n/en";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const LANGS = ["en", "ro", "de", "es", "fr", "ja", "ko", "pt-BR", "zh-CN", "zh-TW"] as const;
const WORDS = ["board.keys.typeInTerm", "board.chat.cannotType", "board.chat.showTerm"] as const;

function barProps(over: Partial<KeysBarProps> = {}): KeysBarProps {
  return {
    owner: "board", name: "paycore", chordLabel: "Ctrl+Shift+X", canType: true, asksWaiting: false,
    firstRun: false, onFirstRunDone: vi.fn(), onTypeHere: vi.fn(), ...over,
  };
}
const button = (tree: unknown, name: string) => one(tree, el => el.type === "button" && textOf(el).trim() === name);

describe("internal #99: Chat says where writing goes", () => {
  it("with Chat on, the bar offers ↵ type in Term, and the press is the stage's way into the pane", () => {
    const props = barProps({ chat: true });
    const out = renderToStaticMarkup(createElement(KeysBar, props));
    expect(out).toContain(en["board.keys.typeInTerm"]);
    expect(out).not.toContain(`>${en["board.keys.typeHere"]}<`);
    const press = button(KeysBar(props), en["board.keys.typeInTerm"]);
    expect(press, "type in Term is a button").not.toBeNull();
    (press!.props.onClick as () => void)();
    expect(props.onTypeHere).toHaveBeenCalledTimes(1);
  });

  it("on Chat the first-run line gives way to type in Term; on Term it stays until Got it", () => {
    // Found in the browser pass through the engine: right after a launch, Chat
    // showed "Typing goes to the session, Esc included" while the keys were the
    // deck's, so nothing said Term was where to write.
    const chat = renderToStaticMarkup(createElement(KeysBar, barProps({ chat: true, firstRun: true })));
    expect(chat).toContain(en["board.keys.typeInTerm"]);
    expect(chat).not.toContain(en["board.keys.typingGoes"]);
    expect(chat).not.toContain(`>${en["board.keys.gotIt"]}<`);
    const term = renderToStaticMarkup(createElement(KeysBar, barProps({ firstRun: true })));
    expect(term).toContain(en["board.keys.typingGoes"]);
    expect(term).toContain(`>${en["board.keys.gotIt"]}<`);
  });

  it("with Term on, the bar still says type here", () => {
    const out = renderToStaticMarkup(createElement(KeysBar, barProps()));
    expect(out).toContain(en["board.keys.typeHere"]);
    expect(out).not.toContain(en["board.keys.typeInTerm"]);
  });

  it("a session that cannot take keys says so in Chat, with Show Term, though the pane is a card", () => {
    const onShowTerm = vi.fn();
    const props = barProps({ chat: true, chatCannotType: true, canType: false, paneless: true, onShowTerm });
    const out = renderToStaticMarkup(createElement(KeysBar, props));
    expect(out).not.toMatch(/<footer[^>]*hidden/);
    expect(out).toContain(en["board.chat.cannotType"].replace("'", "&#x27;"));
    expect(out).not.toContain(en["board.keys.typeInTerm"]);
    const show = button(KeysBar(props), en["board.chat.showTerm"]);
    expect(show, "Show Term is a button").not.toBeNull();
    (show!.props.onClick as () => void)();
    expect(onShowTerm).toHaveBeenCalledTimes(1);
  });

  it("in Term, a card's pane keeps its bar hidden, as before", () => {
    const out = renderToStaticMarkup(createElement(KeysBar, barProps({ canType: false, paneless: true })));
    expect(out).toMatch(/<footer[^>]*hidden/);
  });

  it("an ended session's bar keeps its own sentence and Reopen in Chat", () => {
    const out = renderToStaticMarkup(createElement(KeysBar, barProps({
      chat: true, chatCannotType: false, canType: false,
      end: { sentence: "The session ended. This is its last frame.", action: "Reopen here", onAction: vi.fn() },
    })));
    expect(out).toContain("Reopen here");
    expect(out).not.toContain(en["board.chat.cannotType"].replace("'", "&#x27;"));
  });

  it("the three words are in every language, and not the English ones outside English", async () => {
    for (const lang of LANGS) {
      const src = read(`i18n/areas/board/${lang}.ts`);
      for (const key of WORDS) {
        const line = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]+)"`).exec(src);
        expect(line, `${lang} ${key}`).not.toBeNull();
        if (lang !== "en" && lang !== "pt-BR" && lang !== "es" && lang !== "fr" && lang !== "de" && lang !== "ro") {
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
    expect(ts).toMatch(/const chatCannotType = chatOn && p\.show\.kind === "session" && PANELESS\.has\(phase\.kind\);/);
  });
});
