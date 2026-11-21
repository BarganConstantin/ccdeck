// transcript-turns.mjs: what you put into the conversation besides words. A
// slash command you ran is a command turn, with what a local command printed
// under it, and the images you sent are counted on your turn, never carried.
// The records are the shapes Claude Code 2.1 writes.
import { describe, expect, it } from "vitest";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { MAX_ARG, MAX_COMMAND_ARGS, MAX_COMMAND_OUTPUT, transcriptTurns } from "../../server/transcript-turns.mjs";

const line = (o: unknown) => JSON.stringify(o);
const user = (content: unknown, extra: object = {}) => line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown[]) => line({ type: "assistant", message: { content } });
const said = (text: string) => assistant([{ type: "text", text }]);
/** A slash command as Claude Code 2.1 writes it: the message, the name, and the args when there are any. */
const slash = (name: string, args?: string) => [
  `<command-message>${name.replace(/^\//, "")}</command-message>`,
  `<command-name>${name}</command-name>`,
  ...(args === undefined ? [] : [`<command-args>${args}</command-args>`]),
].join("\n");
const stdout = (text: string) => user(`<local-command-stdout>${text}</local-command-stdout>`);
const stderr = (text: string) => user(`<local-command-stderr>${text}</local-command-stderr>`);
const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" } };

describe("a slash command", () => {
  it("is a command turn, from string content", () => {
    expect(transcriptTurns([user(slash("/model", "opus"))])).toEqual([{ kind: "command", name: "/model", args: "opus" }]);
  });

  it("is a command turn, from text parts", () => {
    const parts = [{ type: "text", text: slash("/model", "opus") }];
    expect(transcriptTurns([user(parts)])).toEqual([{ kind: "command", name: "/model", args: "opus" }]);
  });

  it("leaves args out when there are none, or only spaces", () => {
    expect(transcriptTurns([user(slash("/clear"))])).toEqual([{ kind: "command", name: "/clear" }]);
    expect(transcriptTurns([user(slash("/clear", "   "))])).toEqual([{ kind: "command", name: "/clear" }]);
  });

  it("keeps a plugin's name whole, and trims its args", () => {
    expect(transcriptTurns([user(slash("/plugin:skill", "  run it  "))])).toEqual([{ kind: "command", name: "/plugin:skill", args: "run it" }]);
    expect(transcriptTurns([user(slash("/my-review_2"))])).toEqual([{ kind: "command", name: "/my-review_2" }]);
  });

  it("cuts a long name at MAX_ARG and long args at MAX_COMMAND_ARGS", () => {
    const [turn] = transcriptTurns([user(slash(`/${"n".repeat(MAX_ARG + 20)}`, "a".repeat(MAX_COMMAND_ARGS + 50)))]);
    expect(MAX_COMMAND_ARGS).toBe(200);
    expect(turn.name).toHaveLength(MAX_ARG);
    expect(turn.name.endsWith("…")).toBe(true);
    expect(turn.args).toHaveLength(MAX_COMMAND_ARGS);
    expect(turn.args.endsWith("…")).toBe(true);
  });

  it("keeps a skill's command and leaves out its expansion, a meta line", () => {
    const turns = transcriptTurns([
      user(slash("/review", "the auth module")),
      user([{ type: "text", text: "# Review\n\nRead every changed file and report…" }], { isMeta: true }),
      said("Reviewing the auth module."),
    ]);
    expect(turns).toEqual([
      { kind: "command", name: "/review", args: "the auth module" },
      { kind: "assistant", text: "Reviewing the auth module." },
    ]);
  });

  it("is not read out of a person's own words that mention the wrapper", () => {
    const typed = "Why does <command-name> vanish from Chat?";
    expect(transcriptTurns([user(typed)])).toEqual([{ kind: "user", text: typed }]);
    // A whole element in a sentence: still the person's line, as before.
    const [turn] = transcriptTurns([user("Look at <command-name>/model</command-name> in the file")]);
    expect(turn.kind).toBe("user");
  });
});

describe("what a local command printed", () => {
  it("goes under the command it follows", () => {
    expect(transcriptTurns([user(slash("/model", "opus")), stdout("Set model to opus")])).toEqual([
      { kind: "command", name: "/model", args: "opus", output: "Set model to opus" },
    ]);
  });

  it("says the command failed when it came on stderr", () => {
    expect(transcriptTurns([user(slash("/model", "nope")), stderr("Unknown model: nope")])).toEqual([
      { kind: "command", name: "/model", args: "nope", output: "Unknown model: nope", failed: true },
    ]);
  });

  it("joins a second output line to the first with a newline", () => {
    const [turn] = transcriptTurns([user(slash("/cost")), stdout("Total cost: $0.12"), stdout("Duration: 4m")]);
    expect(turn).toEqual({ kind: "command", name: "/cost", output: "Total cost: $0.12\nDuration: 4m" });
    const [mixed] = transcriptTurns([user(slash("/mcp")), stdout("2 servers"), stderr("1 failed to start")]);
    expect(mixed).toEqual({ kind: "command", name: "/mcp", output: "2 servers\n1 failed to start", failed: true });
  });

  it("loses its colours: ANSI escapes are removed, and it is trimmed", () => {
    const [turn] = transcriptTurns([user(slash("/model", "opus")),
      stdout("  Set model to \u001b[1mopus\u001b[22m \u001b[38;5;246m(claude-opus)\u001b[39m\u001b]8;;https://x.test\u0007link\u001b]8;;\u0007\n")]);
    expect(turn.output).toBe("Set model to opus (claude-opus)link");
    expect(turn.output).not.toContain("\u001b");
  });

  it("is cut at MAX_COMMAND_OUTPUT, with the file's cut mark, however many lines add up", () => {
    expect(MAX_COMMAND_OUTPUT).toBe(2000);
    const [one] = transcriptTurns([user(slash("/context")), stdout("x".repeat(MAX_COMMAND_OUTPUT + 100))]);
    expect(one.output).toHaveLength(MAX_COMMAND_OUTPUT);
    expect(one.output.endsWith("…")).toBe(true);
    const [many] = transcriptTurns([user(slash("/context")), stdout("a".repeat(1500)), stdout("b".repeat(1500)), stdout("c".repeat(10))]);
    expect(many.output).toHaveLength(MAX_COMMAND_OUTPUT);
    expect(many.output.endsWith("…")).toBe(true);
    expect(many.output).not.toContain("c");
  });

  it("adds nothing when it is empty", () => {
    expect(transcriptTurns([user(slash("/clear")), stdout("   "), stderr("")])).toEqual([{ kind: "command", name: "/clear" }]);
  });

  it("is left out with no command just before it", () => {
    expect(transcriptTurns([stdout("Set model to opus")])).toEqual([]);
    expect(transcriptTurns([user("hello"), stdout("Set model to opus")])).toEqual([{ kind: "user", text: "hello" }]);
    const [, after] = transcriptTurns([user(slash("/model", "opus")), said("Done."), stdout("late")]);
    expect(after).toEqual({ kind: "assistant", text: "Done." });
  });

  it("still finds its command past the meta caveat Claude Code writes", () => {
    const caveat = user("<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>", { isMeta: true });
    expect(transcriptTurns([caveat, user(slash("/model", "opus")), stdout("Set model to opus")])).toEqual([
      { kind: "command", name: "/model", args: "opus", output: "Set model to opus" },
    ]);
  });
});

describe("images you sent", () => {
  it("are counted on an image-only line, which is no longer dropped", () => {
    expect(transcriptTurns([user([IMAGE])])).toEqual([{ kind: "user", text: "", images: 1 }]);
  });

  it("are counted beside your words, whose [Image #n] placeholders stay as typed", () => {
    const turns = transcriptTurns([user([{ type: "text", text: "[Image #1] [Image #2] what differs?" }, IMAGE, IMAGE])]);
    expect(turns).toEqual([{ kind: "user", text: "[Image #1] [Image #2] what differs?", images: 2 }]);
  });

  it("leave a line with none as it was", () => {
    const [turn] = transcriptTurns([user([{ type: "text", text: "no pictures" }])]);
    expect(turn).toEqual({ kind: "user", text: "no pictures" });
    expect("images" in turn).toBe(false);
  });

  it("inside a tool's result are the tool's, not counted", () => {
    const turns = transcriptTurns([
      assistant([{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "shot.png" } }]),
      user([{ type: "tool_result", tool_use_id: "r1", content: [IMAGE, { type: "text", text: "the screenshot" }] }]),
    ]);
    expect(turns).toEqual([{ kind: "tool", name: "Read", arg: "shot.png" }]);
  });

  it("never carry their data into any turn", () => {
    const turns = transcriptTurns([
      user([IMAGE]),
      user([{ type: "text", text: "and this" }, IMAGE]),
      assistant([{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "a.png" } }]),
      user([{ type: "tool_result", tool_use_id: "r1", content: [IMAGE] }]),
    ]);
    const json = JSON.stringify(turns);
    expect(json).not.toContain(IMAGE.source.data);
    expect(json).not.toContain("base64");
    expect(json).not.toContain("image/png");
  });
});
