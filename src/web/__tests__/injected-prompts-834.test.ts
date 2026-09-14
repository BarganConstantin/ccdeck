// #834: the Prompts list showed Claude Code's injected <task-notification> XML
// as if the user had typed it. It arrives through UserPromptSubmit like a human
// turn, so the reducer recorded it like one, and the rail listed it verbatim and
// counted it. It is now shown as the system event it is, collapsed, in its place
// in time, and left out of every prompt count and of the session's first words.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyEvent, initialState } from "../reducer";
import { injectedPrompt, typedPrompts } from "../injected-prompt";
import type { GraphState, HookEnvelope, HookPayload } from "../types";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const NOTICE = [
  "<task-notification>",
  "<task-id>b055gq9k8</task-id>",
  "<status>completed</status>",
  '<summary>Background command "Watch CI" completed (exit code 0)</summary>',
  "</task-notification>",
].join("\n");

let seq = 0;
const send = (state: GraphState, sid: string, payload: Partial<HookPayload>, at: number) =>
  applyEvent(state, {
    seq: ++seq,
    receivedAt: at,
    payload: { session_id: sid, ...payload } as HookPayload,
  } as HookEnvelope);

describe("recognising a background task's notice (#834)", () => {
  it("names a finished task and keeps its one-line summary, not its XML", () => {
    expect(injectedPrompt(NOTICE)).toEqual({
      label: "background task finished",
      detail: 'Background command "Watch CI" completed (exit code 0)',
    });
  });

  it("says failed and stopped as such, and anything else as an update", () => {
    expect(injectedPrompt(NOTICE.replace("completed</status>", "failed</status>"))!.label).toBe("background task failed");
    expect(injectedPrompt(NOTICE.replace("completed</status>", "killed</status>"))!.label).toBe("background task stopped");
    expect(injectedPrompt(NOTICE.replace("completed</status>", "running</status>"))!.label).toBe("background task update");
    expect(injectedPrompt(NOTICE.replace("completed</status>", "constructor</status>"))!.label).toBe("background task update");
  });

  it("recognises the notice with text after it", () => {
    expect(injectedPrompt(`${NOTICE}\nRead the output file to retrieve the result.`)).not.toBeNull();
  });

  it("leaves a human's words alone, even words that mention the tag", () => {
    expect(injectedPrompt("ship it")).toBeNull();
    expect(injectedPrompt("why does <task-notification> show up in my prompts?")).toBeNull();
  });

  it("keeps only the typed prompts, in order", () => {
    const list = [{ text: "one" }, { text: NOTICE }, { text: "two" }];
    expect(typedPrompts(list).map(p => p.text)).toEqual(["one", "two"]);
  });
});

describe("the reducer (#834)", () => {
  it("keeps the notice in the list, in time, but not as the session's first words", () => {
    seq = 0;
    let s = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/srv/api" }, 1_000);
    s = send(s, "s1", { hook_event_name: "UserPromptSubmit", prompt: NOTICE }, 2_000);
    s = send(s, "s1", { hook_event_name: "UserPromptSubmit", prompt: "ship it" }, 3_000);
    const root = s.agents.get("s1")!;
    expect(root.prompts.map(p => p.text)).toEqual([NOTICE, "ship it"]);
    expect(root.firstPrompt).toBe("ship it");
  });
});

describe("the surfaces that count prompts (#834)", () => {
  const app = read("../App.tsx");
  const summary = read("../components/SessionSummary.tsx");

  it("counts only typed prompts in the rail's heading", () => {
    expect(app).toContain('<span className="section-count">{typedPrompts(agent.prompts).length}</span>');
  });

  it("lists the notice collapsed, by its label, and never prints its text as a prompt", () => {
    expect(app).toMatch(/<details className="prompt-entry prompt-injected" key=\{i\}>/);
    expect(app).toContain("{injected.label}");
    const injectedBranch = /if \(injected\) \{([\s\S]*?)\n\s{14}\}/.exec(app)![1];
    expect(injectedBranch).not.toContain("pr.text");
  });

  it("counts the same way in the session summary", () => {
    expect(summary).toContain("const typed = typedPrompts(a.prompts);");
    expect(summary).toContain("promptCount += typed.length;");
  });
});
