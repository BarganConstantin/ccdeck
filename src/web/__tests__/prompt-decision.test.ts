// prompt-decision.ts: the Decision card for a prompt read off the screen, with
// the call it asks about taken from the transcript.
import { describe, expect, it } from "vitest";
import { mayPrompt, promptDecision } from "../prompt-decision";
import { promptId, type ScreenPrompt } from "../screen-prompt";
import type { ChatTurn } from "../components/chat/chat-model";

const BASH: ScreenPrompt = {
  kind: "permission",
  question: "Do you want to proceed?",
  options: ["Yes", "Yes, and don't ask again for npm test commands in /home/u/web-api", "No"],
};
const EDIT: ScreenPrompt = {
  kind: "permission",
  question: "Do you want to make this edit to rate-limit.ts?",
  options: ["Yes", "Yes, allow all edits during this session (shift+tab)", "No"],
};
const PLAN: ScreenPrompt = {
  kind: "plan",
  question: "Would you like to proceed?",
  options: ["Yes, clear context (31% used) and auto-accept edits", "Yes, auto-accept edits", "Yes, manually approve edits", "No, keep planning"],
};
const tool = (name: string, arg: string, running = true): ChatTurn => ({ kind: "tool", name, arg, ...(running ? { running: true } : null) });

describe("the title names the call that waits", () => {
  it("a command: its line in mono, and Yes runs it", () => {
    const model = promptDecision(BASH, [tool("Read", "a.ts", false), tool("Bash", "npm test -- rate-limit")], "web-api");
    expect(model).toMatchObject({ kind: "permission", title: "Allow this command?", command: "npm test -- rate-limit", caption: "Do you want to proceed?", origin: "launched", session: "web-api" });
    expect(model.options[0]).toEqual({ label: "Yes", sub: "Just this once. The next one asks again.", runs: true });
  });

  it("an edit: its file in mono, and Yes does not say it runs", () => {
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      const model = promptDecision(EDIT, [tool(name, "src/rate-limit.ts")], "web-api");
      expect(model.title).toBe("Allow this edit?");
      expect(model.command).toBe("src/rate-limit.ts");
      expect(model.options[0].runs).toBeUndefined();
    }
  });

  it("another tool by its name", () => {
    expect(promptDecision(BASH, [tool("WebFetch", "https://example.com")], "s").title).toBe("Allow WebFetch?");
  });

  it("several calls, or none, is a step with no line in mono", () => {
    const two = promptDecision(BASH, [tool("Bash", "a"), tool("Bash", "b")], "s");
    expect(two.title).toBe("Allow this step?");
    expect(two.command).toBeUndefined();
    expect(promptDecision(BASH, [], "s").title).toBe("Allow this step?");
  });
});

describe("the rows are the screen's, word for word", () => {
  it("a rule-changing row is locked; No refuses and says Claude stops", () => {
    const [, always, no] = promptDecision(BASH, [tool("Bash", "npm test")], "s").options;
    expect(always).toEqual({ label: BASH.options[1], sub: "", locked: true, lockNote: "Changes the session’s rules, so only in the terminal" });
    expect(no).toEqual({ label: "No", sub: "It doesn't run. Claude stops and waits for your next message." });
  });

  it("a plan: mode rows locked, manual approve answers, keep planning takes words", () => {
    const model = promptDecision(PLAN, [{ kind: "plan", text: "# Plan", running: true }], "web-api");
    expect(model).toMatchObject({ kind: "plan", title: "Approve this plan?", caption: "The plan is above, in the conversation." });
    expect(model.command).toBeUndefined();
    expect(model.options.map(o => [o.label, !!o.locked, !!o.free])).toEqual([
      [PLAN.options[0], true, false],
      [PLAN.options[1], true, false],
      [PLAN.options[2], false, false],
      [PLAN.options[3], false, true],
    ]);
    expect(model.options[0].lockNote).toBe("Changes the session’s mode, so only in the terminal");
    expect(model.options[2].sub).toBe("Claude starts, and every edit still asks you.");
    expect(model.options[3].sub).toBe("Tell Claude what to change.");
  });

  it("a plan row it cannot place is only in the terminal", () => {
    const model = promptDecision({ ...PLAN, options: ["Ultraplan", "No, keep planning"] }, [], "s");
    expect(model.options[0]).toMatchObject({ locked: true, lockNote: "Only in the terminal" });
  });

  it("a plan the transcript does not carry is read in Term", () => {
    expect(promptDecision(PLAN, [{ kind: "plan", text: "", running: true }], "s").caption).toBe("Read the plan in Term before you approve it.");
    expect(promptDecision(PLAN, [], "s").caption).toBe("Read the plan in Term before you approve it.");
  });
});

describe("the card's id", () => {
  it("is the prompt's, with the call: another call or another prompt is another card", () => {
    const a = promptDecision(BASH, [tool("Bash", "npm test")], "s").id;
    expect(a).toContain(promptId(BASH));
    expect(promptDecision(BASH, [tool("Bash", "npm run build")], "s").id).not.toBe(a);
    expect(promptDecision(EDIT, [tool("Bash", "npm test")], "s").id).not.toBe(a);
    expect(promptDecision(BASH, [tool("Bash", "npm test")], "s").id).toBe(a);
  });
});

describe("when Chat looks at the screen", () => {
  it("while a call or a plan waits", () => {
    expect(mayPrompt([tool("Bash", "npm test")])).toBe(true);
    expect(mayPrompt([{ kind: "plan", text: "x", running: true }])).toBe(true);
  });

  it("not when nothing waits, nor while a question card waits", () => {
    expect(mayPrompt([tool("Bash", "npm test", false), { kind: "assistant", text: "done" }])).toBe(false);
    expect(mayPrompt([{ kind: "plan", text: "x", approved: true }])).toBe(false);
    expect(mayPrompt([tool("Bash", "x"), { kind: "ask", questions: [], running: true }])).toBe(false);
  });
});
