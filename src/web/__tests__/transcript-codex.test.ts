// transcript-turns.mjs on a Codex rollout: each tool call as a row with how it
// went, the change an apply_patch makes, its plan as the task list, beside
// what was said. The records are the shapes Codex writes: function_call /
// function_call_output with JSON arguments and a bare-string result (0.144),
// custom_tool_call / custom_tool_call_output with a bare-string input and an
// array of input_text parts (0.144, 0.147), and the result head lines of
// 0.169's exec_command ("Chunk ID", "Wall time", "Process exited with code").
import { describe, expect, it } from "vitest";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { DIFF_GAP, MAX_ARG, MAX_ERROR, MAX_TURNS, codexTranscriptWindow } from "../../server/transcript-turns.mjs";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { codexObjToPayload, codexToolOutcome } from "../../server/codex-translate.mjs";
import { toolLabel } from "../components/chat/ChatTurn";

const line = (o: unknown) => JSON.stringify(o);
const item = (payload: object) => line({ type: "response_item", payload });
const event = (payload: object) => line({ type: "event_msg", payload });
const fn = (id: string, name: string, args: unknown) =>
  item({ type: "function_call", name, arguments: typeof args === "string" ? args : JSON.stringify(args), call_id: id });
const fnOut = (id: string, output: unknown) => item({ type: "function_call_output", call_id: id, output });
// `status` is the model's item status: "completed" even when the call failed.
const custom = (id: string, name: string, input: string) => item({ type: "custom_tool_call", name, input, call_id: id, status: "completed" });
const customOut = (id: string, ...texts: string[]) =>
  item({ type: "custom_tool_call_output", call_id: id, output: texts.map(text => ({ type: "input_text", text })) });
const turns = (...lines: string[]) => codexTranscriptWindow(lines).turns;
const one = (...lines: string[]) => turns(...lines)[0];

/** What 0.169's exec_command hands the model: its head lines, then the output. */
const unified = (code: number, output: string) =>
  `Chunk ID: 3f9a1c\nWall time: 0.5021 seconds\nProcess exited with code ${code}\nOriginal token count: 12\nOutput:\n${output}`;

const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/server/routes.ts",
  "@@ export function route",
  " const limit = 10;",
  "-const window = 60;",
  "+const window = 30;",
  "@@ export function other",
  "-old();",
  "+fresh();",
  "+more();",
  "*** End Patch",
].join("\n");

describe("a command", () => {
  it("is a row with its command and the terminal mark, plain when it exited 0", () => {
    expect(turns(
      fn("c1", "exec_command", { cmd: "npm test -- --reporter=dot", workdir: "/w", yield_time_ms: 10000 }),
      fnOut("c1", unified(0, "Tests 12 passed")),
    )).toEqual([{ kind: "tool", name: "exec_command", arg: "npm test -- --reporter=dot", mark: "terminal" }]);
  });

  it("failed when it exited non-zero, saying what it printed without Codex's head lines", () => {
    expect(one(fn("c1", "exec_command", { cmd: "npm test" }), fnOut("c1", unified(1, "FAIL src/a.test.ts\n  expected 2, got 3"))))
      .toEqual({ kind: "tool", name: "exec_command", arg: "npm test", mark: "terminal", error: "FAIL src/a.test.ts\n  expected 2, got 3" });
  });

  it("a negative exit (a signal) failed too", () => {
    expect(one(fn("c1", "exec_command", { cmd: "sleep 99" }), fnOut("c1", unified(-1, ""))).error).toContain("Process exited with code -1");
  });

  it("never fails on what the command printed: only the head lines over \"Output:\" count", () => {
    const printed = "Process exited with code 1\nExit code: 2\nScript failed\nunsupported call: x";
    expect(one(fn("c1", "exec_command", { cmd: "cat log" }), fnOut("c1", unified(0, printed))))
      .toEqual({ kind: "tool", name: "exec_command", arg: "cat log", mark: "terminal" });
    // A program that prints its own "Output:" far down is past the head.
    const deep = `${"line\n".repeat(8)}Output:\nProcess exited with code 9`;
    expect(one(fn("c2", "exec_command", { cmd: "./run" }), fnOut("c2", deep)).error).toBeUndefined();
  });

  it("a 0.144 result with no head line at all is a success, as the board reads it", () => {
    expect(one(fn("c1", "exec_command", { cmd: "ls" }), fnOut("c1", "a.ts\nb.ts")).error).toBeUndefined();
  });

  it("reads the command out of a shell's argv, and joins any other argv", () => {
    expect(one(fn("c1", "shell", { command: ["bash", "-lc", "git status --short"], workdir: "/w" }), fnOut("c1", "Exit code: 0\nOutput:\n")).arg)
      .toBe("git status --short");
    expect(one(fn("c1", "shell", { command: ["/bin/zsh", "-c", "make\nmake test"] })).arg).toBe("make");
    expect(one(fn("c1", "shell", { command: ["powershell.exe", "-NoProfile", "-Command", "Get-ChildItem"] })).arg).toBe("Get-ChildItem");
    expect(one(fn("c1", "shell", { command: ["rg", "-n", "TODO", "src"] })).arg).toBe("rg -n TODO src");
  });

  it("shell_command carries its command as a string", () => {
    expect(one(fn("c1", "shell_command", { command: "cd src && ls" }), fnOut("c1", "a.ts"))).toEqual({
      kind: "tool", name: "shell_command", arg: "cd src && ls", mark: "terminal",
    });
  });

  it("the older shell tool's JSON envelope counts its exit code", () => {
    const envelope = (code: number) => JSON.stringify({ output: "boom: not found", metadata: { exit_code: code, duration_seconds: 0.1 } });
    expect(one(fn("c1", "shell", { command: ["bash", "-lc", "boom"] }), fnOut("c1", envelope(127))).error).toBe("boom: not found");
    expect(one(fn("c1", "shell", { command: ["bash", "-lc", "boom"] }), fnOut("c1", envelope(0))).error).toBeUndefined();
  });

  it("a local_shell_call is a row of its argv", () => {
    expect(turns(
      item({ type: "local_shell_call", call_id: "l1", status: "completed", action: { type: "exec", command: ["bash", "-lc", "pwd"] } }),
      fnOut("l1", "Exit code: 0\nWall time: 0 seconds\nOutput:\n/w"),
    )).toEqual([{ kind: "tool", name: "local_shell", arg: "pwd", mark: "terminal" }]);
  });

  it("an exec script is a row of the command it hands tools.exec_command", () => {
    const script = 'const r = await tools.exec_command({ cmd: "git log --oneline -3", yield_time_ms: 1000 });\ntext(r.output);';
    expect(turns(custom("x1", "exec", script), customOut("x1", "Script completed\nWall time 0.2 seconds\nOutput:\n", "a1 one")))
      .toEqual([{ kind: "tool", name: "exec", arg: "git log --oneline -3", mark: "terminal" }]);
  });

  it("an exec script that failed says so, and one that runs no command names the tool it calls", () => {
    const failed = one(custom("x1", "exec", 'await tools.exec_command({ cmd: "false" });'), customOut("x1", "Script failed\nWall time 0.1 seconds\nOutput:\nError: exit 1"));
    expect(failed).toMatchObject({ name: "exec", arg: "false", error: "Error: exit 1" });
    expect(one(custom("x2", "exec", "const p = await tools.web__run({ search_query: [] });")).arg).toBe("web__run");
    expect(one(custom("x3", "exec", "\n  console.log(1)\n")).arg).toBe("console.log(1)");
  });
});

describe("an apply_patch", () => {
  it("is a row of its file with the change as diff lines and their count", () => {
    expect(turns(custom("p1", "apply_patch", PATCH), customOut("p1", "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM src/server/routes.ts\n")))
      .toEqual([{
        kind: "tool", name: "apply_patch", arg: "src/server/routes.ts", note: "+3 −2",
        diff: { lines: [" const limit = 10;", "-const window = 60;", "+const window = 30;", DIFF_GAP, "-old();", "+fresh();", "+more();"] },
      }]);
  });

  it("names every file it touches; an added file is all \"+\", a deleted one has no lines", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: docs/new.md",
      "+# New",
      "+",
      "+Text.",
      "*** Delete File: docs/old.md",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@",
      "-a",
      "+b",
      "*** End of File",
      "*** End Patch",
    ].join("\n");
    expect(one(custom("p1", "apply_patch", patch), customOut("p1", "Exit code: 0\nOutput:\n"))).toEqual({
      kind: "tool", name: "apply_patch", arg: "docs/new.md, docs/old.md, src/a.ts", note: "+4 −1",
      diff: { lines: ["+# New", "+", "+Text.", DIFF_GAP, "-a", "+b"] },
    });
  });

  it("reads the patch from the function form's arguments too", () => {
    expect(one(fn("p1", "apply_patch", { input: PATCH }), fnOut("p1", "Exit code: 0\nOutput:\n"))).toMatchObject({ arg: "src/server/routes.ts", note: "+3 −2" });
  });

  it("still waiting for its result shows the change it asks for, running", () => {
    expect(one(custom("p1", "apply_patch", PATCH))).toMatchObject({ arg: "src/server/routes.ts", note: "+3 −2", running: true });
  });

  it("that did not apply failed and changed nothing: no diff", () => {
    const failed = one(custom("p1", "apply_patch", PATCH), customOut("p1", "Exit code: 1\nWall time: 0 seconds\nOutput:\nFailed to find expected lines in src/server/routes.ts"));
    expect(failed).toEqual({ kind: "tool", name: "apply_patch", arg: "src/server/routes.ts", error: "Failed to find expected lines in src/server/routes.ts" });
    const unverified = one(custom("p2", "apply_patch", PATCH), customOut("p2", "apply_patch verification failed: invalid hunk at line 3"));
    expect(unverified).toEqual({ kind: "tool", name: "apply_patch", arg: "src/server/routes.ts", error: "apply_patch verification failed: invalid hunk at line 3" });
  });

  it("failed when Codex's patch_apply_end says it did not succeed", () => {
    expect(turns(
      custom("p1", "apply_patch", PATCH),
      event({ type: "patch_apply_end", call_id: "p1", success: false, stdout: "", stderr: "src/server/routes.ts: no such file" }),
    )).toEqual([{ kind: "tool", name: "apply_patch", arg: "src/server/routes.ts", error: "src/server/routes.ts: no such file" }]);
    // A successful one is an answer: the row stops running.
    expect(one(custom("p2", "apply_patch", PATCH), event({ type: "patch_apply_end", call_id: "p2", success: true, stdout: "Success.", stderr: "" })))
      .toMatchObject({ note: "+3 −2", diff: expect.anything() });
    expect(one(custom("p2", "apply_patch", PATCH), event({ type: "patch_apply_end", call_id: "p2", success: true })).running).toBeUndefined();
  });
});

describe("a call answered No at the approval prompt, or one Codex could not run", () => {
  it("is Declined, with nothing to open and no change, when you said No", () => {
    expect(one(fn("c1", "shell", { command: ["bash", "-lc", "rm -rf build"] }), fnOut("c1", "exec command rejected by user")))
      .toEqual({ kind: "tool", name: "shell", arg: "rm -rf build", mark: "terminal", declined: true });
    expect(one(custom("p1", "apply_patch", PATCH), customOut("p1", "patch rejected by user")))
      .toEqual({ kind: "tool", name: "apply_patch", arg: "src/server/routes.ts", declined: true });
  });

  it("failed, saying why, when Codex could not run it", () => {
    expect(one(fn("c1", "frobnicate", { path: "a" }), fnOut("c1", "unsupported call: frobnicate")))
      .toEqual({ kind: "tool", name: "frobnicate", arg: "a", error: "unsupported call: frobnicate" });
    expect(one(fn("c1", "exec_command", "{not json"), fnOut("c1", "failed to parse function arguments: expected value at line 1 column 2")))
      .toEqual({ kind: "tool", name: "exec_command", arg: "{not json", mark: "terminal", error: "failed to parse function arguments: expected value at line 1 column 2" });
    expect(one(custom("c2", "mystery", "x"), customOut("c2", "unsupported custom tool call: mystery")).error).toBe("unsupported custom tool call: mystery");
  });

  it("only that sentence, whole, declines: a command that prints it ran", () => {
    expect(one(fn("c1", "exec_command", { cmd: "echo" }), fnOut("c1", unified(0, "exec command rejected by user"))).declined).toBeUndefined();
  });
});

describe("what is still running", () => {
  it("is a call with no result while its turn goes on", () => {
    expect(turns(event({ type: "task_started" }), fn("c1", "exec_command", { cmd: "npm run build" })))
      .toEqual([{ kind: "tool", name: "exec_command", arg: "npm run build", mark: "terminal", running: true }]);
  });

  it("not once the turn ended or was interrupted: Codex will not answer it then", () => {
    for (const end of ["task_complete", "turn_aborted"]) {
      expect(turns(fn("c1", "exec_command", { cmd: "npm run build" }), event({ type: end })), end)
        .toEqual([{ kind: "tool", name: "exec_command", arg: "npm run build", mark: "terminal" }]);
    }
    // An end before the call is an earlier turn's.
    expect(one(event({ type: "task_complete" }), fn("c1", "exec_command", { cmd: "x" }))).toMatchObject({ running: true });
  });

  it("a result is found wherever it is in the lines", () => {
    expect(turns(fnOut("c1", unified(2, "no")), fn("c1", "exec_command", { cmd: "x" }))[0]).toMatchObject({ error: "no" });
  });
});

describe("Codex's other tools", () => {
  it("update_plan is the task list, in TodoWrite's three states", () => {
    expect(turns(
      fn("u1", "update_plan", { explanation: "Next", plan: [{ step: "Read the routes", status: "completed" }, { step: "Add the limiter", status: "in_progress" }, { step: "Test", status: "pending" }] }),
      fnOut("u1", "Plan updated"),
    )).toEqual([{ kind: "todo", items: [
      { text: "Read the routes", status: "done" },
      { text: "Add the limiter", status: "active" },
      { text: "Test", status: "pending" },
    ] }]);
    // Without a plan it is a tool row like any other.
    expect(one(fn("u2", "update_plan", { explanation: "x" }), fnOut("u2", "Plan updated"))).toEqual({ kind: "tool", name: "update_plan", arg: "" });
  });

  it("a web search is a row of what it looked for, with the search mark", () => {
    expect(turns(
      item({ type: "web_search_call", status: "completed", action: { type: "search", query: "vitest dot reporter" } }),
      item({ type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://vitest.dev/guide/reporters" } }),
    )).toEqual([
      { kind: "tool", name: "WebSearch", arg: "vitest dot reporter", mark: "search" },
      { kind: "tool", name: "WebSearch", arg: "https://vitest.dev/guide/reporters", mark: "search" },
    ]);
  });

  it("any other call is a row of the usual fields, with the file mark", () => {
    expect(one(fn("v1", "view_image", { path: "/w/shot.png" }), fnOut("v1", "attached"))).toEqual({ kind: "tool", name: "view_image", arg: "/w/shot.png" });
    expect(one(fn("m1", "docs__search", { pattern: "rate limit" }), fnOut("m1", "[]"))).toEqual({ kind: "tool", name: "docs__search", arg: "rate limit" });
    expect(one(fn("w1", "write_stdin", { session_id: 4, chars: "" }), fnOut("w1", unified(0, "")))).toEqual({ kind: "tool", name: "write_stdin", arg: "", mark: "terminal" });
  });

  it("a record with no tool name is not a row", () => {
    expect(turns(item({ type: "function_call", arguments: "{}", call_id: "c" }), item({ type: "custom_tool_call", name: "", input: "x" }))).toEqual([]);
  });
});

describe("beside the conversation", () => {
  it("in the order Codex wrote them, the model's own copies of the messages still left out", () => {
    expect(turns(
      event({ type: "user_message", message: "Run the tests" }),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Running them." }] }),
      event({ type: "agent_message", message: "Running them." }),
      item({ type: "reasoning", summary: [] }),
      fn("c1", "exec_command", { cmd: "npm test" }),
      fnOut("c1", unified(0, "ok")),
      event({ type: "agent_message", message: "All green." }),
      event({ type: "task_complete" }),
    )).toEqual([
      { kind: "user", text: "Run the tests" },
      { kind: "assistant", text: "Running them." },
      { kind: "tool", name: "exec_command", arg: "npm test", mark: "terminal" },
      { kind: "assistant", text: "All green." },
    ]);
  });

  it("bounded as Claude's: the argument, the error, and the turns", () => {
    const long = `${"x".repeat(MAX_ARG * 2)}\nsecond`;
    const row = one(fn("c1", "exec_command", { cmd: long }), fnOut("c1", unified(1, `\u001b[31m${"e".repeat(MAX_ERROR * 2)}\u001b[0m`)));
    expect(row.arg).toHaveLength(MAX_ARG);
    expect(row.arg.endsWith("…")).toBe(true);
    expect(row.error).toHaveLength(MAX_ERROR);
    expect(row.error).not.toContain("\u001b");
    const many = Array.from({ length: MAX_TURNS + 5 }, (_, i) => fn(`c${i}`, "exec_command", { cmd: `echo ${i}` }));
    const window = codexTranscriptWindow(many);
    expect(window.cut).toBe(true);
    expect(window.turns).toHaveLength(MAX_TURNS);
    expect(window.turns.at(-1)).toMatchObject({ arg: `echo ${MAX_TURNS + 4}` });
  });
});

describe("codexToolOutcome, read the same by the board", () => {
  it("reads each head shape, and the text under it", () => {
    expect(codexToolOutcome(unified(0, "ok"))).toEqual({ failed: false, declined: false, text: "ok" });
    expect(codexToolOutcome(unified(3, "bad"))).toEqual({ failed: true, declined: false, text: "bad" });
    expect(codexToolOutcome([{ type: "input_text", text: "Exit code: 1\nOutput:\nno" }])).toEqual({ failed: true, declined: false, text: "no" });
    expect(codexToolOutcome("Process exited with code 0\r\nOutput:\r\nwin")).toEqual({ failed: false, declined: false, text: "win" });
    expect(codexToolOutcome(" exec command rejected by user\n")).toEqual({ failed: false, declined: true, text: "" });
    expect(codexToolOutcome(undefined)).toEqual({ failed: false, declined: false, text: "" });
  });

  it("the board's colours agree with Chat: a 0.169 command that exits non-zero is a failure there too", () => {
    const out = (output: string) => codexObjToPayload({ type: "response_item", payload: { type: "function_call_output", call_id: "c", output } }, "s-board", "/w");
    expect(out(unified(1, "x"))).toMatchObject({ hook_event_name: "PostToolUseFailure" });
    expect(out(unified(0, "x"))).toMatchObject({ hook_event_name: "PostToolUse" });
    expect(out("Exit code: 1\nOutput:\n")).toMatchObject({ hook_event_name: "PostToolUseFailure" });
    // What a command printed never counts as Codex's exit line.
    expect(out(unified(0, "Process exited with code 1"))).toMatchObject({ hook_event_name: "PostToolUse" });
    // Answering No is not a failure: the call never ran.
    expect(out("exec command rejected by user")).toMatchObject({ hook_event_name: "PostToolUse" });
  });
});

describe("the word a Codex row shows in Chat", () => {
  it("reads Codex's raw tool names as the board shows them, and leaves every other name as it is", () => {
    expect(toolLabel("exec_command")).toBe("Shell");
    expect(toolLabel("shell")).toBe("Shell");
    expect(toolLabel("apply_patch")).toBe("Edit");
    expect(toolLabel("WebSearch")).toBe("WebSearch");
    expect(toolLabel("Bash")).toBe("Bash");
    expect(toolLabel("mcp__github__create_pr")).toBe("mcp__github__create_pr");
    // Only the table's own keys count: nothing on Object.prototype is a label.
    expect(toolLabel("toString")).toBe("toString");
    expect(toolLabel("constructor")).toBe("constructor");
  });
});
