// transcript-turns.mjs: a plan Claude Code asks you to approve (ExitPlanMode)
// becomes a plan turn with its Markdown, and once answered, whether it was
// approved. The result texts are the forms Claude Code 2.1 hands the model.
import { describe, expect, it } from "vitest";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { MAX_PLAN, PLAN_TOOL, transcriptTurns } from "../../server/transcript-turns.mjs";

const line = (o: unknown) => JSON.stringify(o);
const assistant = (content: unknown[]) => line({ type: "assistant", message: { content } });
const plan = (id: string, input: unknown) => assistant([{ type: "tool_use", id, name: "ExitPlanMode", input }]);
const answer = (id: string, content: unknown) =>
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });

const PLAN = "## Rate limits\n\n1. A token bucket on the public routes\n2. Tests for burst and refill";

describe("a plan turn", () => {
  it("is ExitPlanMode", () => {
    expect(PLAN_TOOL).toBe("ExitPlanMode");
  });

  it("waits while no answer is in the transcript, with the plan's Markdown", () => {
    expect(transcriptTurns([plan("p1", { plan: PLAN })])).toEqual([{ kind: "plan", text: PLAN, running: true }]);
  });

  it("is approved when the answer starts with \"User has approved\"", () => {
    const turns = transcriptTurns([plan("p1", { plan: PLAN }), answer("p1", "User has approved your plan. You can now start coding.")]);
    expect(turns).toEqual([{ kind: "plan", text: PLAN, approved: true }]);
  });

  it("reads the answer from text parts too", () => {
    const turns = transcriptTurns([plan("p1", { plan: PLAN }), answer("p1", [{ type: "text", text: "User has approved your plan." }])]);
    expect(turns[0].approved).toBe(true);
  });

  it("is not approved when the answer is a refusal or what you wrote back", () => {
    const refused = transcriptTurns([plan("p1", { plan: PLAN }), answer("p1", "The user doesn't want to proceed with this tool use.")]);
    expect(refused).toEqual([{ kind: "plan", text: PLAN, approved: false }]);
    const words = transcriptTurns([plan("p1", { plan: PLAN }), answer("p1", "Keep planning: also cover the admin routes")]);
    expect(words[0].approved).toBe(false);
  });

  it("an answer for another call does not answer it", () => {
    const turns = transcriptTurns([plan("p1", { plan: PLAN }), answer("p2", "User has approved your plan.")]);
    expect(turns[0]).toEqual({ kind: "plan", text: PLAN, running: true });
  });

  it("trims the plan and cuts one longer than MAX_PLAN, and says so", () => {
    expect(transcriptTurns([plan("p1", { plan: `\n  ${PLAN}  \n` })])[0].text).toBe(PLAN);
    const long = "a".repeat(MAX_PLAN + 50);
    const turn = transcriptTurns([plan("p1", { plan: long })])[0];
    expect(turn.cut).toBe(true);
    expect(turn.text.length).toBeLessThanOrEqual(MAX_PLAN + 1);
    expect(transcriptTurns([plan("p1", { plan: PLAN })])[0].cut).toBeUndefined();
  });

  it("has an empty text when the call carries no plan, or not as text", () => {
    expect(transcriptTurns([plan("p1", {})])).toEqual([{ kind: "plan", text: "", running: true }]);
    expect(transcriptTurns([plan("p1", { plan: 42 })])[0].text).toBe("");
    expect(transcriptTurns([plan("p1", null)])[0].text).toBe("");
  });

  it("keeps its place between the text and the tools beside it", () => {
    const turns = transcriptTurns([
      assistant([{ type: "text", text: "Here is the plan." }, { type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: PLAN } }]),
    ]);
    expect(turns.map((t: { kind: string }) => t.kind)).toEqual(["assistant", "plan"]);
  });
});
