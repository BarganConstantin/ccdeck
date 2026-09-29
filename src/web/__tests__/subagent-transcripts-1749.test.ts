// #1749. A session's delegated spend was read from one shape of subagent file
// and one level of its directory, and Claude Code writes two more.
//
// What Claude Code 2.1.285 does, read off its own path builder and lister
// rather than guessed at:
//
//   * an agent's id is `a<16 hex>`, or `a<label>-<16 hex>` when the agent is
//     labelled — the label kept to `[\w-]`, so `aextract_memories-<hex>` for
//     the memory extractor, underscore and all;
//   * its transcript is `<session>/subagents/agent-<id>.jsonl`, or, for an
//     agent a workflow started, `<session>/subagents/workflows/<run>/agent-<id>.jsonl`;
//   * its own lister takes `agent-(.+).jsonl` at any depth below `subagents/`.
//
// The deck took `agent-([0-9a-f]+).jsonl` at the top of `subagents/` only, so a
// labelled agent's tokens and every workflow agent's tokens were missing from
// the session's totals, its per-model split and its subagent models — and the
// cursor cache filed the workflow files as sessions of their own.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Every path below lives inside this temp directory, and the server resolves
// the Claude config directory from the environment — so it points at the
// sandbox BEFORE any import of the server.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-subagent-transcripts-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { pushEvent } = await import("../../server/event-pipeline.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { transcriptSessionKey } = await import("../../server/transcript-scan.mjs");
const sessionUsageTotals = mod.sessionUsageTotals as (p: string) => Promise<{ input_tokens: number } | null>;
const sessionUsageByModel = mod.sessionUsageByModel as (p: string) => Promise<Record<string, { input_tokens: number }> | null>;
const eventsSince = mod.eventsSince as (seq: number) => { payload: Record<string, unknown> }[];

afterAll(() => rmTempDir(DIR));

/** One assistant turn as CC writes it, spending `input` input tokens. */
function turn(input: number, model: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { model, usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + "\n";
}

const PLAIN = "a0123456789abcdef";
const LABELLED = "aextract_memories-0123456789abcdef";
const WORKFLOW = "afedcba9876543210";

let next = 0;
/** The four-file layout from the report, under the sandbox's `projects/`: the
 *  main transcript and one agent of each kind, each on its own model so the
 *  split and the model map can tell them apart. Returns the main path. */
function sessionOnDisk(): { main: string; sid: string } {
  const sid = `sess-${next++}`;
  const slug = join(DIR, "claude", "projects", "-w");
  const subagents = join(slug, sid, "subagents");
  const run = join(subagents, "workflows", "run-7");
  mkdirSync(run, { recursive: true });
  const main = join(slug, `${sid}.jsonl`);
  writeFileSync(main, turn(1, "claude-opus-5"));
  writeFileSync(join(subagents, `agent-${PLAIN}.jsonl`), turn(10, "claude-opus-5"));
  writeFileSync(join(subagents, `agent-${LABELLED}.jsonl`), turn(100, "claude-sonnet-5"));
  // Its sidecar sits beside it, as CC writes one, and is not a transcript.
  writeFileSync(join(subagents, `agent-${LABELLED}.meta.json`), JSON.stringify({ agentType: "memory" }));
  writeFileSync(join(run, `agent-${WORKFLOW}.jsonl`), turn(1000, "claude-haiku-4-5"));
  return { main, sid };
}

describe("every subagent transcript of a session is its session's (#1749)", () => {
  it("sums the labelled agent and the workflow agent into the session's tokens", async () => {
    const { main } = sessionOnDisk();
    // 11 before: the main transcript and the one agent whose id was all hex.
    expect((await sessionUsageTotals(main))!.input_tokens).toBe(1111);
  });

  it("splits their tokens out under their own models", async () => {
    const { main } = sessionOnDisk();
    const split = await sessionUsageByModel(main);
    expect(split).not.toBeNull();
    expect(split!["claude-haiku-4-5"]?.input_tokens, "the workflow agent's model").toBe(1000);
    expect(split!["claude-sonnet-5"]?.input_tokens, "the labelled agent's model").toBe(100);
    expect(split!["claude-opus-5"]?.input_tokens).toBe(11);
  });

  it("names each of them in the session's subagent models, by the id CC gave it", async () => {
    const { main, sid } = sessionOnDisk();
    pushEvent({ hook_event_name: "PreToolUse", session_id: sid, cwd: DIR, transcript_path: main, tool_name: "Bash" }, "hook");
    let models: Record<string, string> | null = null;
    for (let i = 0; i < 200 && !models; i++) {
      const hit = eventsSince(0).find(e => e.payload.hook_event_name === "ModelObserved" && e.payload.session_id === sid);
      if (hit) models = hit.payload.subagentModels as Record<string, string>;
      else await new Promise(r => setTimeout(r, 10));
    }
    expect(models, "no ModelObserved for the session").not.toBeNull();
    expect(models).toEqual({
      [PLAIN]: "claude-opus-5",
      [LABELLED]: "claude-sonnet-5",
      [WORKFLOW]: "claude-haiku-4-5",
    });
  });

  it("files a workflow agent's transcript under its parent session in the cursor cache", () => {
    const sess = join(DIR, "p", "sess");
    expect(transcriptSessionKey(join(sess, "subagents", "workflows", "run-7", "agent-aextract_memories-0123.jsonl")))
      .toBe(resolve(sess));
    expect(transcriptSessionKey(join(sess, "subagents", `agent-${LABELLED}.jsonl`))).toBe(resolve(sess));
    // The two shapes that already grouped still do.
    expect(transcriptSessionKey(join(sess, "subagents", `agent-${PLAIN}.jsonl`))).toBe(resolve(sess));
    expect(transcriptSessionKey(`${sess}.jsonl`)).toBe(resolve(sess));
  });
});
