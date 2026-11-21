// transcript-turns.mjs: a question Claude Code asked (AskUserQuestion) becomes a
// card with its options, and once answered, what was chosen. The result text is
// the form Claude Code 2.1 hands the model; `toolUseResult` is the line's own record.
import { describe, expect, it } from "vitest";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { askQuestions, MAX_OPTIONS, MAX_QUESTIONS, transcriptTurns } from "../../server/transcript-turns.mjs";

const line = (o: unknown) => JSON.stringify(o);
const assistant = (content: unknown[], extra: object = {}) => line({ type: "assistant", message: { content }, ...extra });
const ask = (id: string, questions: unknown[]) => assistant([{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } }]);
const answer = (id: string, content: unknown, own?: unknown) =>
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, ...(own === undefined ? {} : { toolUseResult: own }) });

const DB = {
  header: "Database",
  question: "Which database should the service use?",
  multiSelect: false,
  options: [
    { label: "Postgres", description: "Relational, already in prod" },
    { label: "SQLite", description: "One file, no server" },
  ],
};
const FEATURES = {
  header: "Scope",
  question: "Which features ship first?",
  multiSelect: true,
  options: [{ label: "Search", description: "" }, { label: "Export", description: "" }, { label: "Sharing", description: "" }],
};
const CARD_DB = {
  header: "Database", question: DB.question, multi: false,
  options: [{ label: "Postgres", description: "Relational, already in prod" }, { label: "SQLite", description: "One file, no server" }],
};
const CARD_FEATURES = {
  header: "Scope", question: FEATURES.question, multi: true,
  options: [{ label: "Search", description: "" }, { label: "Export", description: "" }, { label: "Sharing", description: "" }],
};

describe("a question card", () => {
  it("waits while no answer is in the transcript, with every option", () => {
    expect(transcriptTurns([ask("q1", [DB, FEATURES])])).toEqual([
      { kind: "ask", questions: [CARD_DB, CARD_FEATURES], running: true },
    ]);
  });

  it("reads the choices from the line's own record: one, and several", () => {
    const turns = transcriptTurns([
      ask("q1", [DB, FEATURES]),
      answer("q1", "Your questions have been answered: …", {
        questions: [DB, FEATURES], answers: { [DB.question]: "SQLite", [FEATURES.question]: ["Search", "Sharing"] },
      }),
    ]);
    expect(turns).toEqual([{ kind: "ask", questions: [CARD_DB, CARD_FEATURES], answers: ["SQLite", "Search, Sharing"] }]);
  });

  it("reads them from the text the model was handed when the line has no record", () => {
    const said = `Your questions have been answered: "${DB.question}"="Postgres", "${FEATURES.question}"="Export, Sharing". You can now continue with these answers in mind.`;
    expect(transcriptTurns([ask("q1", [DB, FEATURES]), answer("q1", said)])[0].answers).toEqual(["Postgres", "Export, Sharing"]);
  });

  it("an answer in your own words keeps its quotes and commas", () => {
    const said = `Your questions have been answered: "${DB.question}"="MySQL, "the old one"", "${FEATURES.question}"="Search". You can now continue with these answers in mind.`;
    expect(transcriptTurns([ask("q1", [DB, FEATURES]), answer("q1", said)])[0].answers)
      .toEqual(['MySQL, "the old one"', "Search"]);
  });

  it("a question left without a choice is an empty answer, and does not swallow the next", () => {
    const said = `Your questions have been answered: "${DB.question}"=(no option selected), "${FEATURES.question}"="Search". You can now continue.`;
    const own = { answers: { [DB.question]: "(notes only)", [FEATURES.question]: ["Search"] } };
    expect(transcriptTurns([ask("q1", [DB, FEATURES]), answer("q1", said)])[0].answers).toEqual(["", "Search"]);
    expect(transcriptTurns([ask("q1", [DB, FEATURES]), answer("q1", said, own)])[0].answers).toEqual(["", "Search"]);
  });

  it("keeps what you wrote back instead of choosing", () => {
    const [fromText] = transcriptTurns([ask("q1", [DB]), answer("q1", [{ type: "text", text: "The user responded: neither, use files" }])]);
    expect(fromText).toEqual({ kind: "ask", questions: [CARD_DB], answers: [""], reply: "neither, use files" });
    const [fromRecord] = transcriptTurns([ask("q1", [DB]), answer("q1", "The user responded: x", { answers: {}, response: "neither" })]);
    expect(fromRecord).toMatchObject({ answers: [""], reply: "neither" });
  });

  it("a refused question is answered with nothing chosen", () => {
    const [turn] = transcriptTurns([ask("q1", [DB]), answer("q1", "The user doesn't want to proceed with this tool use.")]);
    expect(turn).toEqual({ kind: "ask", questions: [CARD_DB], answers: [""] });
  });

  it("an answer for another call does not answer this one", () => {
    expect(transcriptTurns([ask("q1", [DB]), answer("q2", "The user responded: no")])[0]).toMatchObject({ running: true });
  });
});

describe("what a question card keeps", () => {
  it("only that options carry a preview, never the preview", () => {
    const [q] = askQuestions({ questions: [{ ...DB, options: DB.options.map(o => ({ ...o, preview: "<big mockup>" })) }] });
    expect(q.preview).toBe(true);
    expect(JSON.stringify(q)).not.toContain("mockup");
  });

  it("no options for a question that asks for text or a number", () => {
    const [q] = askQuestions({ questions: [{ question: "How many workers?", kind: "number", options: [] }] });
    expect(q).toEqual({ header: "", question: "How many workers?", multi: false, options: [] });
  });

  it("at most four questions and six options, every text cut", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ label: `o${i}`, description: "d".repeat(900) }));
    const questions = askQuestions({
      questions: Array.from({ length: 6 }, (_, i) => ({ header: "h".repeat(90), question: `q${i} ${"x".repeat(2000)}`, options: many })),
    });
    expect(questions).toHaveLength(MAX_QUESTIONS);
    expect(questions[0].options).toHaveLength(MAX_OPTIONS);
    expect(questions[0].header.length).toBeLessThanOrEqual(40);
    expect(questions[0].question.length).toBeLessThanOrEqual(1000);
    expect(questions[0].options[0].description.length).toBeLessThanOrEqual(400);
  });

  it("drops a question with no text and an option with no label", () => {
    expect(askQuestions({ questions: [{ question: " " }, { question: "Ok?", options: [{ label: "" }, { label: "Yes" }] }] }))
      .toEqual([{ header: "", question: "Ok?", multi: false, options: [{ label: "Yes", description: "" }] }]);
  });

  it("an input that is not a set of questions stays a tool row", () => {
    expect(askQuestions({ questions: "nope" })).toBeNull();
    expect(transcriptTurns([assistant([{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }])]))
      .toEqual([{ kind: "tool", name: "AskUserQuestion", arg: "", running: true }]);
  });
});
