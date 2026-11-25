// transcript-turns.mjs: what happened, beside what was said. The task list
// (TodoWrite) as a todo turn, a failed call's error, the change an edit made,
// an interruption or an API error as a notice, and a sub-agent as one line.
// The records are the shapes Claude Code 2.1 writes.
import { describe, expect, it } from "vitest";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { DIFF_GAP, MAX_AGENT_TEXT, MAX_DIFF_CHARS, MAX_DIFF_LINES, MAX_ERROR, MAX_NOTICE, MAX_TODO_TEXT, MAX_TODOS, transcriptTurns } from "../../server/transcript-turns.mjs";

const line = (o: unknown) => JSON.stringify(o);
const user = (content: unknown, extra: object = {}) => line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown[], extra: object = {}) => line({ type: "assistant", message: { content }, ...extra });
const call = (id: string, name: string, input: unknown, extra: object = {}) => assistant([{ type: "tool_use", id, name, input }], extra);
const answer = (id: string, content: unknown, extra: { is_error?: boolean; own?: unknown; sidechain?: boolean } = {}) => line({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(extra.is_error ? { is_error: true } : null) }] },
  ...(extra.own !== undefined ? { toolUseResult: extra.own } : null),
  ...(extra.sidechain ? { isSidechain: true } : null),
});
// What Claude Code 2.1 hands the model when you answer No at a permission prompt.
const DECLINE = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

describe("the task list", () => {
  const todos = [
    { content: "Read the routes", status: "completed", activeForm: "Reading the routes" },
    { content: "Add the limiter", status: "in_progress", activeForm: "Adding the limiter" },
    { content: "Write the tests", status: "pending", activeForm: "Writing the tests" },
  ];

  it("is a todo turn of the whole snapshot, done, active and pending", () => {
    expect(transcriptTurns([call("t1", "TodoWrite", { todos }), answer("t1", "Todos have been modified successfully.")])).toEqual([{
      kind: "todo",
      items: [
        { text: "Read the routes", status: "done" },
        { text: "Add the limiter", status: "active" },
        { text: "Write the tests", status: "pending" },
      ],
    }]);
  });

  it("is one turn per call, each the list as it stood, running or answered alike", () => {
    const later = todos.map(todo => ({ ...todo, status: "completed" }));
    const turns = transcriptTurns([call("t1", "TodoWrite", { todos }), answer("t1", "ok"), call("t2", "TodoWrite", { todos: later })]);
    expect(turns).toHaveLength(2);
    expect(turns[0].items.map((i: { status: string }) => i.status)).toEqual(["done", "active", "pending"]);
    expect(turns[1]).toEqual({ kind: "todo", items: later.map(t => ({ text: t.content, status: "done" })) });
    expect(turns[1].running).toBeUndefined();
  });

  it("reads activeForm when content is missing, skips items with no words, and an unknown status is pending", () => {
    const turns = transcriptTurns([call("t1", "TodoWrite", { todos: [
      { activeForm: "Only the active form", status: "in_progress" },
      { content: "   ", status: "pending" },
      null,
      "text",
      { content: "Odd status", status: "blocked" },
      { content: "Inherited name", status: "constructor" },
      { content: "No status" },
    ] })]);
    expect(turns[0].items).toEqual([
      { text: "Only the active form", status: "active" },
      { text: "Odd status", status: "pending" },
      { text: "Inherited name", status: "pending" },
      { text: "No status", status: "pending" },
    ]);
  });

  it("keeps at most MAX_TODOS items of at most MAX_TODO_TEXT characters", () => {
    const many = Array.from({ length: MAX_TODOS + 10 }, (_, i) => ({ content: `task ${i}`, status: "pending" }));
    const [turn] = transcriptTurns([call("t1", "TodoWrite", { todos: many })]);
    expect(turn.items).toHaveLength(MAX_TODOS);
    expect(turn.items.at(-1).text).toBe(`task ${MAX_TODOS - 1}`);
    const [long] = transcriptTurns([call("t1", "TodoWrite", { todos: [{ content: "x".repeat(MAX_TODO_TEXT + 40), status: "pending" }] })]);
    expect(long.items[0].text).toHaveLength(MAX_TODO_TEXT);
    expect(long.items[0].text.endsWith("…")).toBe(true);
  });

  it("an emptied list is a todo turn with no items", () => {
    expect(transcriptTurns([call("t1", "TodoWrite", { todos: [] })])).toEqual([{ kind: "todo", items: [] }]);
  });

  it("an input with no list stays a tool row", () => {
    expect(transcriptTurns([call("t1", "TodoWrite", { todo: "x" })])).toEqual([{ kind: "tool", name: "TodoWrite", arg: "", running: true }]);
    expect(transcriptTurns([call("t1", "TodoWrite", null)])[0].kind).toBe("tool");
  });
});

describe("a failed call", () => {
  it("stays a tool row and carries what the tool said", () => {
    const turns = transcriptTurns([
      call("b1", "Bash", { command: "npm test" }),
      answer("b1", "  Error: 3 tests failed\n  at run (test.js:1)  ", { is_error: true }),
    ]);
    expect(turns).toEqual([{ kind: "tool", name: "Bash", arg: "npm test", error: "Error: 3 tests failed\n  at run (test.js:1)" }]);
  });

  it("reads the error from text parts, and leaves off Claude Code's own wrapper", () => {
    const parts = transcriptTurns([call("b1", "Bash", { command: "x" }), answer("b1", [{ type: "text", text: "one" }, { type: "text", text: "two" }], { is_error: true })]);
    expect(parts[0].error).toBe("one\ntwo");
    const wrapped = transcriptTurns([
      call("r1", "Write", { file_path: "a.ts", content: "x" }),
      answer("r1", "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>", { is_error: true }),
    ]);
    expect(wrapped[0].error).toBe("File has not been read yet. Read it first before writing to it.");
  });

  it("cuts an error longer than MAX_ERROR with an ellipsis", () => {
    const [turn] = transcriptTurns([call("b1", "Bash", { command: "x" }), answer("b1", "e".repeat(MAX_ERROR + 100), { is_error: true })]);
    expect(turn.error).toHaveLength(MAX_ERROR);
    expect(turn.error.endsWith("…")).toBe(true);
  });

  it("says it failed even when the tool said nothing", () => {
    const [turn] = transcriptTurns([call("b1", "Bash", { command: "x" }), answer("b1", "", { is_error: true })]);
    expect(turn.error).toBe("");
  });

  it("has no error when it succeeded or still runs", () => {
    const turns = transcriptTurns([call("b1", "Bash", { command: "x" }), answer("b1", "fine"), call("b2", "Bash", { command: "y" })]);
    // CHANGED ON PURPOSE (Chat shows what happened): a command that succeeded carries what it printed and exit 0.
    expect(turns[0]).toEqual({ kind: "tool", name: "Bash", arg: "x", exit: 0, output: { text: "fine", lines: 1 } });
    expect(turns[1]).toEqual({ kind: "tool", name: "Bash", arg: "y", running: true });
  });
});

describe("a declined call", () => {
  it("says declined and carries no error, and an edit shows no change: nothing ran", () => {
    expect(transcriptTurns([call("b1", "Bash", { command: "rm -rf build" }), answer("b1", DECLINE, { is_error: true })]))
      .toEqual([{ kind: "tool", name: "Bash", arg: "rm -rf build", declined: true }]);
    const [edit] = transcriptTurns([
      call("e1", "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }),
      answer("e1", [{ type: "text", text: DECLINE }], { is_error: true }),
    ]);
    expect(edit.declined).toBe(true);
    expect(edit.error).toBeUndefined();
    expect(edit.diff).toBeUndefined();
    expect(edit.note).toBeUndefined();
  });

  it("is only an error that opens with Claude Code's sentence", () => {
    const quoted = transcriptTurns([call("b1", "Bash", { command: "x" }), answer("b1", `Error: ${DECLINE}`, { is_error: true })]);
    expect(quoted[0].declined).toBeUndefined();
    expect(quoted[0].error).toContain("Error: The user");
    const said = transcriptTurns([call("b1", "Bash", { command: "echo" }), answer("b1", DECLINE)])[0];
    expect(said.declined).toBeUndefined();
    expect(said.error).toBeUndefined();
    expect(said.exit).toBe(0);
  });
});

describe("an edit's change", () => {
  const PATCH = [
    { oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [" const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", " export {};"] },
    { oldStart: 40, oldLines: 2, newStart: 41, newLines: 1, lines: [" end();", "-old();"] },
  ];

  it("prefers the patch Claude Code recorded, its hunks parted by a … line, and counts it in the note", () => {
    const turns = transcriptTurns([
      call("e1", "Edit", { file_path: "src/a.ts", old_string: "const b = 2;", new_string: "const b = 3;\nconst c = 4;" }),
      answer("e1", "The file src/a.ts has been updated.", { own: { filePath: "src/a.ts", structuredPatch: PATCH } }),
    ]);
    expect(turns).toEqual([{
      kind: "tool", name: "Edit", arg: "src/a.ts", note: "+2 −2",
      // CHANGED ON PURPOSE (diff cards with line numbers): where each hunk starts rides with the lines.
      diff: { lines: [" const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", " export {};", DIFF_GAP, " end();", "-old();"],
        starts: [{ old: 10, new: 10 }, { old: 40, new: 41 }] },
    }]);
    expect(DIFF_GAP).toBe("…");
  });

  it("gives line numbers only when every hunk has them, and a written file starts at line 1", () => {
    const [partial] = transcriptTurns([
      call("e1", "Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }),
      answer("e1", "ok", { own: { structuredPatch: [PATCH[0], { lines: ["-x", "+y"] }] } }),
    ]);
    expect(partial.diff.starts).toBeUndefined();
    const [fromInput] = transcriptTurns([call("e2", "Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }), answer("e2", "ok")]);
    expect(fromInput.diff.starts).toBeUndefined();
    const [written] = transcriptTurns([call("w1", "Write", { file_path: "n.ts", content: "a\nb\n" })]);
    expect(written.diff).toEqual({ lines: ["+a", "+b"], starts: [{ old: 0, new: 1 }] });
  });

  it("reads the change from the input when there is no patch: what went as -, what came as +", () => {
    const turns = transcriptTurns([
      call("e1", "Edit", { file_path: "src/a.ts", old_string: "a\nb\n", new_string: "a\nc\nd\n" }),
      answer("e1", "ok"),
    ]);
    expect(turns[0]).toMatchObject({ note: "+3 −2", diff: { lines: ["-a", "-b", "+a", "+c", "+d"] } });
    expect(turns[0].diff.cut).toBeUndefined();
  });

  it("shows a running edit's change from its input, so a waiting prompt can be read in Chat", () => {
    const [turn] = transcriptTurns([call("e1", "Edit", { file_path: "a.ts", old_string: "x", new_string: "y" })]);
    expect(turn).toEqual({ kind: "tool", name: "Edit", arg: "a.ts", running: true, note: "+1 −1", diff: { lines: ["-x", "+y"] } });
  });

  it("joins a MultiEdit's edits with a … line", () => {
    const [turn] = transcriptTurns([call("m1", "MultiEdit", { file_path: "a.ts", edits: [
      { old_string: "one", new_string: "1" },
      { old_string: "", new_string: "" },
      { old_string: "two", new_string: "2\n2b" },
    ] }), answer("m1", "ok")]);
    expect(turn.diff.lines).toEqual(["-one", "+1", DIFF_GAP, "-two", "+2", "+2b"]);
    expect(turn.note).toBe("+3 −2");
  });

  it("draws a written file as all +, from its content when the new file has no patch", () => {
    const [created] = transcriptTurns([
      call("w1", "Write", { file_path: "new.ts", content: "line 1\nline 2\n" }),
      answer("w1", "File created successfully at: new.ts", { own: { type: "create", filePath: "new.ts", structuredPatch: [] } }),
    ]);
    expect(created).toMatchObject({ note: "+2 −0", diff: { lines: ["+line 1", "+line 2"] } });
    const [updated] = transcriptTurns([
      call("w1", "Write", { file_path: "old.ts", content: "b" }),
      answer("w1", "The file old.ts has been updated.", { own: { type: "update", structuredPatch: [{ lines: ["-a", "+b"] }] } }),
    ]);
    expect(updated).toMatchObject({ note: "+1 −1", diff: { lines: ["-a", "+b"] } });
  });

  it("uses the input when the line answers several calls, since its record is not this call's", () => {
    const both = line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }, { type: "tool_result", tool_use_id: "e2", content: "ok" }] },
      toolUseResult: { structuredPatch: PATCH },
    });
    const turns = transcriptTurns([
      assistant([
        { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } },
        { type: "tool_use", id: "e2", name: "Edit", input: { file_path: "b.ts", old_string: "p", new_string: "q" } },
      ]),
      both,
    ]);
    expect(turns.map((t: { diff: { lines: string[] } }) => t.diff.lines)).toEqual([["-x", "+y"], ["-p", "+q"]]);
  });

  it("stops at MAX_DIFF_LINES and says so, while the note counts the whole change", () => {
    const content = Array.from({ length: MAX_DIFF_LINES + 50 }, (_, i) => `l${i}`).join("\n");
    const [turn] = transcriptTurns([call("w1", "Write", { file_path: "big.ts", content }), answer("w1", "ok")]);
    expect(turn.diff.lines).toHaveLength(MAX_DIFF_LINES);
    expect(turn.diff.cut).toBe(true);
    expect(turn.note).toBe(`+${MAX_DIFF_LINES + 50} −0`);
  });

  it("stops at MAX_DIFF_CHARS, cutting a line that would not fit", () => {
    const content = Array.from({ length: 20 }, () => "y".repeat(1000)).join("\n");
    const [turn] = transcriptTurns([call("w1", "Write", { file_path: "wide.ts", content }), answer("w1", "ok")]);
    expect(turn.diff.cut).toBe(true);
    expect(turn.diff.lines.join("").length).toBeLessThanOrEqual(MAX_DIFF_CHARS);
    expect(turn.diff.lines.at(-1).endsWith("…")).toBe(true);
    // One minified line longer than the whole budget still shows its start.
    const [one] = transcriptTurns([call("w2", "Write", { file_path: "min.js", content: "z".repeat(MAX_DIFF_CHARS * 2) }), answer("w2", "ok")]);
    expect(one.diff.lines).toHaveLength(1);
    expect(one.diff.lines[0]).toHaveLength(MAX_DIFF_CHARS);
    expect(one.diff.cut).toBe(true);
    expect(one.note).toBe("+1 −0");
  });

  it("is left out when the edit failed: nothing changed", () => {
    const [turn] = transcriptTurns([
      call("e1", "Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }),
      answer("e1", "<tool_use_error>String to replace not found in file.</tool_use_error>", { is_error: true }),
    ]);
    expect(turn).toEqual({ kind: "tool", name: "Edit", arg: "a.ts", error: "String to replace not found in file." });
  });

  it("is left out when there is nothing to show, and for tools that do not edit", () => {
    expect(transcriptTurns([call("e1", "Edit", { file_path: "a.ts", old_string: "", new_string: "" })])[0].diff).toBeUndefined();
    expect(transcriptTurns([call("e1", "Edit", null)])[0].note).toBeUndefined();
    const [read] = transcriptTurns([call("r1", "Read", { file_path: "a.ts", content: "x" }), answer("r1", "x", { own: { structuredPatch: PATCH } })]);
    expect(read).toEqual({ kind: "tool", name: "Read", arg: "a.ts" });
  });
});

describe("an interruption", () => {
  it("is a notice turn after what it cut short, never what you said", () => {
    const turns = transcriptTurns([
      user("fix the tests"),
      assistant([{ type: "text", text: "Looking." }]),
      user([{ type: "text", text: "[Request interrupted by user]" }]),
      user("try again"),
    ]);
    expect(turns).toEqual([
      { kind: "user", text: "fix the tests" },
      { kind: "assistant", text: "Looking." },
      { kind: "notice", what: "interrupted" },
      { kind: "user", text: "try again" },
    ]);
  });

  it("two in a row are one, a tool's answer between them included; apart, they are two", () => {
    const rejected = "The user doesn't want to proceed with this tool use. The tool use was rejected.";
    const turns = transcriptTurns([
      call("b1", "Bash", { command: "rm -r build" }),
      user([{ type: "text", text: "[Request interrupted by user for tool use]" }]),
      answer("b1", rejected, { is_error: true }),
      user("[Request interrupted by user]"),
    ]);
    expect(turns).toEqual([
      // Esc at the permission prompt: the call was declined, not failed.
      { kind: "tool", name: "Bash", arg: "rm -r build", declined: true },
      { kind: "notice", what: "interrupted" },
    ]);
    const apart = transcriptTurns([user("[Request interrupted by user]"), user("go on"), user("[Request interrupted by user]")]);
    expect(apart.map((t: { kind: string }) => t.kind)).toEqual(["notice", "user", "notice"]);
  });
});

describe("an API error", () => {
  it("is a notice with its first line, not the assistant's prose", () => {
    const turns = transcriptTurns([
      user("hello"),
      assistant([{ type: "text", text: "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\nRetry later." }], { isApiErrorMessage: true }),
    ]);
    expect(turns).toEqual([
      { kind: "user", text: "hello" },
      { kind: "notice", what: "error", text: "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}" },
    ]);
  });

  it("cuts the line at MAX_NOTICE, and has no text when the record says nothing", () => {
    const [long] = transcriptTurns([assistant([{ type: "text", text: `API Error: 401 ${"k".repeat(400)}` }], { isApiErrorMessage: true })]);
    expect(long.text).toHaveLength(MAX_NOTICE);
    expect(long.text.endsWith("…")).toBe(true);
    expect(transcriptTurns([assistant([], { isApiErrorMessage: true })])).toEqual([{ kind: "notice", what: "error" }]);
    expect(transcriptTurns([line({ type: "assistant", isApiErrorMessage: true, message: { content: "\n  API Error: 401 Invalid API key" } })]))
      .toEqual([{ kind: "notice", what: "error", text: "API Error: 401 Invalid API key" }]);
  });

  it("an assistant line not flagged stays prose, whatever it says", () => {
    expect(transcriptTurns([assistant([{ type: "text", text: "API Error: is a phrase I can say" }])])).toEqual([{ kind: "assistant", text: "API Error: is a phrase I can say" }]);
  });
});

describe("a sub-agent", () => {
  const input = { description: "Find the auth code", prompt: "Look through src/ for the login flow.", subagent_type: "Explore" };

  it("is one agent turn, running until its answer comes", () => {
    expect(transcriptTurns([call("a1", "Agent", input)])).toEqual([{ kind: "agent", type: "Explore", description: "Find the auth code", running: true }]);
  });

  it("is done once answered, and failed when the answer is an error", () => {
    expect(transcriptTurns([call("a1", "Agent", input), answer("a1", [{ type: "text", text: "Found it in src/auth.ts" }])]))
      .toEqual([{ kind: "agent", type: "Explore", description: "Find the auth code" }]);
    expect(transcriptTurns([call("a1", "Agent", input), answer("a1", "Agent crashed", { is_error: true })]))
      .toEqual([{ kind: "agent", type: "Explore", description: "Find the auth code", failed: true }]);
  });

  it("declined at its prompt is declined, not failed", () => {
    expect(transcriptTurns([call("a1", "Agent", input), answer("a1", DECLINE, { is_error: true })]))
      .toEqual([{ kind: "agent", type: "Explore", description: "Find the auth code", declined: true }]);
  });

  it("started in the background is launched, not done: by its record, or by its answer's words", () => {
    const launched = "Async agent launched successfully. (This tool result is internal metadata.)";
    expect(transcriptTurns([call("a1", "Agent", { ...input, run_in_background: true }), answer("a1", [{ type: "text", text: launched }])])[0])
      .toEqual({ kind: "agent", type: "Explore", description: "Find the auth code", background: true });
    const own = { status: "async_launched", agentId: "a-1", description: "Find the auth code" };
    expect(transcriptTurns([call("a1", "Agent", input), answer("a1", "Launched.", { own })])[0].background).toBe(true);
    expect(transcriptTurns([call("a1", "Agent", input), answer("a1", "Done: the agent launched the build.")])[0].background).toBeUndefined();
  });

  it("older versions call it Task", () => {
    expect(transcriptTurns([call("a1", "Task", { ...input, subagent_type: "general-purpose" })])[0])
      .toEqual({ kind: "agent", type: "general-purpose", description: "Find the auth code", running: true });
  });

  it("has an empty type when none was given, and falls back to the prompt's first line", () => {
    expect(transcriptTurns([call("a1", "Agent", { prompt: "\n  Count the routes\nand list them" }), answer("a1", "ok")])[0])
      .toEqual({ kind: "agent", type: "", description: "Count the routes" });
    expect(transcriptTurns([call("a1", "Agent", null)])[0]).toEqual({ kind: "agent", type: "", description: "", running: true });
  });

  it("cuts the description at MAX_AGENT_TEXT", () => {
    const [turn] = transcriptTurns([call("a1", "Agent", { ...input, description: "d".repeat(MAX_AGENT_TEXT + 30) })]);
    expect(turn.description).toHaveLength(MAX_AGENT_TEXT);
    expect(turn.description.endsWith("…")).toBe(true);
  });

  it("its own lines stay out: sidechain calls, text, task lists and errors", () => {
    const turns = transcriptTurns([
      call("a1", "Agent", input),
      assistant([{ type: "text", text: "I will grep." }], { isSidechain: true }),
      call("s1", "Bash", { command: "grep -r login src" }, { isSidechain: true }),
      answer("s1", "src/auth.ts: login()", { sidechain: true }),
      call("s2", "TodoWrite", { todos: [{ content: "x", status: "pending" }] }, { isSidechain: true }),
      call("s3", "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, { isSidechain: true }),
      assistant([{ type: "text", text: "API Error: 529" }], { isSidechain: true, isApiErrorMessage: true }),
      user("[Request interrupted by user]", { isSidechain: true }),
      answer("a1", "Found it."),
    ]);
    expect(turns).toEqual([{ kind: "agent", type: "Explore", description: "Find the auth code" }]);
  });

  it("is answered by its own id only", () => {
    expect(transcriptTurns([call("a1", "Agent", input), answer("a2", "Found it.")])[0].running).toBe(true);
  });
});
