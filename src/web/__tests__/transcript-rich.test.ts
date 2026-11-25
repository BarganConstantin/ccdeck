// transcript-turns.mjs and transcript-results.mjs: what a turn adds beside its
// words. When each line was written (`at`), the assistant's thinking as a turn
// with how long it took, what a call printed or found (capped, with its line
// count), a command's exit code, and the longer cap on what the assistant said.
// The records are the shapes Claude Code 2.1 writes (`toolUseResult` is the
// line's own record of a call's result) and Codex 0.169's command results.
import { describe, expect, it } from "vitest";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { MAX_PROSE, MAX_TEXT, codexTranscriptWindow, transcriptTurns, transcriptWindow } from "../../server/transcript-turns.mjs";
import {
  MAX_DETAIL_TOTAL, MAX_OUTPUT_CHARS, MAX_OUTPUT_LINES, MAX_THINKING, MAX_THINKING_MS, cappedOutput, plainOutput, toolResultDetail,
  // @ts-expect-error — server module, untyped by design (tsconfig.build.json)
} from "../../server/transcript-results.mjs";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { codexCommandResult } from "../../server/codex-translate.mjs";

const T0 = Date.parse("2026-11-25T13:56:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const line = (o: unknown) => JSON.stringify(o);
const user = (content: unknown, extra: object = {}) => line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown[], extra: object = {}) => line({ type: "assistant", message: { content }, ...extra });
const call = (id: string, name: string, input: unknown, extra: object = {}) => assistant([{ type: "tool_use", id, name, input }], extra);
const answer = (id: string, content: unknown, extra: { is_error?: boolean; own?: unknown; at?: number } = {}) => line({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(extra.is_error ? { is_error: true } : null) }] },
  ...(extra.own !== undefined ? { toolUseResult: extra.own } : null),
  ...(extra.at !== undefined ? { timestamp: iso(extra.at) } : null),
});
/** The row of one call and its answer. */
const row = (name: string, input: unknown, content: unknown, extra: { is_error?: boolean; own?: unknown } = {}) =>
  transcriptTurns([call("t1", name, input), answer("t1", content, extra)])[0];

describe("when each turn was written", () => {
  it("carries the line's time in ms on every kind of turn, from the line it came from", () => {
    const turns = transcriptTurns([
      user("Add rate limits", { timestamp: iso(T0) }),
      assistant([{ type: "thinking", thinking: "Routes first." }], { timestamp: iso(T0 + 6000) }),
      assistant([{ type: "text", text: "On it." }], { timestamp: iso(T0 + 7000) }),
      call("b1", "Bash", { command: "npm test" }, { timestamp: iso(T0 + 8000) }),
      answer("b1", "ok", { at: T0 + 20000 }),
      assistant([{ type: "text", text: "Done." }], { timestamp: iso(T0 + 87000) }),
    ]);
    expect(turns.map((t: { kind: string; at?: number }) => [t.kind, t.at])).toEqual([
      ["user", T0], ["thinking", T0 + 6000], ["assistant", T0 + 7000], ["tool", T0 + 8000], ["assistant", T0 + 87000],
    ]);
  });

  it("gives every turn of one line that line's time", () => {
    const turns = transcriptTurns([assistant([{ type: "text", text: "Two calls." }, { type: "tool_use", id: "a", name: "Read", input: { file_path: "a" } }], { timestamp: iso(T0) })]);
    expect(turns.map((t: { at?: number }) => t.at)).toEqual([T0, T0]);
  });

  it("leaves `at` out when a line has no time, or one that is not a date", () => {
    const turns = transcriptTurns([user("a"), user("b", { timestamp: "yesterday" }), user("c", { timestamp: 5 })]);
    for (const turn of turns) expect(turn).not.toHaveProperty("at");
  });

  it("a command's output joined to its command keeps the command's time", () => {
    const turns = transcriptTurns([
      user("<command-name>/model</command-name>", { timestamp: iso(T0) }),
      user("<local-command-stdout>Set model to opus</local-command-stdout>", { timestamp: iso(T0 + 50) }),
    ]);
    expect(turns).toEqual([{ kind: "command", name: "/model", output: "Set model to opus", at: T0 }]);
  });

  it("Codex turns carry their record's time too", () => {
    const rec = (payload: object, at: number) => line({ timestamp: iso(at), type: "event_msg", payload });
    const turns = codexTranscriptWindow([rec({ type: "user_message", message: "Run it" }, T0), rec({ type: "agent_message", message: "Ran." }, T0 + 4000)]).turns;
    expect(turns).toEqual([{ kind: "user", text: "Run it", at: T0 }, { kind: "assistant", text: "Ran.", at: T0 + 4000 }]);
  });
});

describe("thinking", () => {
  it("is a turn of its own, with its text and how long it took from the line before", () => {
    const turns = transcriptTurns([
      user("Why?", { timestamp: iso(T0) }),
      assistant([{ type: "thinking", thinking: "  Let me look at the routes.  ", signature: "sig" }], { timestamp: iso(T0 + 6400) }),
    ]);
    expect(turns[1]).toEqual({ kind: "thinking", text: "Let me look at the routes.", took: 6400, at: T0 + 6400 });
  });

  it("measures from a tool's answer when it follows one", () => {
    const turns = transcriptTurns([
      call("b1", "Bash", { command: "ls" }, { timestamp: iso(T0) }),
      answer("b1", "a.ts", { at: T0 + 1000 }),
      assistant([{ type: "thinking", thinking: "Only one file." }], { timestamp: iso(T0 + 3500) }),
    ]);
    expect(turns[1].took).toBe(2500);
  });

  it("tells no time when its line holds more than thinking, or the line before has no time", () => {
    const mixed = transcriptTurns([
      user("q", { timestamp: iso(T0) }),
      assistant([{ type: "thinking", thinking: "hm" }, { type: "text", text: "Answer." }], { timestamp: iso(T0 + 9000) }),
    ]);
    expect(mixed[1]).toEqual({ kind: "thinking", text: "hm", at: T0 + 9000 });
    const first = transcriptTurns([assistant([{ type: "thinking", thinking: "hm" }], { timestamp: iso(T0) })]);
    expect(first[0].took).toBeUndefined();
    const untimed = transcriptTurns([user("q"), assistant([{ type: "thinking", thinking: "hm" }], { timestamp: iso(T0) })]);
    expect(untimed[1].took).toBeUndefined();
  });

  it("does not count a sub-agent's lines as the line before", () => {
    const turns = transcriptTurns([
      user("q", { timestamp: iso(T0) }),
      assistant([{ type: "text", text: "agent talk" }], { timestamp: iso(T0 + 4000), isSidechain: true }),
      assistant([{ type: "thinking", thinking: "hm" }], { timestamp: iso(T0 + 5000) }),
    ]);
    expect(turns).toEqual([{ kind: "user", text: "q", at: T0 }, { kind: "thinking", text: "hm", took: 5000, at: T0 + 5000 }]);
  });

  it("a span longer than an hour, or backwards, is not a time the lines can tell", () => {
    const span = (ms: number) => transcriptTurns([
      user("q", { timestamp: iso(T0) }),
      assistant([{ type: "thinking", thinking: "hm" }], { timestamp: iso(T0 + ms) }),
    ])[1].took;
    expect(span(MAX_THINKING_MS)).toBe(MAX_THINKING_MS);
    expect(span(MAX_THINKING_MS + 1)).toBeUndefined();
    expect(span(-1000)).toBeUndefined();
  });

  it("redacted, or with its text left out, is the mark alone", () => {
    const turns = transcriptTurns([
      assistant([{ type: "redacted_thinking", data: "EuYBCkQ..." }]),
      assistant([{ type: "thinking", thinking: "", signature: "sig" }]),
      assistant([{ type: "thinking", thinking: "   " }]),
    ]);
    expect(turns).toEqual([{ kind: "thinking" }, { kind: "thinking" }, { kind: "thinking" }]);
    expect(JSON.stringify(turns)).not.toContain("EuYBCkQ");
  });

  it("is cut at MAX_THINKING characters and says so", () => {
    const [long] = transcriptTurns([assistant([{ type: "thinking", thinking: "x".repeat(MAX_THINKING + 10) }])]);
    expect(long.text).toHaveLength(MAX_THINKING);
    expect(long.text.endsWith("…")).toBe(true);
    expect(long.cut).toBe(true);
    const [fits] = transcriptTurns([assistant([{ type: "thinking", thinking: "y".repeat(MAX_THINKING) }])]);
    expect(fits.cut).toBeUndefined();
  });
});

describe("what the assistant said", () => {
  it("keeps up to MAX_PROSE characters and says when it cut", () => {
    expect(MAX_PROSE).toBeGreaterThan(MAX_TEXT);
    const [whole] = transcriptTurns([assistant([{ type: "text", text: "a".repeat(MAX_PROSE) }])]);
    expect(whole).toEqual({ kind: "assistant", text: "a".repeat(MAX_PROSE) });
    const [cut] = transcriptTurns([assistant([{ type: "text", text: "b".repeat(MAX_PROSE + 1) }])]);
    expect(cut.text).toHaveLength(MAX_PROSE);
    expect(cut.cut).toBe(true);
  });

  it("what you typed keeps its own cap", () => {
    const [typed] = transcriptTurns([user("c".repeat(MAX_TEXT + 1))]);
    expect(typed.text).toHaveLength(MAX_TEXT);
    expect(typed.cut).toBeUndefined();
  });

  it("Codex's messages take the same caps", () => {
    const msg = (type: string, message: string) => line({ type: "event_msg", payload: { type, message } });
    const [you, it] = codexTranscriptWindow([msg("user_message", "u".repeat(MAX_TEXT + 5)), msg("agent_message", "a".repeat(MAX_PROSE + 5))]).turns;
    expect(you.text).toHaveLength(MAX_TEXT);
    expect(it.text).toHaveLength(MAX_PROSE);
    expect(it.cut).toBe(true);
  });
});

describe("a command's output", () => {
  it("is its own record's stdout and stderr, with exit 0 when it succeeded", () => {
    expect(row("Bash", { command: "npm test" }, "Tests 3 passed", { own: { stdout: "Tests 3 passed\n", stderr: "warn: slow\n", interrupted: false, isImage: false } }))
      .toEqual({ kind: "tool", name: "Bash", arg: "npm test", exit: 0, output: { text: "Tests 3 passed\nwarn: slow", lines: 2 } });
  });

  it("falls back to the text the model was handed when there is no record", () => {
    expect(row("Bash", { command: "ls" }, "a.ts\nb.ts\n").output).toEqual({ text: "a.ts\nb.ts", lines: 2 });
  });

  it("a failed command keeps its error and says its exit code", () => {
    const failed = row("Bash", { command: "npm test" }, "Exit code 2\nFAIL src/a.test.ts", { is_error: true, own: "Error: Exit code 2" });
    expect(failed.error).toBe("Exit code 2\nFAIL src/a.test.ts");
    expect(failed.exit).toBe(2);
    expect(failed.output).toBeUndefined();
    expect(row("Bash", { command: "x" }, "boom", { is_error: true }).exit).toBeUndefined();
  });

  it("an interrupted command says so and states no exit code", () => {
    const stopped = row("Bash", { command: "sleep 99" }, "partial", { own: { stdout: "partial", stderr: "", interrupted: true } });
    expect(stopped.interrupted).toBe(true);
    expect(stopped.exit).toBeUndefined();
    expect(stopped.output).toEqual({ text: "partial", lines: 1 });
  });

  it("states no exit code when Claude Code read a non-zero one as fine, or sent the command to the background", () => {
    expect(row("Bash", { command: "grep x a" }, "", { own: { stdout: "", stderr: "", interrupted: false, returnCodeInterpretation: "No matches found" } }).exit).toBeUndefined();
    const bg = row("Bash", { command: "npm run dev", run_in_background: true }, "Command running in background with ID: b1", { own: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b1" } });
    expect(bg.exit).toBeUndefined();
  });

  it("is plain text: colours gone, a progress bar at its last state, no blank lines round it", () => {
    expect(plainOutput("\n\n\u001b[32m✓\u001b[0m pass\r\n10%\r50%\r100%\n\n  \n")).toBe("✓ pass\n100%");
    expect(row("Bash", { command: "x" }, "\u001b[31mred\u001b[0m").output.text).toBe("red");
  });

  it("printed nothing, carries no output", () => {
    expect(row("Bash", { command: "true" }, "", { own: { stdout: "", stderr: "", interrupted: false } })).toEqual({ kind: "tool", name: "Bash", arg: "true", exit: 0 });
    expect(cappedOutput("\n \n")).toBeNull();
    expect(cappedOutput(undefined)).toBeNull();
  });

  it("keeps the first MAX_OUTPUT_LINES lines, with the count of all of them", () => {
    const printed = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const output = row("Bash", { command: "seq" }, printed).output;
    expect(output.lines).toBe(100);
    expect(output.cut).toBe(true);
    expect(output.text.split("\n")).toHaveLength(MAX_OUTPUT_LINES);
    expect(output.text.endsWith(`line ${MAX_OUTPUT_LINES - 1}`)).toBe(true);
    const fits = cappedOutput(Array.from({ length: MAX_OUTPUT_LINES }, () => "x").join("\n"));
    expect(fits.cut).toBeUndefined();
  });

  it("keeps at most MAX_OUTPUT_CHARS characters, never half a surrogate pair", () => {
    const wide = cappedOutput("x".repeat(MAX_OUTPUT_CHARS * 3));
    expect(wide.text).toHaveLength(MAX_OUTPUT_CHARS);
    expect(wide).toMatchObject({ lines: 1, cut: true });
    const emoji = cappedOutput(`${"x".repeat(MAX_OUTPUT_CHARS - 1)}😀tail`);
    expect(emoji.text).toBe("x".repeat(MAX_OUTPUT_CHARS - 1));
  });

  it("a background command's later output (BashOutput) is read the same way", () => {
    expect(row("BashOutput", { bash_id: "b1" }, "<status>running</status>", { own: { stdout: "listening on 5173", stderr: "" } }).output)
      .toEqual({ text: "listening on 5173", lines: 1 });
  });

  it("a declined or still running command has none of it", () => {
    expect(toolResultDetail("Bash", undefined)).toEqual({});
    expect(toolResultDetail("Bash", { text: "x", declined: true, error: true })).toEqual({});
  });
});

describe("what other calls found", () => {
  it("Read counts the file's lines and never carries them", () => {
    const read = row("Read", { file_path: "src/a.ts" }, "     1→const a = 1;\n     2→const b = 2;", {
      own: { type: "text", file: { filePath: "src/a.ts", content: "const a = 1;\nconst b = 2;", numLines: 182, startLine: 1, totalLines: 182 } },
    });
    expect(read).toEqual({ kind: "tool", name: "Read", arg: "src/a.ts", stat: { lines: 182 } });
    // Without a record, the numbered lines the model was handed are counted.
    expect(row("Read", { file_path: "b" }, "     1→a\n     2→b\n     3→c").stat).toEqual({ lines: 3 });
    // An image read has no lines to count.
    expect(row("Read", { file_path: "shot.png" }, [{ type: "image" }], { own: { type: "image", file: { base64: "AAAA" } } }).stat).toBeUndefined();
  });

  it("Grep counts what it matched, by mode, and lists it", () => {
    const files = row("Grep", { pattern: "limit" }, "Found 2 files\nsrc/a.ts\nsrc/b.ts", { own: { mode: "files_with_matches", filenames: ["src/a.ts", "src/b.ts"], numFiles: 2 } });
    expect(files.stat).toEqual({ files: 2 });
    expect(files.output).toEqual({ text: "src/a.ts\nsrc/b.ts", lines: 2 });
    const content = row("Grep", { pattern: "limit", output_mode: "content" }, "a.ts:3:limit", { own: { mode: "content", numFiles: 0, filenames: [], content: "a.ts:3:limit\nb.ts:9:limit", numLines: 2 } });
    expect(content.stat).toEqual({ lines: 2 });
    expect(content.output.text).toBe("a.ts:3:limit\nb.ts:9:limit");
    const counted = row("Grep", { pattern: "x", output_mode: "count" }, "a.ts:4", { own: { mode: "count", numFiles: 1, filenames: [], content: "a.ts:4", numMatches: 4 } });
    expect(counted.stat).toEqual({ matches: 4, files: 1 });
    expect(row("Grep", { pattern: "x" }, "Found 3 files\na\nb\nc").stat).toEqual({ files: 3 });
  });

  it("Glob counts and lists its files", () => {
    const glob = row("Glob", { pattern: "**/*.ts" }, "a.ts\nb.ts", { own: { filenames: ["a.ts", "b.ts"], numFiles: 2, truncated: false, durationMs: 4 } });
    expect(glob).toMatchObject({ stat: { files: 2 }, output: { text: "a.ts\nb.ts", lines: 2 } });
    expect(row("Glob", { pattern: "*.md" }, "No files found").stat).toEqual({ files: 0 });
    expect(row("Glob", { pattern: "*.md" }, "No files found").output).toBeUndefined();
  });

  it("WebFetch says its status, size and what it read", () => {
    const fetched = row("WebFetch", { url: "https://vitest.dev" }, "summary", { own: { bytes: 48213, code: 200, codeText: "OK", result: "Vitest is a test runner.", durationMs: 900, url: "https://vitest.dev" } });
    expect(fetched).toMatchObject({ stat: { status: 200, bytes: 48213 }, output: { text: "Vitest is a test runner.", lines: 1 } });
  });

  it("WebSearch counts and lists its links", () => {
    const own = { query: "vitest", results: [{ tool_use_id: "s", content: [{ title: "Vitest", url: "https://vitest.dev" }, { title: "", url: "https://x.dev" }] }, "Some commentary"], durationSeconds: 2 };
    const found = row("WebSearch", { query: "vitest" }, "Web search results", { own });
    expect(found.stat).toEqual({ results: 2 });
    expect(found.output.text).toBe("Vitest — https://vitest.dev\nhttps://x.dev");
  });

  it("an MCP tool's text answer is its output; other tools carry none", () => {
    expect(row("mcp__docs__search", { query: "x" }, [{ type: "text", text: "3 pages" }]).output).toEqual({ text: "3 pages", lines: 1 });
    expect(row("Skill", { skill: "x" }, "Launching skill")).toEqual({ kind: "tool", name: "Skill", arg: "" });
  });

  it("a failed call other than a command keeps only its error", () => {
    expect(row("Read", { file_path: "gone" }, "<tool_use_error>File does not exist.</tool_use_error>", { is_error: true }))
      .toEqual({ kind: "tool", name: "Read", arg: "gone", error: "File does not exist." });
  });
});

describe("one answer's detail, held to a total", () => {
  it("keeps the newest outputs whole and drops the text of older ones past MAX_DETAIL_TOTAL", () => {
    const big = "y".repeat(MAX_OUTPUT_CHARS);
    const n = Math.ceil(MAX_DETAIL_TOTAL / MAX_OUTPUT_CHARS) + 10;
    const lines = Array.from({ length: n }, (_, i) => [call(`b${i}`, "Bash", { command: `run ${i}` }), answer(`b${i}`, big)]).flat();
    const { turns } = transcriptWindow(lines);
    const kept = turns.filter((t: { output: { text: string } }) => t.output.text);
    const dropped = turns.filter((t: { output: { text: string } }) => !t.output.text);
    expect(dropped.length).toBeGreaterThan(0);
    expect(kept.reduce((sum: number, t: { output: { text: string } }) => sum + t.output.text.length, 0)).toBeLessThanOrEqual(MAX_DETAIL_TOTAL);
    // The newest are the ones kept; a dropped one still says how many lines it had.
    expect(turns.at(-1).output.text).toBe(big);
    expect(dropped[0].output).toEqual({ text: "", lines: 1, cut: true });
    expect(turns.indexOf(dropped.at(-1))).toBeLessThan(turns.indexOf(kept[0]));
  });

  it("counts thinking text in the same total", () => {
    const n = Math.ceil(MAX_DETAIL_TOTAL / MAX_THINKING) + 5;
    const { turns } = transcriptWindow(Array.from({ length: n }, () => assistant([{ type: "thinking", thinking: "z".repeat(MAX_THINKING) }])));
    const bare = turns.filter((t: { text?: string }) => t.text === undefined);
    expect(bare.length).toBeGreaterThan(0);
    expect(bare[0]).toEqual({ kind: "thinking", cut: true });
    expect(turns.at(-1).text).toHaveLength(MAX_THINKING);
  });

  it("never reads a slash command's printed text as a call's output", () => {
    const turns = transcriptTurns([user("<command-name>/cost</command-name>\n<local-command-stdout>$0.12</local-command-stdout>")]);
    expect(turns).toEqual([{ kind: "command", name: "/cost", output: "$0.12" }]);
  });
});

describe("a Codex command's printed text and exit code", () => {
  const unified = (code: number, output: string) =>
    `Chunk ID: 3f9a1c\nWall time: 0.5021 seconds\nProcess exited with code ${code}\nOriginal token count: 12\nOutput:\n${output}`;

  it("is what follows Output:, and the head line's code", () => {
    expect(codexCommandResult(unified(0, "ok\n"))).toEqual({ text: "ok\n", exit: 0 });
    expect(codexCommandResult(unified(3, "bad"))).toEqual({ text: "bad", exit: 3 });
    expect(codexCommandResult([{ type: "input_text", text: "Exit code: 1\nOutput:\nno" }])).toEqual({ text: "no", exit: 1 });
  });

  it("reads the older envelope's exit code, and states none when nothing says it", () => {
    expect(codexCommandResult(JSON.stringify({ output: "x", metadata: { exit_code: 127 } }))).toEqual({ text: "x", exit: 127 });
    expect(codexCommandResult("a.ts\nb.ts")).toEqual({ text: "a.ts\nb.ts", exit: undefined });
    expect(codexCommandResult(undefined)).toEqual({ text: "", exit: undefined });
  });

  it("puts both on the command's row, capped as a Bash row's", () => {
    const fn = line({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "seq 100" }), call_id: "c1" } });
    const out = line({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: unified(0, Array.from({ length: 100 }, (_, i) => `${i}`).join("\n")) } });
    const [turn] = codexTranscriptWindow([fn, out]).turns;
    expect(turn.exit).toBe(0);
    expect(turn.output).toMatchObject({ lines: 100, cut: true });
    expect(turn.output.text.split("\n")).toHaveLength(MAX_OUTPUT_LINES);
  });
});
