// ask-keys.ts: the keys that answer Claude Code's question prompt from Chat,
// planned from the questions and what was picked, each step waiting for the
// screen to show what it answers.
import { describe, expect, it } from "vitest";
import {
  askSteps, askText, CHAT_WORDS, chatSteps, DOWN_KEY, flatScreen, lead, MAX_ASK_TEXT, offersChat, picksComplete, screenShows, SUBMIT_WORDS,
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

// "Chat about this", as Claude Code 2.1.331 draws it: the last row, under a
// line, numbered after "Type something", and picked by that digit from
// anywhere in the list. Beside a preview it has no number: the last option's
// digit, Down, Enter.
describe("the keys for Chat about this", () => {
  const shows = (question: ChatQuestion) => [lead(question.question), ...question.options.map(o => lead(o.label)), CHAT_WORDS];
  const SCREEN = [
    " ☐ Database", "", " Which database should the service use?", "",
    " ❯ 1. Postgres", "   2. SQLite", "   3. DynamoDB", "   4. Type something.",
    " ─────────────────────────────────", "   5. Chat about this", "",
    " Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");

  it("one question, one choice: the digit after Type something, once the question, its options and the row show", () => {
    expect(chatSteps([DB])).toEqual([{ expect: shows(DB), keys: [{ input: "5" }] }]);
    expect(screenShows(SCREEN, chatSteps([DB])![0].expect)).toBe(true);
  });

  it("a prompt that does not draw the row takes no key: the step waits for its words", () => {
    const without = SCREEN.split("\n").filter(line => !line.includes(CHAT_WORDS)).join("\n");
    expect(screenShows(without, chatSteps([DB])![0].expect)).toBe(false);
  });

  it("several choices: the same digit, with no Tab and no review screen", () => {
    expect(chatSteps([FEATURES])).toEqual([{ expect: shows(FEATURES), keys: [{ input: "5" }] }]);
  });

  it("several questions: only the first one's, the question the prompt opens on", () => {
    expect(chatSteps([DB, FEATURES])).toEqual([{ expect: shows(DB), keys: [{ input: "5" }] }]);
    expect(chatSteps([q("Pick one", ["A", "B"]), DB])).toEqual([
      { expect: [lead("Pick one"), "A", "B", CHAT_WORDS], keys: [{ input: "4" }] },
    ]);
  });

  it("options with a preview: the last option's digit, Down to the row, Enter", () => {
    expect(chatSteps([LAYOUT])).toEqual([
      { expect: shows(LAYOUT), keys: [{ input: "2" }, { input: DOWN_KEY }, { input: "\r" }] },
    ]);
    expect(DOWN_KEY).toBe("\x1b[B");
  });

  it("nothing when no single digit reaches the row, or the first question has no options", () => {
    const many = (n: number) => q("Which one?", Array.from({ length: n }, (_, i) => `Option ${i + 1}`));
    expect(chatSteps([many(7)])?.[0].keys).toEqual([{ input: "9" }]);
    expect(chatSteps([many(8)])).toBeNull();
    expect(chatSteps([q("Which?", Array.from({ length: 9 }, (_, i) => `P${i}`), { preview: true })])?.[0].keys[0]).toEqual({ input: "9" });
    expect(chatSteps([q("Your name?", [])])).toBeNull();
    expect(chatSteps([])).toBeNull();
    expect(offersChat([DB])).toBe(true);
    expect(offersChat([many(8)])).toBe(false);
  });

  it("leaves the answers' keys as they were: options, several choices and Type something", () => {
    expect(askSteps([DB], [{ options: [2] }])).toEqual([{ expect: shows(DB).slice(0, -1), keys: [{ input: "3" }] }]);
    expect(askSteps([DB], [{ options: [], text: "MySQL" }])![0]).toEqual({ expect: shows(DB).slice(0, -1), keys: [{ input: "4" }] });
    expect(askSteps([FEATURES], [{ options: [0] }])![0].expect).not.toContain(CHAT_WORDS);
  });
});
