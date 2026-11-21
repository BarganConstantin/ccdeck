// A tool row with an error or a change opens them from its own button: closed
// at first, aria-expanded saying which, and the detail under the row only
// while open. The button is a native <button type="button">, so Enter and
// Space press it as a click does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffBlock, ToolRow } from "../components/chat/ChatTurn";
import type { ChatTurn } from "../components/chat/chat-model";
import { setLanguage } from "../i18n";
import { all, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => setLanguage("en"));
afterEach(() => setLanguage("en"));

type Tool = Extract<ChatTurn, { kind: "tool" }>;

function rig(turn: Tool) {
  const view = mount(ToolRow, { turn });
  const button = () => one(view.tree, el => el.type === "button")!;
  const detail = () => one(view.tree, el => el.props.className === "chat-tool-detail");
  return {
    view, button, detail,
    press: () => (button().props.onClick as () => void)(),
    pre: (className: string) => one(view.tree, el => el.type === "pre" && el.props.className === className),
  };
}

describe("a failed call's row", () => {
  const turn: Tool = { kind: "tool", name: "Bash", arg: "npm test -- limit", error: "Error: 3 tests failed\n  at run (test.js:1)" };

  it("is a real button, closed, that says Failed", () => {
    const r = rig(turn);
    expect(r.button().props.type).toBe("button");
    expect(r.button().props["aria-expanded"]).toBe(false);
    expect(r.button().props["aria-controls"]).toBeUndefined();
    expect(textOf(one(r.view.tree, el => el.props.className === "chat-tool-failed"))).toBe("Failed");
    expect(r.detail()).toBeNull();
  });

  it("opens the error under the row, the whole argument above it, and closes again", () => {
    const r = rig(turn);
    r.press();
    expect(r.button().props["aria-expanded"]).toBe(true);
    expect(r.button().props["aria-controls"]).toBe(r.detail()!.props.id);
    expect(textOf(r.pre("chat-tool-input"))).toBe("npm test -- limit");
    expect(textOf(r.pre("chat-tool-error"))).toBe("Error: 3 tests failed\n  at run (test.js:1)");
    expect(all(r.view.tree, el => el.type === DiffBlock)).toEqual([]);
    r.press();
    expect(r.button().props["aria-expanded"]).toBe(false);
    expect(r.detail()).toBeNull();
  });
});

describe("an edit's row", () => {
  const turn: Tool = { kind: "tool", name: "Edit", arg: "src/limit.ts", note: "+2 −1", diff: { lines: [" keep", "-old", "+new", "+more"], cut: true } };

  it("shows its counts and opens its change on demand", () => {
    const r = rig(turn);
    expect(textOf(one(r.view.tree, el => el.props.className === "chat-tool-note"))).toBe("+2 −1");
    expect(r.button().props["aria-expanded"]).toBe(false);
    expect(all(r.view.tree, el => el.type === DiffBlock)).toEqual([]);
    r.press();
    expect(r.button().props["aria-expanded"]).toBe(true);
    const diff = all(r.view.tree, el => el.type === DiffBlock) as Drawn[];
    expect(diff).toHaveLength(1);
    expect(diff[0].props.diff).toEqual(turn.diff);
    expect(r.pre("chat-tool-error")).toBeNull();
    expect(one(r.view.tree, el => el.props.className === "chat-tool-failed")).toBeNull();
  });

  it("keeps the running mark while the edit still waits", () => {
    const r = rig({ ...turn, running: true });
    expect(r.button().props["data-running"]).toBe(true);
  });

  it("draws the change's lines, and that it was cut", () => {
    const block = mount(DiffBlock, { diff: turn.diff! });
    const lines = all(block.tree, el => el.props.className === "chat-diff-line");
    expect(lines.map(el => [el.props["data-op"], textOf(el)])).toEqual([["ctx", " keep"], ["del", "-old"], ["add", "+new"], ["add", "+more"]]);
    expect(textOf(one(block.tree, el => el.props.className === "chat-diff-cut"))).toBe("The change is longer than shown here.");
  });
});

describe("a row with nothing to open", () => {
  it("stays the plain disclosure, with no button", () => {
    const r = mount(ToolRow, { turn: { kind: "tool", name: "Read", arg: "src/a.ts" } });
    expect(all(r.tree, el => el.type === "button")).toEqual([]);
    expect(one(r.tree, el => el.type === "details")).not.toBeNull();
  });

  it("an edit with an empty diff has no button either", () => {
    const r = mount(ToolRow, { turn: { kind: "tool", name: "Edit", arg: "a.ts", diff: { lines: [] } } });
    expect(all(r.tree, el => el.type === "button")).toEqual([]);
  });
});
