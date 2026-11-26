// Chat's actions in the pane's ⋯ (ChatMenu.tsx, StageHeader.tsx PaneMore): the
// ⋯ drawn at every width in Chat only, the rows in their order, a Compact that
// cannot go now still reached by the arrows and named with its reason, a press
// that does nothing then, and Session details folded under one row, closed
// until opened, then kept open in this browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ChatMenuRows, { type ChatMenuView } from "../components/terminal/ChatMenu";
import { CHAT_DETAILS_KEY } from "../chat-actions";
import { en } from "../i18n/en";
import { all, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("window", {
    localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); } },
    dispatchEvent: () => true,
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function draw(view: Partial<ChatMenuView> = {}) {
  const picked: Array<() => void> = [];
  const full: ChatMenuView = { term: vi.fn(), details: [], ...view };
  const m = mount(ChatMenuRows, { view: full, pick: (run: () => void) => { picked.push(run); } });
  return { m, picked, view: full };
}

const items = (tree: unknown) => all(tree, el => el.props.role === "menuitem");
const act = (tree: unknown, name: string) => one(tree, el => el.props["data-act"] === name);
const press = (el: Drawn | null) => (el!.props.onClick as () => void)();

describe("Chat's rows in the ⋯", () => {
  it("lead with Compact, then Copy last reply, Show on Board and Show Term, each a menu item", () => {
    const { m } = draw({ compact: { blocked: null, run: vi.fn() }, copy: vi.fn(), board: vi.fn() });
    expect(items(m.tree).map(el => el.props["data-act"])).toEqual(["compact", "copy", "board", "term"]);
    expect(textOf(act(m.tree, "compact"))).toBe(en["board.chat.actions.compact"]);
    expect(textOf(act(m.tree, "copy"))).toBe(en["board.chat.actions.copyReply"]);
    expect(textOf(act(m.tree, "board"))).toBe(en["board.chat.actions.board"]);
    expect(textOf(act(m.tree, "term"))).toBe(en["board.chat.showTerm"]);
  });

  it("draws only what can be done: no Compact for another agent, no Copy with no reply, no Show on Board without a Board", () => {
    const { m } = draw();
    expect(items(m.tree).map(el => el.props["data-act"])).toEqual(["term"]);
  });

  it("hands a press to the menu, which closes before the action runs", () => {
    const run = vi.fn();
    const { m, picked, view } = draw({ compact: { blocked: null, run } });
    press(act(m.tree, "compact"));
    expect(picked).toEqual([run]);
    press(act(m.tree, "term"));
    expect(picked[1]).toBe(view.term);
  });

  it("keeps a Compact that cannot go now in the arrows' reach, named unavailable with its reason, and a press does nothing", () => {
    const why = "Available once Claude Code finishes this turn.";
    const { m, picked } = draw({ compact: { blocked: why, run: vi.fn() } });
    const row = act(m.tree, "compact")!;
    expect(row.props.disabled).toBeUndefined();
    expect(row.props["aria-disabled"]).toBe(true);
    const reason = one(m.tree, el => el.props.className === "ts-act-why")!;
    expect(row.props["aria-describedby"]).toBe(reason.props.id);
    expect(textOf(reason)).toBe(why);
    press(row);
    expect(picked).toEqual([]);
  });
});

describe("Session details", () => {
  it("is no row at all when the deck has no figure for the session", () => {
    const { m } = draw({ details: [] });
    expect(act(m.tree, "details")).toBeNull();
    expect(all(m.tree, el => el.props.role === "separator")).toEqual([]);
  });

  it("is folded until opened, then each figure is a note the arrows reach, and the choice is kept", () => {
    const { m } = draw({ details: ["25% context", "$1.23 spent"] });
    const fold = act(m.tree, "details")!;
    expect(fold.props["aria-expanded"]).toBe(false);
    expect(textOf(fold)).toContain(en["board.chat.actions.details"]);
    expect(all(m.tree, el => String(el.props.className).includes("ts-act-detail"))).toEqual([]);
    press(fold);
    expect(act(m.tree, "details")!.props["aria-expanded"]).toBe(true);
    const rows = all(m.tree, el => String(el.props.className).includes("ts-act-detail"));
    expect(rows.map(textOf)).toEqual(["25% context", "$1.23 spent"]);
    for (const row of rows) {
      expect(row.props.role).toBe("menuitem");
      expect(row.props["aria-disabled"]).toBe("true");
      expect(String(row.props.className)).toContain("ap-menu-note");
    }
    expect(stored.get(CHAT_DETAILS_KEY)).toBe("1");
    // The menu opened again reads the choice.
    expect(act(draw({ details: ["25% context"] }).m.tree, "details")!.props["aria-expanded"]).toBe(true);
  });
});

describe("the ⋯ in Chat", () => {
  const header = source("../components/terminal/StageHeader.tsx");
  const css = source("../styles/terminal-stage.css");

  it("is drawn at every width in Chat only, the menu led by Chat's rows and the header's controls after them while hidden", () => {
    expect(header).toContain('data-chat={chat ? "" : undefined}');
    expect(css).toContain(".ts-head > .ts-compact-more.ts-more.glyph-btn[data-chat] { display: inline-flex; }");
    expect(header).toContain("{chat && <ChatMenuRows view={chat} pick={pick} />}");
    expect(header).toContain('chat={p.chat ?? undefined}');
  });

  it("gives the focus back to the ⋯ and closes the menu before a row's action runs", () => {
    const pick = header.slice(header.indexOf("const pick = "), header.indexOf("const rows = "));
    expect(pick.indexOf("document.getElementById(PANE_MORE_ID)?.focus();")).toBeLessThan(pick.indexOf("setMenu(null);"));
    expect(pick).toContain("window.requestAnimationFrame(run);");
  });
});
