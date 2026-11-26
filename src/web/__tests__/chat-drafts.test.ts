// Chat's drafts outlive the stage (chat-drafts.ts): what is typed for a
// session is found again by whichever stage shows it next, the Board and back
// included; each session's is its own, and an empty box is no draft.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { draftFor, keepDraft } from "../chat-drafts";

describe("a Chat draft", () => {
  it("is found again by its session's key, and only by it", () => {
    keepDraft("claude:a", "half a thought");
    expect(draftFor("claude:a")).toBe("half a thought");
    expect(draftFor("claude:b")).toBe("");
    expect(draftFor("codex:a")).toBe("");
  });

  it("is gone once the box is emptied, as a sent message empties it", () => {
    keepDraft("claude:a", "sent now");
    keepDraft("claude:a", "");
    expect(draftFor("claude:a")).toBe("");
  });

  it("is what the stage's box reads and writes, not a state of its own that goes with it", () => {
    const stage = readFileSync(fileURLToPath(new URL("../components/terminal/TerminalStage.tsx", import.meta.url)), "utf8");
    expect(stage).toContain("const chatDraft = draftFor(chatDraftKey);");
    expect(stage).toContain("onChange={value => putDraft(chatDraftKey, value)}");
    expect(stage).not.toContain("chatDrafts");
  });
});
