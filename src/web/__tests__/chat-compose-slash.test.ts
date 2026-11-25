// The composer's slash list: a "/" at the start opens a listbox of Claude
// Code's common commands and the ones this session ran; the arrows move,
// Enter or Tab complete, Esc closes; a click completes too. The textarea keeps
// the focus and names the active row (aria-activedescendant). A command whose
// dialog only Term draws sends the pane to Term once it is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatComposer, { type ChatComposerProps } from "../components/chat/ChatComposer";
import { opensInTerm, SLASH_COMMANDS, slashItems, slashQuery, usedCommands } from "../components/chat/chat-compose";
import type { ChatTurn } from "../components/chat/chat-model";
import { setLanguage } from "../i18n";
import { AREA_FILES } from "../i18n/catalogs";
import { all, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => setLanguage("en"));
afterEach(() => { setLanguage("en"); vi.unstubAllGlobals(); });

const TURNS: ChatTurn[] = [
  { kind: "command", name: "/model", args: "opus" },
  { kind: "user", text: "hi" },
  { kind: "command", name: "/my-plugin:ship" },
];

function rig(initial: Partial<ChatComposerProps> = {}) {
  let props: ChatComposerProps = {
    value: "", turns: TURNS,
    onSend: vi.fn<ChatComposerProps["onSend"]>(() => "sent"),
    onChange: vi.fn((value: string) => { props = { ...props, value }; view.rerender(props); }),
    onShowTerm: vi.fn(),
    ...initial,
  };
  const view = mount(ChatComposer, props);
  const area = () => one(view.tree, el => el.type === "textarea")! as Drawn;
  const call = (name: string, event: unknown = {}) => (area().props[name] as (e: unknown) => void)(event);
  return {
    view, get props() { return props; }, area,
    focus() { call("onFocus"); },
    blur() { call("onBlur"); },
    type(value: string) { call("onChange", { currentTarget: { value } }); },
    key(key: string) {
      const value = area().props.value as string;
      const event = {
        key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
        nativeEvent: { isComposing: false, keyCode: 0 }, preventDefault: vi.fn(), stopPropagation: vi.fn(),
        currentTarget: { value, selectionStart: value.length, selectionEnd: value.length },
      };
      call("onKeyDown", event);
      return event;
    },
    list: () => one(view.tree, el => el.props.role === "listbox"),
    options: () => all(view.tree, el => el.props.role === "option"),
  };
}

describe("what the list offers", () => {
  it("opens on a slash and a word, never once a space follows or text comes first", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/Comp")).toBe("comp");
    expect(slashQuery("/compact ")).toBeNull();
    expect(slashQuery("say /compact")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });

  it("puts the session's own commands first, newest first, then the built-ins; starts before contains", () => {
    const used = usedCommands(TURNS);
    expect(used).toEqual(["/my-plugin:ship", "/model"]);
    const rows = slashItems("", used);
    expect(rows.slice(0, 3).map(r => r.name)).toEqual(["/my-plugin:ship", "/model", "/clear"]);
    expect(rows.filter(r => r.name === "/model")).toHaveLength(1);
    expect(rows.find(r => r.name === "/my-plugin:ship")).toMatchObject({ used: true, about: undefined, term: false });
    expect(slashItems("co", used).map(r => r.name)).toEqual(["/compact", "/context", "/config"]);
    expect(slashItems("view", []).map(r => r.name)).toEqual(["/review"]);
    expect(slashItems("zzz", [])).toEqual([]);
  });

  it("names only real Claude Code built-ins, each with words in all ten languages", () => {
    expect(SLASH_COMMANDS.map(c => c.name)).toEqual([
      "/clear", "/compact", "/context", "/model", "/review", "/init", "/plan", "/memory", "/usage",
      "/config", "/permissions", "/resume", "/rewind", "/mcp", "/status", "/help",
    ]);
    const boards = AREA_FILES.filter(area => area.area === "board");
    expect(boards).toHaveLength(10);
    for (const { code, catalog } of boards) {
      for (const c of SLASH_COMMANDS) expect(catalog[c.about], `${code}: ${c.about}`).toBeTruthy();
    }
  });

  it("sends the pane to Term for a dialog Claude Code draws there", () => {
    for (const text of ["/model", "/config", "/resume", "/mcp", "/memory", "/permissions", "/help", "/rewind", "/status", "/usage", "/memory add a rule", " /model"]) {
      expect(opensInTerm(text), text).toBe(true);
    }
    for (const text of ["/model opus", "/config theme=dark", "/resume 42", "/compact", "/clear", "/review", "hello /model", "/models", "/my-plugin:ship"]) {
      expect(opensInTerm(text), text).toBe(false);
    }
  });
});

describe("the listbox", () => {
  it("opens with the focus on a slash, as a listbox the textarea points into", () => {
    const r = rig();
    r.focus();
    expect(r.list()).toBeNull();
    r.type("/");
    const list = r.list()!;
    expect(list.type).toBe("ul");
    expect(list.props["aria-label"]).toBe("Commands");
    const options = r.options();
    expect(options.length).toBeGreaterThan(10);
    expect(options[0].props["aria-selected"]).toBe(true);
    expect(options.slice(1).every(o => o.props["aria-selected"] === false)).toBe(true);
    const area = r.area();
    expect(area.props["aria-controls"]).toBe(list.props.id);
    expect(area.props["aria-activedescendant"]).toBe(options[0].props.id);
    expect(area.props["aria-autocomplete"]).toBe("list");
    expect(textOf(options[0])).toContain("/my-plugin:ship");
    expect(textOf(options[0])).toContain("Used in this session");
    expect(textOf(options.find(o => textOf(o).startsWith("/model"))!)).toContain("Opens in Term");
    r.view.unmount();
  });

  it("filters as you type, and closes on a space, an empty box or a blur", () => {
    const r = rig();
    r.focus();
    r.type("/comp");
    expect(r.options().map(o => textOf(o.props.children && (o.props.children as unknown[])[0]))).toEqual(["/compact"]);
    r.type("/compact ");
    expect(r.list()).toBeNull();
    r.type("/c");
    expect(r.list()).not.toBeNull();
    r.blur();
    expect(r.list()).toBeNull();
    r.focus();
    r.type("");
    expect(r.list()).toBeNull();
    r.view.unmount();
  });

  it("moves with the arrows (wrapping), completes on Tab and Enter, and never sends a partial command", () => {
    const r = rig();
    r.focus();
    r.type("/co");
    expect(r.key("ArrowDown").preventDefault).toHaveBeenCalledOnce();
    expect(r.area().props["aria-activedescendant"]).toBe(r.options()[1].props.id);
    r.key("ArrowUp"); r.key("ArrowUp");
    expect(r.options()[2].props["aria-selected"]).toBe(true);
    expect(r.key("Tab").preventDefault).toHaveBeenCalledOnce();
    expect(r.area().props.value).toBe("/config ");
    expect(r.list()).toBeNull();
    r.type("/cle");
    expect(r.key("Enter").preventDefault).toHaveBeenCalledOnce();
    expect(r.area().props.value).toBe("/clear ");
    expect(r.props.onSend).not.toHaveBeenCalled();
    r.view.unmount();
  });

  it("sends at once on Enter when the command is typed whole", () => {
    const r = rig();
    r.focus();
    r.type("/compact");
    expect(r.list()).not.toBeNull();
    r.key("Enter");
    expect(r.props.onSend).toHaveBeenCalledWith("/compact");
    expect(r.props.onShowTerm).not.toHaveBeenCalled();
    r.view.unmount();
  });

  it("Esc closes it and goes no further, and a new word opens it again", () => {
    const r = rig();
    r.focus();
    r.type("/mo");
    const esc = r.key("Escape");
    expect(esc.preventDefault).toHaveBeenCalledOnce();
    expect(esc.stopPropagation).toHaveBeenCalledOnce();
    expect(r.list()).toBeNull();
    expect(r.area().props["aria-activedescendant"]).toBeUndefined();
    expect(r.area().props["aria-controls"]).toBeUndefined();
    // Closed, Esc is the deck's again.
    expect(r.key("Escape").stopPropagation).not.toHaveBeenCalled();
    r.type("/mod");
    expect(r.list()).not.toBeNull();
    r.view.unmount();
  });

  it("completes on a click, without taking the focus from the box", () => {
    const r = rig();
    r.focus();
    r.type("/");
    const row = r.options().find(o => textOf(o).startsWith("/review"))!;
    const down = { preventDefault: vi.fn() };
    (row.props.onMouseDown as (e: unknown) => void)(down);
    expect(down.preventDefault).toHaveBeenCalledOnce();
    (row.props.onMouseMove as () => void)();
    expect(r.options().find(o => textOf(o).startsWith("/review"))!.props["aria-selected"]).toBe(true);
    (row.props.onClick as () => void)();
    expect(r.area().props.value).toBe("/review ");
    r.view.unmount();
  });

  it("a dialog command goes to Term once sent; one with its argument stays in Chat", () => {
    const r = rig();
    r.focus();
    r.type("/model"); r.key("Enter");
    expect(r.props.onSend).toHaveBeenLastCalledWith("/model");
    expect(r.props.onShowTerm).toHaveBeenCalledOnce();
    r.type("/model sonnet"); r.key("Enter");
    expect(r.props.onShowTerm).toHaveBeenCalledOnce();
    (r.props.onSend as ReturnType<typeof vi.fn>).mockReturnValue("unavailable");
    r.type("/help"); r.key("Enter");
    expect(r.props.onShowTerm, "not sent: Chat stays").toHaveBeenCalledOnce();
    r.view.unmount();
  });

  it("speaks the reader's language", () => {
    setLanguage("ro");
    const r = rig();
    r.focus();
    r.type("/cl");
    expect(r.list()!.props["aria-label"]).toBe("Comenzi");
    expect(textOf(r.options()[0])).toContain("Începe o conversație nouă");
    r.view.unmount();
  });
});
