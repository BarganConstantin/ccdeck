// What Chat draws beside the words, from what the transcript now sends: how a
// command ended and what it printed, what a call counted, an edit's change
// numbered in a gutter, the assistant's thinking, a run of calls summed up by
// kind, and when things were said ("Worked for 1m 27s · 15:56"). Drawn here as
// the page first shows them; opening a row is chat-rich-toggle.test.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import ChatView from "../components/chat/ChatView";
import { AssistantBlock, ToolGroup, ToolRow, YourMessage } from "../components/chat/ChatTurn";
import DiffBlock, { diffRows } from "../components/chat/ChatDiff";
import ThinkingRow from "../components/chat/ChatThinking";
import { TurnFooter } from "../components/chat/ChatTime";
import {
  blockTimes, clockText, durationText, exitState, fullTime, linesLeft, outputPreview, statText, workCounts, workSummary,
} from "../components/chat/chat-rich";
import { conversationBlocks, type ChatActivity, type ChatSource, type ChatTurn } from "../components/chat/chat-model";
import { setLanguage, t } from "../i18n";
import { words } from "./screens-fixtures";

type Tool = Extract<ChatTurn, { kind: "tool" }>;

afterEach(() => setLanguage("en"));

const draw = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const row = (turn: Tool) => draw(createElement(ToolRow, { turn }));
/** 15:56 on 25 November 2026, on this machine's clock. */
const AT = new Date(2026, 10, 25, 15, 56, 0).getTime();

const TESTS: Tool = {
  kind: "tool", name: "Bash", arg: "npm test", exit: 0,
  output: { text: "\n> vitest run\n\n ✓ 42 tests\nTests  42 passed (42)\n", lines: 5 },
};

describe("a command's row", () => {
  it("wears a quiet exit 0 chip and previews the output's last line while closed", () => {
    const markup = row(TESTS);
    expect(markup).toMatch(/^<div class="chat-tool-call"><button type="button" class="chat-tool chat-tool-toggle" aria-expanded="false">/);
    expect(markup).toContain('<span class="chat-exit" data-state="ok" title="Exit code 0">exit 0</span>');
    expect(markup).toContain('<span class="chat-tool-preview" aria-hidden="true">Tests  42 passed (42)</span>');
    // Closed, the output itself is not drawn.
    expect(markup).not.toContain("chat-tool-output");
    expect(markup).not.toContain("chat-tool-failed");
  });

  it("says a non-zero exit on its chip, where Failed would be", () => {
    const markup = row({ ...TESTS, exit: 2, error: "Exit code 2\nboom", output: undefined });
    expect(markup).toContain('<span class="chat-exit" data-state="failed" title="Exit code 2">exit 2</span>');
    expect(markup).not.toContain("chat-tool-failed");
  });

  it("says Interrupted when it was stopped, and Failed when no code is known", () => {
    expect(row({ ...TESTS, exit: undefined, interrupted: true })).toContain('<span class="chat-exit" data-state="interrupted">Interrupted</span>');
    const unknown = row({ kind: "tool", name: "Bash", arg: "npm test", error: "Error: 3 tests failed" });
    expect(unknown).toContain('<span class="chat-tool-failed">Failed</span>');
    expect(unknown).not.toContain("chat-exit");
  });

  it("previews nothing while it still runs, and its first line when the output was cut", () => {
    expect(row({ ...TESTS, running: true })).not.toContain("chat-tool-preview");
    expect(outputPreview({ text: "first\nsecond\n", lines: 900, cut: true })).toBe("first");
    expect(outputPreview({ text: "  \n", lines: 1 })).toBe("");
    expect(outputPreview(undefined)).toBe("");
  });

  it("is a plain row with nothing to open when it printed nothing", () => {
    const markup = row({ kind: "tool", name: "Bash", arg: "true", exit: 0 });
    expect(markup).toMatch(/^<details class="chat-tool-call">/);
    expect(markup).toContain('data-state="ok"');
  });

  it("is read the same way from a Codex shell call", () => {
    const markup = row({ kind: "tool", name: "exec_command", mark: "terminal", arg: "ls", exit: 0, output: { text: "a\nb", lines: 2 } });
    expect(markup).toContain('<span class="chat-tool-preview" aria-hidden="true">b</span>');
  });
});

describe("what another call counted", () => {
  it("is a quiet figure on the row", () => {
    expect(row({ kind: "tool", name: "Read", arg: "src/a.ts", stat: { lines: 182 } })).toContain('<span class="chat-tool-note chat-tool-stat">182 lines</span>');
    expect(row({ kind: "tool", name: "Grep", arg: "limit", stat: { matches: 12, files: 3 } })).toContain(">12 matches · 3 files<");
    expect(row({ kind: "tool", name: "WebFetch", arg: "https://example.test", stat: { status: 200, bytes: 48_128 } })).toContain(">200 · 47 KB<");
    expect(row({ kind: "tool", name: "WebSearch", arg: "vitest", stat: { results: 1 } })).toContain(">1 result<");
  });

  it("never draws a figure over the row's own note", () => {
    const markup = row({ kind: "tool", name: "Edit", arg: "a.ts", note: "+1 −0", stat: { lines: 3 }, diff: { lines: ["+x"] } });
    expect(markup).not.toContain("chat-tool-stat");
  });

  it("is said in words, sizes in B, KB and MB", () => {
    expect(statText(undefined, t)).toBe("");
    expect(statText({ lines: 1 }, t)).toBe("1 line");
    expect(statText({ files: 0 }, t)).toBe("0 files");
    expect(statText({ bytes: 512 }, t)).toBe("512 B");
    expect(statText({ bytes: 3 * 1024 * 1024 }, t)).toBe("3 MB");
  });

  it("counts the output's lines that are not shown", () => {
    expect(linesLeft({ text: "a\nb", lines: 40 })).toBe(38);
    expect(linesLeft({ text: "a\nb", lines: 2 })).toBe(0);
    expect(linesLeft({ text: "", lines: 7, cut: true })).toBe(7);
  });

  it("reads how a command ended", () => {
    expect(exitState({ ...TESTS })).toBe("ok");
    expect(exitState({ ...TESTS, exit: 1 })).toBe("failed");
    expect(exitState({ ...TESTS, interrupted: true })).toBe("interrupted");
    expect(exitState({ kind: "tool", name: "Read", arg: "a" })).toBeNull();
  });
});

describe("an edit's change", () => {
  const DIFF = { lines: [" keep", "-old", "+new", "+more", "…", " far", "-gone"], starts: [{ old: 10, new: 10 }, { old: 40, new: 41 }] };

  it("numbers each line in a gutter: kept and added by the new file, removed by the old", () => {
    expect(diffRows(DIFF).map(r => [r.op, r.n])).toEqual([
      ["ctx", 10], ["del", 11], ["add", 11], ["add", 12], ["gap", undefined], ["ctx", 41], ["del", 41],
    ]);
    const markup = draw(createElement(DiffBlock, { diff: DIFF, path: "src/limit.ts" }));
    expect(markup).toMatch(/^<pre class="chat-diff" data-numbered="true"><code>/);
    expect(markup).toContain('<span class="chat-diff-line" data-op="del"><span class="chat-diff-num" aria-hidden="true" data-n="11"></span><span class="chat-diff-sign">-</span>');
    expect(markup).toContain('<span class="chat-diff-line" data-op="gap"><span class="chat-diff-num" aria-hidden="true" data-n=""></span><span class="chat-diff-sign">…</span><span class="chat-diff-text"></span></span>');
  });

  it("colours the code by the file's extension, and leaves it plain for an unknown one", () => {
    const ts = draw(createElement(DiffBlock, { diff: { lines: ["+const a = 1;"] }, path: "src/a.ts" }));
    expect(ts).toContain('<span class="chat-diff-text"><span class="hl-kw">const</span> a = <span class="hl-num">1</span>;</span>');
    expect(draw(createElement(DiffBlock, { diff: { lines: ["+const a = 1;"] }, path: "Makefile" }))).not.toContain("hl-");
  });

  it("draws no gutter when the hunks' starts are not known", () => {
    const markup = draw(createElement(DiffBlock, { diff: { lines: [" a", "+b"] } }));
    expect(markup).toMatch(/^<pre class="chat-diff"><code>/);
    expect(markup).not.toContain("chat-diff-num");
  });

  it("tints its counts on the closed row", () => {
    expect(row({ kind: "tool", name: "Edit", arg: "a.ts", note: "+12 −3", diff: { lines: ["+x"] } }))
      .toContain('<span class="chat-tool-note"><span class="chat-diff-plus">+12</span> <span class="chat-diff-minus">−3</span></span>');
  });
});

describe("thinking", () => {
  it("is one quiet row that opens what it thought, closed at first", () => {
    const markup = draw(createElement(ThinkingRow, { turn: { kind: "thinking", text: "Check the **routes** first.", took: 6_200 } }));
    expect(markup).toMatch(/^<div class="chat-tool-call"><button type="button" class="chat-tool chat-tool-toggle chat-thinking" aria-expanded="false">/);
    expect(markup).toContain('<span class="chat-thinking-label">Thought for 6s</span>');
    expect(markup).not.toContain("chat-thinking-text");
    expect(words(markup)).not.toContain("routes");
  });

  it("says Thought when the time is not known, and has nothing to open without its text", () => {
    const empty = draw(createElement(ThinkingRow, { turn: { kind: "thinking" } }));
    expect(empty).toMatch(/^<div class="chat-tool chat-thinking" data-empty="">/);
    expect(empty).toContain('<span class="chat-thinking-label">Thought</span>');
    expect(empty).not.toContain("<button");
  });

  it("folds into a run of calls, and stands alone beside prose", () => {
    const group = draw(createElement(ToolGroup, { turns: [{ kind: "thinking", took: 2000 }, TESTS] }));
    expect(group).toContain("Thought for 2s");
    expect(words(group)).toContain("Ran 1 command");
    const alone = draw(createElement(AssistantBlock, { turns: [{ kind: "thinking", took: 3000 }, { kind: "assistant", text: "Done." }] }));
    expect(alone).not.toContain("chat-activity");
    expect(alone).toContain("Thought for 3s");
  });
});

describe("a run of calls", () => {
  const read = (arg: string): Tool => ({ kind: "tool", name: "Read", arg });
  const RUN: ChatTurn[] = [
    TESTS, { ...TESTS, arg: "npm run lint" }, { ...TESTS, arg: "git status" }, read("a.ts"), read("b.ts"), read("a.ts"),
    { kind: "tool", name: "Edit", arg: "a.ts", note: "+1 −0" }, { kind: "todo", items: [] },
  ];

  it("is summed up by kind, each file counted once", () => {
    expect(workSummary(RUN, t)).toBe("Ran 3 commands · read 2 files · edited 1 file");
    expect(workCounts(RUN).get("read")).toBe(2);
    expect(draw(createElement(ToolGroup, { turns: RUN as never }))).toContain('<span class="chat-work">Ran 3 commands · read 2 files · edited 1 file</span>');
  });

  it("names three kinds at most, the largest two in their fixed order, the rest as other calls", () => {
    const many: ChatTurn[] = [TESTS, read("a"), { kind: "tool", name: "Grep", arg: "x" }, { kind: "tool", name: "Grep", arg: "y" },
      { kind: "tool", name: "WebFetch", arg: "u" }, { kind: "tool", name: "mcp__x__y", arg: "" }];
    expect(workSummary(many, t)).toBe("Ran 1 command · searched 2 times · made 3 other calls");
    expect(workSummary([{ kind: "tool", name: "WebSearch", arg: "q" }], t)).toBe("Browsed the web once");
  });

  it("is said in the language's own plural forms", () => {
    setLanguage("ro");
    expect(workSummary(RUN, t)).toBe("A rulat 3 comenzi · a citit 2 fișiere · a editat 1 fișier");
    const twenty = Array.from({ length: 20 }, (_, i): ChatTurn => read(`f${i}`));
    expect(workSummary(twenty, t)).toBe("A citit 20 de fișiere");
  });
});

describe("when things were said", () => {
  it("says a span the way Chat does", () => {
    expect(durationText(400, t)).toBe("1s");
    expect(durationText(6_200, t)).toBe("6s");
    expect(durationText(87_000, t)).toBe("1m 27s");
    expect(durationText(2 * 3600_000 + 5 * 60_000, t)).toBe("2h 05m");
  });

  it("puts your message's time and Copy under it, the whole date in the title", () => {
    const markup = draw(createElement(YourMessage, { text: "Add rate limits", at: AT }));
    expect(markup).toContain(`<div class="chat-meta"><time dateTime="${new Date(AT).toISOString()}" title="${fullTime(AT)}">${clockText(AT)}</time>`);
    expect(markup).toContain('<button type="button" class="chat-meta-copy" aria-label="Copy message" title="Copy message">');
    expect(draw(createElement(YourMessage, { text: "", images: 1 }))).not.toContain("chat-meta");
  });

  it("ends an answer with how long it worked and when", () => {
    const markup = draw(createElement(TurnFooter, { time: { end: AT, worked: 87_000 } }));
    expect(markup).toBe(`<p class="chat-turn-foot"><span>Worked for 1m 27s</span><span aria-hidden="true"> · </span><time dateTime="${new Date(AT).toISOString()}" title="${fullTime(AT)}">${clockText(AT)}</time></p>`);
    // Under a second is not worth saying.
    expect(draw(createElement(TurnFooter, { time: { end: AT, worked: 300 } }))).not.toContain("Worked for");
  });

  it("times each answer from your message before it to its last line", () => {
    const turns: ChatTurn[] = [
      { kind: "user", text: "go", at: AT - 87_000 }, { kind: "assistant", text: "On it.", at: AT - 80_000 }, { ...TESTS, at: AT },
      { kind: "user", text: "again" }, { kind: "assistant", text: "Done.", at: AT + 5_000 },
      { kind: "assistant", text: "", at: undefined },
    ];
    const blocks = conversationBlocks(turns);
    const times = blockTimes(blocks);
    const answers = blocks.filter(b => b.kind === "assistant");
    expect(times.get(answers[0].index)).toEqual({ end: AT, worked: 87_000 });
    // No time on the message before it: when it ended, but not how long it took.
    expect(times.get(answers[1].index)).toEqual({ end: AT + 5_000 });
  });

  it("draws the footer under every answer but the one still being written", () => {
    const turns: ChatTurn[] = [
      { kind: "user", text: "go", at: AT - 60_000 }, { kind: "assistant", text: "First.", at: AT },
      { kind: "user", text: "more", at: AT + 1_000 }, { kind: "assistant", text: "Second.", at: AT + 31_000 },
    ];
    const view = (activity?: ChatActivity) => draw(createElement(ChatView, { source: { state: "ready", turns } satisfies ChatSource, activity }));
    const idle = view();
    expect(idle.match(/class="chat-turn-foot"/g)).toHaveLength(2);
    expect(words(idle)).toContain("Worked for 1m 0s");
    expect(words(idle)).toContain("Worked for 30s");
    const busy = view({ state: "working" });
    expect(busy.match(/class="chat-turn-foot"/g)).toHaveLength(1);
    // The answer's start time sits beside its name, shown on hover or focus.
    expect(idle).toContain('class="chat-response-time"');
  });
});
