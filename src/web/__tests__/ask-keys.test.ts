// ask-keys.ts: the keys that answer Claude Code's question prompt from Chat,
// planned from the questions and what was picked, each step waiting for the
// screen to show what it answers.
import { describe, expect, it } from "vitest";
import {
  askSteps, askText, flatScreen, lead, MAX_ASK_TEXT, picksComplete, screenShows, SUBMIT_WORDS,
} from "../ask-keys";
import type { ChatQuestion } from "../components/chat/chat-model";

const q = (question: string, labels: string[], extra: Partial<ChatQuestion> = {}): ChatQuestion => ({
  header: "", question, multi: false, options: labels.map(label => ({ label, description: "" })), ...extra,
});

const DB = q("Which database should the service use?", ["Postgres", "SQLite", "DynamoDB"]);
const FEATURES = q("Which features should ship first?", ["Search", "Export", "Sharing"], { multi: true });
const LAYOUT = q("Which layout reads best?", ["Cards", "Table"], { preview: true });

describe("the opening words a step waits for", () => {
  it("keeps a short text whole, and cuts a long one at a word", () => {
    expect(lead("Postgres")).toBe("Postgres");
    expect(lead("Which database should the service use?")).toBe("Which database should the");
    expect(lead("Which database should the service use?").length).toBeLessThanOrEqual(32);
  });

  it("cuts a text with no space in reach at the limit", () => {
    expect(lead("x".repeat(50))).toBe("x".repeat(32));
  });

  it("reads a wrapped screen as one line", () => {
    const screen = "  Which database should\n  the service use?\n\n  1. Postgres\n  2. SQLite";
    expect(flatScreen(screen)).toBe(" Which database should the service use? 1. Postgres 2. SQLite");
    expect(screenShows(screen, [lead(DB.question), "Postgres", "SQLite"])).toBe(true);
    expect(screenShows(screen, [lead(DB.question), "DynamoDB"])).toBe(false);
    expect(screenShows("anything", [])).toBe(true);
  });

  it("keeps your own words on one line and bounded", () => {
    expect(askText("  two\nlines\r\nhere ")).toBe("two lines here");
    expect(askText("y".repeat(MAX_ASK_TEXT + 50))).toHaveLength(MAX_ASK_TEXT);
    expect(askText(undefined)).toBe("");
  });
});

describe("whether the picks can be sent", () => {
  it("needs one option for one choice, one or more for several", () => {
    expect(picksComplete([DB], [{ options: [1] }])).toBe(true);
    expect(picksComplete([DB], [{ options: [] }])).toBe(false);
    expect(picksComplete([DB], [{ options: [0, 1] }])).toBe(false);
    expect(picksComplete([FEATURES], [{ options: [0, 2] }])).toBe(true);
    expect(picksComplete([FEATURES], [{ options: [] }])).toBe(false);
  });

  it("refuses an option the question does not have", () => {
    expect(picksComplete([DB], [{ options: [3] }])).toBe(false);
    expect(picksComplete([DB], [{ options: [-1] }])).toBe(false);
  });

  it("takes your own words only where Claude Code offers a box for them", () => {
    expect(picksComplete([DB], [{ options: [], text: "MySQL" }])).toBe(true);
    expect(picksComplete([DB], [{ options: [], text: "  " }])).toBe(false);
    expect(picksComplete([FEATURES], [{ options: [], text: "Billing" }])).toBe(false);
    expect(picksComplete([LAYOUT], [{ options: [], text: "Both" }])).toBe(false);
  });

  it("refuses a question with no options, and a missing pick", () => {
    expect(picksComplete([q("Your name?", [])], [{ options: [], text: "Ana" }])).toBe(false);
    expect(picksComplete([DB, FEATURES], [{ options: [0] }])).toBe(false);
  });
});

describe("the keys", () => {
  const shows = (question: ChatQuestion) => [lead(question.question), ...question.options.map(o => lead(o.label))];

  it("one question, one choice: its digit alone, once the question and its options show", () => {
    expect(askSteps([DB], [{ options: [1] }])).toEqual([{ expect: shows(DB), keys: [{ input: "2" }] }]);
  });

  it("several choices: each digit once, in order, then Tab and the review screen's submit", () => {
    expect(askSteps([FEATURES], [{ options: [2, 0, 2] }])).toEqual([
      { expect: shows(FEATURES), keys: [{ input: "1" }, { input: "3" }, { input: "\t" }] },
      { expect: [SUBMIT_WORDS], keys: [{ input: "1" }] },
    ]);
  });

  it("options with a preview: the digit moves the cursor, Enter picks", () => {
    expect(askSteps([LAYOUT], [{ options: [1] }])).toEqual([
      { expect: shows(LAYOUT), keys: [{ input: "2" }, { input: "\r" }] },
    ]);
  });

  it("your own words: the box after the last option, the words pasted, Enter only once they show", () => {
    expect(askSteps([DB], [{ options: [], text: "MySQL,\nplease" }])).toEqual([
      { expect: shows(DB), keys: [{ input: "4" }] },
      { expect: [], keys: [{ paste: "MySQL, please" }] },
      { expect: ["MySQL, please"], keys: [{ input: "\r" }] },
    ]);
  });

  it("two questions: one after the other, then the review screen", () => {
    expect(askSteps([DB, FEATURES], [{ options: [0] }, { options: [1] }])).toEqual([
      { expect: shows(DB), keys: [{ input: "1" }] },
      { expect: shows(FEATURES), keys: [{ input: "2" }, { input: "\t" }] },
      { expect: [SUBMIT_WORDS], keys: [{ input: "1" }] },
    ]);
  });

  it("nothing at all when any pick is not complete", () => {
    expect(askSteps([], [])).toBeNull();
    expect(askSteps([DB, FEATURES], [{ options: [0] }, { options: [] }])).toBeNull();
    expect(askSteps([FEATURES], [{ options: [], text: "Billing" }])).toBeNull();
  });
});
