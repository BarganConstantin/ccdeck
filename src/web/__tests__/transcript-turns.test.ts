// transcript-turns.mjs: a transcript's lines as the turns Chat draws.
import { describe, expect, it } from "vitest";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { MAX_ARG, MAX_TEXT, MAX_TURNS, toolArg, transcriptTurns, transcriptWindow } from "../../server/transcript-turns.mjs";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { createOutputWatch } from "../../server/output-watch.mjs";

const line = (o: unknown) => JSON.stringify(o);
const user = (content: unknown, extra: object = {}) => line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown[], extra: object = {}) => line({ type: "assistant", message: { content }, ...extra });
const use = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const result = (id: string) => user([{ type: "tool_result", tool_use_id: id, content: "ok" }]);

describe("what becomes a turn", () => {
  it("a user line with a string, or with text parts", () => {
    expect(transcriptTurns([user("hello"), user([{ type: "text", text: "a" }, { type: "text", text: "b" }])]))
      .toEqual([{ kind: "user", text: "hello" }, { kind: "user", text: "a\nb" }]);
  });

  it("a user line that only carries a tool's answer makes none", () => {
    expect(transcriptTurns([result("t1")])).toEqual([]);
  });

  it("assistant text, in order with the tool calls beside it", () => {
    const turns = transcriptTurns([
      assistant([{ type: "text", text: "Looking." }, use("t1", "Read", { file_path: "src/a.ts" })]),
      result("t1"),
      assistant([{ type: "text", text: "Done." }]),
    ]);
    expect(turns).toEqual([
      { kind: "assistant", text: "Looking." },
      { kind: "tool", name: "Read", arg: "src/a.ts" },
      { kind: "assistant", text: "Done." },
    ]);
  });

  it("skips thinking blocks, sidechain lines and meta lines", () => {
    const turns = transcriptTurns([
      assistant([{ type: "thinking", thinking: "secret plan" }]),
      assistant([{ type: "text", text: "from a subagent" }], { isSidechain: true }),
      user("caveat text", { isMeta: true }),
      user("real"),
    ]);
    expect(turns).toEqual([{ kind: "user", text: "real" }]);
  });

  it("skips a line that is not JSON, and a torn last line", () => {
    expect(transcriptTurns(["", "not json", user("ok"), '{"type":"user","message":{"con'])).toEqual([{ kind: "user", text: "ok" }]);
  });

  it("marks a call with no answer in the window as running, and one with an answer as not", () => {
    const turns = transcriptTurns([
      assistant([use("t1", "Bash", { command: "npm test" }), use("t2", "Read", { file_path: "a" })]),
      result("t1"),
    ]);
    expect(turns[0]).toEqual({ kind: "tool", name: "Bash", arg: "npm test" });
    expect(turns[1]).toEqual({ kind: "tool", name: "Read", arg: "a", running: true });
  });
});

describe("what Claude Code wrote for itself is not what you typed", () => {
  it("skips a compaction summary, flagged or following the boundary", () => {
    const summary = "This session is being continued from a previous conversation that ran out of context. ".repeat(20);
    expect(transcriptTurns([user(summary, { isCompactSummary: true }), user("real")])).toEqual([{ kind: "user", text: "real" }]);
    expect(transcriptTurns([
      line({ type: "system", subtype: "compact_boundary" }), user(summary), user("real"),
    ])).toEqual([{ kind: "user", text: "real" }]);
    // The same words typed by a person, with no boundary before them, are theirs.
    expect(transcriptTurns([user(summary)])).toHaveLength(1);
  });

  it("skips user text made only of a slash command's wrappers or a local command's output", () => {
    const wrapped = [
      "<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>",
      "<command-name>/model</command-name>\n<command-args>opus</command-args>",
      "<local-command-stdout>Set model to opus</local-command-stdout>",
      "<local-command-stderr>oops</local-command-stderr>",
    ];
    expect(transcriptTurns(wrapped.map(w => user(w)))).toEqual([]);
    expect(transcriptTurns([user([{ type: "text", text: wrapped[2] }])])).toEqual([]);
  });

  it("keeps what a person typed beside a wrapper", () => {
    expect(transcriptTurns([user("<command-name>/x</command-name> and then this")])).toEqual([{ kind: "user", text: "and then this" }]);
  });

  it("skips an interruption note, as text or as a part", () => {
    expect(transcriptTurns([
      user("[Request interrupted by user]"),
      user([{ type: "text", text: "[Request interrupted by user for tool use]" }]),
    ])).toEqual([]);
  });
});

describe("the one-line argument", () => {
  it("is tried in the order command, file_path, path, pattern, url, description", () => {
    const all = { description: "d", url: "u", pattern: "p", path: "pa", file_path: "f", command: "c" };
    const order = ["command", "file_path", "path", "pattern", "url", "description"] as const;
    const left: Record<string, string> = { ...all };
    for (const field of order) {
      expect(toolArg(left)).toBe(all[field]);
      delete left[field];
    }
    expect(toolArg(left)).toBe("");
  });

  it("keeps the first line only", () => {
    expect(toolArg({ command: "git status\ngit diff" })).toBe("git status");
    expect(toolArg({ command: "\n  first real line\nsecond" })).toBe("first real line");
  });

  it("is at most 120 characters, cut with an ellipsis", () => {
    const arg = toolArg({ command: "x".repeat(500) });
    expect(arg).toHaveLength(MAX_ARG);
    expect(arg.endsWith("…")).toBe(true);
    expect(toolArg({ command: "y".repeat(MAX_ARG) })).toBe("y".repeat(MAX_ARG));
  });

  it("ignores an input that is not an object and fields that are not text", () => {
    expect(toolArg(null)).toBe("");
    expect(toolArg("x")).toBe("");
    expect(toolArg({ command: 5, file_path: "f" })).toBe("f");
  });
});

describe("the caps", () => {
  it("cuts a text at 4000 characters with an ellipsis", () => {
    const [turn] = transcriptTurns([user("a".repeat(MAX_TEXT + 50))]);
    expect(turn.text).toHaveLength(MAX_TEXT);
    expect(turn.text.endsWith("…")).toBe(true);
    const [same] = transcriptTurns([user("b".repeat(MAX_TEXT))]);
    expect(same.text).toBe("b".repeat(MAX_TEXT));
  });

  it("says whether the cap dropped turns from the front", () => {
    expect(transcriptWindow(Array.from({ length: MAX_TURNS }, (_, i) => user(`m${i}`))).cut).toBe(false);
    const over = transcriptWindow(Array.from({ length: MAX_TURNS + 1 }, (_, i) => user(`m${i}`)));
    expect(over.cut).toBe(true);
    expect(over.turns).toHaveLength(MAX_TURNS);
  });

  it("keeps the last 200 turns", () => {
    const turns = transcriptTurns(Array.from({ length: MAX_TURNS + 30 }, (_, i) => user(`m${i}`)));
    expect(turns).toHaveLength(MAX_TURNS);
    expect(turns[0].text).toBe("m30");
    expect(turns.at(-1).text).toBe(`m${MAX_TURNS + 29}`);
  });
});

describe("output-watch's pathOf, which the route asks", () => {
  it("is the path last noted, replaced on a change, and gone after forget and clear", () => {
    const watch = createOutputWatch();
    expect(watch.pathOf("a")).toBeUndefined();
    watch.note("a", "/p/one.jsonl");
    watch.note("b", "/p/two.jsonl");
    expect(watch.pathOf("a")).toBe("/p/one.jsonl");
    watch.note("a", "/p/moved.jsonl");
    expect(watch.pathOf("a")).toBe("/p/moved.jsonl");
    watch.forget("a");
    expect(watch.pathOf("a")).toBeUndefined();
    expect(watch.pathOf("b")).toBe("/p/two.jsonl");
    watch.clear();
    expect(watch.pathOf("b")).toBeUndefined();
  });

  it("knows nothing for a session with no id or no path", () => {
    const watch = createOutputWatch();
    watch.note("", "/p/x.jsonl");
    watch.note("c", "");
    expect(watch.size()).toBe(0);
    expect(watch.pathOf("c")).toBeUndefined();
  });
});
