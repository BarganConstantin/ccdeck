// screen-prompt.ts: Claude Code's permission prompt and plan approval read off
// the live screen, which rows Chat may answer, and the keys that answer them.
// The screens are drawn as Claude Code 2.1 draws them (its own labels and
// question lines); each step waits for the screen to show what it answers.
import { describe, expect, it } from "vitest";
import { lead, MAX_ASK_TEXT } from "../ask-keys";
import {
  promptId, promptSteps, promptText, readScreenPrompt, rowRole, sameAsAnswered, samePrompt, screenShowsPrompt,
} from "../screen-prompt";

const BASH = [
  "⏺ Now the limiter's tests.",
  "",
  "────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   npm test -- rate-limit",
  "   Run the rate limiter's tests",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for npm test commands in /home/u/web-api",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

const EDIT = [
  " Edit file",
  "   src/server/middleware/rate-limit.ts",
  "   12  + const bucket = new Bucket(limit);",
  " Do you want to make this edit to",
  " src/server/middleware/rate-limit.ts?",
  " ❯ 1. Yes",
  "   2. Yes, allow all edits during this session (shift+tab)",
  "   3. No",
].join("\n");

const PLAN = [
  " Here is Claude's plan:",
  "╭──────────────────────────────────────────────╮",
  "│ # Rate limiting                              │",
  "│ 1. A token bucket on the public routes       │",
  "│ 2. Limits read from config/rate.json         │",
  "╰──────────────────────────────────────────────╯",
  "────────────────────────────────────────────────",
  " Claude has written up a plan and is ready to execute. Would you like to proceed?",
  "",
  " ❯ 1. Yes, clear context (31% used) and auto-accept edits",
  "   2. Yes, auto-accept edits",
  "   3. Yes, manually approve edits",
  "   4. No, keep planning",
  "",
  " ctrl-g to edit in Notepad · ~/.claude/plans/rate-limit.md",
].join("\n");

describe("reading the prompt off the screen", () => {
  it("reads a command's permission prompt: its question and every row, word for word", () => {
    expect(readScreenPrompt(BASH)).toEqual({
      kind: "permission",
      question: "Do you want to proceed?",
      options: ["Yes", "Yes, and don't ask again for npm test commands in /home/u/web-api", "No"],
    });
  });

  it("reads an edit's question wrapped over two lines, the file's dots included", () => {
    expect(readScreenPrompt(EDIT)?.question).toBe("Do you want to make this edit to src/server/middleware/rate-limit.ts?");
    expect(readScreenPrompt(EDIT)?.options).toHaveLength(3);
  });

  it("keeps the question apart from a line drawn right over it", () => {
    const screen = BASH.replace("   Run the rate limiter's tests\n\n", "   Run the rate limiter's tests\n");
    expect(readScreenPrompt(screen)?.question).toBe("Do you want to proceed?");
  });

  it("reads the plan approval, and not the numbered list inside the plan", () => {
    expect(readScreenPrompt(PLAN)).toEqual({
      kind: "plan",
      question: "Would you like to proceed?",
      options: [
        "Yes, clear context (31% used) and auto-accept edits",
        "Yes, auto-accept edits",
        "Yes, manually approve edits",
        "No, keep planning",
      ],
    });
  });

  it("reads the rows in the screen's order when No comes first", () => {
    const screen = " Do you want to proceed?\n ❯ 1. No\n   2. Yes";
    expect(readScreenPrompt(screen)?.options).toEqual(["No", "Yes"]);
  });

  it("reads through a frame's sides", () => {
    const screen = [
      "╭────────────────────────────────────────────╮",
      "│ Bash command                               │",
      "│ Do you want to proceed?                    │",
      "│ ❯ 1. Yes                                   │",
      "│   2. No, and tell Claude what to do differently (esc) │",
      "╰────────────────────────────────────────────╯",
    ].join("\n");
    expect(readScreenPrompt(screen)?.options).toEqual(["Yes", "No, and tell Claude what to do differently (esc)"]);
  });

  it("draws nothing for Claude's own question prompt", () => {
    const screen = " ☐ Database\n\n Which database should the service use?\n\n ❯ 1. Postgres\n   2. SQLite\n   3. Type something.";
    expect(readScreenPrompt(screen)).toBeNull();
  });

  it("draws nothing for a list in the assistant's own text, which has no pointer", () => {
    const screen = "⏺ Do you want to proceed?\n  1. Yes\n  2. No\n\n> ";
    expect(readScreenPrompt(screen)).toBeNull();
  });

  it("draws nothing for a plan question with no plan over it", () => {
    expect(readScreenPrompt(" Would you like to proceed?\n ❯ 1. Yes\n   2. No")).toBeNull();
  });

  it("draws nothing once the screen has moved on past the rows", () => {
    const after = ["⏺ Bash(npm test)", "  ⎿  12 passed", "⏺ Done.", "", "> ", "  ? for shortcuts", "  model · 31%"].join("\n");
    expect(readScreenPrompt(`${BASH}\n${after}`)).toBeNull();
  });

  it("draws nothing for a single row or an empty screen", () => {
    expect(readScreenPrompt(" Do you want to proceed?\n ❯ 1. Yes")).toBeNull();
    expect(readScreenPrompt("")).toBeNull();
  });
});

describe("what Chat may answer", () => {
  it("answers Yes and No on a permission prompt, and locks every row that changes the rules", () => {
    expect(rowRole("permission", "Yes")).toBe("answer");
    expect(rowRole("permission", "No")).toBe("answer");
    expect(rowRole("permission", "No, and tell Claude what to do differently (esc)")).toBe("answer");
    expect(rowRole("permission", "Yes, and don't ask again for npm test commands in /home/u/web-api")).toBe("locked");
    expect(rowRole("permission", "Yes, allow all edits during this session (shift+tab)")).toBe("locked");
    expect(rowRole("permission", "Yes, and switch to Auto for this session")).toBe("locked");
  });

  it("answers manual approval and takes words for keep planning; every row that changes the mode is locked", () => {
    expect(rowRole("plan", "Yes, manually approve edits")).toBe("answer");
    expect(rowRole("plan", "No, keep planning")).toBe("words");
    expect(rowRole("plan", "Yes, clear context (31% used) and auto-accept edits")).toBe("locked");
    expect(rowRole("plan", "Yes, auto-accept edits")).toBe("locked");
    expect(rowRole("plan", "Yes, and switch to Bypass Permissions for this session")).toBe("locked");
    expect(rowRole("plan", "No, refine with Ultraplan in a cloud session")).toBe("locked");
  });
});

describe("the keys that answer", () => {
  const bash = readScreenPrompt(BASH)!;
  const plan = readScreenPrompt(PLAN)!;

  it("picks Yes with its digit, once the screen shows the question and every row", () => {
    const steps = promptSteps(bash, 0)!;
    expect(steps).toHaveLength(1);
    expect(steps[0].keys).toEqual([{ input: "1" }]);
    expect(steps[0].expect).toEqual([lead(bash.question), ...bash.options.map(o => lead(o))]);
  });

  it("picks No with its own digit, wherever it sits", () => {
    expect(promptSteps(bash, 2)![0].keys).toEqual([{ input: "3" }]);
    const first = readScreenPrompt(" Do you want to proceed?\n ❯ 1. No\n   2. Yes")!;
    expect(promptSteps(first, 0)![0].keys).toEqual([{ input: "1" }]);
  });

  it("sends nothing for a locked row, a row that is not there, or words on a row that takes none", () => {
    expect(promptSteps(bash, 1)).toBeNull();
    expect(promptSteps(bash, 7)).toBeNull();
    expect(promptSteps(bash, 0, "and then")).toBeNull();
    expect(promptSteps(plan, 0)).toBeNull();
    expect(promptSteps(plan, 1)).toBeNull();
  });

  it("starts the plan with manual approval", () => {
    expect(promptSteps(plan, 2)).toEqual([{ expect: [lead(plan.question), ...plan.options.map(o => lead(o))], keys: [{ input: "3" }] }]);
  });

  it("keeps planning with your words: the digit opens the box, the words go in, Enter once they show", () => {
    const steps = promptSteps(plan, 3, "Use a sliding window\ninstead")!;
    expect(steps.map(step => step.keys)).toEqual([
      [{ input: "4" }],
      [{ paste: "Use a sliding window instead" }],
      [{ input: "\r" }],
    ]);
    expect(steps[1].expect).toEqual([]);
    expect(steps[2].expect).toEqual([lead("Use a sliding window instead")]);
  });

  it("does not keep planning without words", () => {
    expect(promptSteps(plan, 3)).toBeNull();
    expect(promptSteps(plan, 3, "  \n ")).toBeNull();
  });

  it("bounds the words to one line", () => {
    expect(promptText("a\r\nb")).toBe("a b");
    expect(promptText("x".repeat(MAX_ASK_TEXT + 50))).toHaveLength(MAX_ASK_TEXT);
    expect(promptText(undefined)).toBe("");
  });
});

describe("the same prompt, read again", () => {
  it("is the same while its question and rows are", () => {
    const prompt = readScreenPrompt(BASH)!;
    expect(samePrompt(prompt, readScreenPrompt(BASH))).toBe(true);
    expect(screenShowsPrompt(BASH, prompt)).toBe(true);
    expect(promptId(prompt)).toBe(promptId(readScreenPrompt(BASH)!));
  });

  it("is another once a row changes or the prompt is gone", () => {
    const prompt = readScreenPrompt(BASH)!;
    const other = BASH.replace("npm test commands", "npm commands");
    expect(samePrompt(prompt, readScreenPrompt(other))).toBe(false);
    expect(promptId(prompt)).not.toBe(promptId(readScreenPrompt(other)!));
    expect(screenShowsPrompt("⏺ Done.\n\n> ", prompt)).toBe(false);
    expect(samePrompt(null, prompt)).toBe(false);
  });
});

describe("the answered prompt, while its words go in", () => {
  it("is the same prompt when only the row that takes words shows them", () => {
    const plan = readScreenPrompt(PLAN)!;
    const typed = readScreenPrompt(PLAN.replace("4. No, keep planning", "4. also cover the admin routes"))!;
    expect(samePrompt(plan, typed)).toBe(false);
    expect(sameAsAnswered(plan, typed)).toBe(true);
  });

  it("is another prompt when any other row, the question or the kind differs", () => {
    const plan = readScreenPrompt(PLAN)!;
    expect(sameAsAnswered(plan, readScreenPrompt(PLAN.replace("3. Yes, manually approve edits", "3. Yes, approve edits"))!)).toBe(false);
    const bash = readScreenPrompt(BASH)!;
    expect(sameAsAnswered(bash, readScreenPrompt(BASH.replace("3. No", "3. No, and tell Claude what to do differently"))!)).toBe(false);
    expect(sameAsAnswered(bash, readScreenPrompt(EDIT)!)).toBe(false);
    expect(sameAsAnswered(bash, plan)).toBe(false);
  });
});
