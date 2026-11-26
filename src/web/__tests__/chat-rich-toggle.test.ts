// The rich rows that answer a press: Copy says Copied for a moment and says it
// once to a screen reader, a command's row opens its output with how much was
// left out, and a thinking row opens what it thought. Each is a native
// <button type="button">, so Enter and Space press it as a click does. Drawn
// under the suite's stand-in React, which also follows the reader's language.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatCode, { COPIED_MS, CopyButton } from "../components/chat/ChatCode";
import { ToolRow } from "../components/chat/ChatTurn";
import { ToolOutputBlock, ToolPreview } from "../components/chat/ChatToolOutput";
import ThinkingRow from "../components/chat/ChatThinking";
import { TurnFooter } from "../components/chat/ChatTime";
import type { ChatTurn } from "../components/chat/chat-model";
import { copyText } from "../copy-text";
import { resetLanguageForTest, setLanguage } from "../i18n";
import { all, flush, mount, one, textOf } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../copy-text", () => ({ copyText: vi.fn(async () => true) }));

beforeEach(() => { resetLanguageForTest(); setLanguage("en"); vi.mocked(copyText).mockClear(); });
afterEach(() => { vi.useRealTimers(); setLanguage("en"); });

type Tool = Extract<ChatTurn, { kind: "tool" }>;

describe("Copy", () => {
  function rig(text = "npm test") {
    const view = mount(CopyButton, { text, label: "Copy code", className: "chat-code-copy" });
    const button = () => one(view.tree, el => el.type === "button")!;
    const status = () => one(view.tree, el => el.props.role === "status")!;
    return { view, button, status, press: () => (button().props.onClick as () => void)() };
  }

  it("is a real button named for what it copies", () => {
    const r = rig();
    expect(r.button().props.type).toBe("button");
    expect(r.button().props["aria-label"]).toBe("Copy code");
    expect(r.button().props["data-copied"]).toBeUndefined();
    expect(r.status().props["aria-live"]).toBe("polite");
    expect(textOf(r.status())).toBe("");
  });

  it("copies, says Copied for a moment, and once to a screen reader", async () => {
    vi.useFakeTimers();
    const r = rig("echo hi");
    r.press();
    await flush();
    expect(copyText).toHaveBeenCalledWith("echo hi");
    expect(r.button().props["data-copied"]).toBe(true);
    expect(r.button().props["aria-label"]).toBe("Copied");
    expect(textOf(r.status())).toBe("Copied");
    vi.advanceTimersByTime(COPIED_MS - 1);
    expect(r.button().props["data-copied"]).toBe(true);
    vi.advanceTimersByTime(1);
    expect(r.button().props["data-copied"]).toBeUndefined();
    expect(textOf(r.status())).toBe("");
  });

  it("says nothing when the copy failed", async () => {
    vi.mocked(copyText).mockResolvedValueOnce(false);
    const r = rig();
    r.press();
    await flush();
    expect(r.button().props["data-copied"]).toBeUndefined();
    expect(textOf(r.status())).toBe("");
  });

  it("on a code block copies the code without the fence's last line break", () => {
    const view = mount(ChatCode, { code: "const a = 1;\n", language: "ts" });
    const copy = one(view.tree, el => el.type === CopyButton)!;
    expect(copy.props.text).toBe("const a = 1;");
    expect(copy.props.label).toBe("Copy code");
  });
});

describe("a command's output", () => {
  const turn: Tool = {
    kind: "tool", name: "Bash", arg: "npm test", exit: 1, error: "Exit code 1",
    output: { text: "FAIL a.test.ts\n1 failed", lines: 40, cut: true },
  };

  it("opens under the row with the whole command, the preview gone while open", () => {
    const view = mount(ToolRow, { turn });
    const button = () => one(view.tree, el => el.type === "button")!;
    expect(button().props["aria-expanded"]).toBe(false);
    expect(all(view.tree, el => el.type === ToolPreview)).toHaveLength(1);
    expect(all(view.tree, el => el.type === ToolOutputBlock)).toEqual([]);
    (button().props.onClick as () => void)();
    expect(button().props["aria-expanded"]).toBe(true);
    const detail = one(view.tree, el => el.props.className === "chat-tool-detail")!;
    expect(button().props["aria-controls"]).toBe(detail.props.id);
    expect(textOf(one(detail, el => el.props.className === "chat-tool-input"))).toBe("npm test");
    expect(one(detail, el => el.type === ToolOutputBlock)!.props.output).toEqual(turn.output);
    expect(all(view.tree, el => el.type === ToolPreview)).toEqual([]);
  });

  it("is drawn wrapped, named, and says how much was left out", () => {
    const view = mount(ToolOutputBlock, { output: turn.output! });
    const pre = one(view.tree, el => el.type === "pre")!;
    expect(pre.props.className).toBe("chat-tool-output");
    expect(pre.props["aria-label"]).toBe("Output");
    expect(textOf(pre)).toBe("FAIL a.test.ts\n1 failed");
    expect(textOf(one(view.tree, el => el.props.className === "chat-tool-output-cut"))).toBe("Output cut — 38 more lines");
    const one_ = mount(ToolOutputBlock, { output: { text: "a", lines: 2, cut: true } });
    expect(textOf(one(one_.tree, el => el.props.className === "chat-tool-output-cut"))).toBe("Output cut — 1 more line");
    const budget = mount(ToolOutputBlock, { output: { text: "", lines: 12, cut: true } });
    expect(one(budget.tree, el => el.type === "pre")).toBeNull();
    expect(textOf(one(budget.tree, el => el.props.className === "chat-tool-output-cut"))).toBe("Output cut — 12 more lines");
  });
});

describe("a thinking row", () => {
  it("opens what it thought under itself, dimmed, and closes again", () => {
    const view = mount(ThinkingRow, { turn: { kind: "thinking", text: "Look at **routes**.", took: 6000, cut: true } });
    const button = () => one(view.tree, el => el.type === "button")!;
    const text = () => one(view.tree, el => el.props.className === "chat-thinking-text");
    expect(button().props.type).toBe("button");
    expect(text()).toBeNull();
    (button().props.onClick as () => void)();
    expect(button().props["aria-expanded"]).toBe(true);
    expect(button().props["aria-controls"]).toBe(text()!.props.id);
    expect(one(text(), el => el.props.text === "Look at **routes**.")).not.toBeNull();
    expect(textOf(one(text(), el => el.props.className === "chat-tool-output-cut"))).toBe("The rest of this thought is not kept here.");
    (button().props.onClick as () => void)();
    expect(text()).toBeNull();
  });
});

describe("in another language", () => {
  it("says the thought, the work and Copy in the reader's words", () => {
    setLanguage("ro");
    const thinking = mount(ThinkingRow, { turn: { kind: "thinking", took: 6000 } });
    expect(textOf(one(thinking.tree, el => el.props.className === "chat-thinking-label"))).toBe("A gândit 6 s");
    const footer = mount(TurnFooter, { time: { end: Date.now(), worked: 87_000 } });
    expect(textOf(footer.tree)).toContain("A lucrat 1 min 27 s");
    const code = mount(ChatCode, { code: "x", language: "sh" });
    expect(one(code.tree, el => el.type === CopyButton)!.props.label).toBe("Copiază codul");
    const output = mount(ToolOutputBlock, { output: { text: "a", lines: 21, cut: true } });
    expect(textOf(one(output.tree, el => el.props.className === "chat-tool-output-cut"))).not.toContain("Output");
  });
});
