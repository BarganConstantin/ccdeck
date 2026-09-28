// #1650: the context panel counts one assistant reply once, however many
// content blocks it was written in.
//
// Claude Code writes one assistant line per content block of a response —
// thinking, text, each tool call — all of them one message, with
// `apiBlockIndex` counting the blocks from 0. #1641 stopped the token totals
// from summing the usage each of those lines repeats; the context breakdown
// read the same lines and went on counting every one of them as a message of
// its own. Measured across forty real transcripts: 14,249 assistant lines for
// 7,431 replies, and the panel printed the first number.
//
// The cases below are one reply as Claude Code writes it, two replies, the
// records an older Claude Code wrote without the field (which must go on
// counting as they did), and the counts beside it that come off the same lines
// and were already right: a tool call and a tool result each sit on a line of
// their own.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs server module, no types
const enrichment = await import("../../server/session-enrichment.mjs");
const { readContextFromTranscript } = enrichment as {
  readContextFromTranscript(p: string): Promise<Record<string, number> | null>;
};

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-context-per-reply-"));
afterAll(() => rmTempDir(DIR));

const USAGE = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 };

/** One reply written in `kinds.length` content blocks, one line per block, as
 *  Claude Code writes it. `index: false` leaves the field off, as a version
 *  from before it existed did. */
function reply(id: string, kinds: string[], { index = true } = {}): string {
  return kinds.map((kind, i) => JSON.stringify({
    type: "assistant", requestId: `req_${id}`, ...(index ? { apiBlockIndex: i } : {}),
    timestamp: "2026-09-28T10:00:00Z",
    message: { id: `msg_${id}`, model: "claude-opus-4-7", usage: USAGE, content: [{ type: kind }] },
  }) + "\n").join("");
}

/** The user line that answers one tool call. */
function toolResult(id: string): string {
  return JSON.stringify({
    type: "user", timestamp: "2026-09-28T10:00:01Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  }) + "\n";
}

let n = 0;
async function context(body: string) {
  const path = join(DIR, `session-${++n}.jsonl`);
  writeFileSync(path, body);
  return readContextFromTranscript(path);
}

describe("a reply written in several content blocks", () => {
  it("is one assistant message", async () => {
    expect((await context(reply("1", ["thinking", "text", "tool_use"])))?.msgsAssistant).toBe(1);
  });

  it("and the next reply is one more", async () => {
    const ctx = await context(reply("1", ["thinking", "tool_use"]) + toolResult("t1") + reply("2", ["text", "tool_use", "tool_use"]));
    expect(ctx?.msgsAssistant).toBe(2);
  });

  it("still counts each of its tool calls, and each result, once", async () => {
    const ctx = await context(reply("1", ["thinking", "tool_use", "tool_use"]) + toolResult("t1") + toolResult("t2"));
    expect(ctx).toMatchObject({ msgsAssistant: 1, toolUses: 2, toolResults: 2, msgsUser: 2 });
  });
});

describe("records written before Claude Code marked its blocks", () => {
  it("are counted line by line, as they always were", async () => {
    expect((await context(reply("1", ["text", "tool_use"], { index: false })))?.msgsAssistant).toBe(2);
  });
});
