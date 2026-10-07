// A Codex session's hover card says, as its card does, that its approval
// prompts are not visible here.
//
// Codex writes no approval request to its rollout, so a Codex session parked on
// an approval prompt never gets a waiting line. Its card says so in that line's
// slot instead — "approvals not visible" — while the session is live under a
// policy that can ask (codex-approval.ts). The hover card, which is how a board
// zoomed out reads a card at all, left that line out: with keyboard focus on a
// live Codex session at a distance, its exec call in flight with no result, the
// hover card said "live · 1 in-flight" and nothing about the one thing the deck
// cannot see. It now carries the same line, in the same slot, in the same quiet
// ink: a note about the deck, never an alarm about the session.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { declared, sheetRules } from "./sheet-cascade";
import { codexApprovalTell } from "../codex-approval";
import type { AgentNodeData } from "../types";

const peek = readFileSync(fileURLToPath(new URL("../components/SessionPeek.tsx", import.meta.url)), "utf8");
/** Every rule that names the line, at any width. */
const rules = () => sheetRules().filter(r => r.selectors.some(s => s.includes("node-peek-blind")));
const got = (prop: string) => declared(rules().filter(r => r.media == null).map(r => r.body).join(";"), prop) ?? null;

describe("a Codex session's hover card", () => {
  it("carries the card's approvals line, whole", () => {
    expect(peek).toContain("const blind = codexApprovalTell(a);");
    expect(peek).toContain('{blind && <p className="node-peek-blind"><span className="approval-blind-dot" aria-hidden />{blind.label}</p>}');
  });

  it("in the waiting line's slot: after the session title, before the counts", () => {
    const title = peek.indexOf('className="node-peek-title"');
    const blind = peek.indexOf('className="node-peek-blind"');
    const facts = peek.indexOf('className="node-peek-facts"');
    expect(title).toBeGreaterThan(-1);
    expect(blind).toBeGreaterThan(title);
    expect(facts).toBeGreaterThan(blind);
  });

  it("in the card's quiet ink, never the amber that means waiting on you", () => {
    expect(got("color")).toBe("var(--muted)");
    expect(rules().map(r => r.body).join("\n")).not.toContain("--warn");
    expect(got("font-style")).toBe("italic");
    // Short enough to never need cutting, and not cut.
    expect(got("text-overflow")).toBeNull();
    expect(got("-webkit-line-clamp")).toBeNull();
  });

  it("only where the card says it: a live Codex session under a policy that can ask", () => {
    const codex = (over: Partial<AgentNodeData>) => ({
      id: "c1", sessionId: "c1", label: "shop-api-fix", kind: "root", state: "active", provider: "codex",
      approvalPolicy: "on-request", startedAt: 0, tools: [], prompts: [], toolCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, ...over,
    } as unknown as AgentNodeData);
    expect(codexApprovalTell(codex({}))?.label).toBe("approvals not visible");
    expect(codexApprovalTell(codex({ approvalPolicy: "never" }))).toBeNull();
    expect(codexApprovalTell(codex({ state: "done" }))).toBeNull();
    expect(codexApprovalTell(codex({ provider: "claude" }))).toBeNull();
  });
});
