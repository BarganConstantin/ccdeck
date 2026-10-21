// The reasoning effort in the model chip (#2155): "Opus 5.5 · xhigh".
//
// A user asked to see the model and the effort. The model was everywhere; the
// effort nowhere, although both CLIs state it. Claude Code puts `effort.level`
// on the hooks it fires inside a tool-use context, per agent — the owner's own
// event log carries it on every PreToolUse, PostToolUse, Stop and SubagentStop,
// subagents included. Codex writes it on every turn's `turn_context`.
//
// The owner's rule: only what the session itself said. No level is read off a
// setting or a model's default, so a session that never stated one shows the
// model alone — and a model that has no effort clears the one it replaced.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { applyEvent, initialState } from "../reducer";
import type { GraphState } from "../reducer";
import { subagentIdFor } from "../graph-state";
import { claudeEffort } from "../payload-effort";
import { modelChipText, modelChipTitle } from "../model-label";
import { foldEnrichment } from "../parked-enrichment";
import type { HookEnvelope, HookPayload } from "../types";

// @ts-expect-error — plain .mjs server module, no types
const translate = await import("../../server/codex-translate.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { readCodexRollout } = await import("../../server/codex-enrichment.mjs");
// @ts-expect-error — plain .mjs server module, no types
const evicted = await import("../../server/evicted-enrichment.mjs");
const codexObjToPayload = translate.codexObjToPayload as (o: unknown, sid: string, cwd: string) => HookPayload | null;

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-effort-2155-"));
afterAll(() => rmTempDir(DIR));

let seq = 0;
const env = (payload: HookPayload): HookEnvelope =>
  ({ seq: ++seq, receivedAt: 1_700_000_000_000 + seq, source: "hook", payload });
const run = (events: HookPayload[], state: GraphState = initialState()) =>
  events.reduce((s, p) => applyEvent(s, env(p)), state);

const SID = "s-effort";
const AGENT = "a0123456789abcdef";
const tool = (over: Partial<HookPayload> = {}): HookPayload => ({
  hook_event_name: "PreToolUse", session_id: SID, tool_name: "Read", tool_use_id: `t${seq}`, tool_input: {}, ...over,
});

describe("what a Claude Code payload says about effort", () => {
  it("is the level on the hooks Claude Code fires inside a tool-use context", () => {
    for (const name of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop"]) {
      expect(claudeEffort(name, { hook_event_name: name, effort: { level: "xhigh" } } as HookPayload), name).toBe("xhigh");
    }
  });

  it("is a model without one when such a hook arrives without it", () => {
    // Those hooks carry the field whenever the model supports effort, so its
    // absence there is an answer, and the chip must drop the old level.
    expect(claudeEffort("PreToolUse", { hook_event_name: "PreToolUse" } as HookPayload)).toBeNull();
    expect(claudeEffort("Stop", { hook_event_name: "Stop", effort: null } as HookPayload)).toBeNull();
  });

  it("is nothing at all on the events that never carry it, and on Codex's", () => {
    // A prompt or a session start says nothing either way: clearing on them
    // would blank the chip between every two tool calls.
    expect(claudeEffort("UserPromptSubmit", { hook_event_name: "UserPromptSubmit" } as HookPayload)).toBeUndefined();
    expect(claudeEffort("SessionStart", { hook_event_name: "SessionStart" } as HookPayload)).toBeUndefined();
    expect(claudeEffort("PreToolUse", { hook_event_name: "PreToolUse", provider: "codex" } as HookPayload)).toBeUndefined();
  });

  it("takes only a level that looks like one", () => {
    for (const level of ["", 7, "x".repeat(40), "high; rm", { a: 1 }]) {
      expect(claudeEffort("PreToolUse", { hook_event_name: "PreToolUse", effort: { level } } as HookPayload)).toBeNull();
    }
  });
});

describe("a Claude Code session's effort on its cards", () => {
  it("lands on the root, and on a subagent its own, from the hooks that name each", () => {
    // A subagent's frontmatter can set its own level, and its hooks carry its
    // agent_id: its level must not overwrite the root's, nor the root's its.
    const state = run([
      { hook_event_name: "SessionStart", session_id: SID, model: "claude-opus-5-5" },
      tool({ effort: { level: "xhigh" } }),
      { hook_event_name: "SubagentStart", session_id: SID, agent_id: AGENT, agent_type: "Explore" },
      tool({ agent_id: AGENT, effort: { level: "low" } }),
    ]);
    expect(state.agents.get(SID)!.effort).toBe("xhigh");
    expect(state.agents.get(subagentIdFor(SID, AGENT))!.effort).toBe("low");
  });

  it("follows /effort mid-session, and goes when the model has none", () => {
    let state = run([
      { hook_event_name: "SessionStart", session_id: SID, model: "claude-opus-5-5" },
      tool({ effort: { level: "xhigh" } }),
      tool({ effort: { level: "medium" } }),
    ]);
    expect(state.agents.get(SID)!.effort).toBe("medium");
    // A prompt between two turns says nothing about effort.
    state = run([{ hook_event_name: "UserPromptSubmit", session_id: SID, prompt: "go on" }], state);
    expect(state.agents.get(SID)!.effort).toBe("medium");
    // /model to one without an effort parameter: the next tool hook has none.
    state = run([tool()], state);
    expect(state.agents.get(SID)!.effort).toBeUndefined();
  });

  it("is never filled in when the session did not say it", () => {
    const state = run([
      { hook_event_name: "SessionStart", session_id: SID, model: "claude-opus-5-5" },
      { hook_event_name: "UserPromptSubmit", session_id: SID, prompt: "hi" },
    ]);
    expect(state.agents.get(SID)!.effort).toBeUndefined();
  });
});

describe("a Codex session's effort", () => {
  const CODEX = "codex-effort-sid";
  const turnContext = (payload: Record<string, unknown>) => ({ type: "turn_context", payload: { model: "gpt-6.1-sol", ...payload } });
  const prompt = { type: "event_msg", payload: { type: "user_message", message: "hi" } };

  it("rides on every payload after a turn_context, as Codex wrote it", () => {
    const sid = `${CODEX}-1`;
    // Before the first turn the field is absent: not known yet, not "none".
    expect(codexObjToPayload(prompt, sid, "/w")).not.toHaveProperty("reasoning_effort");
    expect(codexObjToPayload(turnContext({ effort: "medium" }), sid, "/w")).toBeNull();
    expect(codexObjToPayload(prompt, sid, "/w")).toMatchObject({ reasoning_effort: "medium", provider: "codex" });
  });

  it("falls back to the collaboration mode's copy, and is null for a turn with neither", () => {
    const sid = `${CODEX}-2`;
    codexObjToPayload(turnContext({ collaboration_mode: { settings: { reasoning_effort: "high" } } }), sid, "/w");
    expect(codexObjToPayload(prompt, sid, "/w")).toMatchObject({ reasoning_effort: "high" });
    codexObjToPayload(turnContext({}), sid, "/w");
    expect(codexObjToPayload(prompt, sid, "/w")).toMatchObject({ reasoning_effort: null });
  });

  it("is stamped on the root, cleared by null, and left alone by a payload without it", () => {
    let state = run([
      { hook_event_name: "SessionStart", session_id: CODEX, provider: "codex", model: "gpt-6.1-sol" },
      { hook_event_name: "UserPromptSubmit", session_id: CODEX, provider: "codex", prompt: "hi", reasoning_effort: "medium" },
    ]);
    expect(state.agents.get(CODEX)!.effort).toBe("medium");
    state = run([{ hook_event_name: "UserPromptSubmit", session_id: CODEX, provider: "codex", prompt: "again" }], state);
    expect(state.agents.get(CODEX)!.effort).toBe("medium");
    state = run([{ hook_event_name: "UserPromptSubmit", session_id: CODEX, provider: "codex", prompt: "now", reasoning_effort: null }], state);
    expect(state.agents.get(CODEX)!.effort).toBeUndefined();
  });

  it("is read off a hook-delivered session's rollout too: the newest turn's", async () => {
    const path = join(DIR, "rollout-2026-10-18T10-00-00-0a1b2c3d-0000-4000-8000-000000000001.jsonl");
    writeFileSync(path, [
      { type: "session_meta", payload: { id: "x", cwd: "/w" } },
      turnContext({ effort: "low" }),
      { type: "response_item", payload: { type: "message", model: "gpt-6.1-sol" } },
      turnContext({ effort: "xhigh" }),
    ].map(o => JSON.stringify(o)).join("\n") + "\n");
    expect(await readCodexRollout(path)).toMatchObject({ model: "gpt-6.1-sol", effort: "xhigh" });
  });
});

describe("a null effort survives the folds that keep the newest enrichment", () => {
  // A ModelObserved parked before its card, or evicted from the ring, is
  // folded with the next one. A null there is a turn with no effort, and has
  // to win over the level before it, on both sides of the wire.
  const prev = { hook_event_name: "ModelObserved", session_id: SID, model: "gpt-6.1-sol", reasoning_effort: "high" } as HookPayload;
  it.each([
    ["page", (a: HookPayload, b: HookPayload) => foldEnrichment(a, b)],
    ["server", (a: HookPayload, b: HookPayload) => evicted.foldEnrichment(a, b) as HookPayload],
  ])("on the %s", (_side, fold) => {
    expect(fold(prev, { ...prev, reasoning_effort: null }).reasoning_effort).toBeNull();
    const { reasoning_effort: _gone, ...without } = prev;
    expect(fold(prev, without as HookPayload).reasoning_effort).toBe("high");
  });
});

describe("the chip's words", () => {
  it("put the effort after the model, and nothing when there is none", () => {
    expect(modelChipText("claude-opus-5-5", "xhigh")).toBe("Opus 5.5 · xhigh");
    expect(modelChipText("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelChipText("gpt-6.1-sol", "medium")).toMatch(/ · medium$/);
    expect(modelChipTitle("claude-opus-5-5", "xhigh")).toBe("claude-opus-5-5\neffort: xhigh");
    expect(modelChipTitle("claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});

describe("the card's chip", () => {
  const card = (data: unknown) => renderToStaticMarkup(createElement(ReactFlowProvider, null,
    // NodeProps carries more than the card reads; only data matters here.
    createElement(AgentNode as never, { id: "s", data, selected: false } as never)));

  it("draws the effort with the model, and its full id and level in the tooltip", () => {
    const state = run([
      { hook_event_name: "SessionStart", session_id: "card", cwd: "/w/docs", model: "claude-opus-5-5" },
      { hook_event_name: "PreToolUse", session_id: "card", tool_name: "Read", tool_use_id: "c1", tool_input: {}, effort: { level: "high" } },
    ]);
    const html = card(state.agents.get("card"));
    expect(html).toContain(">Opus 5.5 · high</span>");
    expect(html).toContain('title="claude-opus-5-5\neffort: high"');
  });

  it("keeps the model alone where the row has no room for the effort", () => {
    // Measured in a browser, so pinned here at the source: with a spawn badge
    // and "+1", "Opus 5.5 · xhigh +1" overflowed the row by 51px and the row's
    // ellipsis took the whole chip, model and all, off the card. The card now
    // measures the row and gives up the kind word, then the effort (#2169 —
    // the order is card-row-squeeze.test.ts's); tried again when the row's
    // contents or width change.
    const src = readFileSync(fileURLToPath(new URL("../components/AgentNode.tsx", import.meta.url)), "utf8");
    expect(src).toMatch(/overflowing: el\.scrollWidth > el\.clientWidth,/);
    expect(src).toMatch(/useBeforePaint\(\(\) => \{ setSqueeze\(0\); \}, \[data\.effort, data\.model, otherModels\.length, data\.cwdBasename, data\.childCount, data\.kind, squeezeMax, rowWidth\]\)/);
    expect(src).toMatch(/modelChipText\(data\.model, row\.effort \? data\.effort : undefined\)/);
    expect(src).toMatch(/className="sub-details" ref=\{detailsRef\}/);
  });
});
